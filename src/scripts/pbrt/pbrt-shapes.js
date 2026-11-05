// pbrt-v4 shapes → triangle geometry in the shape's own space (worker side, no three.js):
//   plymesh (PLY ascii / binary, polygons as fans), trianglemesh, bilinearmesh (flat patches as two triangles, curved
//   ones as a grid), loopsubdiv (Loop subdivision, own implementation of the published rules), sphere, disk, cylinder.
//   curves (hair, fur – batches of the parser): straight pieces with a radius (curves/curve-build.js), not triangles.
// Orientation like pbrt: the surface faces along the right-handed winding normal or the file's normals;
// ReverseOrientation flips both (index order and normals) – emitters shine on that side, glass is entered from it.
// Meshes without normals get crease normals (30°, shared with the other importers) with vertices split at hard edges.
import { creaseCornerNormals } from '../crease-normals.js';
import { buildCurves } from '../curves/curve-build.js';

const f32 = v => (v instanceof Float32Array ? v : Float32Array.from(v));

/**
 * Geometry of one shape: { positions, normals, uvs, index } (Float32Array / Uint32Array) or null (nothing to build);
 * warn(text) collects what was left out.
 */
export function buildShape(shape, plyBytes, warn) {
    const p = shape.params;
    const num = (name, def) => (p[name]?.v?.length && typeof p[name].v[0] === 'number' ? p[name].v[0] : def);
    let g = null;
    switch (shape.type) {
        case 'plymesh':
            if (!plyBytes) return null;
            g = readPly(plyBytes, warn);
            if (p.displacement) warn('plymesh displacement left out');
            break;
        case 'trianglemesh': {
            const P = p.P?.v;
            if (!P?.length) return null;
            let index = p.indices?.v;
            if (!index?.length) { if (P.length === 9) index = [0, 1, 2]; else return null; }
            g = { positions: f32(P), normals: p.N?.v?.length === P.length ? f32(p.N.v) : null, uvs: uvsOf(p, P.length / 3), index: Uint32Array.from(index) };
            break;
        }
        case 'bilinearmesh': g = bilinear(p); break;
        case 'loopsubdiv': {
            const P = p.P?.v, index = p.indices?.v;
            if (!P?.length || !index?.length) return null;
            g = loopSubdivide(P, index, Math.min(Math.max(Math.round(num('levels', 3)), 0), 6));
            break;
        }
        case 'sphere': g = sphere(num('radius', 1), num('zmin', -num('radius', 1)), num('zmax', num('radius', 1)), num('phimax', 360)); break;
        case 'disk': g = disk(num('height', 0), num('radius', 1), num('innerradius', 0), num('phimax', 360)); break;
        case 'cylinder': g = cylinder(num('radius', 1), num('zmin', -1), num('zmax', 1), num('phimax', 360)); break;
        case 'curves': {
            // hair/fur batch (pbrt-parse.js): straight pieces with a radius – the path tracer tests them as cylinders
            const c = buildCurves(shape.curves, shape.curveThinning || {});
            return c.pieces ? { positions: c.positions, normals: c.normals, tangents: c.tangents, uvs: c.uvs, index: c.index, curves: { pieces: c.pieces, maxRadius: c.maxRadius } } : null;
        }
        default: warn(`shape ${shape.type} left out`); return null;
    }
    if (!g || !g.index.length) return null;
    dropBadIndices(g);
    if (!g.normals) g = withCreaseNormals(g);
    if (shape.reverse) {
        for (let i = 0; i < g.index.length; i += 3) { const t = g.index[i + 1]; g.index[i + 1] = g.index[i + 2]; g.index[i + 2] = t; }
        for (let i = 0; i < g.normals.length; i++) g.normals[i] = -g.normals[i];
    }
    return g;
}

function uvsOf(p, n) {
    const uv = p.uv?.v || p.st?.v;
    return uv?.length === n * 2 ? f32(uv) : null;
}

function dropBadIndices(g) {
    const nv = g.positions.length / 3;
    let bad = false;
    for (let i = 0; i < g.index.length; i++) if (g.index[i] >= nv) { bad = true; break; }
    if (!bad) return;
    const out = [];
    for (let i = 0; i < g.index.length; i += 3) {
        if (g.index[i] < nv && g.index[i + 1] < nv && g.index[i + 2] < nv) out.push(g.index[i], g.index[i + 1], g.index[i + 2]);
    }
    g.index = Uint32Array.from(out);
}

// corner normals by crease angle; a vertex whose corners differ is split (hard edge)
function withCreaseNormals(g) {
    const { positions, uvs, index } = g;
    const corners = creaseCornerNormals(positions, index);
    const nv = positions.length / 3;
    const first = new Int32Array(nv).fill(-1);   // vertex → first output vertex
    const nextOf = [];                             // output vertex → next output vertex of the same source (-1)
    const src = [];
    const N = [];
    const outIndex = new Uint32Array(index.length);
    for (let i = 0; i < index.length; i++) {
        const v = index[i];
        const nx = corners[3 * i], ny = corners[3 * i + 1], nz = corners[3 * i + 2];
        let o = first[v], last = -1;
        while (o >= 0) {
            if (N[3 * o] * nx + N[3 * o + 1] * ny + N[3 * o + 2] * nz > 0.9999) break;
            last = o;
            o = nextOf[o];
        }
        if (o < 0) {
            o = src.length;
            src.push(v);
            nextOf.push(-1);
            N.push(nx, ny, nz);
            if (last >= 0) nextOf[last] = o; else first[v] = o;
        }
        outIndex[i] = o;
    }
    const n = src.length;
    const P = new Float32Array(n * 3), NN = Float32Array.from(N), UV = uvs ? new Float32Array(n * 2) : null;
    for (let o = 0; o < n; o++) {
        const v = src[o];
        P[3 * o] = positions[3 * v]; P[3 * o + 1] = positions[3 * v + 1]; P[3 * o + 2] = positions[3 * v + 2];
        if (UV) { UV[2 * o] = uvs[2 * v]; UV[2 * o + 1] = uvs[2 * v + 1]; }
    }
    return { positions: P, normals: NN, uvs: UV, index: outIndex };
}

function smoothNormals(positions, index) {
    const n = new Float32Array(positions.length);
    for (let i = 0; i < index.length; i += 3) {
        const a = 3 * index[i], b = 3 * index[i + 1], c = 3 * index[i + 2];
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;   // area weighted
        for (const k of [a, b, c]) { n[k] += x; n[k + 1] += y; n[k + 2] += z; }
    }
    for (let k = 0; k < n.length; k += 3) {
        const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
        n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return n;
}

// --- PLY ---

const PLY_TYPES = {
    char: [1, 'getInt8'], int8: [1, 'getInt8'], uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
    short: [2, 'getInt16'], int16: [2, 'getInt16'], ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
    int: [4, 'getInt32'], int32: [4, 'getInt32'], uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
    float: [4, 'getFloat32'], float32: [4, 'getFloat32'], double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};

/** PLY mesh → { positions, normals (or null), uvs (or null), index } – polygons as fans */
export function readPly(bytes, warn = () => {}) {
    // header up to "end_header" + line break
    let end = -1;
    const limit = Math.min(bytes.length, 1 << 16);
    for (let i = 0; i < limit - 10; i++) {
        if (bytes[i] === 101 && bytes[i + 1] === 110 && bytes[i + 2] === 100 && bytes[i + 3] === 95 && String.fromCharCode(...bytes.subarray(i, i + 10)) === 'end_header') {
            end = i + 10;
            while (end < bytes.length && bytes[end] !== 10) end++;
            end++;
            break;
        }
    }
    if (end < 0) throw new Error('PLY header missing');
    const header = String.fromCharCode(...bytes.subarray(0, end)).split(/\r?\n/);
    if (header[0].trim() !== 'ply') throw new Error('not a PLY file');
    let format = 'ascii';
    const elements = [];
    for (const line of header) {
        const w = line.trim().split(/\s+/);
        if (w[0] === 'format') format = w[1];
        else if (w[0] === 'element') elements.push({ name: w[1], count: +w[2], props: [] });
        else if (w[0] === 'property' && elements.length) {
            const el = elements[elements.length - 1];
            if (w[1] === 'list') el.props.push({ list: true, countType: w[2], type: w[3], name: w[4] });
            else el.props.push({ type: w[1], name: w[2] });
        }
    }
    const vertexEl = elements.find(e => e.name === 'vertex');
    if (!vertexEl) throw new Error('PLY without vertices');
    const nv = vertexEl.count;
    const col = name => vertexEl.props.findIndex(pr => pr.name === name);
    const ix = col('x'), iy = col('y'), iz = col('z');
    const inx = col('nx'), iny = col('ny'), inz = col('nz');
    let iu = col('u'), ivv = col('v');
    if (iu < 0) { iu = col('s'); ivv = col('t'); }
    if (iu < 0) { iu = col('texture_u'); ivv = col('texture_v'); }
    if (iu < 0) { iu = col('texture_s'); ivv = col('texture_t'); }
    const positions = new Float32Array(nv * 3);
    const normals = inx >= 0 && iny >= 0 && inz >= 0 ? new Float32Array(nv * 3) : null;
    const uvs = iu >= 0 && ivv >= 0 ? new Float32Array(nv * 2) : null;
    const tris = [];
    let faces = 0, polygons = 0;
    const row = new Float64Array(vertexEl.props.length);
    const takeVertex = k => {
        positions[3 * k] = row[ix]; positions[3 * k + 1] = row[iy]; positions[3 * k + 2] = row[iz];
        if (normals) { normals[3 * k] = row[inx]; normals[3 * k + 1] = row[iny]; normals[3 * k + 2] = row[inz]; }
        if (uvs) { uvs[2 * k] = row[iu]; uvs[2 * k + 1] = row[ivv]; }
    };
    const takeFace = list => {
        faces++;
        if (list.length > 3) polygons++;
        for (let j = 1; j + 1 < list.length; j++) tris.push(list[0], list[j], list[j + 1]);
    };
    if (format === 'ascii') {
        const text = new TextDecoder().decode(bytes.subarray(end));
        const tok = text.split(/\s+/).filter(Boolean);
        let t = 0;
        for (const el of elements) {
            for (let k = 0; k < el.count; k++) {
                if (el === vertexEl) {
                    for (let j = 0; j < el.props.length; j++) {
                        const pr = el.props[j];
                        if (pr.list) { const c = +tok[t++]; t += c; row[j] = 0; } else row[j] = +tok[t++];
                    }
                    takeVertex(k);
                } else {
                    for (const pr of el.props) {
                        if (pr.list) {
                            const c = +tok[t++];
                            const list = tok.slice(t, t + c).map(Number);
                            t += c;
                            if (el.name === 'face' && (pr.name === 'vertex_indices' || pr.name === 'vertex_index')) takeFace(list);
                        } else t++;
                    }
                }
            }
        }
    } else {
        const little = format === 'binary_little_endian';
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let o = end;
        for (const el of elements) {
            const fixed = el.props.every(pr => !pr.list);
            if (el === vertexEl && fixed) {
                const readers = el.props.map(pr => PLY_TYPES[pr.type]);
                if (readers.some(r => !r)) throw new Error('PLY property type not supported');
                for (let k = 0; k < el.count; k++) {
                    for (let j = 0; j < readers.length; j++) { row[j] = dv[readers[j][1]](o, little); o += readers[j][0]; }
                    takeVertex(k);
                }
                continue;
            }
            for (let k = 0; k < el.count; k++) {
                for (let j = 0; j < el.props.length; j++) {
                    const pr = el.props[j];
                    if (pr.list) {
                        const [cs, cm] = PLY_TYPES[pr.countType];
                        const [s, m] = PLY_TYPES[pr.type];
                        const c = dv[cm](o, little); o += cs;
                        if (el.name === 'face' && (pr.name === 'vertex_indices' || pr.name === 'vertex_index')) {
                            if (c === 3) { tris.push(dv[m](o, little), dv[m](o + s, little), dv[m](o + 2 * s, little)); faces++; } else {
                                const list = new Array(c);
                                for (let q = 0; q < c; q++) list[q] = dv[m](o + q * s, little);
                                takeFace(list);
                            }
                        }
                        o += c * s;
                    } else {
                        const [s, m] = PLY_TYPES[pr.type];
                        if (el === vertexEl) row[j] = dv[m](o, little);
                        o += s;
                    }
                }
                if (el === vertexEl) takeVertex(k);
            }
        }
    }
    void faces;
    if (polygons) warn('PLY polygons split into triangles');
    return { positions, normals, uvs, index: Uint32Array.from(tris) };
}

// --- bilinear patches ---

function bilinear(p) {
    const P = p.P?.v;
    if (!P?.length) return null;
    const nv = P.length / 3;
    let index = p.indices?.v;
    if (!index?.length) { if (nv === 4) index = [0, 1, 2, 3]; else return null; }
    const uv = p.uv?.v?.length === nv * 2 ? p.uv.v : null;
    const N = p.N?.v?.length === nv * 3 ? p.N.v : null;
    const pos = [], nor = [], uvs = [], tri = [];
    const at = (i, k) => P[3 * i + k];
    for (let q = 0; q + 3 < index.length; q += 4) {
        const [i00, i10, i01, i11] = [index[q], index[q + 1], index[q + 2], index[q + 3]];
        // flat: p11 in the plane of the other three → two triangles, otherwise a grid over the bilinear surface
        const e1 = [0, 1, 2].map(k => at(i10, k) - at(i00, k)), e2 = [0, 1, 2].map(k => at(i01, k) - at(i00, k));
        const e3 = [0, 1, 2].map(k => at(i11, k) - at(i00, k));
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(...n) || 1;
        const off = Math.abs((e3[0] * n[0] + e3[1] * n[1] + e3[2] * n[2]) / nl);
        const size = Math.max(Math.hypot(...e1), Math.hypot(...e2), 1e-30);
        const steps = off < 1e-4 * size ? 1 : 8;
        const base = pos.length / 3;
        for (let j = 0; j <= steps; j++) {
            for (let i = 0; i <= steps; i++) {
                const u = i / steps, v = j / steps;
                const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
                const ids = [i00, i10, i01, i11];
                for (let k = 0; k < 3; k++) pos.push(ids.reduce((a, id, m) => a + w[m] * P[3 * id + k], 0));
                if (N) {
                    const nn = [0, 1, 2].map(k => ids.reduce((a, id, m) => a + w[m] * N[3 * id + k], 0));
                    const l = Math.hypot(...nn) || 1;
                    nor.push(nn[0] / l, nn[1] / l, nn[2] / l);
                }
                if (uv) uvs.push(ids.reduce((a, id, m) => a + w[m] * uv[2 * id], 0), ids.reduce((a, id, m) => a + w[m] * uv[2 * id + 1], 0));
                else uvs.push(u, v);
            }
        }
        for (let j = 0; j < steps; j++) {
            for (let i = 0; i < steps; i++) {
                const a = base + j * (steps + 1) + i, b = a + 1, c = a + steps + 1, d = c + 1;
                tri.push(a, b, d, a, d, c);   // normal = (p10 − p00) × (p01 − p00), as pbrt's patch
            }
        }
    }
    return { positions: Float32Array.from(pos), normals: N ? Float32Array.from(nor) : null, uvs: Float32Array.from(uvs), index: Uint32Array.from(tri) };
}

// --- quadrics (tessellated) ---

function grid(rows, cols, point) {
    const pos = new Float32Array((rows + 1) * (cols + 1) * 3), nor = new Float32Array(pos.length), uvs = new Float32Array((rows + 1) * (cols + 1) * 2);
    let k = 0;
    for (let i = 0; i <= rows; i++) {
        for (let j = 0; j <= cols; j++, k++) {
            const { p, n, uv } = point(i / rows, j / cols);
            pos.set(p, 3 * k); nor.set(n, 3 * k); uvs.set(uv, 2 * k);
        }
    }
    const index = new Uint32Array(rows * cols * 6);
    let t = 0;
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const a = i * (cols + 1) + j, b = a + 1, d = a + cols + 1, c = d + 1;
            index.set([a, b, c, a, c, d], t);
            t += 6;
        }
    }
    return { positions: pos, normals: nor, uvs, index };
}
const segments = phimax => Math.max(4, Math.ceil(96 * Math.min(Math.abs(phimax), 360) / 360));

function sphere(r, zmin, zmax, phimax) {
    r = Math.abs(r) || 1;
    const z0 = Math.max(Math.min(zmin, zmax), -r), z1 = Math.min(Math.max(zmin, zmax), r);
    const t0 = Math.acos(Math.min(Math.max(z0 / r, -1), 1)), t1 = Math.acos(Math.min(Math.max(z1 / r, -1), 1));
    const phi = Math.min(Math.max(phimax, 0), 360) * Math.PI / 180;
    // rows along z (θ from t0 down to t1), columns along φ – outward normal = ∂p/∂φ × ∂p/∂z
    return grid(Math.max(4, Math.ceil(48 * (t0 - t1) / Math.PI)), segments(phimax), (v, u) => {
        const th = t0 + (t1 - t0) * v, ph = phi * u;
        const s = Math.sin(th), c = Math.cos(th);
        const n = [s * Math.cos(ph), s * Math.sin(ph), c];
        return { p: [r * n[0], r * n[1], r * n[2]], n, uv: [u, v] };
    });
}
function cylinder(r, zmin, zmax, phimax) {
    const z0 = Math.min(zmin, zmax), z1 = Math.max(zmin, zmax);
    const phi = Math.min(Math.max(phimax, 0), 360) * Math.PI / 180;
    return grid(1, segments(phimax), (v, u) => {
        const ph = phi * u;
        const n = [Math.cos(ph), Math.sin(ph), 0];
        return { p: [r * n[0], r * n[1], z0 + (z1 - z0) * v], n, uv: [u, v] };
    });
}
function disk(h, r, ri, phimax) {
    const phi = Math.min(Math.max(phimax, 0), 360) * Math.PI / 180;
    // rows from the outer radius inwards, columns along φ – normal +z (∂p/∂φ × inward radius, as pbrt)
    const g = grid(1, segments(phimax), (v, u) => {
        const rho = r + (ri - r) * v, ph = phi * u;
        return { p: [rho * Math.cos(ph), rho * Math.sin(ph), h], n: [0, 0, 1], uv: [u, v] };
    });
    // rows: outer → inner; a, b along φ at the outer ring – (b − a) × (d − a) points +z as long as ri < r
    if (ri > r) for (let i = 0; i < g.index.length; i += 3) { const t = g.index[i + 1]; g.index[i + 1] = g.index[i + 2]; g.index[i + 2] = t; }
    return g;
}

// --- Loop subdivision (Loop 1987; vertex weights β = 3/16 for valence 3, 3/(8n) otherwise; boundaries as curves) ---

export function loopSubdivide(P, index, levels) {
    let pos = Float64Array.from(P);
    let tri = Uint32Array.from(index);
    for (let level = 0; level < levels; level++) {
        const nv = pos.length / 3, nt = tri.length / 3;
        const edgeOf = new Map();
        const ea = [], eb = [], eo1 = [], eo2 = [], ecount = [];
        const triEdge = new Int32Array(nt * 3);
        for (let t = 0; t < nt; t++) {
            for (let k = 0; k < 3; k++) {
                const a = tri[3 * t + k], b = tri[3 * t + (k + 1) % 3], c = tri[3 * t + (k + 2) % 3];
                const key = a < b ? a * nv + b : b * nv + a;
                let e = edgeOf.get(key);
                if (e === undefined) {
                    e = ea.length;
                    edgeOf.set(key, e);
                    ea.push(a); eb.push(b); eo1.push(c); eo2.push(-1); ecount.push(1);
                } else {
                    if (ecount[e] === 1) eo2[e] = c;
                    ecount[e]++;
                }
                triEdge[3 * t + k] = e;
            }
        }
        const ne = ea.length;
        const sum = new Float64Array(nv * 3), valence = new Uint32Array(nv);
        const bsum = new Float64Array(nv * 3), bcount = new Uint32Array(nv);
        for (let e = 0; e < ne; e++) {
            const a = ea[e], b = eb[e];
            for (let k = 0; k < 3; k++) { sum[3 * a + k] += pos[3 * b + k]; sum[3 * b + k] += pos[3 * a + k]; }
            valence[a]++; valence[b]++;
            if (ecount[e] !== 2) {
                for (let k = 0; k < 3; k++) { bsum[3 * a + k] += pos[3 * b + k]; bsum[3 * b + k] += pos[3 * a + k]; }
                bcount[a]++; bcount[b]++;
            }
        }
        const out = new Float64Array((nv + ne) * 3);
        for (let v = 0; v < nv; v++) {
            for (let k = 0; k < 3; k++) {
                const x = pos[3 * v + k];
                if (bcount[v] === 2) out[3 * v + k] = 0.75 * x + 0.125 * bsum[3 * v + k];
                else if (bcount[v] > 0 || valence[v] < 3) out[3 * v + k] = x;   // corner / non-manifold: kept
                else {
                    const n = valence[v], beta = n === 3 ? 3 / 16 : 3 / (8 * n);
                    out[3 * v + k] = (1 - n * beta) * x + beta * sum[3 * v + k];
                }
            }
        }
        for (let e = 0; e < ne; e++) {
            const a = ea[e], b = eb[e], o = 3 * (nv + e);
            for (let k = 0; k < 3; k++) {
                out[o + k] = ecount[e] === 2
                    ? 0.375 * (pos[3 * a + k] + pos[3 * b + k]) + 0.125 * (pos[3 * eo1[e] + k] + pos[3 * eo2[e] + k])
                    : 0.5 * (pos[3 * a + k] + pos[3 * b + k]);
            }
        }
        const next = new Uint32Array(nt * 12);
        for (let t = 0; t < nt; t++) {
            const v0 = tri[3 * t], v1 = tri[3 * t + 1], v2 = tri[3 * t + 2];
            const e0 = nv + triEdge[3 * t], e1 = nv + triEdge[3 * t + 1], e2 = nv + triEdge[3 * t + 2];   // v0v1, v1v2, v2v0
            next.set([v0, e0, e2, v1, e1, e0, v2, e2, e1, e0, e1, e2], 12 * t);
        }
        pos = out;
        tri = next;
    }
    const positions = Float32Array.from(pos);
    return { positions, normals: smoothNormals(positions, tri), uvs: null, index: tri };
}

// --- emitters that are real area lights ---

/**
 * A flat rectangle (two triangles or one patch over four corners) or a full disc in the shape's space:
 * { kind: 'rect', center, u, v (half edges), normal } | { kind: 'disc', center, u, v (radius vectors), normal } | null.
 * normal: the side it emits to (the file's normals, else the winding; ReverseOrientation already applied by buildShape).
 */
export function emitterShape(shape, g) {
    if (shape.type === 'disk') {
        const p = shape.params;
        const num = (name, def) => (p[name]?.v?.length ? p[name].v[0] : def);
        if (num('innerradius', 0) > 0 || num('phimax', 360) < 360) return null;
        const r = num('radius', 1), h = num('height', 0);
        return { kind: 'disc', center: [0, 0, h], u: [r, 0, 0], v: [0, r, 0], normal: [0, 0, shape.reverse ? -1 : 1] };
    }
    if (!['trianglemesh', 'plymesh', 'bilinearmesh'].includes(shape.type) || !g) return null;
    const { positions: P, index } = g;
    // unique corner positions (exporters often write the quad's corners twice)
    const corners = [];
    for (let i = 0; i < P.length / 3; i++) {
        const p = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
        if (!corners.some(c => Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-6 * (1 + Math.hypot(...p)))) corners.push(p);
        if (corners.length > 4) return null;
    }
    if (corners.length !== 4 || index.length !== 6) return null;
    const center = [0, 1, 2].map(k => corners.reduce((a, c) => a + c[k], 0) / 4);
    // the diagonal pair: the corner farthest from corner 0 is opposite; the other two span the edges
    const d = corners.map(c => Math.hypot(c[0] - corners[0][0], c[1] - corners[0][1], c[2] - corners[0][2]));
    const far = d.indexOf(Math.max(...d));
    const [s1, s2] = [1, 2, 3].filter(i => i !== far);
    const e1 = [0, 1, 2].map(k => corners[s1][k] - corners[0][k]), e2 = [0, 1, 2].map(k => corners[s2][k] - corners[0][k]);
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (!(l1 > 0 && l2 > 0)) return null;
    // a rectangle: right angle and the fourth corner where it belongs
    const dot = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (l1 * l2);
    const fourth = [0, 1, 2].map(k => corners[0][k] + e1[k] + e2[k]);
    if (Math.abs(dot) > 1e-3 || Math.hypot(...[0, 1, 2].map(k => fourth[k] - corners[far][k])) > 1e-3 * Math.max(l1, l2)) return null;
    let normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    // facing: the vertex normals if any, else the first triangle's winding
    const ref = g.normals ? [g.normals[0], g.normals[1], g.normals[2]] : triNormal(P, index);
    if (normal[0] * ref[0] + normal[1] * ref[1] + normal[2] * ref[2] < 0) normal = normal.map(x => -x);
    const nl = Math.hypot(...normal);
    return { kind: 'rect', center, u: e1.map(x => x / 2), v: e2.map(x => x / 2), normal: normal.map(x => x / nl) };
}
function triNormal(P, index) {
    const a = 3 * index[0], b = 3 * index[1], c = 3 * index[2];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
