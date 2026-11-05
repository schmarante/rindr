// Hair and fur as curves – the geometry side (pure functions, run in a worker): cubic Bézier segments → straight pieces
// with a radius. Each piece becomes one stand-in triangle (a, b, a) for the path tracer's BVH; the ray test treats it
// as a cylinder from a to b (curve-pt.js – radius per point in uv.x), the raster draws the pieces as lines with a
// hair sheen (curve-mesh.js). Own implementation after the common curve definitions (Bézier, uniform B-spline).
//
// Segments are collected while reading (CurveBatch: 14 floats each – 4 control points, width at both ends), so millions
// of hairs never become objects of their own.

export const SEGMENT_FLOATS = 14;

/** A growing list of cubic Bézier segments (control points + widths), one per material/transform/object */
export class CurveBatch {
    constructor() {
        this.data = new Float32Array(SEGMENT_FLOATS * 1024);
        this.count = 0;
    }
    _grow() {
        const next = new Float32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
    }
    _push(c0, c1, c2, c3, w0, w1) {
        if ((this.count + 1) * SEGMENT_FLOATS > this.data.length) this._grow();
        const d = this.data, o = this.count * SEGMENT_FLOATS;
        for (let k = 0; k < 3; k++) { d[o + k] = c0[k]; d[o + 3 + k] = c1[k]; d[o + 6 + k] = c2[k]; d[o + 9 + k] = c3[k]; }
        d[o + 12] = w0; d[o + 13] = w1;
        this.count++;
    }
    /**
     * One curve: its control points (flat xyz), degree 2 or 3, basis 'bezier' | 'bspline', width at start and end (the
     * diameter, linear along the whole curve). Returns the number of segments added (0: not enough points).
     */
    add(P, degree = 3, basis = 'bezier', width0 = 1, width1 = 1) {
        const n = Math.floor(P.length / 3);
        const p = i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
        const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const mix = (ws, ...ps) => [0, 1, 2].map(k => ps.reduce((s, q, i) => s + q[k] * ws[i], 0));
        // quadratic → cubic: the inner points two thirds towards the middle one
        const cubic = (q0, q1, q2) => [q0, lerp(q0, q1, 2 / 3), lerp(q2, q1, 2 / 3), q2];
        const segs = [];
        if (basis === 'bspline') {
            if (degree === 2) for (let i = 0; i + 2 < n; i++) { const [a, b, c] = [p(i), p(i + 1), p(i + 2)]; segs.push(cubic(lerp(a, b, 0.5), b, lerp(b, c, 0.5))); }
            else for (let i = 0; i + 3 < n; i++) {
                const [a, b, c, d] = [p(i), p(i + 1), p(i + 2), p(i + 3)];
                segs.push([mix([1 / 6, 4 / 6, 1 / 6], a, b, c), mix([4 / 6, 2 / 6], b, c), mix([2 / 6, 4 / 6], b, c), mix([1 / 6, 4 / 6, 1 / 6], b, c, d)]);
            }
        } else if (degree === 2) {
            for (let i = 0; i + 2 < n; i += 2) segs.push(cubic(p(i), p(i + 1), p(i + 2)));
        } else {
            for (let i = 0; i + 3 < n; i += 3) segs.push([p(i), p(i + 1), p(i + 2), p(i + 3)]);
        }
        segs.forEach((s, i) => this._push(s[0], s[1], s[2], s[3], width0 + (width1 - width0) * i / segs.length, width0 + (width1 - width0) * (i + 1) / segs.length));
        return segs.length;
    }
}

const MAX_PIECES = 4;

// pieces for one segment: from how far its inner control points stand off the chord, relative to the chord and the
// width (a flat error of a tenth of the chord or the width is invisible on a hair)
function piecesOf(d, o) {
    const ax = d[o], ay = d[o + 1], az = d[o + 2], bx = d[o + 9], by = d[o + 10], bz = d[o + 11];
    const cx = bx - ax, cy = by - ay, cz = bz - az, len2 = cx * cx + cy * cy + cz * cz;
    let dev = 0;
    for (const q of [3, 6]) {
        const px = d[o + q] - ax, py = d[o + q + 1] - ay, pz = d[o + q + 2] - az;
        const t = len2 > 0 ? (px * cx + py * cy + pz * cz) / len2 : 0;
        const ex = px - cx * t, ey = py - cy * t, ez = pz - cz * t;
        dev = Math.max(dev, Math.sqrt(ex * ex + ey * ey + ez * ez));
    }
    const tol = Math.max(0.05 * Math.sqrt(len2), 0.5 * Math.max(d[o + 12], d[o + 13]), 1e-12);
    // the polyline's error falls with the square of the piece count
    return Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.sqrt(dev / tol))));
}

/**
 * Batches → one geometry of straight pieces. keep(i): which segments stay (thinning to a budget – the kept ones grow by
 * widthScale to cover about the same area).
 * @returns {{ positions: Float32Array, normals: Float32Array, tangents: Float32Array (xyz direction, w 1),
 *   uvs: Float32Array (x = radius, y = a random number per hair 0…1 – the raster turns its normal by it),
 *   index: Uint32Array (a, b, a per piece), pieces: number, maxRadius: number }}
 */
export function buildCurves(batch, { stride = 1, widthScale = 1 } = {}) {
    const d = batch.data;
    let points = 0, pieces = 0;
    const counts = new Uint8Array(Math.ceil(batch.count / stride));
    for (let s = 0, j = 0; s < batch.count; s += stride, j++) {
        const n = piecesOf(d, s * SEGMENT_FLOATS);
        counts[j] = n;
        pieces += n;
        points += n + 1;
    }
    const positions = new Float32Array(points * 3), normals = new Float32Array(points * 3), tangents = new Float32Array(points * 4);
    const uvs = new Float32Array(points * 2), index = new Uint32Array(pieces * 3);
    let v = 0, t = 0, maxRadius = 0;
    for (let s = 0, j = 0; s < batch.count; s += stride, j++) {
        const o = s * SEGMENT_FLOATS, n = counts[j];
        const random = ((Math.imul(s + 1, 2654435761) >>> 0) % 65536) / 65535;
        for (let i = 0; i <= n; i++) {
            const u = i / n, w = 1 - u;
            // position and derivative of the cubic Bézier
            const b0 = w * w * w, b1 = 3 * w * w * u, b2 = 3 * w * u * u, b3 = u * u * u;
            const d0 = -3 * w * w, d1 = 3 * w * w - 6 * w * u, d2 = 6 * w * u - 3 * u * u, d3 = 3 * u * u;
            let tx = 0, ty = 0, tz = 0;
            for (let k = 0; k < 3; k++) {
                positions[3 * v + k] = b0 * d[o + k] + b1 * d[o + 3 + k] + b2 * d[o + 6 + k] + b3 * d[o + 9 + k];
                const dk = d0 * d[o + k] + d1 * d[o + 3 + k] + d2 * d[o + 6 + k] + d3 * d[o + 9 + k];
                if (k === 0) tx = dk; else if (k === 1) ty = dk; else tz = dk;
            }
            let l = Math.hypot(tx, ty, tz);
            if (!(l > 0)) { tx = d[o + 9] - d[o]; ty = d[o + 10] - d[o + 1]; tz = d[o + 11] - d[o + 2]; l = Math.hypot(tx, ty, tz) || 1; }
            tx /= l; ty /= l; tz /= l;
            tangents.set([tx, ty, tz, 1], 4 * v);
            // a normal across the hair (only a placeholder – the ray test finds the real one)
            const ax = Math.abs(tx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
            let nx = ty * 0 - tz * ay, ny = tz * ax - tx * 0, nz = tx * ay - ty * ax;
            const nl = Math.hypot(nx, ny, nz) || 1;
            normals.set([nx / nl, ny / nl, nz / nl], 3 * v);
            const r = 0.5 * (d[o + 12] * w + d[o + 13] * u) * widthScale;
            uvs[2 * v] = r;
            uvs[2 * v + 1] = random;
            if (r > maxRadius) maxRadius = r;
            if (i < n) { index[t++] = v; index[t++] = v + 1; index[t++] = v; }
            v++;
        }
    }
    return { positions, normals, tangents, uvs, index, pieces, maxRadius };
}

/** pieces a batch would give (budget planning, before building) */
export function countPieces(batch, stride = 1) {
    let pieces = 0;
    for (let s = 0; s < batch.count; s += stride) pieces += piecesOf(batch.data, s * SEGMENT_FLOATS);
    return pieces;
}
