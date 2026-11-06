// Hair and bristles from a material (hair.js; user, Nov. 2026: "einen Zylinder, der mit tausenden Haaren gefüllt ist, oder
// einen Rasierpinsel"): real fibres in the format of the imported hair (curves/curve-build.js – straight pieces with a
// radius, one stand-in triangle (a, b, a) each; the path tracer traces cylinders with the hair scattering model, the raster
// draws lines). Plain data in, plain arrays out – runs in hair-worker.js and, small, on the main thread for previews.
//  - fill: the shape is filled with fibres along `up` – each fibre from where a ray along it enters the shape to where it
//    leaves (bottom → top), so the tips end on the surface (a brush knot modelled as a bulb gets its exact outline);
//    spread pulls the roots towards the middle of the bottom (fanning out like a brush), a slight outward bow with it
//  - grow: fibres stand on the surface along the smoothed normal (like grass – grass-field.js), droop bends the tips
//    towards −up (gravity), length = given
//  - both: curl (a helix around the fibre, growing from the root), clump (tips drawn together in clumps), variation
//    (shorter fibres at random), taper (thinner towards the tip); vertex colours root → tip (with a little spread per
//    fibre); the same fibres every time (random numbers from the fibre's index)
//  - more fibres than the budget: fewer, thicker ones (the look stays about as dense)
import { surfaceArea, smoothNormals } from './grass-field.js';

// small deterministic random generator (mulberry32)
function random(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const normalize = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/** points per fibre: straight fibres need few, curled ones more */
export const pointsPerFibre = curl => (curl > 0.01 ? 10 : 4);

/** fibres wanted: coverage × area / fibre cross-section (area: the cross-section of the shape (fill) or its surface (grow)) */
export function fibresFor(area, thickness, density) {
    const r = Math.max(thickness, 1e-9) / 2;
    return Math.max(0, density) * area / (Math.PI * r * r);
}

/**
 * @param {object} input  (lengths in the mesh's own units)
 *   positions, index – the mesh; up – world up in its units; mode 'fill' | 'grow'; thickness (fibre diameter at the root),
 *   taper 0…1, density (coverage 0…1), length (grow), spread, curl, clump, variation, droop (0…1 each), root / tip
 *   (linear RGB), maxFibres (budget); raycastAll(origin, dir) → hit distances along the ray (fill – the worker's BVH)
 * @param {(fraction: number) => void} [onProgress]
 * @returns {{ positions, normals, tangents, uvs, colors, weights, index, fibres, pieces, maxRadius, area }}  uv.x = radius,
 *   uv.y = a random number per fibre (as curve-build.js), colors linear; weights per point [root → tip share, fibre shade]
 *   (recolour without building again – recolor())
 */
export function hairFibres(input, onProgress = null) {
    const { positions, index, mode = 'fill', thickness, taper = 0.5, density = 0.3, length = 1, spread = 0, curl = 0, clump = 0,
        variation = 0, droop = 0, root = [0.3, 0.25, 0.2], tip = [0.3, 0.25, 0.2], maxFibres = 1e5, up = [0, 1, 0], raycastAll = null } = input;
    const K = pointsPerFibre(curl);
    const U = normalize([...up]);
    const fibres = [];   // per fibre: { R (root), M (bow control), T (tip), side (curl frame), seed }
    let area = 0;
    if (mode === 'fill') {
        if (!raycastAll) throw new Error('hairFibres fill: no ray test');
        // frame across the axis, extent of the shape along and across it
        const E1 = normalize(cross(Math.abs(U[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], U)), E2 = cross(U, E1);
        let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity, minA = Infinity, maxA = -Infinity;
        const n = positions.length / 3;
        for (let i = 0; i < n; i++) {
            const p = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
            const a = dot(p, E1), b = dot(p, E2), c = dot(p, U);
            if (a < min1) min1 = a; if (a > max1) max1 = a;
            if (b < min2) min2 = b; if (b > max2) max2 = b;
            if (c < minA) minA = c; if (c > maxA) maxA = c;
        }
        const w1 = max1 - min1, w2 = max2 - min2, h = maxA - minA;
        if (!(w1 > 0 && w2 > 0 && h > 0)) return empty();
        const start = minA - 0.01 * h;
        const at = (a, b) => [E1[0] * a + E2[0] * b + U[0] * start, E1[1] * a + E2[1] * b + U[1] * start, E1[2] * a + E2[2] * b + U[2] * start];
        // first entry and the exit after it along +up (none: outside the shape)
        const span = (a, b) => {
            const hits = raycastAll(at(a, b), U);
            if (hits.length < 2) return null;
            return [hits[0], hits[1]];
        };
        // the shape's cross-section by sampling, its middle at the bottom (spread pulls the roots there)
        const probe = random(12345);
        let inside = 0, s1 = 0, s2 = 0, sBottom = 0;
        const SAMPLES = 2048;
        for (let i = 0; i < SAMPLES; i++) {
            const a = min1 + probe() * w1, b = min2 + probe() * w2;
            const s = span(a, b);
            if (!s) continue;
            inside++;
            s1 += a; s2 += b; sBottom += s[0];
        }
        if (!inside) return empty();
        area = w1 * w2 * inside / SAMPLES;
        const c1 = s1 / inside, c2 = s2 / inside, cBottom = start + sBottom / inside;
        const wanted = fibresFor(area, thickness, density);
        const count = Math.max(0, Math.min(Math.floor(wanted), Math.floor(maxFibres)));
        const widen = count > 0 ? Math.min(Math.sqrt(wanted / count), 4) : 1;
        const rnd = random(987654);
        let tries = 0;
        const limit = count * 40 + 1000;
        while (fibres.length < count && tries++ < limit) {
            const a = min1 + rnd() * w1, b = min2 + rnd() * w2;
            const s = span(a, b);
            if (!s) continue;
            const seed = fibres.length;
            const B = at(a, b), T = at(a, b);
            for (let k = 0; k < 3; k++) { B[k] += U[k] * s[0]; T[k] += U[k] * s[1]; }
            // spread: the root pulled towards the middle of the bottom; outward from the axis the fibre bows a little
            const middle = [E1[0] * c1 + E2[0] * c2 + U[0] * cBottom, E1[1] * c1 + E2[1] * c2 + U[1] * cBottom, E1[2] * c1 + E2[2] * c2 + U[2] * cBottom];
            const R = B.map((v, k) => v + (middle[k] - v) * spread * 0.85);
            const out = [a - c1, b - c2];
            const outLen = Math.hypot(out[0], out[1]) || 1;
            const bow = spread * 0.08 * (s[1] - s[0]);
            const M = R.map((v, k) => (v + T[k]) / 2 + (E1[k] * out[0] + E2[k] * out[1]) / outLen * bow);
            fibres.push({ R, M, T, seed, widen });
            if (onProgress && fibres.length % 2000 === 0) onProgress(0.5 * fibres.length / Math.max(count, 1));
        }
    } else {
        // grow: scattered over the surface by area (as grass-field.js), along the smoothed normal
        const count3 = index ? index.length / 3 : positions.length / 9;
        area = surfaceArea(positions, index);
        const wanted = fibresFor(area, thickness, density);
        const count = Math.max(0, Math.min(Math.floor(wanted), Math.floor(maxFibres)));
        const widen = count > 0 ? Math.min(Math.sqrt(wanted / count), 4) : 1;
        const normals = smoothNormals(positions, index);
        const perArea = count / Math.max(area, 1e-30);
        const v = i => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
        for (let t = 0; t < count3 && fibres.length < count; t++) {
            const ia = index ? index[t * 3] : t * 3, ib = index ? index[t * 3 + 1] : t * 3 + 1, ic = index ? index[t * 3 + 2] : t * 3 + 2;
            const A = v(ia), Bv = v(ib), C = v(ic);
            const triArea = 0.5 * Math.hypot(...cross(Bv.map((x, k) => x - A[k]), C.map((x, k) => x - A[k])));
            const expected = triArea * perArea;
            const rnd = random(t * 747796405 + 2891336453);
            const n = Math.floor(expected) + (rnd() < expected - Math.floor(expected) ? 1 : 0);
            for (let k = 0; k < n && fibres.length < count; k++) {
                let u = rnd(), w = rnd();
                if (u + w > 1) { u = 1 - u; w = 1 - w; }
                const z = 1 - u - w;
                const R = [0, 1, 2].map(i => A[i] * z + Bv[i] * u + C[i] * w);
                const N = normalize([0, 1, 2].map(i => normals[ia * 3 + i] * z + normals[ib * 3 + i] * u + normals[ic * 3 + i] * w));
                const L = length * (1 - variation * rnd());
                // droop: the second half bends towards −up
                const M = R.map((x, i) => x + N[i] * L * 0.5);
                const D = normalize(N.map((x, i) => x * (1 - droop) - U[i] * droop * 1.2));
                const T = M.map((x, i) => x + D[i] * L * 0.5);
                fibres.push({ R, M, T, seed: fibres.length, widen, grown: true });
            }
            if (onProgress && t % 4096 === 0) onProgress(0.5 * t / count3);
        }
    }
    if (!fibres.length) return empty(area);

    // clumps: tips drawn towards the mean tip of their cell (cell ≈ a tenth of the fibres' typical length)
    let clumps = null, cell = 1;
    if (clump > 0) {
        let lenSum = 0;
        for (const f of fibres.slice(0, 500)) lenSum += Math.hypot(f.T[0] - f.R[0], f.T[1] - f.R[1], f.T[2] - f.R[2]);
        cell = Math.max(lenSum / Math.min(fibres.length, 500) * 0.12, thickness * 4);
        clumps = new Map();
        const key = p => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
        for (const f of fibres) {
            const k = key(f.T);
            const c = clumps.get(k) ?? { s: [0, 0, 0], n: 0 };
            c.s[0] += f.T[0]; c.s[1] += f.T[1]; c.s[2] += f.T[2]; c.n++;
            clumps.set(k, c);
            f.clumpKey = k;
        }
    }

    // the pieces
    const nF = fibres.length, nP = nF * K, pieces = nF * (K - 1);
    const outPos = new Float32Array(nP * 3), outNor = new Float32Array(nP * 3), outTan = new Float32Array(nP * 4);
    const outUv = new Float32Array(nP * 2), outCol = new Float32Array(nP * 3), outW = new Float32Array(nP * 2), outIdx = new Uint32Array(pieces * 3);
    let maxRadius = 0, t = 0;
    const P = new Array(K);
    for (let f = 0; f < nF; f++) {
        const fib = fibres[f];
        const rnd = random(fib.seed * 2654435761 + 7);
        const shorten = fib.grown ? 1 : 1 - variation * rnd();
        const strand = rnd();
        const shade = 0.9 + 0.2 * rnd();
        const phase = rnd() * Math.PI * 2, turns = 2 + rnd() * 2;
        const len = Math.hypot(fib.T[0] - fib.R[0], fib.T[1] - fib.R[1], fib.T[2] - fib.R[2]);
        const dir = normalize(fib.T.map((x, k) => x - fib.R[k]));
        const s1 = normalize(cross(Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], dir)), s2 = cross(dir, s1);
        const amp = curl * 0.06 * len;
        let pull = null;
        if (clumps) {
            const c = clumps.get(fib.clumpKey);
            // towards the clump's middle – each fibre to its own point near it (tips on one point: the BVH cannot split them)
            const j = () => (rnd() - 0.5) * cell * 0.35;
            if (c.n > 1) pull = [c.s[0] / c.n + j() - fib.T[0], c.s[1] / c.n + j() - fib.T[1], c.s[2] / c.n + j() - fib.T[2]].map(x => x * clump * 0.8);
        }
        const r0 = (thickness / 2) * fib.widen;
        for (let i = 0; i < K; i++) {
            const u = (i / (K - 1)) * shorten, w = 1 - u;
            // quadratic Bézier root → bow → tip
            const p = [0, 1, 2].map(k => w * w * fib.R[k] + 2 * w * u * fib.M[k] + u * u * fib.T[k]);
            if (amp > 0) {
                const a = phase + u * turns * Math.PI * 2, g = amp * smooth(0, 0.3, u);
                for (let k = 0; k < 3; k++) p[k] += (s1[k] * Math.cos(a) + s2[k] * Math.sin(a)) * g;
            }
            if (pull) { const g = u * u; for (let k = 0; k < 3; k++) p[k] += pull[k] * g; }
            P[i] = p;
        }
        for (let i = 0; i < K; i++) {
            const v = f * K + i, u = i / (K - 1);
            const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, K - 1)];
            const T = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
            outPos.set(P[i], v * 3);
            outTan.set([T[0], T[1], T[2], 1], v * 4);
            const N = normalize(cross(Math.abs(T[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], T));
            outNor.set(N, v * 3);
            const r = r0 * Math.max(1 - taper * Math.pow(u, 1.5), 0.15);
            outUv[v * 2] = r;
            outUv[v * 2 + 1] = strand;
            if (r > maxRadius) maxRadius = r;
            const m = smooth(0.35, 1, u);
            outW[v * 2] = m;
            outW[v * 2 + 1] = shade;
            for (let k = 0; k < 3; k++) outCol[v * 3 + k] = (root[k] + (tip[k] - root[k]) * m) * shade;
            if (i < K - 1) { outIdx[t++] = v; outIdx[t++] = v + 1; outIdx[t++] = v; }
        }
        if (onProgress && f % 4000 === 0) onProgress(0.5 + 0.5 * f / nF);
    }
    return { positions: outPos, normals: outNor, tangents: outTan, uvs: outUv, colors: outCol, weights: outW, index: outIdx, fibres: nF, pieces, maxRadius, area };

    function empty(a = 0) {
        return { positions: new Float32Array(0), normals: new Float32Array(0), tangents: new Float32Array(0), uvs: new Float32Array(0), colors: new Float32Array(0), weights: new Float32Array(0), index: new Uint32Array(0), fibres: 0, pieces: 0, maxRadius: 0, area: a };
    }
}

/** new root / tip colours (linear RGB) into the colours of built fibres (weights from hairFibres) */
export function recolor(colors, weights, root, tip) {
    for (let v = 0, n = weights.length / 2; v < n; v++) {
        const m = weights[v * 2], shade = weights[v * 2 + 1];
        for (let k = 0; k < 3; k++) colors[v * 3 + k] = (root[k] + (tip[k] - root[k]) * m) * shade;
    }
}

/** the cross-section (fill) or surface (grow) the fibres cover, for the budget – cheap estimate without a ray test */
export function hairArea(positions, index, mode, up = [0, 1, 0]) {
    if (mode !== 'fill') return surfaceArea(positions, index);
    // fill: the shape's extent across `up` (a box – the sampled area comes later, in the worker)
    const U = normalize([...up]);
    const E1 = normalize(cross(Math.abs(U[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], U)), E2 = cross(U, E1);
    let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const p = [positions[i], positions[i + 1], positions[i + 2]];
        const a = dot(p, E1), b = dot(p, E2);
        if (a < min1) min1 = a; if (a > max1) max1 = a;
        if (b < min2) min2 = b; if (b > max2) max2 = b;
    }
    return Math.max(0, (max1 - min1) * (max2 - min2)) * Math.PI / 4;   // an ellipse in the box
}
