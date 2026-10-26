// OBJ scene (obj-parse.js, from the worker) + its MTL → a three.js group like the loaders give it: one group per OBJ group,
// one mesh per material in it; mesh-importer.js converts it like the other formats.
// Materials (MTL): Kd / map_Kd colour (sRGB as most exporters write it; Blender writes its scene-linear values – an MTL
// whose header names Blender is read linear), Ke / map_Ke emission, Ns → roughness (Blender writes Ns = 1000 · (1 − roughness)²;
// Pr wins; no Ns = 0 → rough, as the format's default), Pm metal, d / map_d opacity – d < 1 with illum 4/6/7/9 (glass) as transmission –, map_Bump / bump → bump map,
// norm / map_Kn → normal map. Textures by file name (absolute paths of the authoring machine: the resolver takes the name).
// Both sides drawn: OBJ has no notion of sides and exporters keep whatever winding the faces had (Blender shows both by
// default) – a rug seen from above showed its back faces and vanished, a bed base looked like glass.
import * as THREE from 'three/webgpu';
import { parseMtl } from './obj-parse.js';

export { parseMtl };

/**
 * @param {object} scene  parseObj() result
 * @param {object} mtl  parseMtl() result (all mtllib files merged)
 * @param {THREE.LoadingManager} manager
 */
export function buildObj(scene, mtl, manager, name = '', { linear = false } = {}) {
    const root = new THREE.Group();
    root.name = name;
    const loader = new THREE.TextureLoader(manager);
    const textures = new Map();
    const texture = (file, srgb) => {
        if (!file) return null;
        const key = file + (srgb ? '|s' : '');
        if (!textures.has(key)) {
            const tex = loader.load(file.replace(/\\/g, '/'));
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            textures.set(key, tex);
        }
        return textures.get(key);
    };
    const rgb = v => (Array.isArray(v) ? v : typeof v === 'number' ? [v, v, v] : null);
    const materials = new Map();
    const materialOf = matName => {
        if (materials.has(matName)) return materials.get(matName);
        const m = mtl[matName] || {};
        const d = typeof m.d === 'number' ? m.d : typeof m.tr === 'number' ? 1 - m.tr : 1;
        const glass = d < 1 && [4, 6, 7, 9].includes(m.illum);
        const mat = new THREE.MeshPhysicalMaterial({ name: matName || 'Standard', ior: Math.min(Math.max(m.ni ?? 1.5, 1), 2.333) });
        if (glass) { mat.transmission = 1 - d; mat.thickness = 0; }
        // Blender writes its Specular IOR Level as Ks (0.5 = normal, 0 = no reflection) – other exporters a specular colour
        const ks = rgb(m.ks);
        if (linear && ks) mat.specularIntensity = Math.min(Math.max(((ks[0] + ks[1] + ks[2]) / 3) * 2, 0), 1);
        const kd = rgb(m.kd);
        mat.color.setRGB(...(kd ?? [0.8, 0.8, 0.8]), linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
        mat.roughness = typeof m.pr === 'number' ? m.pr : Math.min(1, Math.max(0, 1 - Math.sqrt(Math.min(typeof m.ns === 'number' ? m.ns : 0, 1000) / 1000)));
        mat.side = THREE.DoubleSide;
        mat.metalness = typeof m.pm === 'number' ? m.pm : 0;
        const map = texture(m.map_kd, true);
        if (map) { mat.map = map; if (!kd) mat.color.set(0xffffff); }
        const ke = rgb(m.ke);
        const glow = texture(m.map_ke, true);
        if (ke && Math.max(...ke) > 0) mat.emissive.setRGB(...ke, linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
        if (glow && ke && Math.max(...ke) > 0) mat.emissiveMap = glow;
        const bump = texture(m.map_bump, false);
        if (bump) { mat.bumpMap = bump; mat.bumpScale = Number.isFinite(m.bumpScale) ? m.bumpScale : 1; }
        const normal = texture(m.norm ?? m.map_kn, false);
        if (normal) mat.normalMap = normal;
        const alpha = texture(m.map_d, false);
        if (!glass && (d < 1 || alpha)) { mat.transparent = true; mat.opacity = d; if (alpha) mat.alphaMap = alpha; }
        materials.set(matName, mat);
        return mat;
    };
    for (const g of scene.groups) {
        const group = new THREE.Group();
        group.name = g.name;
        for (const p of g.parts) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
            if (p.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
            if (p.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
            geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
            const mesh = new THREE.Mesh(geometry, materialOf(p.material));
            mesh.name = g.parts.length > 1 ? `${g.name} ${p.material}` : g.name;
            group.add(mesh);
        }
        root.add(group);
    }
    return root;
}
