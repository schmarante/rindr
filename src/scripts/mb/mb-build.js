// MB scene (mb-parse.js, from the worker) → a three.js group like the loaders give it: one group per transform node with
// its matrix, the meshes of a shape node under it, one mesh per material; mesh-importer.js converts it like the other
// formats (normals computed there – creased, 30°). Transforms of the default cameras and hidden nodes stay out.
//
// Transform (column vectors): T · RT · RP · R · RA · RP⁻¹ · ST · SP · SH · S · SP⁻¹ – translation, rotate pivot
// (+ its translation), rotation in its order (ro: xyz, yzx, zxy, xzy, yxz, zyx – the first axis applied first), rotate
// axis, scale pivot (+ translation), shear, scale; angles in radians.
// Materials: Phong (colour × diffuse coefficient, transparency → opacity, specular colour, cosine power → shininess,
// incandescence → emission), Blinn (eccentricity → shininess), Lambert (no highlight).
import * as THREE from 'three/webgpu';

const ORDERS = ['ZYX', 'XZY', 'YXZ', 'YZX', 'ZXY', 'XYZ'];   // three's names for the orders above
const UNITS = { mm: 1, cm: 10, m: 1000, km: 1e6, in: 25.4, ft: 304.8, yd: 914.4, mi: 1609344 };

/** units → mm */
export const mbScale = scene => UNITS[scene.unit] ?? 10;

export function buildMb(scene, name = '') {
    const root = new THREE.Group();
    root.name = name;
    const materials = new Map();
    const materialOf = matName => {
        if (materials.has(matName)) return materials.get(matName);
        const m = scene.materials[matName];
        const clamp = x => Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1);
        let mat;
        if (!m || m.type === 'RLAM') mat = new THREE.MeshLambertMaterial({ name: matName || 'Standard' });
        else {
            mat = new THREE.MeshPhongMaterial({ name: matName });
            if (m.specular) mat.specular.setRGB(...m.specular.map(clamp), THREE.SRGBColorSpace);
            const ecc = m.eccentricity;
            mat.shininess = m.cosinePower > 0 ? m.cosinePower : ecc > 0 ? Math.max(2 / (ecc * ecc) - 2, 1) : 20;
        }
        const color = m?.color ?? [0.5, 0.5, 0.5];
        const k = Number.isFinite(m?.diffuse) ? m.diffuse : 0.8;
        mat.color.setRGB(...color.map(clamp), THREE.SRGBColorSpace).multiplyScalar(clamp(k));
        if (m?.transparency) {
            const tr = (m.transparency[0] + m.transparency[1] + m.transparency[2]) / 3;
            if (tr > 0.01) { mat.transparent = true; mat.opacity = 1 - clamp(tr); }
        }
        if (m?.incandescence && Math.max(...m.incandescence) > 0) mat.emissive.setRGB(...m.incandescence.map(clamp), THREE.SRGBColorSpace);
        materials.set(matName, mat);
        return mat;
    };
    const v3 = (a, d = 0) => new THREE.Vector3(...(a ?? [d, d, d]));
    const translate = a => new THREE.Matrix4().makeTranslation(v3(a));
    const groups = scene.transforms.map(t => {
        const g = new THREE.Group();
        g.name = t.name;
        g.visible = t.visible && !t.camera;
        const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(t.r ?? [0, 0, 0]), ORDERS[t.ro | 0] ?? 'ZYX'));
        const RA = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(t.ra ?? [0, 0, 0]), 'ZYX'));
        const S = new THREE.Matrix4().makeScale(...(t.s ?? [1, 1, 1]));
        const sh = t.sh ?? [0, 0, 0];   // xy, xz, yz
        const SH = new THREE.Matrix4().set(1, 0, 0, 0, sh[0], 1, 0, 0, sh[1], sh[2], 1, 0, 0, 0, 0, 1).transpose();
        const sp = v3(t.sp), rp = v3(t.rp);
        const M = translate(t.t).multiply(translate(t.rpt)).multiply(new THREE.Matrix4().makeTranslation(rp)).multiply(R).multiply(RA)
            .multiply(new THREE.Matrix4().makeTranslation(rp.clone().negate())).multiply(translate(t.spt))
            .multiply(new THREE.Matrix4().makeTranslation(sp)).multiply(SH).multiply(S).multiply(new THREE.Matrix4().makeTranslation(sp.clone().negate()));
        M.decompose(g.position, g.quaternion, g.scale);
        return g;
    });
    scene.transforms.forEach((t, i) => (t.parent >= 0 ? groups[t.parent] : root).add(groups[i]));
    for (const mesh of scene.meshes) {
        if (!mesh.visible) continue;
        const parent = mesh.transform >= 0 ? groups[mesh.transform] : root;
        for (const p of mesh.parts) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
            if (p.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
            geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
            const m = new THREE.Mesh(geometry, materialOf(p.material));
            m.name = mesh.parts.length > 1 ? `${parent.name} ${p.material}` : parent.name || mesh.name;
            parent.add(m);
        }
    }
    return root;
}
