// STL in parts on all workers: the pure functions (stl-import.js drives them, the STEP worker pool runs them –
// step/worker.js 'stl:*').
//
// An STL is a triangle soup: every triangle has its own three corners, no parts, no shared vertices. Large CAD exports
// (assemblies of thousands of bodies, tens of millions of triangles) were one mesh with three vertices per triangle,
// oriented, smoothed and given a BVH by one thread each – minutes and several GB. Here:
//   1. readBinary + analyzeSoup – a chunk of the file per job: vertices welded (exact position), triangles with the
//      same three vertices as an earlier one are its alias (twin of opposite winding = two-sided, same winding =
//      duplicate) and left out of the edge count; parts = triangles connected over edges used by exactly two triangles
//      (bodies touching at an edge or a corner stay apart, a two-sided sheet stays one part); pieces (orientation) =
//      the same over edges wound consistently. Per piece: closed / open / two-sided, area, signed volume; sample points
//      of open pieces for the ray test; edges used once in the chunk (cut by the chunk border or really open) for the
//      join.
//   2. joinOpenEdges – an edge used once in each of two chunks joins their parts (the main thread unites the
//      (chunk, part) pairs); a part across chunks is exported from them (exportParts) and analysed again as a whole.
//   3. Orientation as before for the whole soup (one worker, removed): closed piece with clearly negative volume → flipped;
//      open piece: rays from its sample points along and against the normal against the whole model (testRays: every
//      worker its triangles, blocked = blocked in any), the side that escapes more often is outside; pieces with
//      two-sided triangles never (applyFlips).
//   4. Copies: parts with the same counts and size measures (fingerprints) are compared – matchBrep on the vertices,
//      then every triangle's centre, normal and colour (proofData / proveCopies). A copy takes the first part's
//      geometry with an alignment matrix.
//   5. partGeometries – per remaining part and colour: crease normals (30°, crease-normals.js), vertices shared per
//      (position, normal), box UVs, BVH + tangents.

import { BufferAttribute, BufferGeometry, Ray, Vector3 } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import { creaseCornerNormals } from '../crease-normals.js';
import { boxProject, UV_TILE } from '../box-project.js';
import { matchBrep, PointGrid } from '../step/brep-match.js';

export const NO_COLOR = 0xffff;        // the file has no facet colours
export const DEFAULT_COLOR = 0x8000;   // facet with the header's default colour (bit 15 set)

const pow2Above = x => { let c = 1024; while (c < x) c *= 2; return c; };
const USES = 4;   // triangles remembered per edge (two for parts and pieces, up to four for the splinters)

/**
 * Facets of a binary STL: positions (9 floats per triangle) and the colour code per triangle (15-bit RGB as written,
 * DEFAULT_COLOR, or NO_COLOR without "COLOR=" in the header – the convention three's STLLoader reads). Triangles with
 * non-finite coordinates become a point at the origin (dropped as collapsed by analyzeSoup).
 * @param {Uint8Array} bytes file (or chunk) bytes @param {number} offset byte offset of the first facet
 */
export function readBinary(bytes, offset, count, colors) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const P = new Float32Array(count * 9), codes = new Uint16Array(count);
    let broken = 0;
    for (let t = 0, o = offset; t < count; t++, o += 50) {
        let ok = true;
        for (let j = 0; j < 9; j++) {
            const v = view.getFloat32(o + 12 + j * 4, true);
            P[t * 9 + j] = v;
            if (v - v !== 0) ok = false;   // NaN / ±Infinity
        }
        if (!ok) { P.fill(0, t * 9, t * 9 + 9); broken++; }
        codes[t] = !colors ? NO_COLOR : (view.getUint16(o + 48, true) & 0x8000 ? DEFAULT_COLOR : view.getUint16(o + 48, true));
    }
    return { P, codes, broken };
}

/** Like readBinary for positions from elsewhere (ASCII STL through three's loader): non-finite triangles → origin */
export function soupFromPositions(P) {
    let broken = 0;
    for (let t = 0; t < P.length / 9; t++) {
        let ok = true;
        for (let j = 0; j < 9; j++) { const v = P[t * 9 + j]; if (v - v !== 0) ok = false; }
        if (!ok) { P.fill(0, t * 9, t * 9 + 9); broken++; }
    }
    return { P, codes: new Uint16Array(P.length / 9).fill(NO_COLOR), broken };
}

/**
 * Structure of a triangle soup (see the header, step 1). Kept in the worker for the later steps.
 * @param {Float32Array} P positions, 9 per triangle (−0 is turned into 0 in place)
 * @param {Uint16Array} codes colour code per triangle
 * @param {Int32Array|number} gidx index of each triangle in the file, or that of the first (consecutive)
 */
export function analyzeSoup(P, codes, gidx) {
    const n = P.length / 9;
    const g = typeof gidx === 'number' ? t => gidx + t : t => gidx[t];
    const bits = new Uint32Array(P.buffer, P.byteOffset, n * 9);
    for (let i = 0; i < n * 9; i++) if (bits[i] === 0x80000000) { bits[i] = 0; }   // −0 = 0: the same position

    // 1. weld: vertex id per corner (exact position)
    const corner = new Int32Array(n * 3);
    let vMask = pow2Above(n * 2) - 1, vSlots = new Int32Array(vMask + 1).fill(-1);
    let first = new Int32Array(n * 3);   // vertex → a corner holding its coordinates
    let vCount = 0;
    const vHash = c => {
        let h = Math.imul(bits[c * 3] ^ 0x811C9DC5, 0x01000193);
        h = Math.imul(h ^ bits[c * 3 + 1], 0x01000193);
        h = Math.imul(h ^ bits[c * 3 + 2], 0x01000193);
        return (h ^ (h >>> 15)) & vMask;
    };
    for (let c = 0; c < n * 3; c++) {
        let h = vHash(c), id = vSlots[h];
        for (; id >= 0; h = (h + 1) & vMask, id = vSlots[h]) {
            const f = first[id];
            if (bits[f * 3] === bits[c * 3] && bits[f * 3 + 1] === bits[c * 3 + 1] && bits[f * 3 + 2] === bits[c * 3 + 2]) break;
        }
        if (id < 0) {
            id = vCount++;
            first[id] = c;
            vSlots[h] = id;
            if (vCount > (vMask + 1) * 0.5) {
                vMask = vMask * 2 + 1;
                vSlots = new Int32Array(vMask + 1).fill(-1);
                for (let v = 0; v < vCount; v++) {
                    let s = vHash(first[v]);
                    while (vSlots[s] >= 0) s = (s + 1) & vMask;
                    vSlots[s] = v;
                }
            }
        }
        corner[c] = id;
    }
    vSlots = null;
    first = first.slice(0, vCount);

    // 2. collapsed triangles (two corners on one vertex: no area) are dropped; a triangle with the same three vertices
    //    as an earlier one is its alias – opposite winding = two-sided (never flipped), same winding = duplicate
    const dead = new Uint8Array(n), alias = new Int32Array(n).fill(-1), twoSided = new Uint8Array(n);
    {
        const tMask = pow2Above(n * 2) - 1, tSlots = new Int32Array(tMask + 1).fill(-1);
        for (let t = 0; t < n; t++) {
            const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
            if (a === b || b === c || a === c) { dead[t] = 1; continue; }
            const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
            let h = (Math.imul(lo ^ Math.imul(mid, 0x85EBCA77) ^ Math.imul(hi, 0xC2B2AE3D), 0x9E3779B1) >>> 0) & tMask, o = tSlots[h];
            for (; o >= 0; h = (h + 1) & tMask, o = tSlots[h]) {
                const p = corner[o * 3], q = corner[o * 3 + 1], r = corner[o * 3 + 2];
                if (Math.min(p, q, r) === lo && Math.max(p, q, r) === hi && p + q + r - lo - hi === mid) break;
            }
            if (o >= 0) {
                alias[t] = o;
                const p = corner[o * 3], q = corner[o * 3 + 1];
                const same = (p === a && q === b) || (p === b && q === c) || (p === c && q === a);
                if (!same) twoSided[t] = twoSided[o] = 1;
            } else tSlots[h] = t;
        }
    }

    // 3. edges of the triangles that count (live, no alias): uses (count, first USES triangles signed by direction)
    const eMask = pow2Above(n * 3) - 1, eSlots = new Int32Array(eMask + 1).fill(-1);
    const ends = new Int32Array(n * 6), count = new Uint8Array(n * 3), use = new Int32Array(n * 3 * USES);
    const triEdge = new Int32Array(n * 3).fill(-1);
    let eCount = 0;
    const eHash = (a, b) => { const h = Math.imul(a ^ Math.imul(b, 0x85EBCA77), 0x9E3779B1); return (h ^ (h >>> 15)) & eMask; };
    for (let t = 0; t < n; t++) {
        if (dead[t] || alias[t] >= 0) continue;
        for (let k = 0; k < 3; k++) {
            const a = corner[t * 3 + k], b = corner[t * 3 + (k + 1) % 3];
            const lo = a < b ? a : b, hi = a < b ? b : a;
            let h = eHash(lo, hi), e = eSlots[h];
            for (; e >= 0; h = (h + 1) & eMask, e = eSlots[h]) if (ends[e * 2] === lo && ends[e * 2 + 1] === hi) break;
            if (e < 0) { e = eCount++; ends[e * 2] = lo; ends[e * 2 + 1] = hi; eSlots[h] = e; }
            const c = count[e];
            if (c < USES) use[e * USES + c] = a < b ? t + 1 : -(t + 1);   // signed: direction along lo → hi
            if (c < 255) count[e] = c + 1;
            triEdge[t * 3 + k] = e;
        }
    }

    // 4. parts (edges used by exactly two triangles) and pieces (… wound consistently); aliases join their triangle
    const part = new Int32Array(n), piece = new Int32Array(n);
    for (let t = 0; t < n; t++) { part[t] = t; piece[t] = t; }
    const find = (p, x) => { while (p[x] !== x) x = p[x] = p[p[x]]; return x; };
    const unite = (p, a, b) => { a = find(p, a); b = find(p, b); if (a !== b) { if (a < b) p[b] = a; else p[a] = b; } };
    for (let e = 0; e < eCount; e++) {
        if (count[e] !== 2) continue;
        const u = use[e * USES], v = use[e * USES + 1], a = Math.abs(u) - 1, b = Math.abs(v) - 1;
        unite(part, a, b);
        if ((u > 0) !== (v > 0)) unite(piece, a, b);
    }
    for (let t = 0; t < n; t++) if (alias[t] >= 0) { unite(part, t, alias[t]); unite(piece, t, alias[t]); }
    attachSplinters(n, dead, alias, corner, triEdge, count, use, part, find, unite);
    // open: an edge of the triangle not shared consistently by two (aliases: their triangle's)
    const open = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
        if (dead[t] || alias[t] >= 0) continue;
        for (let k = 0; k < 3; k++) {
            const e = triEdge[t * 3 + k];
            if (count[e] !== 2 || (use[e * USES] > 0) === (use[e * USES + 1] > 0)) { open[t] = 1; break; }
        }
    }

    // edges used once: endpoints as position bits (lo < hi lexicographically) + part, for the join of the chunks
    let nOpen = 0;
    for (let e = 0; e < eCount; e++) if (count[e] === 1) nOpen++;
    const openBits = new Uint32Array(nOpen * 6), openTri = new Int32Array(nOpen);
    {
        let w = 0;
        const less = (a, b) => {
            for (let k = 0; k < 3; k++) { const x = bits[first[a] * 3 + k], y = bits[first[b] * 3 + k]; if (x !== y) return x < y; }
            return false;
        };
        for (let e = 0; e < eCount; e++) {
            if (count[e] !== 1) continue;
            let a = ends[e * 2], b = ends[e * 2 + 1];
            if (less(b, a)) { const x = a; a = b; b = x; }
            for (let k = 0; k < 3; k++) { openBits[w * 6 + k] = bits[first[a] * 3 + k]; openBits[w * 6 + 3 + k] = bits[first[b] * 3 + k]; }
            openTri[w++] = Math.abs(use[e * USES]) - 1;
        }
    }

    // 5. labels in triangle order (dead: −1), triangles grouped per piece
    const partOf = new Int32Array(n), pieceOf = new Int32Array(n), partId = new Int32Array(n).fill(-1), pieceId = new Int32Array(n).fill(-1);
    let parts = 0, pieces = 0;
    for (let t = 0; t < n; t++) {
        if (dead[t]) { partOf[t] = pieceOf[t] = -1; continue; }
        const r = find(part, t), q = find(piece, t);
        if (partId[r] < 0) partId[r] = parts++;
        if (pieceId[q] < 0) pieceId[q] = pieces++;
        partOf[t] = partId[r];
        pieceOf[t] = pieceId[q];
    }
    for (let w = 0; w < nOpen; w++) openTri[w] = partOf[openTri[w]];   // → part of the triangle using the edge
    const openPart = openTri;

    // per part: triangles, first triangle in the file, bounds; per piece: part, area, signed volume, open, two-sided
    const partTris = new Int32Array(parts), partFirst = new Int32Array(parts).fill(-1), partBox = new Float32Array(parts * 6);
    for (let p = 0; p < parts; p++) { partBox.fill(Infinity, p * 6, p * 6 + 3); partBox.fill(-Infinity, p * 6 + 3, p * 6 + 6); }
    const piecePart = new Int32Array(pieces), pArea = new Float64Array(pieces), pVol = new Float64Array(pieces);
    const pOpen = new Uint8Array(pieces), pTwo = new Uint8Array(pieces), pTris = new Int32Array(pieces), pFirst = new Int32Array(pieces).fill(-1);
    const area = new Float64Array(n);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let t = 0; t < n; t++) {
        const p = partOf[t];
        if (p < 0) continue;
        const q = pieceOf[t];
        partTris[p]++;
        if (partFirst[p] < 0) partFirst[p] = g(t);
        piecePart[q] = p;
        if (pFirst[q] < 0) pFirst[q] = g(t);
        const o = t * 9;
        const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
        const B = partBox, b6 = p * 6;
        B[b6] = Math.min(B[b6], ax, bx, cx); B[b6 + 3] = Math.max(B[b6 + 3], ax, bx, cx);
        B[b6 + 1] = Math.min(B[b6 + 1], ay, by, cy); B[b6 + 4] = Math.max(B[b6 + 4], ay, by, cy);
        B[b6 + 2] = Math.min(B[b6 + 2], az, bz, cz); B[b6 + 5] = Math.max(B[b6 + 5], az, bz, cz);
        if (twoSided[t]) pTwo[q] = 1;
        if (alias[t] >= 0) continue;   // duplicates: no second time area and volume
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        area[t] = Math.hypot(nx, ny, nz) / 2;
        pArea[q] += area[t];
        pTris[q]++;
        pVol[q] += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        if (open[t]) pOpen[q] = 1;
    }
    for (let p = 0; p < parts; p++) {
        const b6 = p * 6;
        minX = Math.min(minX, partBox[b6]); minY = Math.min(minY, partBox[b6 + 1]); minZ = Math.min(minZ, partBox[b6 + 2]);
        maxX = Math.max(maxX, partBox[b6 + 3]); maxY = Math.max(maxY, partBox[b6 + 4]); maxZ = Math.max(maxZ, partBox[b6 + 5]);
    }

    // 6. closed piece inside out: clearly negative volume (flat pieces have ~0 – no decision); open pieces get samples
    const flipClosed = new Uint8Array(pieces), pieceK = new Uint8Array(pieces);
    let samples = 0;
    for (let q = 0; q < pieces; q++) {
        if (pTwo[q] || pArea[q] <= 0) continue;
        if (!pOpen[q]) { if (pVol[q] < -1e-3 * pArea[q] ** 1.5) flipClosed[q] = 1; continue; }
        pieceK[q] = Math.min(16, Math.max(2, Math.ceil(pTris[q] / 50)));
        samples += pieceK[q];
    }
    const sample = sampleOpenPieces(P, pieceOf, area, pieces, pieceK, pFirst, pArea, samples);

    return {
        // kept in the worker
        n, P, codes, gidx, corner, vCount, partOf, pieceOf, flipped: false,
        // to the main thread
        summary: {
            triangles: n, dead: n - partTris.reduce((s, x) => s + x, 0), vertices: vCount,
            box: [minX, minY, minZ, maxX, maxY, maxZ],
            parts: { count: parts, tris: partTris, first: partFirst, box: partBox },
            pieces: { count: pieces, part: piecePart, flipClosed, k: pieceK, open: pOpen, tris: pTris },
            samples: sample,
            open: { bits: openBits, part: openPart },
        },
    };
}

// Splinters: a face of a body whose edges another body uses as well (touching bodies, an edge used three or four times)
// is not connected to its body – a quad of two triangles came out as a part of its own (a large brick assembly: ~2 500
// such parts of 0.4 mm; they would fly off on their own when exploding). A part of at most SPLINTER triangles that
// shares such an edge with another part joins the one it shares most of them with – counted only where the other
// triangle runs along the edge the other way (wound consistently: its own body; the touching body's side runs the same
// way – independent of how the bodies are oriented). Other splinters (the touching body's coincident face) only if
// nothing else is there; ties: the larger part, then the first. The first USES triangles of an edge are known.
const SPLINTER = 64;
function attachSplinters(n, dead, alias, corner, triEdge, count, use, part, find, unite) {
    const size = new Int32Array(n);
    for (let t = 0; t < n; t++) if (!dead[t]) size[find(part, t)]++;
    const shared = new Map();   // splinter root → Map(other root → shared edges)
    for (let t = 0; t < n; t++) {
        if (dead[t] || alias[t] >= 0) continue;
        const r = find(part, t);
        if (size[r] > SPLINTER) continue;
        for (let k = 0; k < 3; k++) {
            const e = triEdge[t * 3 + k];
            if (count[e] < 3) continue;
            const forward = corner[t * 3 + k] < corner[t * 3 + (k + 1) % 3];
            for (let j = 0; j < Math.min(count[e], USES); j++) {
                const u = use[e * USES + j];
                if ((u > 0) === forward) continue;   // the same direction: not its own body (or itself)
                const o = find(part, Math.abs(u) - 1);
                if (o === r) continue;
                if (!shared.has(r)) shared.set(r, new Map());
                const m = shared.get(r);
                m.set(o, (m.get(o) || 0) + 1);
            }
        }
    }
    const best = [];
    const rank = (o, c) => [size[o] > SPLINTER ? 1 : 0, c, size[o], -o];
    const better = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    for (const [r, m] of shared) {
        let pick = -1, top = null;
        for (const [o, c] of m) { const x = rank(o, c); if (!top || better(x, top)) { pick = o; top = x; } }
        best.push([r, pick]);
    }
    best.sort((a, b) => a[0] - b[0]);   // deterministic order of the unions
    for (const [r, o] of best) unite(part, r, o);
}

// sample points of open pieces: per piece k points, area-weighted, deterministic per piece (seed = its first triangle
// in the file, independent of how the file was split into chunks)
function sampleOpenPieces(P, pieceOf, area, pieces, pieceK, pFirst, pArea, total) {
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), of = new Int32Array(total);
    if (!total) return { pos, nor, piece: of };
    // triangles of the sampled pieces grouped per piece (counting sort), cumulative area for the binary search
    const n = pieceOf.length, start = new Int32Array(pieces + 1);
    for (let t = 0; t < n; t++) { const q = pieceOf[t]; if (q >= 0 && pieceK[q] && area[t] > 0) start[q + 1]++; }
    for (let q = 0; q < pieces; q++) start[q + 1] += start[q];
    const order = new Int32Array(start[pieces]), fill = start.slice(0, pieces), cum = new Float64Array(start[pieces]);
    for (let t = 0; t < n; t++) { const q = pieceOf[t]; if (q >= 0 && pieceK[q] && area[t] > 0) order[fill[q]++] = t; }
    for (let q = 0; q < pieces; q++) { let s = 0; for (let j = start[q]; j < start[q + 1]; j++) cum[j] = s += area[order[j]]; }
    let w = 0;
    for (let q = 0; q < pieces; q++) {
        if (!pieceK[q]) continue;
        let seed = Math.imul(pFirst[q] ^ 0x2545F491, 0x9E3779B1) | 0;
        const random = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
        for (let i = 0; i < pieceK[q]; i++) {
            const r = random() * pArea[q];
            let lo = start[q], hi = start[q + 1] - 1;
            while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
            const t = order[lo], o = t * 9;
            const ax = P[o], ay = P[o + 1], az = P[o + 2];
            const ux = P[o + 3] - ax, uy = P[o + 4] - ay, uz = P[o + 5] - az, vx = P[o + 6] - ax, vy = P[o + 7] - ay, vz = P[o + 8] - az;
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz);
            let u = random(), v = random();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            if (!l) continue;   // (no area – not sampled anyway)
            nx /= l; ny /= l; nz /= l;
            pos[w * 3] = ax + ux * u + vx * v; pos[w * 3 + 1] = ay + uy * u + vy * v; pos[w * 3 + 2] = az + uz * u + vz * v;
            nor[w * 3] = nx; nor[w * 3 + 1] = ny; nor[w * 3 + 2] = nz;
            of[w++] = q;
        }
    }
    return { pos: pos.slice(0, w * 3), nor: nor.slice(0, w * 3), piece: of.slice(0, w) };
}

/**
 * Join of the chunks: edges used once in two chunks connect their parts. lists[i] = { bits, part } of chunk i
 * (analyzeSoup summary.open). Returns pairs [chunkA, partA, chunkB, partB, …]. An edge used once in three chunks
 * (non-manifold) joins nothing – as within a chunk.
 */
export function joinOpenEdges(lists) {
    let total = 0;
    for (const l of lists) total += l.part.length;
    const mask = pow2Above(total * 2) - 1, slots = new Int32Array(mask + 1).fill(-1);
    const chunkOf = new Int32Array(total), recOf = new Int32Array(total), hits = new Uint8Array(total), partner = new Int32Array(total).fill(-1);
    let w = 0;
    for (let c = 0; c < lists.length; c++) {
        const { bits } = lists[c];
        for (let r = 0; r < lists[c].part.length; r++) {
            let h = 0x811C9DC5;
            for (let k = 0; k < 6; k++) h = Math.imul(h ^ bits[r * 6 + k], 0x01000193);
            h = (h ^ (h >>> 15)) & mask;
            let s = slots[h];
            for (; s >= 0; h = (h + 1) & mask, s = slots[h]) {
                const B = lists[chunkOf[s]].bits, rs = recOf[s];
                let same = true;
                for (let k = 0; k < 6 && same; k++) same = B[rs * 6 + k] === bits[r * 6 + k];
                if (same) break;
            }
            if (s >= 0) { if (hits[s] < 255) hits[s]++; if (hits[s] === 1) partner[s] = w; }
            else slots[h] = w;
            chunkOf[w] = c; recOf[w] = r; w++;
        }
    }
    const pairs = [];
    for (let s = 0; s < total; s++) {
        if (hits[s] !== 1) continue;
        const o = partner[s];
        pairs.push(chunkOf[s], lists[chunkOf[s]].part[recOf[s]], chunkOf[o], lists[chunkOf[o]].part[recOf[o]]);
    }
    return Int32Array.from(pairs);
}

/** Triangles of some parts of a soup (for the part across chunks): positions, colour codes, index in the file */
export function exportParts(soup, parts) {
    const want = new Set(parts);
    let m = 0;
    for (let t = 0; t < soup.n; t++) if (want.has(soup.partOf[t])) m++;
    const P = new Float32Array(m * 9), codes = new Uint16Array(m), gidx = new Int32Array(m);
    let w = 0;
    for (let t = 0; t < soup.n; t++) {
        if (!want.has(soup.partOf[t])) continue;
        P.set(soup.P.subarray(t * 9, t * 9 + 9), w * 9);
        codes[w] = soup.codes[t];
        gidx[w++] = typeof soup.gidx === 'number' ? soup.gidx + t : soup.gidx[t];
    }
    return { P, codes, gidx };
}

/**
 * Ray test of sample points against the triangles of this worker's soups: blocked[i] = 1 if the ray from point i
 * (moved eps off the surface) along +normal (sign 1) or −normal (sign −1) hits a triangle farther than minHit.
 * As before: any hit (shapecast stops at the first – cheaper than the closest).
 */
export function testRays(soups, pos, nor, sign, eps, minHit) {
    const blocked = new Uint8Array(pos.length / 3);
    const ray = new Ray(), hitPoint = new Vector3(), origin = new Vector3(), dir = new Vector3();
    for (const s of soups) {
        if (!s.rayBvh) {
            const g = new BufferGeometry();
            g.setAttribute('position', new BufferAttribute(s.P, 3));
            s.rayBvh = new MeshBVH(g, { indirect: true });   // indirect: positions stay in place
        }
    }
    for (let i = 0; i < blocked.length; i++) {
        dir.set(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]).multiplyScalar(sign);
        origin.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).addScaledVector(dir, eps);
        ray.set(origin, dir);
        for (const s of soups) {
            const hit = s.rayBvh.shapecast({
                intersectsBounds: box => ray.intersectsBox(box),
                intersectsTriangle: tri => {
                    const p = ray.intersectTriangle(tri.a, tri.b, tri.c, false, hitPoint);
                    return p !== null && p.distanceTo(origin) > minHit;
                },
            });
            if (hit) { blocked[i] = 1; break; }
        }
    }
    return blocked;
}

/** Flip the pieces marked in flip (one entry per piece): corners 1 and 2 swapped (positions and vertex ids) */
export function applyFlips(soup, flip) {
    let flipped = 0;
    const { P, corner, pieceOf } = soup;
    for (let t = 0; t < soup.n; t++) {
        const q = pieceOf[t];
        if (q < 0 || !flip[q]) continue;
        flipped++;
        const o = t * 9;
        for (let j = 0; j < 3; j++) { const x = P[o + 3 + j]; P[o + 3 + j] = P[o + 6 + j]; P[o + 6 + j] = x; }
        const c = corner[t * 3 + 1]; corner[t * 3 + 1] = corner[t * 3 + 2]; corner[t * 3 + 2] = c;
    }
    soup.rayBvh = null;
    return flipped;
}

// triangles grouped per part (counting sort), built once after the orientation
function partIndex(soup, parts) {
    if (soup.partStart) return;
    const start = new Int32Array(parts + 1);
    for (let t = 0; t < soup.n; t++) if (soup.partOf[t] >= 0) start[soup.partOf[t] + 1]++;
    for (let p = 0; p < parts; p++) start[p + 1] += start[p];
    const order = new Int32Array(start[parts]), fill = start.slice(0, parts);
    for (let t = 0; t < soup.n; t++) if (soup.partOf[t] >= 0) order[fill[soup.partOf[t]]++] = t;
    soup.partStart = start;
    soup.partOrder = order;
    soup.localVertex = new Int32Array(soup.vCount).fill(-1);   // scratch: soup vertex → vertex of the current part
}

// vertices of one part in the order of first use; soup.localVertex holds their numbers until resetLocal
function partVertices(soup, p) {
    const { partStart: start, partOrder: order, corner, localVertex: local, P } = soup;
    const list = new Int32Array((start[p + 1] - start[p]) * 3);   // typed: a part can have millions of vertices
    let nv = 0;
    for (let j = start[p]; j < start[p + 1]; j++) {
        const t = order[j];
        for (let k = 0; k < 3; k++) {
            const v = corner[t * 3 + k];
            if (local[v] < 0) { local[v] = nv; list[nv++] = t * 3 + k; }
        }
    }
    const X = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { const c = list[i]; X[i * 3] = P[c * 3]; X[i * 3 + 1] = P[c * 3 + 1]; X[i * 3 + 2] = P[c * 3 + 2]; }
    return { X, corners: list.subarray(0, nv) };
}
function resetLocal(soup, corners) { for (const c of corners) soup.localVertex[soup.corner[c]] = -1; }

/**
 * Fingerprints of parts (after the orientation) for the copy search – invariant under rotation and translation:
 * triangles, vertices, colour signature, area, Σ squared vertex distances to their centroid, extent (largest distance).
 * Returns { tris, verts, sig (Uint32), area, spread, radius (Float64) } per requested part.
 */
export function fingerprints(soup, parts, partCount) {
    partIndex(soup, partCount);
    const m = parts.length;
    const out = { tris: new Int32Array(m), verts: new Int32Array(m), sig: new Uint32Array(m), area: new Float64Array(m), spread: new Float64Array(m), radius: new Float64Array(m) };
    const { P, codes, partStart: start, partOrder: order } = soup;
    parts.forEach((p, i) => {
        const { X, corners } = partVertices(soup, p);
        resetLocal(soup, corners);
        const nv = X.length / 3;
        let cx = 0, cy = 0, cz = 0;
        for (let v = 0; v < nv; v++) { cx += X[v * 3]; cy += X[v * 3 + 1]; cz += X[v * 3 + 2]; }
        cx /= nv; cy /= nv; cz /= nv;
        let spread = 0, radius = 0;
        for (let v = 0; v < nv; v++) {
            const d = (X[v * 3] - cx) ** 2 + (X[v * 3 + 1] - cy) ** 2 + (X[v * 3 + 2] - cz) ** 2;
            spread += d;
            if (d > radius) radius = d;
        }
        let A = 0, sig = 0x811C9DC5;
        const colorCounts = new Map();
        for (let j = start[p]; j < start[p + 1]; j++) {
            const t = order[j], o = t * 9;
            const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
            A += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
            colorCounts.set(codes[t], (colorCounts.get(codes[t]) || 0) + 1);
        }
        for (const [c, k] of [...colorCounts].sort((a, b) => a[0] - b[0])) sig = Math.imul(Math.imul(sig ^ c, 0x01000193) ^ k, 0x01000193);
        out.tris[i] = start[p + 1] - start[p];
        out.verts[i] = nv;
        out.sig[i] = sig >>> 0;
        out.area[i] = A;
        out.spread[i] = spread;
        out.radius[i] = Math.sqrt(radius);
    });
    return out;
}

/**
 * What another worker needs to prove a copy of this part: vertices (matchBrep), per triangle centre, unit normal and
 * colour code.
 */
export function proofData(soup, p) {
    const { X, corners } = partVertices(soup, p);
    resetLocal(soup, corners);
    const { P, codes, partStart: start, partOrder: order } = soup;
    const m = start[p + 1] - start[p];
    const centre = new Float64Array(m * 3), normal = new Float32Array(m * 3), code = new Uint16Array(m);
    for (let j = 0; j < m; j++) {
        const t = order[start[p] + j], o = t * 9;
        for (let k = 0; k < 3; k++) centre[j * 3 + k] = (P[o + k] + P[o + 3 + k] + P[o + 6 + k]) / 3;
        const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
        normal[j * 3] = nx / l; normal[j * 3 + 1] = ny / l; normal[j * 3 + 2] = nz / l;
        code[j] = codes[t];
    }
    return { points: X, centre, normal, code };
}

/**
 * Is part p of this soup a copy of the part described by A (proofData of another part)? matchBrep on the vertices
 * (proper rotation, every vertex within tol), then every triangle of A must have one in p with the same centre (within
 * tol), normal (the same side) and colour. Returns { R, cA, cB } (x_p = R · (x_A − cA) + cB) or null.
 */
export function proveCopy(A, soup, p, tol) {
    const B = proofData(soup, p);
    if (B.code.length !== A.code.length) return null;
    const m = A.code.length, r = 2 * tol, r2 = r * r;
    let grid = null, order = null;
    const q = [0, 0, 0];
    const trianglesMatch = (R, cA, cB) => {
        if (!grid) {
            grid = new PointGrid(B.centre, 4 * tol);
            order = new Int32Array(m);   // A's triangles in a scattered order: a wrong rotation fails after a few
            for (let j = 0, k = 0, step = scatter(m); j < m; j++, k = (k + step) % m) order[j] = k;
        }
        let nx, ny, nz, cj;
        const fits = i => {
            const dx = B.centre[i * 3] - q[0], dy = B.centre[i * 3 + 1] - q[1], dz = B.centre[i * 3 + 2] - q[2];
            return dx * dx + dy * dy + dz * dz <= r2 && B.code[i] === cj && nx * B.normal[i * 3] + ny * B.normal[i * 3 + 1] + nz * B.normal[i * 3 + 2] > 0.9;
        };
        for (let jj = 0; jj < m; jj++) {
            const j = order[jj];
            const x = A.centre[j * 3] - cA[0], y = A.centre[j * 3 + 1] - cA[1], z = A.centre[j * 3 + 2] - cA[2];
            q[0] = R[0] * x + R[1] * y + R[2] * z + cB[0];
            q[1] = R[3] * x + R[4] * y + R[5] * z + cB[1];
            q[2] = R[6] * x + R[7] * y + R[8] * z + cB[2];
            const ax = A.normal[j * 3], ay = A.normal[j * 3 + 1], az = A.normal[j * 3 + 2];
            nx = R[0] * ax + R[1] * ay + R[2] * az; ny = R[3] * ax + R[4] * ay + R[5] * az; nz = R[6] * ax + R[7] * ay + R[8] * az;
            cj = A.code[j];
            if (!grid.near(q, r, fits)) return false;
        }
        return true;
    };
    // a symmetric part maps its vertices onto themselves under several rotations – the triangles decide (next one if not)
    const match = matchBrep({ points: A.points, faces: [] }, { points: B.points, faces: [] }, tol, null, trianglesMatch);
    return match ? { R: Array.from(match.R), cA: match.cA, cB: match.cB } : null;
}

// a step coprime to n, roughly n × golden ratio – visits all indices in a scattered order
function scatter(n) {
    let s = Math.max(1, Math.round(n * 0.618034));
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    while (gcd(s, n) !== 1) s++;
    return s % n || 1;
}

/**
 * Geometries of one part, one per colour code (ascending): crease normals over the whole part (30°), vertices shared
 * per (position, normal), box UVs (mm), with bvh: BVH (SAH) + tangents as the 'bvh' job of the STEP worker.
 * Returns [{ code, positions, normals, uvs, index, tangents, roots }].
 */
export function partGeometries(soup, p, { bvh = false } = {}) {
    const { X, corners } = partVertices(soup, p);
    const { partStart: start, partOrder: order, corner, localVertex: local, codes } = soup;
    const m = start[p + 1] - start[p];
    const positions = Float32Array.from(X);
    const index = new Uint32Array(m * 3);
    for (let j = 0; j < m; j++) { const t = order[start[p] + j]; for (let k = 0; k < 3; k++) index[j * 3 + k] = local[corner[t * 3 + k]]; }
    resetLocal(soup, corners);
    const cn = creaseCornerNormals(positions, index);
    const nbits = new Uint32Array(cn.buffer);
    // colour groups in ascending code order (counting sort – typed arrays only, a part can be the whole file)
    const counts = new Map();
    for (let j = 0; j < m; j++) { const c = codes[order[start[p] + j]]; counts.set(c, (counts.get(c) || 0) + 1); }
    const groups = [...counts.keys()].sort((a, b) => a - b), offset = new Map();
    let at = 0;
    for (const c of groups) { offset.set(c, at); at += counts.get(c); }
    const byCode = new Int32Array(m);
    for (let j = 0; j < m; j++) { const c = codes[order[start[p] + j]]; const o = offset.get(c); byCode[o] = j; offset.set(c, o + 1); }
    const nv = positions.length / 3;
    const head = new Int32Array(nv).fill(-1);
    const out = [];
    at = 0;
    for (const code of groups) {
        const tris = byCode.subarray(at, at += counts.get(code));
        // vertex per (part vertex, normal): list per part vertex of the emitted ones
        const max = tris.length * 3;
        const src = new Int32Array(max), next = new Int32Array(max), nrm = new Uint32Array(max * 3);
        const idx = new Uint32Array(max);
        let count = 0, w = 0;
        for (const j of tris) {
            for (let k = 0; k < 3; k++) {
                const i = j * 3 + k, v = index[i];
                let o = head[v];
                for (; o >= 0; o = next[o]) if (nrm[o * 3] === nbits[i * 3] && nrm[o * 3 + 1] === nbits[i * 3 + 1] && nrm[o * 3 + 2] === nbits[i * 3 + 2]) break;
                if (o < 0) {
                    o = count++;
                    src[o] = v;
                    nrm[o * 3] = nbits[i * 3]; nrm[o * 3 + 1] = nbits[i * 3 + 1]; nrm[o * 3 + 2] = nbits[i * 3 + 2];
                    next[o] = head[v];
                    head[v] = o;
                }
                idx[w++] = o;
            }
        }
        for (let o = 0; o < count; o++) head[src[o]] = -1;
        const pos = new Float32Array(count * 3), nor = new Float32Array(nrm.buffer.slice(0, count * 12));
        for (let o = 0; o < count; o++) { const v = src[o]; pos[o * 3] = positions[v * 3]; pos[o * 3 + 1] = positions[v * 3 + 1]; pos[o * 3 + 2] = positions[v * 3 + 2]; }
        const g = boxProject({ positions: pos, normals: nor, index: idx }, UV_TILE);
        const r = { code, positions: g.positions, normals: g.normals, uvs: g.uvs, index: g.index, tangents: null, roots: null };
        if (bvh) Object.assign(r, buildBvh(r));
        out.push(r);
    }
    return out;
}

/** BVH (SAH, reordered index) + tangents – the same as the STEP worker's 'bvh' job */
export function buildBvh({ positions, index, normals, uvs }) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const bvh = new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5 });
    const { roots } = MeshBVH.serialize(bvh, { cloneBuffers: false });
    let tangents = null;
    if (normals && uvs) {
        geometry.setAttribute('normal', new BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
        geometry.computeTangents();
        tangents = geometry.getAttribute('tangent').array;
    }
    return { roots, tangents, index: geometry.index.array };
}
