// LWO scene (lwo-parse.js, from the worker) → a three.js group like the loaders give it: one group per layer (layer
// hierarchy from the parent numbers), one mesh per surface in it; mesh-importer.js converts it like the other formats.
// Hidden layers stay out (convert skips invisible objects).
//
// Surfaces (the format's classic channels → physically based, own mapping):
//   - colour COLR (sRGB) × diffuse DIFF; luminosity LUMI → emission of the surface colour
//   - metal: colour highlights CLRH (the format's way to tint highlights and reflections like a metal) or more reflection
//     REFL than diffuse – then the colour is the metal's colour
//   - roughness from the glossiness GLOS (Phong exponent 2^(10·g+2) → GGX α = √(2/(n+2)) → RINDR roughness √α); a mirror
//     reflection (REFL ≥ 0.1) is sharp – at most 0.15 + 2 × its blur RBLR
//   - specular SPEC (or REFL) 0 → no reflection at all, as the modeller shows such a surface
//   - transparency TRAN → transmission with refraction index RIND (1 = no bending in the modeller – a pane: 1.5)
//   - both sides SIDE 3
//   - image layers (IMAP) on the UV map of the surface (lwo-parse.js chooses it): colour COLR → colour picture, BUMP →
//     bump picture (× BUMP × TAMP) – a picture named "normal" is a normal map (DirectX: green flipped). Other channels,
//     procedural/gradient layers and projections (planar, cylindrical, spherical, cubic) are not taken over.
import * as THREE from 'three/webgpu';

/**
 * @param {object} scene  parseLwo() result
 * @param {THREE.LoadingManager} manager
 * @param {(n: number) => string} layerName  name of an unnamed layer
 */
export function buildLwo(scene, manager, name = '', layerName = n => `Layer ${n}`) {
    const root = new THREE.Group();
    root.name = name;
    const loader = new THREE.TextureLoader(manager);
    const textures = new Map();
    // LWO paths are "device:path" (M:folder/file.png) or paths relative to its content folder – the file is looked up
    // by its name (dropped files, next to the model)
    const texture = (clip, srgb) => {
        const path = scene.clips[clip];
        if (typeof path !== 'string' || !path) return null;
        const file = path.split(/[\\/:]/).pop();
        const key = file + (srgb ? '|s' : '');
        if (!textures.has(key)) {
            const tex = loader.load(file);
            tex.name = file;
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            textures.set(key, tex);
        }
        return textures.get(key);
    };
    const materials = scene.surfaces.map(s => surfaceMaterial(s, texture));

    const groups = new Map();
    for (const l of scene.layers) {
        const group = new THREE.Group();
        group.name = l.name && l.name !== '(unnamed)' ? l.name : layerName(l.number + 1);
        group.visible = !l.hidden;
        groups.set(l.number, group);
        for (const p of l.parts) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
            if (p.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
            geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
            const mesh = new THREE.Mesh(geometry, materials[p.surface]);
            mesh.name = l.parts.length > 1 ? scene.surfaces[p.surface].name || group.name : group.name;
            group.add(mesh);
        }
    }
    // layer hierarchy: the parent number of a layer (missing parent → top level)
    for (const l of scene.layers) {
        const group = groups.get(l.number);
        (l.parent >= 0 && l.parent !== l.number && groups.get(l.parent) || root).add(group);
    }
    return root;
}

function surfaceMaterial(s, texture) {
    const mat = new THREE.MeshPhysicalMaterial({ name: s.name || 'Standard' });
    const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
    const diffuse = clamp(s.diffuse), reflection = clamp(s.reflection), specular = clamp(s.specular);
    const metal = s.colorHighlights >= 0.5 || (reflection > diffuse && reflection >= 0.2);
    mat.color.setRGB(...s.color.map(x => clamp(x)), THREE.SRGBColorSpace);
    if (!metal) mat.color.multiplyScalar(diffuse);
    mat.metalness = metal ? 1 : 0;
    // glossiness → Phong exponent → GGX α → RINDR roughness (α = r²)
    const n = 2 ** (10 * clamp(s.glossiness) + 2);
    let roughness = Math.sqrt(Math.sqrt(2 / (n + 2)));
    if (reflection >= 0.1) roughness = Math.min(roughness, 0.15 + 2 * clamp(s.reflectionBlur));
    mat.roughness = roughness;
    if (!metal) mat.specularIntensity = clamp(Math.max(specular, reflection) * 2);
    if (s.transparency > 0) {
        mat.transmission = clamp(s.transparency);
        mat.ior = s.ior > 1.01 ? Math.min(s.ior, 3.5) : 1.5;
        mat.thickness = 0;
        mat.specularIntensity = 1;
    }
    if (s.luminosity > 0) mat.emissive.setRGB(...s.color.map(x => clamp(x) * clamp(s.luminosity)), THREE.SRGBColorSpace);
    mat.side = s.side === 3 ? THREE.DoubleSide : THREE.FrontSide;
    // image layers on the surface's UV map: the first enabled one per channel
    const layerOf = channel => s.blocks.find(b => b.type === 'IMAP' && b.enabled && b.channel === channel && b.proj === 5 && b.vmap === s.uvMap && s.uvMap && b.image > 0);
    const colorLayer = layerOf('COLR');
    const map = colorLayer && texture(colorLayer.image, true);
    if (map) { mat.map = map; mat.color.setRGB(metal ? 1 : diffuse, metal ? 1 : diffuse, metal ? 1 : diffuse); }
    const bumpLayer = layerOf('BUMP');
    const bump = bumpLayer && texture(bumpLayer.image, false);
    if (bump) {
        if (/normal/i.test(bump.name)) {
            mat.normalMap = bump;
            if (/directx|[_\-. ]dx[_\-. ]/i.test(bump.name)) mat.normalScale.set(1, -1);
        } else {
            mat.bumpMap = bump;
            mat.bumpScale = (Number.isFinite(s.bump) ? s.bump : 1) * (Number.isFinite(bumpLayer.amplitude) ? bumpLayer.amplitude : 1);
        }
    }
    return mat;
}
