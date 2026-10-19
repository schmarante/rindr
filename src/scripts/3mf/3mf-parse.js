// 3MF reader (3D Manufacturing Format, own implementation after the published core specification): a zip (OPC
// package) with XML model files. Pure functions – runs in 3mf-worker.js and in Node (tests).
//   _rels/.rels            → root model part (relationship type …/3dmodel), fallback: first 3D/*.model
//   <model unit="…">       micron, millimeter (default), centimeter, inch, foot, meter
//   <resources>            basematerials > base (name, displaycolor #RRGGBB[AA]),
//                          m:colorgroup > m:color, m:texture2d (path, tilestyleu/v), m:texture2dgroup > m:tex2coord,
//                          object (name, pid/pindex = default property) > mesh > vertices/vertex (x y z),
//                          triangles/triangle (v1 v2 v3, pid p1 p2 p3) – or object > components > component
//                          (objectid, transform, p:path = object in another model part: production extension,
//                          used by slicer projects)
//   <build> > item         objectid, transform, p:path
// Transforms are 3×4 in row-vector order (x' = x·m00 + y·m10 + z·m20 + m30), handed on as the 12 numbers.
// Ids are scoped per model part (key `${part}#${id}`). Not read: composite materials, multi-properties
// (their first colour layer is used), beam lattice, slices, slicer paint data, thumbnails.
import { creaseCornerNormals } from '../crease-normals.js';

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const MAX_COLORS = 64;   // more distinct triangle colours (painted meshes): quantized, the material list stays usable
const MODEL_REL = '/3dmodel';

/**
 * @param {Map<string, () => Promise<Uint8Array>>} zip readZip(buffer, { paths: true })
 * @returns {Promise<{ unitMm, title, objects, build, materials, textures, geometries, unsupported }>}
 *   objects: [{ name, geometry (index or -1), components: [{ object, transform }] }], build: [{ object, transform }],
 *   geometries: per mesh object the parts [{ material (index or -1), positions, normals, uvs|null, index }],
 *   materials: [{ name, color: [r, g, b, a] (sRGB 0…1), texture (index or -1) }], textures: [{ name, path, type, bytes, tileu, tilev }]
 */
export async function read3mf(zip, onProgress = () => {}) {
    const byPath = new Map();
    for (const name of zip.keys()) byPath.set(normPath(name), name);
    const readPart = async path => {
        const name = byPath.get(normPath(path));
        return name ? zip.get(name)() : null;
    };
    const root = await rootModelPath(readPart, [...byPath.keys()]);
    if (!root) throw new Error('3MF: no model part');
    // model parts: the root one and those referenced via p:path (read once each)
    const parts = new Map();
    const queue = [root];
    while (queue.length) {
        const path = queue.shift();
        if (parts.has(path)) continue;
        const bytes = await readPart(path);
        if (!bytes) { parts.set(path, null); continue; }
        const model = parseModel(bytes, path);
        parts.set(path, model);
        for (const p of model.refs) if (!parts.has(p)) queue.push(p);
        onProgress(parts.size, parts.size + queue.length);
    }
    const rootModel = parts.get(root);
    if (!rootModel) throw new Error('3MF: no model part');
    const unsupported = new Set();
    for (const m of parts.values()) if (m) for (const u of m.unsupported) unsupported.add(u);

    // objects → flat list (index), mesh objects → geometries
    const objects = [], objectIndex = new Map(), meshObjects = [];
    for (const [path, m] of parts) {
        if (!m) continue;
        for (const [id, r] of m.resources) {
            if (r.kind !== 'object') continue;
            objectIndex.set(`${path}#${id}`, objects.length);
            objects.push({ name: r.name, geometry: r.mesh ? meshObjects.push({ path, object: r }) - 1 : -1, components: [], raw: r, path });
        }
    }
    const ref = (path, id) => objectIndex.get(`${path}#${id}`) ?? -1;
    for (const o of objects) {
        o.components = (o.raw.components || []).map(c => ({ object: ref(c.path ? normPath(c.path) : o.path, c.objectid), transform: c.transform })).filter(c => c.object >= 0);
    }
    const build = rootModel.build.map(b => ({ object: ref(b.path ? normPath(b.path) : root, b.objectid), transform: b.transform })).filter(b => b.object >= 0);

    // properties per triangle → material slots; textures by path
    const textures = [], textureIndex = new Map();
    const texture = async (path, res) => {
        const key = normPath(res.path);
        if (textureIndex.has(key)) return textureIndex.get(key);
        const bytes = await readPart(res.path);
        const k = bytes ? textures.push({ name: res.path.split('/').pop(), path: res.path, type: res.contenttype || '', bytes, tileu: res.tileu, tilev: res.tilev }) - 1 : -1;
        textureIndex.set(key, k);
        return k;
    };
    const slots = new Slots();
    const triMaterial = [];   // per mesh object: Int32Array of slot ids per triangle
    const triUv = [];         // per mesh object: { uvs, corner: Int32Array (index into uvs per corner) } or null
    for (const { path, object: r } of meshObjects) {
        const m = parts.get(path);
        const nf = r.mesh.tri.length / 3;
        const slot = new Int32Array(nf).fill(-1);
        let uvs = null, cornerUv = null;
        const groupOffsets = new Map();
        for (let f = 0; f < nf; f++) {
            let pid = r.mesh.tpid[f], p1 = r.mesh.tp[f * 3], p2 = r.mesh.tp[f * 3 + 1], p3 = r.mesh.tp[f * 3 + 2];
            if (pid < 0) { pid = r.pid; p1 = r.pindex; p2 = p3 = -1; }
            if (pid < 0) continue;
            if (p1 < 0) p1 = r.pid === pid && r.pindex >= 0 ? r.pindex : 0;
            if (p2 < 0) p2 = p1;
            if (p3 < 0) p3 = p1;
            let res = m.resources.get(pid);
            if (res?.kind === 'multi') { res = res.layer >= 0 ? m.resources.get(res.layer) : null; p1 = p2 = p3 = 0; }
            if (!res) continue;
            if (res.kind === 'base') {
                const b = res.items[p1];
                if (b) slot[f] = slots.color(b.color, b.name, `${path}#${pid}:${p1}`);
            } else if (res.kind === 'color') {
                const c = averageColor(res.colors, p1, p2, p3);
                if (c) slot[f] = slots.color(c, null, null);
            } else if (res.kind === 'texgroup') {
                const tex = m.resources.get(res.texid);
                if (tex?.kind !== 'texture2d') continue;
                const ti = await texture(path, tex);
                if (ti < 0) continue;
                slot[f] = slots.texture(ti, textures[ti].name);
                // per-corner UVs: groups used by this object concatenated
                if (!groupOffsets.has(pid)) {
                    const prev = uvs ? uvs.length : 0;
                    const merged = new Float32Array(prev + res.uvs.length);
                    if (uvs) merged.set(uvs);
                    merged.set(res.uvs, prev);
                    uvs = merged;
                    groupOffsets.set(pid, prev / 2);
                }
                cornerUv ??= new Int32Array(nf * 3).fill(-1);
                const o = groupOffsets.get(pid), n = res.uvs.length / 2;
                cornerUv[f * 3] = p1 < n ? o + p1 : -1; cornerUv[f * 3 + 1] = p2 < n ? o + p2 : -1; cornerUv[f * 3 + 2] = p3 < n ? o + p3 : -1;
            }
        }
        triMaterial.push(slot);
        triUv.push(uvs ? { uvs, corner: cornerUv } : null);
    }
    const materials = slots.finish(triMaterial);

    const geometries = meshObjects.map(({ object: r }, g) => {
        const parts = buildGeometry(r.mesh.P, r.mesh.tri, triMaterial[g], triUv[g]);
        onProgress(g + 1, meshObjects.length);
        r.mesh = null;   // raw arrays no longer needed
        return parts;
    });
    for (const o of objects) { delete o.raw; delete o.path; }
    return { unitMm: UNIT_MM[rootModel.unit] ?? 1, title: rootModel.title, objects, build, materials, textures, geometries, unsupported: [...unsupported] };
}

// OPC part names: case-insensitive, absolute ("/3D/3dmodel.model"); zip entries have no leading slash
const normPath = p => p.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();

async function rootModelPath(readPart, paths) {
    const rels = await readPart('_rels/.rels');
    if (rels) {
        const text = new TextDecoder().decode(rels);
        for (const m of text.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
            const type = /\bType\s*=\s*["']([^"']*)["']/.exec(m[0])?.[1] || '';
            const target = /\bTarget\s*=\s*["']([^"']*)["']/.exec(m[0])?.[1];
            if (target && type.endsWith(MODEL_REL) && paths.includes(normPath(target))) return normPath(target);
        }
    }
    return paths.find(p => p.startsWith('3d/') && p.endsWith('.model')) || paths.find(p => p.endsWith('.model')) || null;
}

// --- material slots (one per base material / colour / texture) ---

class Slots {
    constructor() {
        this.list = [];        // { name, rgba (packed, colour slots), key, texture }
        this.byKey = new Map();
    }
    // named base material: its own slot (two bases with the same colour stay apart); colour group: by colour
    color(rgba, name, key) {
        const k = key ?? `c${rgba}`;
        let s = this.byKey.get(k);
        if (s === undefined) { s = this.list.push({ name, rgba, named: !!key, texture: -1 }) - 1; this.byKey.set(k, s); }
        return s;
    }
    texture(ti, name) {
        const k = `t${ti}`;
        let s = this.byKey.get(k);
        if (s === undefined) { s = this.list.push({ name, rgba: 0xffffffff, named: true, texture: ti }) - 1; this.byKey.set(k, s); }
        return s;
    }
    // too many unnamed colours: snap them to a coarse grid (4 levels per channel) and merge
    finish(triMaterial) {
        const loose = this.list.filter(s => !s.named).length;
        let remap = null;
        if (loose > MAX_COLORS) {
            const merged = new Map();
            remap = new Int32Array(this.list.length);
            const out = [];
            this.list.forEach((s, i) => {
                if (s.named) { remap[i] = out.push(s) - 1; return; }
                const q = quantize(s.rgba);
                if (!merged.has(q)) merged.set(q, out.push({ ...s, rgba: q }) - 1);
                remap[i] = merged.get(q);
            });
            this.list = out;
            for (const slot of triMaterial) for (let f = 0; f < slot.length; f++) if (slot[f] >= 0) slot[f] = remap[slot[f]];
        }
        return this.list.map(s => {
            const color = [(s.rgba >>> 24) / 255, ((s.rgba >>> 16) & 255) / 255, ((s.rgba >>> 8) & 255) / 255, (s.rgba & 255) / 255];
            return { name: s.name || hex(s.rgba), color, texture: s.texture };
        });
    }
}

const hex = rgba => '#' + (rgba >>> 8).toString(16).padStart(6, '0').toUpperCase();
function quantize(rgba) {
    const q = v => Math.round(Math.round(v / 85) * 85);
    return ((q(rgba >>> 24) << 24) | (q((rgba >>> 16) & 255) << 16) | (q((rgba >>> 8) & 255) << 8) | (rgba & 255)) >>> 0;
}
// a triangle with three corner colours (gradient) gets their mean – there are no vertex colours in RINDR
function averageColor(colors, a, b, c) {
    const ca = colors[a], cb = colors[b] ?? ca, cc = colors[c] ?? ca;
    if (ca === undefined) return null;
    if (ca === cb && ca === cc) return ca;
    const ch = s => Math.round((((ca >>> s) & 255) + ((cb >>> s) & 255) + ((cc >>> s) & 255)) / 3);
    return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** "#RRGGBB" / "#RRGGBBAA" → packed RGBA (alpha 255 when missing); invalid → mid grey */
export function parseColor(s) {
    const m = /^\s*#?([0-9a-f]{6})([0-9a-f]{2})?\s*$/i.exec(s || '');
    if (!m) return 0x808080ff;
    return ((parseInt(m[1], 16) << 8) | (m[2] ? parseInt(m[2], 16) : 255)) >>> 0;
}

// --- geometry: smooth normals by angle, corners welded, split by material slot ---

/**
 * 3MF meshes share vertices across hard edges (a cube has 8) – normals per corner (30° crease), then corners with the
 * same vertex, UV and normal welded again. Triangles with invalid indices are dropped.
 */
export function buildGeometry(P, tri, slot, uv) {
    const nv = P.length / 3;
    let nf = tri.length / 3;
    // drop triangles with indices out of range or repeated corners (the spec forbids them)
    let keep = 0;
    for (let f = 0; f < nf; f++) {
        const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
        if (a >= nv || b >= nv || c >= nv || a === b || b === c || a === c) continue;
        if (keep !== f) {
            tri[keep * 3] = a; tri[keep * 3 + 1] = b; tri[keep * 3 + 2] = c;
            slot[keep] = slot[f];
            if (uv) { uv.corner[keep * 3] = uv.corner[f * 3]; uv.corner[keep * 3 + 1] = uv.corner[f * 3 + 1]; uv.corner[keep * 3 + 2] = uv.corner[f * 3 + 2]; }
        }
        keep++;
    }
    if (keep !== nf) { tri = tri.subarray(0, keep * 3); nf = keep; }
    if (!nf) return [];
    const CN = creaseCornerNormals(P, tri);
    // weld: per vertex a chain of output vertices (same UV and normal → reuse)
    let cap = Math.max(16, Math.ceil(nv * 1.5));
    let OP = new Float32Array(cap * 3), ON = new Float32Array(cap * 3), UVI = new Int32Array(cap), next = new Int32Array(cap);
    const head = new Int32Array(nv).fill(-1);
    let count = 0;
    const grow = () => {
        cap *= 2;
        const g2 = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
        OP = g2(OP, 3); ON = g2(ON, 3); UVI = g2(UVI, 1); next = g2(next, 1);
    };
    const corner = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) {
        const v = tri[i];
        const nx = CN[i * 3], ny = CN[i * 3 + 1], nz = CN[i * 3 + 2];
        const ui = uv ? uv.corner[i] : -1;
        let found = -1;
        for (let k = head[v]; k >= 0; k = next[k]) {
            if (UVI[k] !== ui) continue;
            if (Math.abs(ON[k * 3] - nx) > 1e-4 || Math.abs(ON[k * 3 + 1] - ny) > 1e-4 || Math.abs(ON[k * 3 + 2] - nz) > 1e-4) continue;
            found = k;
            break;
        }
        if (found < 0) {
            if (count >= cap) grow();
            found = count++;
            OP[found * 3] = P[v * 3]; OP[found * 3 + 1] = P[v * 3 + 1]; OP[found * 3 + 2] = P[v * 3 + 2];
            ON[found * 3] = nx; ON[found * 3 + 1] = ny; ON[found * 3 + 2] = nz;
            UVI[found] = ui;
            next[found] = head[v];
            head[v] = found;
        }
        corner[i] = found;
    }
    // triangles per slot → compact buffers
    const perSlot = new Map();
    for (let f = 0; f < nf; f++) perSlot.set(slot[f], (perSlot.get(slot[f]) || 0) + 1);
    const local = new Int32Array(count);
    const out = [];
    for (const [material, n] of perSlot) {
        const index = new Uint32Array(n * 3);
        local.fill(-1);
        let w = 0, nvOut = 0, textured = false;
        for (let f = 0; f < nf; f++) {
            if (slot[f] !== material) continue;
            for (let k = 0; k < 3; k++) {
                const c = corner[f * 3 + k];
                if (local[c] < 0) local[c] = nvOut++;
                if (UVI[c] >= 0) textured = true;
                index[w++] = local[c];
            }
        }
        const positions = new Float32Array(nvOut * 3), normals = new Float32Array(nvOut * 3), uvs = textured ? new Float32Array(nvOut * 2) : null;
        for (let c = 0; c < count; c++) {
            const l = local[c];
            if (l < 0) continue;
            positions.set(OP.subarray(c * 3, c * 3 + 3), l * 3);
            normals.set(ON.subarray(c * 3, c * 3 + 3), l * 3);
            if (uvs && UVI[c] >= 0) { uvs[l * 2] = uv.uvs[UVI[c] * 2]; uvs[l * 2 + 1] = uv.uvs[UVI[c] * 2 + 1]; }
        }
        out.push({ material, positions, normals, uvs, index });
    }
    return out;
}

// --- XML: byte scanner (model parts reach hundreds of MB – no DOM, no string of the whole file) ---

const LT = 60, GT = 62, SLASH = 47, QM = 63, EX = 33, EQ = 61, DQ = 34, SQ = 39, COLON = 58;
const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13;
const utf8 = new TextDecoder();

class Grow {
    constructor(Type, cap = 1024) { this.a = new Type(cap); this.n = 0; }
    push(v) {
        if (this.n === this.a.length) { const b = new this.a.constructor(this.a.length * 2); b.set(this.a); this.a = b; }
        this.a[this.n++] = v;
    }
    done() { return this.a.slice(0, this.n); }
}

/** One model part → { unit, title, resources: Map(id → resource), build, refs (other parts named in p:path), unsupported } */
export function parseModel(bytes, selfPath = '') {
    const len = bytes.length;
    const resources = new Map(), build = [], refs = new Set(), unsupported = new Set();
    let unit = 'millimeter', title = '';
    // attribute ranges of the current tag
    const AN = new Int32Array(128), AE = new Int32Array(128), VS = new Int32Array(128), VE = new Int32Array(128);
    let attrs = 0;
    const nameIs = (k, s) => {
        let a = AN[k];
        const e = AE[k];
        for (let j = a; j < e; j++) if (bytes[j] === COLON) a = j + 1;   // local name
        if (e - a !== s.length) return false;
        for (let j = 0; j < s.length; j++) if (bytes[a + j] !== s.charCodeAt(j)) return false;
        return true;
    };
    const attr = s => { for (let k = 0; k < attrs; k++) if (nameIs(k, s)) return decodeEntities(utf8.decode(bytes.subarray(VS[k], VE[k]))); return null; };
    const attrNum = (s, def) => { for (let k = 0; k < attrs; k++) if (nameIs(k, s)) return parseNum(bytes, VS[k], VE[k]); return def; };
    const intAttr = s => { const v = attrNum(s, -1); return Number.isFinite(v) ? Math.trunc(v) : -1; };
    const transform = () => {
        const s = attr('transform');
        if (!s) return null;
        const v = s.trim().split(/\s+/).map(Number);
        return v.length === 12 && v.every(Number.isFinite) ? v : null;
    };
    const pathAttr = () => { const p = attr('path'); if (p) { const n = normPath(p); if (n !== selfPath) refs.add(n); return n; } return null; };

    let obj = null, group = null;   // open object / material group
    let P = null, T = null, TP = null, TPID = null;
    let inBuild = false, metaName = null, metaStart = -1;
    let i = 0;
    for (;;) {
        i = bytes.indexOf(LT, i);
        if (i < 0) break;
        const c = bytes[i + 1];
        if (c === QM) { i = findSeq(bytes, i + 2, '?>') + 2; continue; }
        if (c === EX) {
            if (bytes[i + 2] === 45 && bytes[i + 3] === 45) i = findSeq(bytes, i + 4, '-->') + 3;
            else if (bytes[i + 2] === 91) i = findSeq(bytes, i + 2, ']]>') + 3;
            else i = bytes.indexOf(GT, i) + 1;
            if (i <= 0) break;
            continue;
        }
        // tag name (local part)
        const close = c === SLASH;
        let j = i + (close ? 2 : 1);
        let ls = j;
        while (j < len && !isSpace(bytes[j]) && bytes[j] !== GT && bytes[j] !== SLASH) { if (bytes[j] === COLON) ls = j + 1; j++; }
        const le = j;
        const tag = tagName(bytes, ls, le);
        if (close) {
            const tagStart = i;
            i = bytes.indexOf(GT, j) + 1;
            if (i <= 0) break;
            if (tag === 'object' && obj) {
                if (P) obj.mesh = { P: P.done(), tri: T.done(), tp: TP.done(), tpid: TPID.done() };
                P = T = TP = TPID = null;
                obj = null;
            } else if (group && (tag === 'basematerials' || tag === 'colorgroup' || tag === 'texture2dgroup')) {
                if (group.kind === 'texgroup') group.uvs = group.uvsGrow.done(), delete group.uvsGrow;
                group = null;
            } else if (tag === 'build') inBuild = false;
            else if (tag === 'metadata' && metaName === 'Title' && metaStart >= 0) {
                title = decodeEntities(utf8.decode(bytes.subarray(metaStart, tagStart))).trim();
                metaName = null;
            }
            continue;
        }
        // attributes
        attrs = 0;
        let self = false;
        for (;;) {
            while (j < len && isSpace(bytes[j])) j++;
            const b = bytes[j];
            if (b === GT) { j++; break; }
            if (b === SLASH) { self = true; j = bytes.indexOf(GT, j) + 1; break; }
            if (j >= len) break;
            const ns = j;
            while (j < len && bytes[j] !== EQ && !isSpace(bytes[j])) j++;
            const ne = j;
            while (j < len && bytes[j] !== DQ && bytes[j] !== SQ) j++;
            const q = bytes[j++];
            const vs = j;
            j = bytes.indexOf(q, j);
            if (j < 0) { j = len; break; }
            if (attrs < 128) { AN[attrs] = ns; AE[attrs] = ne; VS[attrs] = vs; VE[attrs] = j; attrs++; }
            j++;
        }
        i = j;
        if (j <= 0) break;
        switch (tag) {
            case 'vertex': {
                if (!P) break;
                let x = 0, y = 0, z = 0;
                for (let k = 0; k < attrs; k++) {
                    if (AE[k] - AN[k] !== 1) continue;
                    const n = bytes[AN[k]], v = parseNum(bytes, VS[k], VE[k]);
                    if (n === 120) x = v; else if (n === 121) y = v; else if (n === 122) z = v;
                }
                P.push(x); P.push(y); P.push(z);
                break;
            }
            case 'triangle': {
                if (!T) break;
                let v1 = -1, v2 = -1, v3 = -1, p1 = -1, p2 = -1, p3 = -1, pid = -1;
                for (let k = 0; k < attrs; k++) {
                    const a = AN[k], l = AE[k] - a;
                    if (l === 2) {
                        const n0 = bytes[a], n1 = bytes[a + 1], v = parseNum(bytes, VS[k], VE[k]);
                        if (n0 === 118) { if (n1 === 49) v1 = v; else if (n1 === 50) v2 = v; else if (n1 === 51) v3 = v; }
                        else if (n0 === 112) { if (n1 === 49) p1 = v; else if (n1 === 50) p2 = v; else if (n1 === 51) p3 = v; }
                    } else if (l === 3 && bytes[a] === 112 && bytes[a + 1] === 105 && bytes[a + 2] === 100) pid = parseNum(bytes, VS[k], VE[k]);
                }
                if (!(v1 >= 0 && v2 >= 0 && v3 >= 0)) break;
                T.push(v1); T.push(v2); T.push(v3);
                TP.push(p1); TP.push(p2); TP.push(p3);
                TPID.push(pid);
                break;
            }
            case 'model': unit = (attr('unit') || 'millimeter').toLowerCase(); break;
            case 'metadata': metaName = attr('name'); metaStart = self ? -1 : i; break;
            case 'object': {
                const id = intAttr('id');
                obj = { kind: 'object', name: attr('name') || '', pid: intAttr('pid'), pindex: intAttr('pindex'), mesh: null, components: null };
                if (id >= 0) resources.set(id, obj);
                if (self) obj = null;
                break;
            }
            case 'mesh': if (obj) { P = new Grow(Float32Array, 3 * 1024); T = new Grow(Uint32Array, 3 * 1024); TP = new Grow(Int32Array, 3 * 1024); TPID = new Grow(Int32Array, 1024); } break;
            case 'component': if (obj) (obj.components ??= []).push({ objectid: intAttr('objectid'), transform: transform(), path: pathAttr() }); break;
            case 'build': inBuild = !self; break;
            case 'item': if (inBuild) build.push({ objectid: intAttr('objectid'), transform: transform(), path: pathAttr() }); break;
            case 'basematerials': group = { kind: 'base', items: [] }; resources.set(intAttr('id'), group); if (self) group = null; break;
            case 'base': if (group?.kind === 'base') group.items.push({ name: attr('name') || '', color: parseColor(attr('displaycolor')) }); break;
            case 'colorgroup': group = { kind: 'color', colors: [] }; resources.set(intAttr('id'), group); if (self) group = null; break;
            case 'color': if (group?.kind === 'color') group.colors.push(parseColor(attr('color'))); break;
            case 'texture2d':
                resources.set(intAttr('id'), { kind: 'texture2d', path: attr('path') || '', contenttype: attr('contenttype') || '',
                    tileu: (attr('tilestyleu') || 'wrap').toLowerCase(), tilev: (attr('tilestylev') || 'wrap').toLowerCase() });
                break;
            case 'texture2dgroup': group = { kind: 'texgroup', texid: intAttr('texid'), uvsGrow: new Grow(Float32Array, 2048) }; resources.set(intAttr('id'), group); if (self) group = null; break;
            case 'tex2coord': if (group?.kind === 'texgroup') { group.uvsGrow.push(attrNum('u', 0)); group.uvsGrow.push(attrNum('v', 0)); } break;
            case 'multiproperties': {
                // layers of properties (e.g. colour × texture): only a colour/base layer is used
                const pids = (attr('pids') || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
                const layer = pids.find(p => ['base', 'color'].includes(resources.get(p)?.kind)) ?? -1;
                resources.set(intAttr('id'), { kind: 'multi', layer });
                unsupported.add('multiproperties');
                break;
            }
            case 'compositematerials': unsupported.add('compositematerials'); break;
            case 'beamlattice': unsupported.add('beamlattice'); break;
            case 'slicestack': unsupported.add('slicestack'); break;
            default: break;
        }
    }
    return { unit, title, resources, build, refs: [...refs], unsupported: [...unsupported] };
}

// local tag names we act on (ASCII) – compared by bytes, no string per vertex/triangle
const TAGS = ['vertex', 'triangle', 'model', 'metadata', 'object', 'mesh', 'component', 'build', 'item', 'basematerials', 'base',
    'colorgroup', 'color', 'texture2d', 'texture2dgroup', 'tex2coord', 'multiproperties', 'compositematerials', 'beamlattice', 'slicestack'];
const TAG_CODES = TAGS.map(s => [...s].map(ch => ch.charCodeAt(0)));
function tagName(bytes, s, e) {
    const n = e - s;
    for (let t = 0; t < TAGS.length; t++) {
        const code = TAG_CODES[t];
        if (code.length !== n) continue;
        let k = 0;
        while (k < n && bytes[s + k] === code[k]) k++;
        if (k === n) return TAGS[t];
    }
    return '';
}

function findSeq(bytes, from, seq) {
    const first = seq.charCodeAt(0);
    for (let i = bytes.indexOf(first, from); i >= 0; i = bytes.indexOf(first, i + 1)) {
        let k = 1;
        while (k < seq.length && bytes[i + k] === seq.charCodeAt(k)) k++;
        if (k === seq.length) return i;
    }
    return -1;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
    if (!s.includes('&')) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENTITIES[e] ?? m;
    });
}

/** Decimal number from bytes [s, e) (sign, fraction, exponent); not a number → NaN */
export function parseNum(b, s, e) {
    let i = s;
    while (i < e && isSpace(b[i])) i++;
    let neg = false;
    if (b[i] === 45) { neg = true; i++; } else if (b[i] === 43) i++;
    let m = 0, exp = 0, digits = 0, any = false;
    for (; i < e; i++) {
        const d = b[i] - 48;
        if (d < 0 || d > 9) break;
        any = true;
        if (digits < 16) { m = m * 10 + d; if (m) digits++; } else exp++;
    }
    if (b[i] === 46) {
        for (i++; i < e; i++) {
            const d = b[i] - 48;
            if (d < 0 || d > 9) break;
            any = true;
            if (digits < 16) { m = m * 10 + d; if (m) digits++; exp--; }
        }
    }
    if (!any) return NaN;
    if (b[i] === 101 || b[i] === 69) {
        i++;
        let en = false;
        if (b[i] === 45) { en = true; i++; } else if (b[i] === 43) i++;
        let x = 0;
        for (; i < e; i++) { const d = b[i] - 48; if (d < 0 || d > 9) break; x = x * 10 + d; }
        exp += en ? -x : x;
    }
    const v = exp === 0 ? m : exp > 0 ? m * 10 ** exp : m / 10 ** -exp;
    return neg ? -v : v;
}
