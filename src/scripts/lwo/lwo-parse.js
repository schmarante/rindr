// LWO object reader (.lwo, LWO2; own implementation after the published format description of the modeller's
// SDK). An IFF container: "FORM" u32 size "LWO2", then chunks (ID4, u32 size, body, padded
// to an even length); inside SURF/CLIP/BLOK sub-chunks with u16 sizes. All numbers big-endian.
//
//   TAGS  string list – polygon tags (PTAG SURF) index it, SURF chunks name the surfaces after it
//   LAYR  u16 number, u16 flags (bit 0 hidden), vec pivot, name, [u16 parent number]; starts a layer – the chunks
//         up to the next LAYR belong to it
//   PNTS  vec12 per point (object coordinates – layers are not transformed, the pivot only for rotating)
//   VMAP  ID4 type, u16 dim, name, then (vx point, f32[dim]) – TXUV (dim 2) = UV map, NORM (dim 3) = vertex normals
//   VMAD  the same per polygon corner: (vx point, vx polygon, f32[dim]) – UV seams; wins over the VMAP
//   POLS  ID4 type (FACE, PTCH/SUBD = subdivision patches; CURV, MBAL, BONE skipped), then per polygon u16
//         (count in the low 10 bits, flags above) and vx points; vertices run clockwise seen from the front
//   PTAG  ID4 type, (vx polygon, u16 tag) – SURF assigns the surface; PTAG and VMAD count the polygons of the last POLS
//   CLIP  u32 index, STIL file name / ISEQ image sequence (first image) / XREF another clip
//   SURF  name, source, sub-chunks: COLR vec12, DIFF LUMI SPEC REFL TRAN TRNL GLOS RIND BUMP RBLR CLRH f32, SIDE u16
//         (3 = both sides), SMAN smoothing angle (rad; 0 = flat), BLOK texture layers (IMAP image: CHAN channel, ENAB,
//         PROJ 5 = UV map named by VMAP, IMAG clip, WRAP, TAMP bump amplitude)
//   vx = variable-length index: u16, or u32 & 0xFFFFFF when the first byte is 0xFF
//
// LWO is left-handed with Y up in metres: z is mirrored (→ right-handed) and each triangle's order reversed (the
// front is where the normal of the corner order points before mirroring – checked on closed meshes: positive volume).
// Subdivision patches are refined Catmull–Clark like the modeller's default
// (subdivide.js, 3 levels, fewer when all patches of the file would exceed SUBDIV_FACES). Normals: the surface's smoothing angle
// between neighbouring polygons of the same surface (the modeller's rule: each polygon against the one being shaded), or
// the file's vertex normals (NORM).
import { triangulate } from '../polygon-triangulate.js';
import { subdivideCorners } from '../subdivide.js';

const PATCH_LEVEL = 3;        // the modeller's default patch divisions
const SUBDIV_FACES = 2e6;     // faces of all patches after refining at most (the level is lowered until it fits)

/** 'LWO2' | 'LWO3' | 'LWOB' | 'LWLO' | null */
export function lwoKind(bytes) {
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FORM') return null;
    const kind = String.fromCharCode(...bytes.subarray(8, 12));
    return ['LWO2', 'LWO3', 'LWOB', 'LWLO'].includes(kind) ? kind : null;
}

const SURFACE_DEFAULTS = {
    color: [0.784, 0.784, 0.784], diffuse: 1, luminosity: 0, specular: 0, reflection: 0, transparency: 0,
    translucency: 0, glossiness: 0.4, ior: 1, bump: 1, reflectionBlur: 0, colorHighlights: 0, side: 1, smoothing: 0,
};
const copy = x => JSON.parse(JSON.stringify(x));
const SURFACE_FLOATS = { DIFF: 'diffuse', LUMI: 'luminosity', SPEC: 'specular', REFL: 'reflection', TRAN: 'transparency',
    TRNL: 'translucency', GLOS: 'glossiness', RIND: 'ior', BUMP: 'bump', RBLR: 'reflectionBlur', CLRH: 'colorHighlights' };

export function parseLwo(bytes, progress = () => {}) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = lwoKind(bytes);
    if (kind !== 'LWO2') throw new Error(`Unsupported LWO format ${kind}`);
    const end = Math.min(8 + dv.getUint32(4), bytes.length);
    const id = p => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    // zero-terminated string, padded to an even length → [string, next offset]
    const str = (p, limit) => {
        let e = p;
        while (e < limit && bytes[e] !== 0) e++;
        let s = '';
        for (let i = p; i < e; i++) s += String.fromCharCode(bytes[i]);
        try { s = decodeURIComponent(escape(s)); } catch { /* not UTF-8: Latin-1 as it is */ }
        e++;
        return [s, e + (e - p) % 2];
    };
    const vx = p => (bytes[p] === 0xff ? [dv.getUint32(p) & 0xffffff, p + 4] : [dv.getUint16(p), p + 2]);

    const tags = [];
    const layers = [];
    const clips = {};
    const surfaces = new Map();
    const skipped = { lines: 0, other: 0 };
    let layer = null;
    const newLayer = (number, flags, pivot, name, parent) => {
        layer = { number, hidden: !!(flags & 1), pivot, name, parent, points: new Float32Array(0), polys: null,
            polyBase: 0, uvMaps: new Map(), normalMaps: new Map() };
        layers.push(layer);
        return layer;
    };
    const currentLayer = () => layer ?? newLayer(0, 0, [0, 0, 0], '', -1);
    // per layer and vertex map name: { dim, point: Float32Array(np·dim), has: Uint8Array(np), corner: Map(poly → [point, values …]) }
    const vmapOf = (store, name, dim, np) => {
        let m = store.get(name);
        if (!m) store.set(name, m = { dim, point: null, has: null, corner: new Map(), np });
        if (!m.point && np) { m.point = new Float32Array(np * dim); m.has = new Uint8Array(np); }
        return m;
    };

    let p = 12, lastReport = 0;
    while (p + 8 <= end) {
        const cid = id(p), size = dv.getUint32(p + 4), b = p + 8, e = Math.min(b + size, end);
        if (cid === 'TAGS') {
            for (let q = b; q < e;) { const [s, n] = str(q, e); tags.push(s); q = n; }
        } else if (cid === 'LAYR') {
            const number = dv.getUint16(b), flags = dv.getUint16(b + 2);
            const pivot = [dv.getFloat32(b + 4), dv.getFloat32(b + 8), dv.getFloat32(b + 12)];
            const [name, q] = str(b + 16, e);
            const parent = q + 2 <= e ? dv.getUint16(q) : 0xffff;
            newLayer(number, flags, pivot, name, parent === 0xffff ? -1 : parent);
        } else if (cid === 'PNTS') {
            const L = currentLayer(), n = Math.floor(size / 12), pts = new Float32Array(n * 3);
            for (let i = 0; i < n * 3; i++) pts[i] = dv.getFloat32(b + i * 4);
            L.points = pts;
        } else if (cid === 'VMAP' || cid === 'VMAD') {
            const L = currentLayer(), type = id(b), dim = dv.getUint16(b + 4);
            const [name, q0] = str(b + 6, e);
            const np = L.points.length / 3;
            const store = type === 'TXUV' && dim === 2 ? L.uvMaps : type === 'NORM' && dim === 3 ? L.normalMaps : null;
            if (store) {
                const m = vmapOf(store, name, dim, np);
                for (let q = q0; q < e;) {
                    let point, poly;
                    [point, q] = vx(q);
                    if (cid === 'VMAD') [poly, q] = vx(q);
                    if (q + dim * 4 > e) break;
                    if (point < np) {
                        if (cid === 'VMAP') {
                            for (let k = 0; k < dim; k++) m.point[point * dim + k] = dv.getFloat32(q + k * 4);
                            m.has[point] = 1;
                        } else {
                            const key = L.polyBase + poly;
                            let list = m.corner.get(key);
                            if (!list) m.corner.set(key, list = []);
                            list.push(point);
                            for (let k = 0; k < dim; k++) list.push(dv.getFloat32(q + k * 4));
                        }
                    }
                    q += dim * 4;
                }
            }
        } else if (cid === 'POLS') {
            const L = currentLayer(), type = id(b);
            const kindOf = type === 'FACE' ? 0 : type === 'PTCH' || type === 'SUBD' ? 1 : 2;
            L.polys ??= new PolyList();
            L.polyBase = L.polys.count;
            const np = L.points.length / 3;
            for (let q = b + 4; q + 2 <= e;) {
                const n = dv.getUint16(q) & 0x3ff;
                q += 2;
                let bad = false;
                for (let k = 0; k < n && q < e; k++) {
                    let v;
                    [v, q] = vx(q);
                    if (v >= np) bad = true;
                    L.polys.vertex(v);
                }
                L.polys.end(bad || n < 3 ? 2 : kindOf);
                if (n < 3 && n > 0) skipped.lines++;
                else if (kindOf === 2) skipped.other++;
            }
        } else if (cid === 'PTAG') {
            const L = currentLayer();
            if (id(b) === 'SURF' && L.polys) {
                for (let q = b + 4; q + 2 < e;) {
                    let poly;
                    [poly, q] = vx(q);
                    const tag = dv.getUint16(q);
                    q += 2;
                    L.polys.setTag(L.polyBase + poly, tag);
                }
            }
        } else if (cid === 'CLIP') {
            clips[dv.getUint32(b)] = readClip(b + 4, e);
        } else if (cid === 'SURF') {
            const [name, q1] = str(b, e);
            const [source, q2] = str(q1, e);
            const surf = { name, ...copy(source && surfaces.has(source) ? surfaces.get(source) : SURFACE_DEFAULTS), blocks: [] };
            surf.name = name;
            readSurface(surf, q2, e);
            surf.blocks.sort((x, y) => (x.ordinal < y.ordinal ? -1 : x.ordinal > y.ordinal ? 1 : 0));
            surfaces.set(name, surf);
        }
        p = b + size + (size & 1);
        if (p - lastReport > 1 << 22) { lastReport = p; progress(0.6 * p / end); }
    }
    // clips that refer to another one (XREF)
    for (const k of Object.keys(clips)) for (let i = 0; i < 8 && typeof clips[k] === 'object' && clips[k]; i++) clips[k] = clips[clips[k].ref] ?? null;

    function readClip(q, e) {
        while (q + 6 <= e) {
            const sid = id(q), n = dv.getUint16(q + 4), s = q + 6;
            if (sid === 'STIL') return str(s, s + n)[0];
            if (sid === 'ISEQ') {
                // u8 digits, u8 flags, i16 offset, u16 reserved, i16 start, i16 end, prefix, suffix → the first image
                const digits = bytes[s], start = dv.getInt16(s + 6);
                const [prefix, r] = str(s + 10, s + n);
                const [suffix] = str(r, s + n);
                return prefix + String(start).padStart(digits, '0') + suffix;
            }
            if (sid === 'XREF') return { ref: dv.getUint32(s) };
            q = s + n + (n & 1);
        }
        return null;
    }
    function readSurface(surf, q, e) {
        while (q + 6 <= e) {
            const sid = id(q), n = dv.getUint16(q + 4), s = q + 6;
            if (sid === 'COLR') surf.color = [dv.getFloat32(s), dv.getFloat32(s + 4), dv.getFloat32(s + 8)];
            else if (SURFACE_FLOATS[sid]) surf[SURFACE_FLOATS[sid]] = dv.getFloat32(s);
            else if (sid === 'SIDE') surf.side = dv.getUint16(s);
            else if (sid === 'SMAN') surf.smoothing = dv.getFloat32(s);
            else if (sid === 'BLOK') { const blk = readBlock(s, s + n); if (blk) surf.blocks.push(blk); }
            q = s + n + (n & 1);
        }
    }
    function readBlock(q, e) {
        if (q + 6 > e) return null;
        const type = id(q), hn = dv.getUint16(q + 4), hs = q + 6, he = Math.min(hs + hn, e);
        const blk = { type, ordinal: '', channel: 'COLR', enabled: true, opacity: 1, proj: -1, image: -1, vmap: '', amplitude: 1, wrap: [1, 1], negative: false };
        let r;
        [blk.ordinal, r] = str(hs, he);
        while (r + 6 <= he) {
            const sid = id(r), n = dv.getUint16(r + 4), s = r + 6;
            if (sid === 'CHAN') blk.channel = id(s);
            else if (sid === 'ENAB') blk.enabled = dv.getUint16(s) !== 0;
            else if (sid === 'OPAC') blk.opacity = dv.getFloat32(s + 2);
            else if (sid === 'NEGA') blk.negative = dv.getUint16(s) !== 0;
            r = s + n + (n & 1);
        }
        for (r = hs + hn + (hn & 1); r + 6 <= e;) {
            const sid = id(r), n = dv.getUint16(r + 4), s = r + 6;
            if (sid === 'PROJ') blk.proj = dv.getUint16(s);
            else if (sid === 'IMAG') blk.image = vx(s)[0];
            else if (sid === 'VMAP') blk.vmap = str(s, s + n)[0];
            else if (sid === 'TAMP') blk.amplitude = dv.getFloat32(s);
            else if (sid === 'WRAP') blk.wrap = [dv.getUint16(s), dv.getUint16(s + 2)];
            r = s + n + (n & 1);
        }
        return blk;
    }

    // --- surfaces per tag, the UV map of each surface ---
    const surfaceList = [];
    const surfaceIndex = new Map();
    const surfaceOfTag = tags.map(name => {
        if (!surfaceIndex.has(name)) { surfaceIndex.set(name, surfaceList.length); surfaceList.push(surfaces.get(name) ?? { name, ...copy(SURFACE_DEFAULTS), blocks: [] }); }
        return surfaceIndex.get(name);
    });
    const fallbackSurface = () => {
        if (!surfaceIndex.has('')) { surfaceIndex.set('', surfaceList.length); surfaceList.push({ name: '', ...copy(SURFACE_DEFAULTS), blocks: [] }); }
        return surfaceIndex.get('');
    };
    for (const L of layers) {
        if (!L.polys) continue;
        L.polys.finish();
        const P = L.polys;
        P.surface = new Int32Array(P.count);
        for (let f = 0; f < P.count; f++) {
            const tag = P.tags ? P.tags[f] : -1;
            P.surface[f] = tag >= 0 && tag < surfaceOfTag.length ? surfaceOfTag[tag] : fallbackSurface();
        }
    }
    // A surface's pictures need one UV map: the candidates are the UV maps its image layers name (colour first, in layer
    // order); the first that covers every corner of the surface in every layer wins. A map that covers only part of it is a
    // decal over the surface (the modeller leaves the other polygons out of that layer) – not taken over. Without a candidate:
    // per layer the first UV map that covers the surface (for library materials).
    const uvAt = (m, f, v, out) => {
        const list = m.corner.get(f);
        if (list) for (let i = 0; i < list.length; i += 3) if (list[i] === v) { out[0] = list[i + 1]; out[1] = list[i + 2]; return true; }
        if (m.has?.[v]) { out[0] = m.point[v * 2]; out[1] = m.point[v * 2 + 1]; return true; }
        return false;
    };
    const tmp = [0, 0];
    const covers = (L, m, s) => {
        const P = L.polys;
        for (let f = 0; f < P.count; f++) {
            if (P.kind[f] === 2 || P.surface[f] !== s) continue;
            for (let c = P.offsets[f]; c < P.offsets[f + 1]; c++) if (!uvAt(m, f, P.verts[c], tmp)) return false;
        }
        return true;
    };
    surfaceList.forEach((surf, s) => {
        const candidates = [];
        for (const ch of ['COLR', null]) {
            for (const blk of surf.blocks) {
                if (blk.type !== 'IMAP' || !blk.enabled || blk.proj !== 5 || !blk.vmap || (ch && blk.channel !== ch)) continue;
                if (!candidates.includes(blk.vmap)) candidates.push(blk.vmap);
            }
        }
        surf.uvMap = candidates.find(name => layers.every(L => !L.polys || !L.polys.surface.includes(s) || (L.uvMaps.has(name) && covers(L, L.uvMaps.get(name), s)))) ?? null;
    });

    // --- geometry per layer ---
    // one patch level for the whole file: the modeller's 3, lower while all layers' patches would exceed SUBDIV_FACES
    let patchCorners = 0;
    for (const L of layers) if (L.polys) for (let f = 0; f < L.polys.count; f++) if (L.polys.kind[f] === 1) patchCorners += L.polys.offsets[f + 1] - L.polys.offsets[f];
    let patchLevel = PATCH_LEVEL;
    while (patchLevel > 0 && patchCorners * 4 ** (patchLevel - 1) > SUBDIV_FACES) patchLevel--;
    const out = [];
    layers.forEach((L, li) => {
        const parts = new Map();   // surface → Builder
        if (L.polys) buildLayer(L, parts);
        out.push({ number: L.number, name: L.name, parent: L.parent, hidden: L.hidden, pivot: L.pivot,
            parts: [...parts.entries()].map(([s, bld]) => ({ surface: s, ...bld.result() })).filter(x => x.index.length) });
        progress(0.6 + 0.4 * (li + 1) / layers.length);
    });

    function buildLayer(L, parts) {
        const P = L.polys, pts = L.points, np = pts.length / 3;
        // UV map per surface in this layer
        const uvMapOf = surfaceList.map((surf, s) => {
            if (!P.surface.includes(s)) return null;
            if (surf.uvMap && L.uvMaps.has(surf.uvMap)) return L.uvMaps.get(surf.uvMap);
            for (const m of L.uvMaps.values()) if (covers(L, m, s)) return m;
            return null;
        });
        const normalMap = L.normalMaps.size ? L.normalMaps.values().next().value : null;
        // corner arrays per kind (0 polygons, 1 patches)
        for (const kind of [0, 1]) {
            let nf = 0, nc = 0;
            for (let f = 0; f < P.count; f++) if (P.kind[f] === kind) { nf++; nc += P.offsets[f + 1] - P.offsets[f]; }
            if (!nf) continue;
            const offsets = new Int32Array(nf + 1), cv = new Int32Array(nc), faceSurf = new Int32Array(nf);
            let uv = null, nrm = null;
            const anyUv = uvMapOf.some(m => m);
            if (anyUv) uv = new Float32Array(nc * 2);
            if (normalMap && kind === 0) nrm = new Float32Array(nc * 3).fill(NaN);
            const n3 = [0, 0, 0];
            let fi = 0, c = 0;
            for (let f = 0; f < P.count; f++) {
                if (P.kind[f] !== kind) continue;
                const s = P.surface[f], um = uvMapOf[s];
                faceSurf[fi] = s;
                for (let k = P.offsets[f]; k < P.offsets[f + 1]; k++, c++) {
                    const v = P.verts[k];
                    cv[c] = v;
                    if (um && uvAt(um, f, v, tmp)) { uv[c * 2] = tmp[0]; uv[c * 2 + 1] = tmp[1]; }
                    if (nrm && normalAt(normalMap, f, v, n3)) { nrm[c * 3] = n3[0]; nrm[c * 3 + 1] = n3[1]; nrm[c * 3 + 2] = n3[2]; }
                }
                offsets[++fi] = c;
            }
            if (kind === 0) { emit(pts, offsets, cv, uv, nrm, faceSurf, parts, 0); continue; }
            // patches: only the points they use, edges numbered, refined
            const remap = new Int32Array(np).fill(-1);
            let nu = 0;
            for (let k = 0; k < nc; k++) if (remap[cv[k]] < 0) remap[cv[k]] = nu++;
            const pos = new Float32Array(nu * 3);
            for (let v = 0; v < np; v++) if (remap[v] >= 0) { const o = remap[v] * 3; pos[o] = pts[v * 3]; pos[o + 1] = pts[v * 3 + 1]; pos[o + 2] = pts[v * 3 + 2]; }
            for (let k = 0; k < nc; k++) cv[k] = remap[cv[k]];
            const ce = new Int32Array(nc), edges = new Map();
            for (let f = 0; f < nf; f++) {
                for (let k = offsets[f]; k < offsets[f + 1]; k++) {
                    const a = cv[k], b2 = cv[k + 1 < offsets[f + 1] ? k + 1 : offsets[f]];
                    const key = a < b2 ? a * nu + b2 : b2 * nu + a;
                    let e = edges.get(key);
                    if (e === undefined) edges.set(key, e = edges.size);
                    ce[k] = e;
                }
            }
            const level = patchLevel;
            if (level === 0) { emit(pos, offsets, cv, uv, null, faceSurf, parts, 1); continue; }
            const r = subdivideCorners({ pos, offsets, cv, ce, ne: edges.size, uv }, level);
            emit(r.pos, r.offsets, r.cv, r.uv, null, Int32Array.from(r.root, x => faceSurf[x]), parts, 1);
        }
    }
    function normalAt(m, f, v, out) {
        const list = m.corner.get(f);
        if (list) for (let i = 0; i < list.length; i += 4) if (list[i] === v) { out[0] = list[i + 1]; out[1] = list[i + 2]; out[2] = list[i + 3]; return true; }
        if (m.has?.[v]) { out[0] = m.point[v * 3]; out[1] = m.point[v * 3 + 1]; out[2] = m.point[v * 3 + 2]; return true; }
        return false;
    }

    // corners → per surface welded vertices (position, normal, UV) and triangles; left-handed → right-handed (z mirrored)
    function emit(pos, offsets, cv, uv, nrm, faceSurf, parts, subset) {
        const nf = offsets.length - 1, nc = cv.length, nv = pos.length / 3;
        // face normals (Newell – length = 2 × area)
        const fn = new Float64Array(nf * 3);
        for (let f = 0; f < nf; f++) {
            let x = 0, y = 0, z = 0;
            for (let c = offsets[f], e = offsets[f + 1]; c < e; c++) {
                const a = cv[c] * 3, b2 = cv[c + 1 < e ? c + 1 : offsets[f]] * 3;
                x += (pos[a + 1] - pos[b2 + 1]) * (pos[a + 2] + pos[b2 + 2]);
                y += (pos[a + 2] - pos[b2 + 2]) * (pos[a] + pos[b2]);
                z += (pos[a] - pos[b2]) * (pos[a + 1] + pos[b2 + 1]);
            }
            fn[f * 3] = x; fn[f * 3 + 1] = y; fn[f * 3 + 2] = z;
        }
        const faceOf = new Int32Array(nc);
        for (let f = 0; f < nf; f++) for (let c = offsets[f]; c < offsets[f + 1]; c++) faceOf[c] = f;
        // corners per point (CSR)
        const start = new Int32Array(nv + 1);
        for (let c = 0; c < nc; c++) start[cv[c] + 1]++;
        for (let v = 0; v < nv; v++) start[v + 1] += start[v];
        const fill = start.slice(0, nv), around = new Int32Array(nc);
        for (let c = 0; c < nc; c++) around[fill[cv[c]]++] = c;
        const cosSman = surfaceList.map(sf => (sf.smoothing > 1e-4 ? Math.cos(Math.min(sf.smoothing, Math.PI)) : 2));
        const len = f => Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]) || 1;
        const flen = new Float64Array(nf);
        for (let f = 0; f < nf; f++) flen[f] = len(f);
        const cn = new Float32Array(nc * 3);
        for (let c = 0; c < nc; c++) {
            if (nrm && !Number.isNaN(nrm[c * 3])) { cn[c * 3] = nrm[c * 3]; cn[c * 3 + 1] = nrm[c * 3 + 1]; cn[c * 3 + 2] = nrm[c * 3 + 2]; continue; }
            const f = faceOf[c], s = faceSurf[f], cs = cosSman[s];
            let x = fn[f * 3], y = fn[f * 3 + 1], z = fn[f * 3 + 2];
            if (cs <= 1) {
                const v = cv[c];
                for (let i = start[v]; i < start[v + 1]; i++) {
                    const g = faceOf[around[i]];
                    if (g === f || faceSurf[g] !== s) continue;
                    const d = (fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2]) / (flen[f] * flen[g]);
                    if (d >= cs) { x += fn[g * 3]; y += fn[g * 3 + 1]; z += fn[g * 3 + 2]; }
                }
            }
            const l = Math.hypot(x, y, z) || 1;
            cn[c * 3] = x / l; cn[c * 3 + 1] = y / l; cn[c * 3 + 2] = z / l;
        }
        // triangles per face, vertices welded per surface
        const tri = [];
        for (let f = 0; f < nf; f++) {
            const s = faceSurf[f];
            let bld = parts.get(s);
            if (!bld) parts.set(s, bld = new Builder(!!uv));
            const c0 = offsets[f], n = offsets[f + 1] - c0;
            tri.length = 0;
            triangulate(pos, cv, c0, n, fn, f, tri);
            const key = subset * 0x40000000;
            for (let i = 0; i < tri.length; i += 3) {
                const a = bld.vertex(key, tri[i], pos, cv, cn, uv), b2 = bld.vertex(key, tri[i + 1], pos, cv, cn, uv), c = bld.vertex(key, tri[i + 2], pos, cv, cn, uv);
                if (a !== b2 && b2 !== c && a !== c) bld.tri(a, c, b2);   // mirrored: the turning reverses
            }
        }
    }

    return { layers: out, surfaces: surfaceList, clips, skipped, patchLevel: patchCorners ? patchLevel : null };
}

// one polygon list per layer: corners in growing typed arrays
class PolyList {
    constructor() {
        this.verts = new Int32Array(1024); this.nv = 0;
        this.offsets = new Int32Array(257); this.kind = new Uint8Array(256); this.count = 0;
        this.tags = null;
    }
    vertex(v) {
        if (this.nv === this.verts.length) { const x = new Int32Array(this.verts.length * 2); x.set(this.verts); this.verts = x; }
        this.verts[this.nv++] = v;
    }
    end(kind) {
        if (this.count + 2 > this.offsets.length) {
            const o = new Int32Array(this.offsets.length * 2); o.set(this.offsets); this.offsets = o;
            const k = new Uint8Array(this.offsets.length); k.set(this.kind); this.kind = k;
            if (this.tags) { const t = new Int32Array(this.offsets.length).fill(-1); t.set(this.tags); this.tags = t; }
        }
        this.kind[this.count] = kind;
        this.offsets[++this.count] = this.nv;
    }
    setTag(f, tag) {
        if (f >= this.count) return;
        if (!this.tags) this.tags = new Int32Array(this.offsets.length).fill(-1);
        this.tags[f] = tag;
    }
    finish() {
        this.verts = this.verts.slice(0, this.nv);
        this.offsets = this.offsets.slice(0, this.count + 1);
        this.kind = this.kind.slice(0, this.count);
        if (this.tags) this.tags = this.tags.slice(0, this.count);
    }
}

// welded vertices of one surface in one layer: a chain per source point, same normal and UV → same vertex
class Builder {
    constructor(hasUv) {
        this.hasUv = hasUv;
        this.head = new Map();   // source point key → first vertex
        this.next = new Int32Array(1024);
        this.pos = new Float32Array(3072); this.nrm = new Float32Array(3072); this.uv = hasUv ? new Float32Array(2048) : null;
        this.n = 0;
        this.index = new Uint32Array(3072); this.nIndex = 0;
    }
    vertex(key, c, pos, cv, cn, uv) {
        const point = key + cv[c];
        for (let v = this.head.get(point) ?? -1; v >= 0; v = this.next[v]) {
            const o = v * 3, q = c * 3;
            if (this.nrm[o] !== cn[q] || this.nrm[o + 1] !== cn[q + 1] || this.nrm[o + 2] !== -cn[q + 2]) continue;
            if (uv && (this.uv[v * 2] !== uv[c * 2] || this.uv[v * 2 + 1] !== uv[c * 2 + 1])) continue;
            return v;
        }
        const v = this.n++;
        if (v === this.next.length) this.grow();
        this.next[v] = this.head.get(point) ?? -1;
        this.head.set(point, v);
        const p = cv[c] * 3, o = v * 3, q = c * 3;
        // left-handed → right-handed: z mirrored
        this.pos[o] = pos[p]; this.pos[o + 1] = pos[p + 1]; this.pos[o + 2] = -pos[p + 2];
        this.nrm[o] = cn[q]; this.nrm[o + 1] = cn[q + 1]; this.nrm[o + 2] = -cn[q + 2];
        if (uv) { this.uv[v * 2] = uv[c * 2]; this.uv[v * 2 + 1] = uv[c * 2 + 1]; }
        return v;
    }
    grow() {
        const n = this.next.length * 2;
        const g = (a, k) => { const x = new a.constructor(n * k); x.set(a); return x; };
        this.next = g(this.next, 1);
        this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 3);
        if (this.uv) this.uv = g(this.uv, 2);
    }
    tri(a, b, c) {
        if (this.nIndex + 3 > this.index.length) { const x = new Uint32Array(this.index.length * 2); x.set(this.index); this.index = x; }
        this.index[this.nIndex++] = a; this.index[this.nIndex++] = b; this.index[this.nIndex++] = c;
    }
    result() {
        return {
            positions: this.pos.slice(0, this.n * 3), normals: this.nrm.slice(0, this.n * 3),
            uvs: this.uv ? this.uv.slice(0, this.n * 2) : null, index: this.index.slice(0, this.nIndex),
        };
    }
}
