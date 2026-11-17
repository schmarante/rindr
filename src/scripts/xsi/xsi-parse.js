// .xsi reader (.xsi, text form "xsi 0350txt 0032" and similar; own implementation after the published description of
// the exchange format). The file is a tree of templates: `TYPE [name] { values …, nested templates }`, values separated
// by commas/semicolons, strings in double quotes. Read on the bytes (files of hundreds of MB never become one string);
// numbers go into one growing buffer, a mesh is built as soon as its template closes and its numbers are dropped again.
//
//   SI_CoordinateSystem  hand (0 left, 1 right), u, v, then the direction of x, y, z (0 right, 1 left, 2 up, 3 down,
//                        4 in, 5 out)
//   SI_Angle             0 degrees, 1 radians
//   SI_MaterialLibrary   XSI_Material (connections "surface", "RealTime" … to XSI_Shader children: prog id, counts,
//                        then parameters "name","TYPE",value) or the older SI_Material (face colour rgba, power,
//                        specular rgb, emissive rgb, shading model, ambient rgb, SI_Texture2D file)
//   SI_Model             a node: SI_Transform (scale xyz, rotation xyz, translation xyz – about X first, then Y, then Z),
//                        SI_Visibility, SI_GlobalMaterial, SI_Mesh, child SI_Models
//   SI_Mesh              SI_Shape: number of arrays, "ORDERED"/"INDEXED", per array its count, kind (POSITION, NORMAL,
//                        COLOR, TEX_COORD_UV… + projection name) and values (INDEXED: each with its index first);
//                        SI_PolygonList: polygons, elements ("NORMAL|TEX_COORD_UV0" …), material, corners, the corner
//                        count per polygon, the position index per corner, then one index array per element in the order
//                        of the element string; SI_TriangleList: the same with three corners each
//
// Result: { models (tree), meshes (per SI_Mesh its parts: one per polygon list), materials, coordinateSystem, radians }.
import { triangulate } from '../polygon-triangulate.js';

/** { version, binary } of a .xsi header, else null */
export function xsiHeader(bytes) {
    const head = String.fromCharCode(...bytes.subarray(0, Math.min(16, bytes.length)));
    const m = /^xsi (\d{4})(txt|bin)/.exec(head);
    return m ? { version: m[1], binary: m[2] === 'bin' } : null;
}

const WS = new Uint8Array(256);
for (const c of ' \t\r\n,;') WS[c.charCodeAt(0)] = 1;
const STOP = new Uint8Array(256);   // ends an identifier or a number
for (const c of ' \t\r\n,;{}"') STOP[c.charCodeAt(0)] = 1;

export function parseXsi(bytes, progress = () => {}) {
    const n = bytes.length;
    const header = xsiHeader(bytes);
    if (!header) throw new Error('Not an .xsi file');
    if (header.binary) throw new Error('Binary .xsi is not supported');
    let num = new Float64Array(1 << 20), nNum = 0;
    const pushNum = x => {
        if (nNum === num.length) { const g = new Float64Array(num.length * 2); g.set(num); num = g; }
        num[nNum++] = x;
    };
    const text = (a, b) => {
        let s = '';
        for (let i = a; i < b; i += 4096) s += String.fromCharCode(...bytes.subarray(i, Math.min(b, i + 4096)));
        try { return decodeURIComponent(escape(s)); } catch { return s; }
    };
    const meshes = [];
    const result = { models: [], meshes, materials: new Map(), coordinateSystem: null, radians: false, writer: '', skipped: {} };
    const root = { type: '', name: '', items: [], children: [] };
    const stack = [root];
    let node = root;
    let p = bytes.indexOf(10) + 1;   // after the header line
    let lastReport = 0;
    const addNum = x => {
        const items = node.items, last = items[items.length - 1];
        if (last && typeof last === 'object' && last.e === nNum) last.e++;
        else items.push({ s: nNum, e: nNum + 1 });
        pushNum(x);
    };
    while (p < n) {
        const c = bytes[p];
        if (WS[c]) { p++; continue; }
        if (c === 125) {   // }
            p++;
            if (stack.length > 1) {
                const done = stack.pop();
                node = stack[stack.length - 1];
                closed(done);
            }
            continue;
        }
        if (c === 34) {   // "
            const e = bytes.indexOf(34, p + 1);
            const end = e < 0 ? n : e;
            node.items.push(text(p + 1, end));
            p = end + 1;
            continue;
        }
        if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
            // number (own parser – no substrings); "-1.#IND00" and other non-numbers → 0
            let q = p, sign = 1, v = 0, ok = false;
            if (bytes[q] === 45) { sign = -1; q++; } else if (bytes[q] === 43) q++;
            while (q < n && bytes[q] >= 48 && bytes[q] <= 57) { v = v * 10 + bytes[q] - 48; q++; ok = true; }
            if (bytes[q] === 46) {
                q++;
                let f = 0.1;
                while (q < n && bytes[q] >= 48 && bytes[q] <= 57) { v += (bytes[q] - 48) * f; f *= 0.1; q++; ok = true; }
            }
            if (ok && (bytes[q] === 101 || bytes[q] === 69)) {
                q++;
                let es = 1, ev = 0;
                if (bytes[q] === 45) { es = -1; q++; } else if (bytes[q] === 43) q++;
                while (q < n && bytes[q] >= 48 && bytes[q] <= 57) { ev = ev * 10 + bytes[q] - 48; q++; }
                v *= 10 ** (es * ev);
            }
            if (q < n && !STOP[bytes[q]]) { while (q < n && !STOP[bytes[q]]) q++; v = 0; }
            addNum(ok ? sign * v : 0);
            p = q;
            continue;
        }
        if (c === 123) { p++; continue; }   // stray {
        // a template: TYPE [name] {
        let q = p;
        while (q < n && !STOP[bytes[q]]) q++;
        const type = text(p, q);
        while (q < n && WS[bytes[q]] && bytes[q] !== 44) q++;
        let name = '';
        if (bytes[q] !== 123) {
            const s = q;
            while (q < n && !STOP[bytes[q]]) q++;
            name = text(s, q);
            while (q < n && WS[bytes[q]]) q++;
        }
        if (bytes[q] !== 123) { node.items.push(type); if (name) node.items.push(name); p = q; continue; }   // a bare word
        p = q + 1;
        const child = { type, name, items: [], children: [], numStart: nNum };
        node.children.push(child);
        stack.push(child);
        node = child;
        if (p - lastReport > 1 << 23) { lastReport = p; progress(p / n); }
    }

    // a template closed: meshes are built right away (their numbers dropped), the rest stays in the tree
    function closed(t) {
        if (t.type === 'SI_Mesh') {
            t.mesh = meshes.push(buildMesh(t)) - 1;
            t.children = []; t.items = [];
            nNum = t.numStart;
        } else if (t.type === 'XSI_Mesh') {
            result.skipped.xsiMesh = (result.skipped.xsiMesh || 0) + 1;
            t.children = []; t.items = [];
            nNum = t.numStart;
        }
    }

    // values of a template one by one: numbers out of their runs, strings as they are
    function cursor(t) {
        let i = 0, k = -1;
        const items = t.items;
        const at = () => {
            while (i < items.length) {
                const it = items[i];
                if (typeof it !== 'object') return it;
                if (k < 0) k = it.s;
                if (k < it.e) return it;
                i++; k = -1;
            }
            return undefined;
        };
        return {
            num() { const it = at(); if (typeof it !== 'object') { if (it !== undefined) i++; return NaN; } return num[k++]; },
            str() { const it = at(); if (typeof it === 'object' || it === undefined) return null; i++; return it; },
            isStr() { const it = at(); return it !== undefined && typeof it !== 'object'; },
            done() { return at() === undefined; },
            ints(count) {
                const out = new Int32Array(count);
                for (let j = 0; j < count; j++) out[j] = this.num();
                return out;
            },
        };
    }

    function buildMesh(t) {
        const shape = t.children.find(c => c.type === 'SI_Shape');
        const arrays = new Map();   // kind → { dim, values }
        if (shape) {
            const cur = cursor(shape);
            const count = cur.num();
            const indexed = String(cur.str()).toUpperCase() === 'INDEXED';
            for (let a = 0; a < count && !cur.done(); a++) {
                const nEl = cur.num();
                const kind = String(cur.str() || '').toUpperCase();
                if (kind.startsWith('TEX_COORD') && cur.isStr()) cur.str();   // projection name
                const dim = kind === 'POSITION' || kind === 'NORMAL' ? 3 : kind === 'COLOR' ? 4 : kind.startsWith('TEX_COORD_UVW') ? 3 : kind.startsWith('TEX_COORD') ? 2 : 3;
                const values = new Float32Array(nEl * dim);
                for (let e = 0; e < nEl; e++) {
                    const at = indexed ? cur.num() : e;
                    for (let d = 0; d < dim; d++) {
                        const v = cur.num();
                        if (at >= 0 && at < nEl) values[at * dim + d] = v;
                    }
                }
                arrays.set(kind, { dim, values, count: nEl });
            }
        }
        const positions = arrays.get('POSITION');
        const parts = [];
        if (!positions) return { name: t.name, parts };
        for (const list of t.children) {
            const tri = list.type === 'SI_TriangleList';
            if (list.type !== 'SI_PolygonList' && !tri) {
                if (list.type === 'SI_TriStrip' || list.type === 'SI_TriangleStripList') result.skipped.strips = (result.skipped.strips || 0) + 1;
                continue;
            }
            const cur = cursor(list);
            const nPoly = cur.num();
            const elements = cur.isStr() ? String(cur.str()).toUpperCase().split('|').filter(Boolean) : [];
            const material = cur.isStr() ? cur.str() : '';
            let nCorner, counts;
            if (tri) { nCorner = nPoly * 3; counts = new Int32Array(nPoly).fill(3); } else { nCorner = cur.num(); counts = cur.ints(nPoly); }
            const posIdx = cur.ints(nCorner);
            const idx = elements.map(() => cur.ints(nCorner));
            // the index arrays follow the element string – checked against the array sizes, other orders tried else
            const sizeOf = el => arrays.get(el)?.count ?? (el.startsWith('TEX_COORD') ? [...arrays].find(([k]) => k.startsWith('TEX_COORD'))?.[1].count : undefined);
            const fits = order => order.every((el, k) => { const size = sizeOf(el); if (size === undefined) return false; for (const x of idx[k]) if (x < 0 || x >= size) return false; return true; });
            let order = elements;
            if (!fits(order)) order = permutations(elements).find(fits) ?? elements.map(() => '');
            const arrayOf = el => arrays.get(el) ?? (el.startsWith('TEX_COORD') ? [...arrays].find(([k]) => k.startsWith('TEX_COORD'))?.[1] : null);
            let nIdx = null, uvIdx = null, colIdx = null, nArr = null, uvArr = null, colArr = null;
            order.forEach((el, k) => {
                if (el === 'NORMAL' && !nIdx) { nIdx = idx[k]; nArr = arrayOf(el); }
                else if (el.startsWith('TEX_COORD') && !uvIdx) { uvIdx = idx[k]; uvArr = arrayOf(el); }
                else if (el === 'COLOR' && !colIdx) { colIdx = idx[k]; colArr = arrayOf(el); }
            });
            parts.push(buildPart(list.name, material, positions, counts, posIdx, nIdx, nArr, uvIdx, uvArr, colIdx, colArr));
        }
        return { name: t.name, parts };
    }

    // corners → welded vertices (same position, normal, UV, colour index) and triangles
    function buildPart(name, material, positions, counts, posIdx, nIdx, nArr, uvIdx, uvArr, colIdx, colArr) {
        const pos = positions.values, np = positions.count;
        const nf = counts.length;
        const offsets = new Int32Array(nf + 1);
        for (let f = 0; f < nf; f++) offsets[f + 1] = offsets[f] + Math.max(counts[f], 0);
        const nc = Math.min(offsets[nf], posIdx.length);
        const fn = new Float64Array(nf * 3);
        for (let f = 0; f < nf; f++) {
            let x = 0, y = 0, z = 0;
            for (let c = offsets[f], e = Math.min(offsets[f + 1], nc); c < e; c++) {
                const a = posIdx[c] * 3, b = posIdx[c + 1 < e ? c + 1 : offsets[f]] * 3;
                x += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
                y += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
                z += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
            }
            fn[f * 3] = x; fn[f * 3 + 1] = y; fn[f * 3 + 2] = z;
        }
        const head = new Int32Array(np).fill(-1);
        let next = new Int32Array(1024), corner = new Int32Array(1024), nv = 0;
        const vertex = c => {
            const v0 = posIdx[c];
            for (let v = head[v0]; v >= 0; v = next[v]) {
                const o = corner[v];
                if ((nIdx && nIdx[o] !== nIdx[c]) || (uvIdx && uvIdx[o] !== uvIdx[c]) || (colIdx && colIdx[o] !== colIdx[c])) continue;
                return v;
            }
            if (nv === next.length) { const g = new Int32Array(nv * 2); g.set(next); next = g; const h = new Int32Array(nv * 2); h.set(corner); corner = h; }
            next[nv] = head[v0]; head[v0] = nv; corner[nv] = c;
            return nv++;
        };
        let index = new Uint32Array(Math.max(nc * 2, 3)), ni = 0;
        const tri = [];
        for (let f = 0; f < nf; f++) {
            const c0 = offsets[f], cnt = Math.min(offsets[f + 1], nc) - c0;
            if (cnt < 3) continue;
            let bad = false;
            for (let c = c0; c < c0 + cnt; c++) if (posIdx[c] < 0 || posIdx[c] >= np) bad = true;
            if (bad) continue;
            tri.length = 0;
            triangulate(pos, posIdx, c0, cnt, fn, f, tri);
            for (let k = 0; k < tri.length; k += 3) {
                const a = vertex(tri[k]), b = vertex(tri[k + 1]), c = vertex(tri[k + 2]);
                if (a === b || b === c || a === c) continue;
                if (ni + 3 > index.length) { const g = new Uint32Array(index.length * 2); g.set(index); index = g; }
                index[ni++] = a; index[ni++] = b; index[ni++] = c;
            }
        }
        // the file's normals must face the way of their polygons – some exporters write normal indices that do not belong
        // to the corners (a van: whole parts with ~45 % of the corners against their polygon, 40 % across it); below 90 %
        // they are dropped and computed again (mesh-importer.js: creased, 30°)
        let useNormals = !!(nIdx && nArr);
        if (useNormals) {
            let ok = 0, all = 0;
            for (let f = 0; f < nf; f++) {
                const l = Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
                if (!(l > 0)) continue;
                for (let c = offsets[f], e = Math.min(offsets[f + 1], nc); c < e; c++) {
                    const q = nIdx[c] * 3;
                    if (q < 0 || q + 2 >= nArr.values.length) continue;
                    all++;
                    if (fn[f * 3] * nArr.values[q] + fn[f * 3 + 1] * nArr.values[q + 1] + fn[f * 3 + 2] * nArr.values[q + 2] > 0) ok++;
                }
            }
            if (all && ok < 0.9 * all) { useNormals = false; result.skipped.badNormals = (result.skipped.badNormals || 0) + 1; }
        }
        const outPos = new Float32Array(nv * 3);
        const outN = useNormals ? new Float32Array(nv * 3) : null;
        const outUv = uvIdx && uvArr ? new Float32Array(nv * 2) : null;
        const outCol = colIdx && colArr ? new Float32Array(nv * 3) : null;
        for (let v = 0; v < nv; v++) {
            const c = corner[v], pi = posIdx[c] * 3;
            outPos[v * 3] = pos[pi]; outPos[v * 3 + 1] = pos[pi + 1]; outPos[v * 3 + 2] = pos[pi + 2];
            if (outN) { const q = nIdx[c] * 3; outN[v * 3] = nArr.values[q]; outN[v * 3 + 1] = nArr.values[q + 1]; outN[v * 3 + 2] = nArr.values[q + 2]; }
            if (outUv) { const q = uvIdx[c] * uvArr.dim; outUv[v * 2] = uvArr.values[q]; outUv[v * 2 + 1] = uvArr.values[q + 1]; }
            if (outCol) { const q = colIdx[c] * 4; outCol[v * 3] = colArr.values[q]; outCol[v * 3 + 1] = colArr.values[q + 1]; outCol[v * 3 + 2] = colArr.values[q + 2]; }
        }
        return { name, material, positions: outPos, normals: outN, uvs: outUv, colors: outCol, index: index.slice(0, ni) };
    }

    // --- the tree: coordinate system, angles, materials, models ---
    for (const t of root.children) {
        if (t.type === 'SI_FileInfo') {
            // project, user, date, originator – the exporting program is recognised by it (units, axes: xsi-build.js)
            const cur = cursor(t);
            const s = [];
            while (!cur.done()) { const v = cur.isStr() ? cur.str() : (cur.num(), null); if (v) s.push(v); }
            result.writer = s.slice(-1)[0] || '';
        } else if (t.type === 'SI_CoordinateSystem') {
            const cur = cursor(t);
            result.coordinateSystem = [0, 0, 0, 0, 0, 0].map(() => cur.num());
        } else if (t.type === 'SI_Angle') result.radians = cursor(t).num() === 1;
        else if (t.type === 'SI_MaterialLibrary') for (const m of t.children) readMaterial(m);
        else if (t.type === 'SI_Model') result.models.push(readModel(t));
        else if (t.type === 'SI_Material') readMaterial(t);
        else if (t.type === 'SI_Camera' || t.type === 'SI_Light' || t.type === 'XSI_Model') result.skipped[t.type] = (result.skipped[t.type] || 0) + 1;
    }
    result.materials = Object.fromEntries(result.materials);

    function readModel(t) {
        const model = { name: t.name, transform: null, visible: true, material: null, meshes: [], children: [] };
        for (const c of t.children) {
            if (c.type === 'SI_Transform' && (!model.transform || c.name.startsWith('SRT-'))) {
                const cur = cursor(c);
                const v = [];
                for (let i = 0; i < 9; i++) v.push(cur.num());
                if (v.every(Number.isFinite)) model.transform = v;
            } else if (c.type === 'SI_Visibility') model.visible = cursor(c).num() !== 0;
            else if (c.type === 'SI_GlobalMaterial') model.material = cursor(c).str();
            else if (c.type === 'SI_Mesh' && c.mesh !== undefined) model.meshes.push(c.mesh);
            else if (c.type === 'SI_Model') model.children.push(readModel(c));
            else if (c.type === 'SI_Camera' || c.type === 'SI_Light' || c.type === 'SI_Nurbs' || c.type === 'SI_Patch' || c.type === 'SI_PatchSurface' || c.type === 'SI_NurbsSurface') result.skipped[c.type] = (result.skipped[c.type] || 0) + 1;
        }
        return model;
    }

    function readMaterial(t) {
        const mat = { name: t.name, diffuse: null, specular: null, shininess: null, emissive: null, opacity: 1, texture: null };
        if (t.type === 'SI_Material') {
            // face colour rgba, power, specular rgb, emissive rgb, shading model, ambient rgb
            const cur = cursor(t);
            const v = [];
            for (let i = 0; i < 15 && !cur.done(); i++) v.push(cur.num());
            mat.diffuse = v.slice(0, 3); mat.opacity = Number.isFinite(v[3]) ? v[3] : 1;
            mat.shininess = v[4]; mat.specular = v.slice(5, 8); mat.emissive = v.slice(8, 11);
            const tex = t.children.find(c => c.type === 'SI_Texture2D');
            if (tex) {
                // file, mapping, width, height, crop (4), uv swap, u/v repeat, u/v alternate, u/v scale, u/v offset, …
                const cur = cursor(tex);
                mat.texture = cur.str();
                const v = [];
                for (let i = 0; i < 16 && !cur.done(); i++) v.push(cur.num());
                const sc = [v[12], v[13]], of = [v[14], v[15]];
                if ([...sc, ...of].every(Number.isFinite) && sc[0] && sc[1]) mat.textureTransform = { scale: sc, offset: of };
            }
        } else if (t.type === 'XSI_Material') {
            // the shaders' parameters: a surface shader (phong/lambert/blinn …) wins over the real-time one
            const shaders = t.children.filter(c => c.type === 'XSI_Shader').map(readShader);
            const surface = shaders.find(s => /material-(phong|lambert|blinn|cooktorr|constant|strauss|aniso)/i.test(s.progId));
            const realtime = shaders.find(s => /OGLShade/i.test(s.progId));
            const get = (s, key) => s?.params.get(key.toLowerCase());
            const rgb = (s, key) => { const r = get(s, key + '.red'); return r === undefined ? null : [r, get(s, key + '.green') ?? r, get(s, key + '.blue') ?? r]; };
            if (surface) {
                mat.diffuse = rgb(surface, 'diffuse');
                mat.specular = rgb(surface, 'specular');
                mat.shininess = get(surface, 'shiny');
                mat.emissive = rgb(surface, 'incandescence');
                const tr = rgb(surface, 'transparency');
                if (tr && get(surface, 'trans_glossy') === undefined) mat.transmission = (tr[0] + tr[1] + tr[2]) / 3;
                mat.ior = get(surface, 'index_of_refraction');
                const refl = rgb(surface, 'reflectivity');
                if (refl) mat.reflectivity = (refl[0] + refl[1] + refl[2]) / 3;
            }
            if (realtime && !mat.diffuse) {
                mat.diffuse = rgb(realtime, 'Diffuse');
                mat.opacity = get(realtime, 'Diffuse.alpha') ?? 1;
                mat.specular = rgb(realtime, 'Specular');
                mat.shininess = get(realtime, 'Shininess');
                mat.emissive = rgb(realtime, 'Emissive');
            }
        } else return;
        result.materials.set(t.name, mat);
    }
    function readShader(s) {
        // prog id, then counts, then parameters "name","TYPE",value (connections: "name","source","SHADER")
        const params = new Map();
        const items = [];
        for (const it of s.items) {
            if (typeof it === 'object') for (let k = it.s; k < it.e; k++) items.push(num[k]);
            else items.push(it);
        }
        const progId = typeof items[0] === 'string' ? items[0] : '';
        for (let i = 1; i + 2 < items.length; i++) {
            if (typeof items[i] === 'string' && typeof items[i + 1] === 'string' && typeof items[i + 2] === 'number'
                && /^(FLOAT|INTEGER|BOOLEAN|DOUBLE|INT)$/i.test(items[i + 1])) {
                params.set(items[i].toLowerCase(), items[i + 2]);
                i += 2;
            }
        }
        return { name: s.name, progId, params };
    }

    progress(1);
    return result;
}

function permutations(list) {
    if (list.length <= 1) return [list];
    if (list.length > 5) return [];
    const out = [];
    list.forEach((x, i) => { for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...rest]); });
    return out;
}
