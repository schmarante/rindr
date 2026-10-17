// Grass blades over a surface (grass.js): real geometry – the raster draws it, the path tracer traces it like any other
// mesh. Plain data in, plain arrays out (runs in grass-worker.js and, small, on the main thread for the previews).
//  - blades scattered by area (per triangle the expected number, the remainder by chance; a random point in the
//    triangle), the same blades every time (random numbers from the triangle index)
//  - a blade: 5 triangles, 7 vertices – two rows up the blade and a tip; it stands along the smoothed surface normal
//    (normals averaged over welded positions – with the mesh's own normals hard edges parted the grass into bald
//    lines), turned at random, leans over and bends more towards the tip (and on slopes towards `up`, like grass
//    growing towards the light), narrows to the tip and twists a little
//  - vertex colours = factors on the material colour: dark at the root (light hardly gets down there), per blade a
//    little lighter/darker, yellower/bluer; `dry` = share of straw-coloured blades
//  - too many blades for the budget: fewer, wider blades (the surface stays covered)

const LEVELS = [0, 0.4, 0.75];          // heights of the vertex rows (share of the blade); tip at 1
const WIDTH = 0.05;                     // blade width at the root (× height)
const SPACING = 0.08;                   // distance between blades (× height) at density 1
const RISE = 0.45;                      // bend towards `up` at the tip (× height) on vertical faces
export const GRASS_SHADE = { root: 0.3, tip: 1.08, ground: 0.3 };   // colour root → tip; surface below (× colour)
const VERTS = LEVELS.length * 2 + 1;
const TRIS = (LEVELS.length - 1) * 2 + 1;

/** Blades wanted for a surface area (local units²) – before the budget */
export function bladesFor(area, height, density) {
    const s = SPACING * height / Math.sqrt(Math.max(density, 1e-3));
    return area / (s * s);
}

/** Surface area of a triangle mesh (positions xyz, optional index) */
export function surfaceArea(positions, index) {
    let area = 0;
    const count = index ? index.length / 3 : positions.length / 9;
    for (let t = 0; t < count; t++) area += triArea(positions, index, t);
    return area;
}

function triArea(p, index, t) {
    const a = (index ? index[t * 3] : t * 3) * 3, b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3, c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

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

/**
 * @param {{ positions: Float32Array, index?: Uint32Array|Uint16Array, height: number, density: number, dry: number,
 *   maxBlades: number, up?: number[] }} input  height = blade height in the mesh's own units; up = world up in them
 * @param {(fraction: number) => void} [onProgress]  share of the blades done (now and then)
 * @returns {{ positions: Float32Array, normals: Float32Array, colors: Float32Array, index: Uint32Array, blades: number }}
 */
export function grassBlades({ positions, index, height, density, dry = 0, maxBlades, up = [0, 1, 0] }, onProgress = null) {
    const count = index ? index.length / 3 : positions.length / 9;
    const areas = new Float64Array(count);
    let total = 0;
    for (let t = 0; t < count; t++) total += areas[t] = triArea(positions, index, t);
    const wanted = bladesFor(total, height, density);
    const blades = Math.max(0, Math.min(Math.floor(wanted), Math.floor(maxBlades)));
    const widen = blades > 0 ? Math.min(Math.sqrt(wanted / blades), 2.5) : 1;
    const perArea = blades / Math.max(total, 1e-30);

    // blades per triangle first (exact array sizes)
    const normals = smoothNormals(positions, index);
    const U = normalize([...up]);
    const per = new Uint32Array(count);
    let n = 0;
    for (let t = 0; t < count; t++) {
        const expected = areas[t] * perArea;
        const rnd = random(t * 2654435761 + 1)();
        per[t] = Math.floor(expected) + (rnd < expected - Math.floor(expected) ? 1 : 0);
        n += per[t];
    }
    n = Math.min(n, blades + count);   // the remainders can add a few

    const outPos = new Float32Array(n * VERTS * 3);
    const outNor = new Float32Array(n * VERTS * 3);
    const outCol = new Float32Array(n * VERTS * 3);
    const outIdx = new Uint32Array(n * TRIS * 3);
    const P = [0, 0, 0], N = [0, 0, 0], W = [0, 0, 0], B = [0, 0, 0];
    let blade = 0;
    const step = Math.max(1, Math.floor(n / 50));
    for (let t = 0; t < count && blade < n; t++) {
        if (!per[t]) continue;
        if (onProgress && blade % step < per[t]) onProgress(blade / n);
        const ia = index ? index[t * 3] : t * 3, ib = index ? index[t * 3 + 1] : t * 3 + 1, ic = index ? index[t * 3 + 2] : t * 3 + 2;
        const rnd = random(t * 747796405 + 2891336453);
        // face normal (fallback, and to orient vertex normals that point inwards)
        const fx0 = positions[ib * 3] - positions[ia * 3], fy0 = positions[ib * 3 + 1] - positions[ia * 3 + 1], fz0 = positions[ib * 3 + 2] - positions[ia * 3 + 2];
        const fx1 = positions[ic * 3] - positions[ia * 3], fy1 = positions[ic * 3 + 1] - positions[ia * 3 + 1], fz1 = positions[ic * 3 + 2] - positions[ia * 3 + 2];
        const face = normalize([fy0 * fz1 - fz0 * fy1, fz0 * fx1 - fx0 * fz1, fx0 * fy1 - fy0 * fx1]);
        for (let k = 0; k < per[t] && blade < n; k++, blade++) {
            // random point in the triangle
            let u = rnd(), v = rnd();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = 1 - u - v;
            for (let i = 0; i < 3; i++) {
                P[i] = positions[ia * 3 + i] * w + positions[ib * 3 + i] * u + positions[ic * 3 + i] * v;
                N[i] = normals[ia * 3 + i] * w + normals[ib * 3 + i] * u + normals[ic * 3 + i] * v;
            }
            normalize(N);
            if (!(N[0] * N[0] + N[1] * N[1] + N[2] * N[2] > 0.5)) { N[0] = face[0]; N[1] = face[1]; N[2] = face[2]; }
            // frame: width axis W at a random angle around N, lean axis B across the blade's face
            const ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const T = normalize(cross(ref, N)), S = cross(N, T);
            const phi = rnd() * Math.PI * 2;
            for (let i = 0; i < 3; i++) W[i] = T[i] * Math.cos(phi) + S[i] * Math.sin(phi);
            const sgn = rnd() < 0.5 ? -1 : 1;
            const nw = cross(N, W);
            for (let i = 0; i < 3; i++) B[i] = sgn * nw[i];
            // towards the light: the part of `up` across the normal (none on top or bottom faces)
            const nu = N[0] * U[0] + N[1] * U[1] + N[2] * U[2];
            const R = [U[0] - N[0] * nu, U[1] - N[1] * nu, U[2] - N[2] * nu];
            const h = height * (0.6 + 0.55 * rnd());
            const lean = 0.15 + 0.55 * rnd() * rnd();          // sideways bend at the tip (× height), mostly small
            const twist = (rnd() - 0.5) * 0.8;                  // rotation of the width axis up the blade (radians)
            const width = WIDTH * height * widen * (0.7 + 0.6 * rnd());
            // colour of this blade
            const isDry = rnd() < dry;
            const shade = 0.85 + 0.3 * rnd(), hue = rnd() * 2 - 1;
            const tint = isDry ? [1.7 * shade, 1.35 * shade, 0.45 * shade] : [shade * (1 + 0.12 * hue), shade * (1 + 0.05 * hue), shade * (1 - 0.15 * hue)];

            const v0 = blade * VERTS;
            for (let l = 0; l <= LEVELS.length; l++) {
                const s = l < LEVELS.length ? LEVELS[l] : 1;
                // centre line: up the normal, bending over along B (quadratic – stiff at the root)
                const up = h * s * (1 - 0.35 * lean * s * s), side = h * lean * s * s;
                const dUp = h * (1 - 1.05 * lean * s * s), dSide = 2 * h * lean * s;   // derivative → blade direction
                const ang = twist * s, c = Math.cos(ang), sn = Math.sin(ang);
                const wx = W[0] * c + B[0] * sn, wy = W[1] * c + B[1] * sn, wz = W[2] * c + B[2] * sn;
                const half = l < LEVELS.length ? 0.5 * width * Math.pow(1 - s, 0.7) : 0;
                const rise = RISE * h * s * s, dRise = 2 * RISE * h * s;
                const cx = P[0] + N[0] * up + B[0] * side + R[0] * rise, cy = P[1] + N[1] * up + B[1] * side + R[1] * rise, cz = P[2] + N[2] * up + B[2] * side + R[2] * rise;
                const dir = [N[0] * dUp + B[0] * dSide + R[0] * dRise, N[1] * dUp + B[1] * dSide + R[1] * dRise, N[2] * dUp + B[2] * dSide + R[2] * dRise];
                const nrm = normalize(cross([wx, wy, wz], dir));
                const col = GRASS_SHADE.root + (GRASS_SHADE.tip - GRASS_SHADE.root) * Math.pow(s, 0.7);
                const rows = l < LEVELS.length ? [-1, 1] : [0];
                rows.forEach((side2, j) => {
                    const o = (v0 + l * 2 + j) * 3;
                    outPos[o] = cx + wx * half * side2; outPos[o + 1] = cy + wy * half * side2; outPos[o + 2] = cz + wz * half * side2;
                    outNor[o] = nrm[0]; outNor[o + 1] = nrm[1]; outNor[o + 2] = nrm[2];
                    outCol[o] = tint[0] * col; outCol[o + 1] = tint[1] * col; outCol[o + 2] = tint[2] * col;
                });
            }
            const i0 = blade * TRIS * 3;
            let q = i0;
            for (let l = 0; l < LEVELS.length - 1; l++) {
                const a = v0 + l * 2, b = a + 1, c = a + 2, d = a + 3;
                outIdx[q++] = a; outIdx[q++] = b; outIdx[q++] = c;
                outIdx[q++] = b; outIdx[q++] = d; outIdx[q++] = c;
            }
            const top = v0 + (LEVELS.length - 1) * 2;
            outIdx[q++] = top; outIdx[q++] = top + 1; outIdx[q++] = v0 + VERTS - 1;
        }
    }
    return {
        positions: outPos.subarray(0, blade * VERTS * 3), normals: outNor.subarray(0, blade * VERTS * 3),
        colors: outCol.subarray(0, blade * VERTS * 3), index: outIdx.subarray(0, blade * TRIS * 3), blades: blade,
    };
}

// vertex normals averaged over all faces at the same position (area-weighted), one per vertex
function smoothNormals(p, index) {
    const vertices = p.length / 3, count = index ? index.length / 3 : vertices / 3;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < p.length; i++) { min = Math.min(min, p[i]); max = Math.max(max, p[i]); }
    const q = 1e5 / Math.max(max - min, 1e-30);   // weld tolerance: 1e-5 of the extent
    const id = new Uint32Array(vertices), ids = new Map();
    for (let v = 0; v < vertices; v++) {
        const key = `${Math.round(p[v * 3] * q)},${Math.round(p[v * 3 + 1] * q)},${Math.round(p[v * 3 + 2] * q)}`;
        let k = ids.get(key);
        if (k === undefined) ids.set(key, k = ids.size);
        id[v] = k;
    }
    const acc = new Float64Array(ids.size * 3);
    for (let t = 0; t < count; t++) {
        const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;   // length = 2 × area
        for (const v of [a, b, c]) { acc[id[v] * 3] += nx; acc[id[v] * 3 + 1] += ny; acc[id[v] * 3 + 2] += nz; }
    }
    const out = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices; v++) {
        const n = normalize([acc[id[v] * 3], acc[id[v] * 3 + 1], acc[id[v] * 3 + 2]]);
        out[v * 3] = n[0]; out[v * 3 + 1] = n[1]; out[v * 3 + 2] = n[2];
    }
    return out;
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    a[0] /= l; a[1] /= l; a[2] /= l;
    return a;
}
