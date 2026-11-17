// 3DS scene (3ds-parse.js, from the worker) → a three.js group like the loaders give it. With a keyframer: one group per
// node (hierarchy from the parent ids, "$$$DUMMY" nodes named by their instance name), placed by the first key of its
// tracks – T(position) · R(angle about axis) · S(scale) · T(−pivot) – and its mesh under it at (mesh matrix 4160)⁻¹ (the
// points are stored in world coordinates); a mesh used by several nodes is shared. Without one: each mesh as it is.
// Materials: Phong – diffuse colour (sRGB), specular colour × strength, shininess % → exponent 2^(1 + 9 · %), transparency
// → opacity (100 % = invisible is taken as not set: one exporter writes 100 % for every material, its other formats have
// opaque materials), self-illumination → emission, two-sided, colour / bump / opacity pictures with scale and offset.
import * as THREE from 'three/webgpu';

export function build3ds(scene, manager, name = '') {
    const root = new THREE.Group();
    root.name = name;
    const loader = new THREE.TextureLoader(manager);
    const textures = new Map();
    const texture = (m, srgb) => {
        if (!m?.file) return null;
        const key = m.file + (srgb ? '|s' : '');
        if (!textures.has(key)) {
            const tex = loader.load(m.file.replace(/\\/g, '/'));
            tex.name = m.file.split(/[\\/]/).pop();
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            if (m.scale.every(x => Number.isFinite(x) && x !== 0)) tex.repeat.set(m.scale[0], m.scale[1]);
            if (m.offset.every(Number.isFinite)) tex.offset.set(m.offset[0], m.offset[1]);
            textures.set(key, tex);
        }
        return textures.get(key);
    };
    const byName = new Map(scene.materials.map(m => [m.name, m]));
    const materials = new Map();
    const materialOf = matName => {
        if (materials.has(matName)) return materials.get(matName);
        const m = byName.get(matName);
        const clamp = x => Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1);
        const mat = new THREE.MeshPhongMaterial({ name: matName || 'Standard' });
        if (m) {
            if (m.diffuse) mat.color.setRGB(...m.diffuse.map(clamp), THREE.SRGBColorSpace);
            if (m.specular) mat.specular.setRGB(...m.specular.map(clamp), THREE.SRGBColorSpace).multiplyScalar(m.shinStrength ?? 1);
            mat.shininess = 2 ** (1 + 9 * clamp(m.shininess ?? 0.2));
            if (m.transparency > 0.001 && m.transparency < 0.99) { mat.transparent = true; mat.opacity = 1 - m.transparency; }
            if (m.selfIllum > 0 && m.diffuse) mat.emissive.setRGB(...m.diffuse.map(x => clamp(x) * clamp(m.selfIllum)), THREE.SRGBColorSpace);
            if (m.twoSided) mat.side = THREE.DoubleSide;
            const map = texture(m.map, true);
            if (map) { mat.map = map; mat.color.set(0xffffff); }
            const bump = texture(m.bump, false);
            if (bump) { mat.bumpMap = bump; mat.bumpScale = m.bump.amount ?? 1; }
            const alpha = texture(m.opacityMap, false);
            if (alpha) { mat.alphaMap = alpha; mat.transparent = true; }
        }
        materials.set(matName, mat);
        return mat;
    };
    const geometries = new Map();
    const meshesOf = obj => {
        if (!geometries.has(obj)) {
            geometries.set(obj, obj.parts.map(p => {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
                if (p.normals) g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
                if (p.uvs) g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
                g.setIndex(new THREE.BufferAttribute(p.index, 1));
                return { g, material: p.material };
            }));
        }
        return geometries.get(obj).map(({ g, material }) => {
            const mesh = new THREE.Mesh(g, materialOf(material));
            mesh.name = obj.parts.length > 1 ? `${obj.name} ${material}` : obj.name;
            return mesh;
        });
    };
    const objects = new Map(scene.objects.filter(o => !o.hidden).map(o => [o.name, o]));
    if (!scene.nodes.length) {
        for (const obj of objects.values()) {
            const group = new THREE.Group();
            group.name = obj.name;
            for (const m of meshesOf(obj)) group.add(m);
            root.add(group);
        }
        return root;
    }
    // keyframer nodes: world matrices from the first keys
    const byId = new Map(scene.nodes.map(n => [n.id, n]));
    const world = new Map();
    const worldOf = n => {
        if (world.has(n)) return world.get(n);
        world.set(n, new THREE.Matrix4());   // cycles
        const local = new THREE.Matrix4().makeTranslation(...(n.pos ?? [0, 0, 0]));
        if (n.rot && n.rot[0]) local.multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(n.rot[1], n.rot[2], n.rot[3]).normalize(), n.rot[0]));
        if (n.scale) local.multiply(new THREE.Matrix4().makeScale(...n.scale.map(x => x || 1)));
        local.multiply(new THREE.Matrix4().makeTranslation(-n.pivot[0], -n.pivot[1], -n.pivot[2]));
        const parent = byId.get(n.parent);
        const w = parent && parent !== n ? worldOf(parent).clone().multiply(local) : local;
        world.set(n, w);
        return w;
    };
    const groups = new Map();
    for (const n of scene.nodes) {
        const g = new THREE.Group();
        g.name = n.dummy ? n.instance || 'Dummy' : n.instance ? `${n.name} (${n.instance})` : n.name;
        groups.set(n, g);
    }
    const used = new Set();
    for (const n of scene.nodes) {
        const g = groups.get(n), w = worldOf(n);
        const parent = byId.get(n.parent);
        const pw = parent && parent !== n ? worldOf(parent) : new THREE.Matrix4();
        new THREE.Matrix4().copy(pw).invert().multiply(w).decompose(g.position, g.quaternion, g.scale);
        (parent && parent !== n ? groups.get(parent) : root).add(g);
        const obj = !n.dummy && objects.get(n.name);
        if (!obj) continue;
        used.add(obj);
        const offset = obj.matrix ? new THREE.Matrix4().fromArray(obj.matrix).invert() : new THREE.Matrix4();
        for (const m of meshesOf(obj)) { offset.decompose(m.position, m.quaternion, m.scale); g.add(m); }
    }
    // meshes no node shows: as they are
    for (const obj of objects.values()) {
        if (used.has(obj)) continue;
        const group = new THREE.Group();
        group.name = obj.name;
        for (const m of meshesOf(obj)) group.add(m);
        root.add(group);
    }
    return root;
}
