// Gaussian splats → BVH + packed data for ray tracing them in the path tracer (gaussian-pt.js, docs/splats.md
// "Gaussian Ray Tracing"). Every splat is a 3D Gaussian; a ray meets it where its response along the ray peaks. The BVH
// (three-mesh-bvh's generic BVH, SAH) goes over the box of each ellipsoid as far as its response stays visible
// (α · exp(−½ r²) ≥ 1/255 → r = √(2 ln 255α), at most ~3.3σ – faint splats get small boxes).
// In:  { a (xyz float bits + rgba8 per splat, 4 words), b (log scales + rotation as halfs, 4 words), count, sh (words per
//        splat × shWords, splat-mesh.js), shWords, shCoeffs }
// Out: { data (Float32Array, vec4 units – one storage buffer for the kernel, bindings per shader stage are scarce):
//          [0]                 header as u32: node count, first splat (vec4 index), splat count, SH words | coefficients << 8
//          [1]                 header as u32: first SH word (u32 index), 0, 0, 0
//          [2 …]               nodes, 2 vec4 each (three-mesh-bvh's packed layout: bounds min/max, then offset or the
//                              right child's relative index, then count | 0xffff0000 for a leaf or the split axis)
//          [first splat …]     splats in leaf order, 4 vec4 each: centre + opacity, then the three rows of the
//                              world → unit-sphere matrix (rotation axis / scale); in .w the colour (rgba8 as in the
//                              file, display values – bits), the splat's index in the file (bits), 0
//          [first SH word …]   the splats' higher SH bands in leaf order (words per splat as in the file: snorm8,
//                              coefficient-major) – in this buffer too: one more binding broke the kernel's limit
//        count (splats kept), ms }
import { BVH, SAH } from 'three-mesh-bvh';

const halfToFloat = h => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * 6.103515625e-5 * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + m / 1024);
};

class GaussianBVH extends BVH {
    constructor(bounds, count) {
        super();
        this.bounds = bounds;   // min/max per splat (kept order)
        this.primitiveBuffer = Uint32Array.from({ length: count }, (_, i) => i);
        this.primitiveBufferStride = 1;
    }
    getRootRanges() {
        return [{ offset: 0, count: this.primitiveBuffer.length }];
    }
    writePrimitiveBounds(i, target, base) {
        const o = this.primitiveBuffer[i] * 6;
        for (let k = 0; k < 6; k++) target[base + k] = this.bounds[o + k];
        return target;
    }
}

self.onmessage = ({ data }) => {
    const t0 = performance.now();
    const { a, b, count, sh = null } = data;
    const shWords = sh ? data.shWords : 0, shCoeffs = sh ? data.shCoeffs : 0;
    const words = new Uint32Array(a.buffer, a.byteOffset, count * 4);
    const pos = new Float32Array(a.buffer, a.byteOffset, count * 4);
    const bw = new Uint32Array(b.buffer, b.byteOffset, count * 4);
    // per kept splat: centre + opacity, the three rows of its matrix, colour; bounds for the BVH
    const kept = new Uint32Array(count);
    const rec = new Float32Array(count * 16);
    const recU = new Uint32Array(rec.buffer);
    const bounds = new Float32Array(count * 6);
    let n = 0;
    const R = new Float64Array(9);
    // progress: the splats' boxes ~10 %, the BVH ~85 %, packing the rest (bake display bottom left)
    const progress = p => self.postMessage({ progress: Math.min(Math.max(p, 0), 1) });
    let lastProgress = 0;
    for (let i = 0; i < count; i++) {
        if (i - lastProgress > 200000) { lastProgress = i; progress(0.1 * i / count); }
        const o = i * 4, col = words[o + 3];
        const alpha = (col >>> 24) / 255;
        if (alpha < 1 / 255) continue;
        const s = [Math.exp(halfToFloat(bw[o] & 0xffff)), Math.exp(halfToFloat(bw[o] >>> 16)), Math.exp(halfToFloat(bw[o + 1] & 0xffff))];
        if (!(s[0] > 0 && s[1] > 0 && s[2] > 0) || !s.every(Number.isFinite)) continue;
        let w = halfToFloat(bw[o + 2] & 0xffff), x = halfToFloat(bw[o + 2] >>> 16), y = halfToFloat(bw[o + 3] & 0xffff), z = halfToFloat(bw[o + 3] >>> 16);
        const ql = Math.hypot(w, x, y, z) || 1;
        w /= ql; x /= ql; y /= ql; z /= ql;
        // rotation columns (as the splat vertex shader): column k = local axis k in data space
        R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y + w * z); R[2] = 2 * (x * z - w * y);
        R[3] = 2 * (x * y - w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z + w * x);
        R[6] = 2 * (x * z + w * y); R[7] = 2 * (y * z - w * x); R[8] = 1 - 2 * (x * x + y * y);
        const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
        const r = Math.sqrt(2 * Math.log(255 * alpha));   // response ≥ 1/255 within r standard deviations
        const ex = r * Math.hypot(R[0] * s[0], R[3] * s[1], R[6] * s[2]);
        const ey = r * Math.hypot(R[1] * s[0], R[4] * s[1], R[7] * s[2]);
        const ez = r * Math.hypot(R[2] * s[0], R[5] * s[1], R[8] * s[2]);
        const bo = n * 6;
        bounds[bo] = px - ex; bounds[bo + 1] = py - ey; bounds[bo + 2] = pz - ez;
        bounds[bo + 3] = px + ex; bounds[bo + 4] = py + ey; bounds[bo + 5] = pz + ez;
        const ro = n * 16;
        rec[ro] = px; rec[ro + 1] = py; rec[ro + 2] = pz; rec[ro + 3] = alpha;
        for (let k = 0; k < 3; k++) {
            const q = ro + 4 + k * 4;
            rec[q] = R[k * 3] / s[k]; rec[q + 1] = R[k * 3 + 1] / s[k]; rec[q + 2] = R[k * 3 + 2] / s[k];
        }
        recU[ro + 7] = col;
        recU[ro + 11] = i;
        kept[n++] = i;
    }
    const bvh = new GaussianBVH(bounds, n);
    let reported = 0;
    if (n) bvh.init({ strategy: SAH, targetLeafSize: 4, maxDepth: 22, verbose: false, onProgress: p => { if (p - reported > 0.02) { reported = p; progress(0.1 + 0.85 * p); } } });
    const nodes = n ? new Uint32Array(bvh._roots[0]) : new Uint32Array(0);
    const nodeCount = nodes.length / 8;
    const first = 2 + nodeCount * 2;
    const shFirst = (first + n * 4) * 4;   // u32 index
    const out = new Float32Array(shFirst + n * shWords + 4);
    const u32 = new Uint32Array(out.buffer);
    u32[0] = nodeCount; u32[1] = first; u32[2] = n; u32[3] = shWords | (shCoeffs << 8);
    u32[4] = shFirst;
    u32.set(nodes, 8);
    const order = bvh.primitiveBuffer;
    const shU = sh ? new Uint32Array(sh.buffer, sh.byteOffset, count * shWords) : null;
    for (let j = 0; j < n; j++) {
        out.set(rec.subarray(order[j] * 16, order[j] * 16 + 16), (first + j * 4) * 4);
        if (shU) {
            const orig = recU[order[j] * 16 + 11];
            u32.set(shU.subarray(orig * shWords, orig * shWords + shWords), shFirst + j * shWords);
        }
    }
    self.postMessage({ data: out, count: n, nodes: nodeCount, ms: Math.round(performance.now() - t0) }, [out.buffer]);
};
