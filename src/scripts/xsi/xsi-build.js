// .xsi scene (xsi-parse.js, from the worker) → a three.js group like the loaders give it: one group per SI_Model with
// its transform (scale, rotation about X then Y then Z, translation), one mesh per polygon list; mesh-importer.js
// converts it like the other formats. Hidden models (SI_Visibility 0) stay out.
//
// Axes: SI_CoordinateSystem gives the direction of the file's x, y, z – turned onto Y up, right-handed at the root (a
// left-handed system mirrors). A system that is no set of three axes (one exporter writes six zeros) → the exporter's
// convention: SketchUp writes Z up, everything else counts as Y up.
// Units: .xsi has none – centimetres (a file whose other formats state cm), SketchUp's export millimetres.
// Transforms as the format says (checked against the same model as OBJ: 132 of 142 parts in place; the exporter of that
// file is not consistent – 5 parts only fit without their transform, 5 with none of the ways tried).
// Materials: Phong (diffuse colour sRGB, alpha → opacity, shininess, emissive; a surface shader's transparency →
// transmission), SI_Texture2D → colour picture with its scale/offset.
import * as THREE from 'three/webgpu';

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];   // right, left, up, down, in, out

/** units → mm and the axes for a parsed scene (the writer from SI_FileInfo, if any) */
export function xsiConventions(scene) {
    const sketchUp = /sketchup/i.test(scene.writer || '');
    const cs = scene.coordinateSystem;
    let basis = null;
    if (cs && cs.slice(3, 6).every(x => x >= 0 && x <= 5) && new Set(cs.slice(3, 6).map(x => x >> 1)).size === 3) {
        basis = new THREE.Matrix4().makeBasis(...cs.slice(3, 6).map(i => new THREE.Vector3(...DIRS[i])));
    } else if (sketchUp) basis = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // Z up → Y up
    return { scale: sketchUp ? 1 : 10, basis };
}

/**
 * @param {object} scene  parseXsi() result
 * @param {THREE.LoadingManager} manager
 */
export function buildXsi(scene, manager, name = '') {
    const root = new THREE.Group();
    root.name = name;
    const { basis } = xsiConventions(scene);
    if (basis && !basis.equals(new THREE.Matrix4())) {
        root.matrixAutoUpdate = true;
        basis.decompose(root.position, root.quaternion, root.scale);
    }
    const loader = new THREE.TextureLoader(manager);
    const textures = new Map();
    const materials = new Map();
    const materialOf = matName => {
        const key = String(matName || '').replace(/^.*\./, '');   // "MATLIB-scene.paint" → "paint"
        if (materials.has(key)) return materials.get(key);
        const m = scene.materials[key] ?? scene.materials[matName] ?? null;
        const mat = new THREE.MeshPhongMaterial({ name: key || 'Standard' });
        const rgb = v => (Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite) ? v.map(x => Math.min(Math.max(x, 0), 1)) : null);
        const diffuse = rgb(m?.diffuse);
        mat.color.setRGB(...(diffuse ?? [0.7, 0.7, 0.7]), THREE.SRGBColorSpace);
        if (rgb(m?.specular)) mat.specular.setRGB(...rgb(m.specular), THREE.SRGBColorSpace);
        mat.shininess = Number.isFinite(m?.shininess) && m.shininess > 0 ? m.shininess : 30;
        if (rgb(m?.emissive)) mat.emissive.setRGB(...rgb(m.emissive), THREE.SRGBColorSpace);
        const opacity = Number.isFinite(m?.opacity) ? Math.min(Math.max(m.opacity, 0), 1) : 1;
        if (opacity < 1) { mat.transparent = true; mat.opacity = opacity; }
        if (m?.texture) {
            const file = m.texture.replace(/\\/g, '/');
            if (!textures.has(file)) {
                const tex = loader.load(file);
                tex.name = file.split('/').pop();
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                const tx = m.textureTransform;
                if (tx) { tex.repeat.set(tx.scale[0], tx.scale[1]); tex.offset.set(tx.offset[0], tx.offset[1]); }
                textures.set(file, tex);
            }
            mat.map = textures.get(file);
        }
        materials.set(key, mat);
        return mat;
    };
    const toRad = scene.radians ? 1 : Math.PI / 180;
    let vertexColorMaterial = null;
    const build = (model, parent, inherited) => {
        if (!model.visible) return;
        const group = new THREE.Group();
        group.name = model.name.replace(/^(MDL|MSH)-/, '');
        const t = model.transform;
        if (t) {
            group.scale.set(t[0], t[1], t[2]);
            // about X first, then Y, then Z (fixed axes) = three's intrinsic ZYX
            group.rotation.set(t[3] * toRad, t[4] * toRad, t[5] * toRad, 'ZYX');
            group.position.set(t[6], t[7], t[8]);
        }
        const fallback = model.material ?? inherited;
        for (const mi of model.meshes) {
            const mesh = scene.meshes[mi];
            for (const p of mesh.parts) {
                if (!p.index.length) continue;
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
                if (p.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
                if (p.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
                geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
                let material = materialOf(p.material || fallback);
                if (p.colors) {
                    // colours per vertex (sRGB as written): × the material colour
                    const c = p.colors;
                    for (let i = 0; i < c.length; i++) c[i] = srgbToLinear(c[i]);
                    geometry.setAttribute('color', new THREE.BufferAttribute(c, 3));
                    if (!p.material && !fallback) material = vertexColorMaterial ??= new THREE.MeshPhongMaterial({ name: 'Vertex colours', color: 0xffffff, vertexColors: true });
                    else material.vertexColors = true;
                }
                const m = new THREE.Mesh(geometry, material);
                m.name = mesh.parts.length > 1 ? `${group.name} ${p.name || p.material}` : group.name;
                group.add(m);
            }
        }
        for (const c of model.children) build(c, group, fallback);
        parent.add(group);
    };
    for (const m of scene.models) build(m, root, null);
    return root;
}

const srgbToLinear = x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
