// MB reader (.mb, the binary scene format) – own analysis of the file (no public description of the binary form; checked on a 2018 file
// against the same model as OBJ/.xsi; no third-party code).
//
// Container: IFF with 64-bit sizes – groups "FOR8"/"LIS8"/"CAT8"/"PRO8" + 4 bytes + u64 size + 4-byte type, chunks
// ID4 + 4 bytes + u64 size + data; a chunk's data is padded to 8 bytes counted from the start of its group's content
// (after the type), groups are not padded. Older files ("FOR4", 32-bit sizes): ID4 + u32 size, padded to 4.
//   HEAD     VERS (version), LUNI linear unit ("cm", "mm", "m", "in", "ft"), FINF application info
//   a node   one group per node, its type as 4 bytes (XFRM transform, DMSH mesh, RPHO/RLAM/RBLN… materials, SHAD
//            shading group); CREA: u8 flags (0x80 = no parent), name, parent name (a short name or "|a|b" path), uuid;
//            then one chunk per attribute set: attribute name, u8 flags, data (DBLE double, DBL3 3 doubles, FLT3 floats,
//            STR string, CMP# component list …)
//   CONN     CWFL per connection: u8 flags, source plug, destination plug
// Mesh data (DMSH, chunk MESH, attribute "o"/"ci"): u32 count + float32 positions; u32 count + u32 edge vertex pairs (the
// top bit of the first is a flag – no relation to hard edges found); u32 count + per face corner an edge index (bit 31:
// edge runs backwards, bit 30: last corner of the face, bit 29: last corner of a loop – loops after the first are
// holes); u32 count + float32 normals per vertex (+ u32 when present – not used: they smooth over hard edges); u32 UV set
// count, u32, then per set: name, u32 count + float32 UVs, u32 count + u32 UV index per face corner; 20 bytes.
// Point tweaks "pt[i]" / "pt[a:b]" (FLT3) are added to the positions. Face sets: "iog[0].og[n].gcl" (CMP#: u32
// components, per component 4CC type, u32 ranges, ranges as first/last) – connected to a shading group like the whole
// shape ("iog" → "SG.dsm"); a material's "oc" → "SG.ss".
import { triangulate } from '../polygon-triangulate.js';
import { subdivideCorners } from '../subdivide.js';

// history steps passed through when following a shape's input (group parts, tweaks, group ids, transfer of attributes …)
const PASS = new Set(['GRPP', 'PTWK', 'GPID', 'PTRA', 'TRGE']);
const SMOOTH_FACES = 1e6;   // faces of one smoothed shape at most (levels lowered until it fits)

/** 'FOR8' | 'FOR4' when the bytes start an MB file, else null */
export function mbKind(bytes) {   // the form type of the file is a fixed word
    if (bytes.length < 24) return null;
    const head = String.fromCharCode(...bytes.subarray(0, 4));
    if (head !== 'FOR8' && head !== 'FOR4') return null;
    const type = String.fromCharCode(...bytes.subarray(head === 'FOR8' ? 16 : 8, head === 'FOR8' ? 20 : 12));
    return type === 'Maya' ? head : null;
}

export function parseMb(bytes, progress = () => {}) {
    const kind = mbKind(bytes);
    if (!kind) throw new Error('Not an MB file');
    const wide = kind === 'FOR8';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = p => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const cstr = (p, end) => {
        let e = p;
        while (e < end && bytes[e] !== 0) e++;
        let s = '';
        for (let i = p; i < e; i += 4096) s += String.fromCharCode(...bytes.subarray(i, Math.min(e, i + 4096)));
        try { s = decodeURIComponent(escape(s)); } catch { /* Latin-1 */ }
        return [s, e + 1];
    };
    const GROUPS = new Set(wide ? ['FOR8', 'LIS8', 'CAT8', 'PRO8'] : ['FOR4', 'LIS4', 'CAT4', 'PRO4']);
    const HEAD = wide ? 16 : 8, ALIGN = wide ? 8 : 4;
    const size = p => (wide ? Number(dv.getBigUint64(p + 8)) : dv.getUint32(p + 4));

    const result = { unit: 'cm', version: '', nodes: [], materials: {}, skipped: {} };
    const nodes = result.nodes;
    const connections = [];
    let lastReport = 0;
    // walk the groups: each group under the top one is a node (or HEAD / CONN)
    const walk = (p, end, onChunk) => {
        const base = p;
        while (p + HEAD <= end) {
            const cid = id(p), n = size(p), body = p + HEAD;
            if (GROUPS.has(cid)) { onChunk(null, body, n, id(body)); p = body + n; continue; }
            onChunk(cid, body, n, null);
            p = body + n;
            p += (ALIGN - ((p - base) % ALIGN)) % ALIGN;
        }
    };
    const top = HEAD + 4;
    walk(top, Math.min(bytes.length, HEAD + size(0)), (cid, body, n, type) => {
        if (cid !== null) return;
        if (body - lastReport > 1 << 23) { lastReport = body; progress(0.7 * body / bytes.length); }
        const end = body + n;
        if (type === 'HEAD') {
            walk(body + 4, end, (c, b, len) => {
                if (c === 'LUNI') result.unit = cstr(b, b + len)[0];
                else if (c === 'VERS') result.version = cstr(b, b + len)[0];
            });
            return;
        }
        if (type === 'CONN' || type === 'CONS') {
            // the connections: groups CONN (inside a list CONS) with one CWFL per connection
            const conn = (c, b, len, t) => {
                if (c === null) { if (t === 'CONN') walk(b + 4, b + len, conn); return; }
                if (c !== 'CWFL') return;
                const [src, q] = cstr(b + 1, b + len);
                const [dst] = cstr(q, b + len);
                connections.push([src, dst]);
            };
            walk(body + 4, end, conn);
            return;
        }
        const node = { type, name: '', parent: null, attrs: new Map(), mesh: null };
        walk(body + 4, end, (c, b, len) => {
            if (c === null) return;
            if (c === 'CREA') {
                const flags = bytes[b];
                let q;
                [node.name, q] = cstr(b + 1, b + len);
                if (!(flags & 0x80) && q < b + len) node.parent = cstr(q, b + len)[0];
                return;
            }
            if (c === 'MESH') { node.mesh = { at: b, len }; return; }
            const [name, q] = cstr(b, b + len);
            // the attribute's data after its name and one flag byte
            if (!node.attrs.has(name)) node.attrs.set(name, []);
            node.attrs.get(name).push({ type: c, at: q + 1, end: b + len });
        });
        nodes.push(node);
    });

    // --- helpers on attributes ---
    const doubles = (node, name, count) => {
        const a = node.attrs.get(name)?.[0];
        if (!a) return null;
        const out = [];
        const w = a.type.startsWith('FLT') ? 4 : 8;
        for (let i = 0; i < count && a.at + (i + 1) * w <= a.end; i++) out.push(w === 4 ? dv.getFloat32(a.at + i * 4) : dv.getFloat64(a.at + i * 8));
        return out.length === count ? out : null;
    };

    // --- names → nodes: DAG paths "|a|b|c" (nodes are created after their parents); a reference is a full path, the end of
    // a path ("b|c") or a short name – ambiguous short names (four "tire4Shape" under different wheels) are written as paths
    const byName = new Map(), byPath = new Map();
    const resolve = ref => {
        if (!ref) return -1;
        if (ref.startsWith('|')) return byPath.get(ref) ?? -1;
        const parts = ref.split('|');
        const list = byName.get(parts[parts.length - 1]);
        if (!list) return -1;
        if (parts.length === 1) return list[list.length - 1];
        const tail = '|' + ref;
        for (let i = list.length - 1; i >= 0; i--) if (nodes[list[i]].path?.endsWith(tail)) return list[i];
        return -1;
    };
    nodes.forEach((n, i) => {
        n.index = i;
        const parent = n.parent ? resolve(n.parent) : -1;
        n.parentIndex = parent;
        n.path = (parent >= 0 ? nodes[parent].path : '') + '|' + n.name;
        if (!byName.has(n.name)) byName.set(n.name, []);
        byName.get(n.name).push(i);
        byPath.set(n.path, i);
    });
    const plugNode = plug => resolve(plug.split('.')[0]);

    // --- materials: shading group → material (material.oc → SG.ss) ---
    const sgMaterial = new Map();
    for (const [src, dst] of connections) {
        if (/\.(oc|outColor)$/.test(src) && /\.(ss|surfaceShader)$/.test(dst)) sgMaterial.set(plugNode(dst), plugNode(src));
    }
    for (const n of nodes) {
        if (!/^(RPHO|RLAM|RBLN|PHNE|RANI)$/.test(n.type) && ![...sgMaterial.values()].includes(n.index)) continue;
        result.materials[n.name] = {
            name: n.name, type: n.type,
            color: doubles(n, 'c', 3) ?? [0.5, 0.5, 0.5],
            diffuse: doubles(n, 'dc', 1)?.[0] ?? 0.8,
            transparency: doubles(n, 'it', 3),
            specular: doubles(n, 'sc', 3),
            cosinePower: doubles(n, 'cp', 1)?.[0] ?? (n.type === 'RPHO' ? 20 : null),
            eccentricity: doubles(n, 'ec', 1)?.[0] ?? null,
            incandescence: doubles(n, 'ic', 3),
            reflectivity: doubles(n, 'rfl', 1)?.[0] ?? null,
        };
    }
    // shapes / face sets → shading group: "shape.iog" (whole) or "shape.iog.og[n]" (faces)
    const shapeSets = new Map();   // shape index → [{ group: n | -1, material }]
    for (const [src, dst] of connections) {
        if (!/\.(dsm|dagSetMembers)(\[\d+\])?$/.test(dst)) continue;
        const m = /\.(?:iog|instObjGroups)(?:\[\d+\])?(?:\.(?:og|objectGroups)\[(\d+)\])?$/.exec(src);
        if (!m) continue;
        const shape = plugNode(src), sg = plugNode(dst);
        const mat = sgMaterial.get(sg);
        if (shape < 0) continue;
        if (!shapeSets.has(shape)) shapeSets.set(shape, []);
        shapeSets.get(shape).push({ group: m[1] === undefined ? -1 : +m[1], material: mat >= 0 ? nodes[mat].name : '' });
    }

    // --- transforms ---
    const transforms = [];
    const transformIndex = new Map();
    for (const n of nodes) {
        if (n.type !== 'XFRM' && n.type !== 'JOIN') continue;
        transformIndex.set(n.index, transforms.length);
        const vis = doubles(n, 'v', 1);
        transforms.push({
            name: n.name, parentNode: n.parentIndex,
            t: doubles(n, 't', 3), r: doubles(n, 'r', 3), s: doubles(n, 's', 3),
            rp: doubles(n, 'rp', 3), sp: doubles(n, 'sp', 3), rpt: doubles(n, 'rpt', 3), spt: doubles(n, 'spt', 3),
            ra: doubles(n, 'ra', 3), sh: doubles(n, 'sh', 3), ro: doubles(n, 'ro', 1)?.[0] ?? 0,
            visible: !vis || vis[0] !== 0, camera: false,
        });
    }
    for (const n of nodes) if (n.type === 'DCAM') { const t = transformIndex.get(n.parentIndex); if (t !== undefined) transforms[t].camera = true; }
    for (const t of transforms) { t.parent = transformIndex.get(t.parentNode) ?? -1; delete t.parentNode; }

    // --- meshes ---
    // a shape whose mesh is the result of its construction history has no mesh data of its own: its input ("i") is followed
    // upstream through the history nodes to the shape that holds the data (a hidden intermediate one); smoothing steps on
    // the way (polySmoothFace, divisions "dv", default 1) are redone with Catmull–Clark (subdivide.js), group/tweak steps
    // are passed through, other steps are left out (counted)
    const into = new Map();   // "node index.attribute" → source plug
    for (const [src, dst] of connections) {
        const dot = dst.indexOf('.');
        const node = resolve(dst.slice(0, dot));
        if (node >= 0) into.set(node + dst.slice(dot), src);
    }
    const historyOf = n => {
        let levels = 0, plug = into.get(n.index + '.i') ?? into.get(n.index + '.inMesh');
        for (let guard = 0; plug && guard < 64; guard++) {
            const src = nodes[plugNode(plug)];
            if (!src) return null;
            if (src.type === 'DMSH') {
                if (src.mesh) return { source: src, levels };
                plug = into.get(src.index + '.i') ?? into.get(src.index + '.inMesh');
                continue;
            }
            if (src.type === 'PSMF') levels += Math.max(0, Math.round(doubles(src, 'dv', 1)?.[0] ?? 1));
            else if (!PASS.has(src.type)) result.skipped.history = (result.skipped.history || 0) + 1;
            plug = ['ip', 'ig', 'i', 'inputPolymesh', 'inputGeometry', 'inMesh'].map(a => into.get(src.index + '.' + a) ?? into.get(src.index + '.' + a + '[0]')).find(Boolean)
                ?? into.get(src.index + '.ip[0].ig') ?? into.get(src.index + '.input[0].inputGeometry');
        }
        return null;
    };
    const meshes = [];
    let done = 0, smoothFaces = 0;
    const meshNodes = nodes.filter(n => n.type === 'DMSH');
    for (const n of meshNodes) {
        const io = doubles(n, 'io', 1);
        if (io && io[0]) { result.skipped.intermediate = (result.skipped.intermediate || 0) + 1; continue; }
        const vis = doubles(n, 'v', 1);
        let source = n, levels = 0;
        if (!n.mesh) {
            const h = historyOf(n);
            if (!h) { result.skipped.noData = (result.skipped.noData || 0) + 1; continue; }
            ({ source, levels } = h);
        }
        try {
            const parts = buildMesh(n, source, levels);
            meshes.push({ name: n.name, transform: transformIndex.get(n.parentIndex) ?? -1, visible: !vis || vis[0] !== 0, parts });
        } catch (err) {
            result.skipped.broken = (result.skipped.broken || 0) + 1;
        }
        progress(0.7 + 0.3 * ++done / meshNodes.length);
    }
    result.transforms = transforms;
    result.meshes = meshes;
    return result;

    function buildMesh(n, source, levels) {
        const { at, len } = source.mesh, end = at + len;
        let q = cstr(at, end)[1] + 1;   // attribute name, flag byte
        const u32 = () => { const v = dv.getUint32(q); q += 4; return v; };
        const nPos = u32();
        let pos = new Float32Array(nPos);
        for (let i = 0; i < nPos; i++) pos[i] = dv.getFloat32(q + i * 4);
        q += nPos * 4;
        const nv0 = Math.floor(nPos / 3);
        const nEdge = u32();
        const edges = new Int32Array(nEdge);
        for (let i = 0; i < nEdge; i++) edges[i] = dv.getUint32(q + i * 4) & 0x7fffffff;
        q += nEdge * 4;
        const nCorner = u32();
        const fe = new Uint32Array(nCorner);
        for (let i = 0; i < nCorner; i++) fe[i] = dv.getUint32(q + i * 4);
        q += nCorner * 4;
        const nNrm = u32();
        q += nNrm * 4;
        if (nNrm) q += 4;
        const nSets = u32();
        q += 4;
        const sets = [];
        for (let s = 0; s < nSets && q < end; s++) {
            const [name, q2] = cstr(q, end);
            q = q2;
            const c = u32();
            const uv = new Float32Array(c);
            for (let i = 0; i < c; i++) uv[i] = dv.getFloat32(q + i * 4);
            q += c * 4;
            const ci = u32();
            const idx = new Int32Array(ci);
            for (let i = 0; i < ci; i++) idx[i] = dv.getInt32(q + i * 4);
            q += ci * 4;
            sets.push({ name, uv, idx });
        }
        if (q > end) throw new Error('mesh data beyond its chunk');
        // point tweaks (pt[i], pt[a:b]) of the shape holding the data, added to its positions
        for (const [name, list] of source.attrs) {
            const m = /^(?:pt|pnts)\[(\d+)(?::(\d+))?\]$/.exec(name);
            if (!m) continue;
            const a = +m[1], b = m[2] === undefined ? a : +m[2];
            for (const ch of list) {
                if (ch.type !== 'FLT3' && ch.type !== 'DBL3') continue;
                const w = ch.type === 'FLT3' ? 4 : 8;
                for (let v = a, o = ch.at; v <= b && v < nv0 && o + 3 * w <= ch.end; v++, o += 3 * w) {
                    for (let k = 0; k < 3; k++) pos[v * 3 + k] += w === 4 ? dv.getFloat32(o + k * 4) : dv.getFloat64(o + k * 8);
                }
            }
        }
        // faces: corner vertices from the edges (outer loop only), UVs of the current set (else the first) per corner
        const strAttr = (node, name) => { const a = node.attrs.get(name)?.[0]; return a ? cstr(a.at, a.end)[0] : ''; };
        const current = strAttr(source, 'cuvs') || strAttr(n, 'cuvs');
        const set = sets.find(s => s.name === current) ?? sets[0] ?? null;
        const offs = [0], cvL = [], uvL = [];
        let inHole = false, holes = 0;
        for (let i = 0; i < nCorner; i++) {
            const x = fe[i], e = x & 0x1fffffff;
            if (!inHole) {
                cvL.push(x & 0x80000000 ? edges[e * 2 + 1] : edges[e * 2]);
                const ui = set && i < set.idx.length ? set.idx[i] : -1;
                uvL.push(ui >= 0 && ui * 2 + 1 < set.uv.length ? set.uv[ui * 2] : 0, ui >= 0 && ui * 2 + 1 < set.uv.length ? set.uv[ui * 2 + 1] : 0);
            }
            if (x & 0x40000000) { offs.push(cvL.length); inHole = false; } else if (x & 0x20000000) { inHole = true; holes++; }
        }
        if (holes) result.skipped.holes = (result.skipped.holes || 0) + holes;
        let offsets = Int32Array.from(offs), cv = Int32Array.from(cvL), uv = set ? Float32Array.from(uvL) : null, root = null;
        for (const v of cv) if (v < 0 || v >= nv0) throw new Error('vertex index out of range');
        // smoothing from the history (Catmull–Clark like the program's default "exponential" smoothing)
        let level = levels;
        while (level > 0 && cv.length * 4 ** (level - 1) > SMOOTH_FACES) level--;
        if (level > 0) {
            const ce = new Int32Array(cv.length), map = new Map();
            for (let f = 0; f + 1 < offsets.length; f++) {
                for (let c = offsets[f]; c < offsets[f + 1]; c++) {
                    const a = cv[c], b = cv[c + 1 < offsets[f + 1] ? c + 1 : offsets[f]];
                    const key = a < b ? a * nv0 + b : b * nv0 + a;
                    let e = map.get(key);
                    if (e === undefined) map.set(key, e = map.size);
                    ce[c] = e;
                }
            }
            const r = subdivideCorners({ pos, offsets, cv, ce, ne: map.size, uv }, level);
            ({ pos, offsets, cv, uv, root } = r);
        }
        const nv = pos.length / 3, nf = offsets.length - 1;
        // face sets of the visible shape (iog[0].og[n].gcl: face ranges of its final faces – the smoothed children follow
        // their input face in order, as here) → material per face
        const faceMat = new Int32Array(nf).fill(-1);
        const shapeSetsOf = shapeSets.get(n.index) ?? [];
        const matNames = [];
        const matIndex = name => { let k = matNames.indexOf(name); if (k < 0) k = matNames.push(name) - 1; return k; };
        const whole = shapeSetsOf.find(s => s.group < 0);
        if (whole) faceMat.fill(matIndex(whole.material));
        for (const s of shapeSetsOf) {
            if (s.group < 0) continue;
            let list = n.attrs.get(`iog[0].og[${s.group}].gcl`) ?? n.attrs.get(`instObjGroups[0].objectGroups[${s.group}].objectGrpCompList`);
            let viaRoot = false;
            if (!list) {
                // the face list sits in the history: groupId → the group parts step it feeds ("gi"), its input faces ("ic")
                const gidPlug = into.get(`${n.index}.iog.og[${s.group}].gid`) ?? into.get(`${n.index}.iog[0].og[${s.group}].gid`);
                const gid = gidPlug ? plugNode(gidPlug) : -1;
                const parts = gid < 0 ? null : connections.find(([src, dst]) => plugNode(src) === gid && /\.(gi|groupId)$/.test(dst) && nodes[plugNode(dst)]?.type === 'GRPP');
                list = parts ? nodes[plugNode(parts[1])].attrs.get('ic') : null;
                viaRoot = !!list;
            }
            if (!list) continue;
            const k = matIndex(s.material);
            // faces of the input mesh: every smoothed face whose input face is in the list
            const mark = viaRoot && root ? new Uint8Array(offs.length - 1) : null;
            for (const ch of list) {
                let o = ch.at;
                const comps = dv.getUint32(o); o += 4;
                for (let c = 0; c < comps && o + 8 <= ch.end; c++) {
                    o += 4;   // component type
                    const ranges = dv.getUint32(o); o += 4;
                    for (let r = 0; r < ranges && o + 8 <= ch.end; r++, o += 8) {
                        const first = Math.max(0, dv.getInt32(o)), last = dv.getInt32(o + 4);
                        if (mark) { for (let f = first; f <= last && f < mark.length; f++) mark[f] = 1; continue; }
                        for (let f = first; f <= last && f < nf; f++) faceMat[f] = k;
                    }
                }
            }
            if (mark) for (let f = 0; f < nf; f++) if (mark[root[f]]) faceMat[f] = k;
        }
        if (!matNames.length || faceMat.includes(-1)) { const k = matIndex(''); for (let f = 0; f < nf; f++) if (faceMat[f] < 0) faceMat[f] = k; }
        if (level > 0) smoothFaces += nf;
        // triangles per material, vertices welded per (vertex, UV)
        const fn = new Float64Array(nf * 3);
        for (let f = 0; f < nf; f++) {
            let x = 0, y = 0, z = 0;
            for (let c = offsets[f], e = offsets[f + 1]; c < e; c++) {
                const a = cv[c] * 3, b = cv[c + 1 < e ? c + 1 : offsets[f]] * 3;
                x += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
                y += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
                z += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
            }
            fn[f * 3] = x; fn[f * 3 + 1] = y; fn[f * 3 + 2] = z;
        }
        const parts = matNames.map(material => ({ material, head: new Int32Array(nv).fill(-1), next: [], corner: [], index: [] }));
        const tri = [];
        for (let f = 0; f < nf; f++) {
            const cnt = offsets[f + 1] - offsets[f];
            if (cnt < 3) continue;
            const part = parts[faceMat[f]];
            tri.length = 0;
            triangulate(pos, cv, offsets[f], cnt, fn, f, tri);
            const vert = c => {
                const v0 = cv[c];
                for (let v = part.head[v0]; v >= 0; v = part.next[v]) {
                    const o = part.corner[v];
                    if (!uv || (uv[o * 2] === uv[c * 2] && uv[o * 2 + 1] === uv[c * 2 + 1])) return v;
                }
                const v = part.corner.length;
                part.corner.push(c); part.next.push(part.head[v0]); part.head[v0] = v;
                return v;
            };
            for (let k = 0; k < tri.length; k += 3) {
                const a = vert(tri[k]), b = vert(tri[k + 1]), c = vert(tri[k + 2]);
                if (a !== b && b !== c && a !== c) part.index.push(a, b, c);
            }
        }
        return parts.filter(p => p.index.length).map(p => {
            const count = p.corner.length;
            const positions = new Float32Array(count * 3);
            const uvs = uv ? new Float32Array(count * 2) : null;
            for (let v = 0; v < count; v++) {
                const c = p.corner[v], pv = cv[c] * 3;
                positions[v * 3] = pos[pv]; positions[v * 3 + 1] = pos[pv + 1]; positions[v * 3 + 2] = pos[pv + 2];
                if (uvs) { uvs[v * 2] = uv[c * 2]; uvs[v * 2 + 1] = uv[c * 2 + 1]; }
            }
            return { material: p.material, positions, uvs, index: Uint32Array.from(p.index) };
        });
    }
}
