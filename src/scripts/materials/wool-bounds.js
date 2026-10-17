// BVH bounds of wool meshes for the path tracer (wool.js, wool-pt.js): the fibres stand out of the surface, so the
// boxes of a wool geometry's BVH must hold the fibre prisms (each triangle and its outermost shell, the vertices pushed
// out along their normals) – the traversal never reaches a fibre outside them. Grown only where fibres are and in their
// direction: padding every box by the fibre length in all directions made neighbouring small boxes overlap and slowed
// the whole path tracer down about 4× (Oct. 2026). Called by the Vite plugin rindr-wool from BVHComputeData.getBVH
// (at every path tracer scene build); refit() gives back the tight bounds once a geometry carries no wool. Own module
// without three-mesh-bvh/webgpu imports (BVHComputeData imports it – a cycle otherwise).
import { WOOL_GEOMETRIES } from './wool.js';

/** The BVH of `object` with bounds that fit its wool (or none) – returns `bvh` */
export function woolBounds(object, bvh) {
    if (!bvh?._roots || object?.isBatchedMesh) return bvh;
    const target = WOOL_GEOMETRIES.get(object.geometry) ?? 0;
    if ((bvh._rindrWool ?? 0) === target) return bvh;
    if (target > 0) grow(bvh, target);
    else bvh.refit();
    bvh._rindrWool = target;
    return bvh;
}

function grow(bvh, length) {
    const geometry = bvh.geometry;
    const pos = geometry.attributes.position, nor = geometry.attributes.normal, index = geometry.index;
    if (!pos || !nor) return;
    const indirect = bvh._indirectBuffer ?? null;
    const box = new Float64Array(6);
    for (const root of bvh._roots) {
        const f32 = new Float32Array(root), u32 = new Uint32Array(root), u16 = new Uint16Array(root);
        // post-order: a leaf from its triangles and their tops, an inner node from its two children
        const visit = n32 => {
            if (u16[n32 * 2 + 15] === 0xffff) {
                box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
                const offset = u32[n32 + 6], count = u16[n32 * 2 + 14];
                for (let t = offset; t < offset + count; t++) {
                    const tri = indirect ? indirect[t] : t;
                    for (let k = 0; k < 3; k++) {
                        const v = index ? index.getX(tri * 3 + k) : tri * 3 + k;
                        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
                        const tx = x + nor.getX(v) * length, ty = y + nor.getY(v) * length, tz = z + nor.getZ(v) * length;
                        box[0] = Math.min(box[0], x, tx); box[1] = Math.min(box[1], y, ty); box[2] = Math.min(box[2], z, tz);
                        box[3] = Math.max(box[3], x, tx); box[4] = Math.max(box[4], y, ty); box[5] = Math.max(box[5], z, tz);
                    }
                }
                for (let i = 0; i < 6; i++) f32[n32 + i] = box[i];
                return;
            }
            const left = n32 + 8, right = n32 + u32[n32 + 6] * 8;
            visit(left);
            visit(right);
            for (let i = 0; i < 3; i++) {
                f32[n32 + i] = Math.min(f32[left + i], f32[right + i]);
                f32[n32 + 3 + i] = Math.max(f32[left + 3 + i], f32[right + 3 + i]);
            }
        };
        visit(0);
    }
}
