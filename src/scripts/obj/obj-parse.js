// OBJ reader (.obj, Wavefront text format): read straight from the bytes – a 440 MB file as one string (three.js'
// OBJLoader) is beyond what a tab can hold. Lines: v (x y z), vt (u v), vn (x y z), f (v, v/vt, v//vn, v/vt/vn – also
// negative = relative; polygons as a fan), o / g (a new part), usemtl (material), mtllib (material files); s and
// everything else ignored. Per (group, material) the corners are welded by their (v, vt, vn) triple (hash table) – one
// vertex each, an index into them. A group that is a closed mesh wound inwards is turned outwards (orient-outward.js).

import { orientOutward } from '../orient-outward.js';

const NL = 10, CR = 13, SP = 32, TAB = 9, SLASH = 47, MINUS = 45, PLUS = 43, DOT = 46, HASH = 35;

/**
 * @param {Uint8Array} bytes
 * @param {(done: number) => void} [onProgress]  share of the file read
 * @returns {{ mtllibs: string[], groups: { name: string, parts: { material: string, positions: Float32Array,
 *   normals: Float32Array|null, uvs: Float32Array|null, index: Uint32Array }[] }[] }}
 */
export function parseObj(bytes, onProgress = () => {}) {
    const n = bytes.length;
    let p = 0;
    const v = new Grow(Float32Array), vt = new Grow(Float32Array), vn = new Grow(Float32Array);
    const groups = [];
    const mtllibs = [];
    const head = new TextDecoder().decode(bytes.subarray(0, 200));
    const writer = /^#\s*Blender/m.test(head) ? 'blender' : null;
    let group = null, part = null, material = '';
    const newGroup = name => { group = { name, parts: new Map() }; groups.push(group); part = null; };
    const currentPart = () => {
        if (!group) newGroup('');
        if (!part || part.material !== material) {
            part = group.parts.get(material);
            if (!part) { part = new Part(material); group.parts.set(material, part); }
        }
        return part;
    };
    // number at p (after spaces): sign, digits, fraction, exponent
    const skipSpaces = () => { while (p < n && (bytes[p] === SP || bytes[p] === TAB)) p++; };
    const number = () => {
        skipSpaces();
        let sign = 1;
        if (bytes[p] === MINUS) { sign = -1; p++; } else if (bytes[p] === PLUS) p++;
        let x = 0, c;
        while (p < n && (c = bytes[p] - 48) >= 0 && c <= 9) { x = x * 10 + c; p++; }
        if (bytes[p] === DOT) {
            p++;
            let f = 0.1;
            while (p < n && (c = bytes[p] - 48) >= 0 && c <= 9) { x += c * f; f *= 0.1; p++; }
        }
        if (bytes[p] === 101 || bytes[p] === 69) {   // e / E
            p++;
            let es = 1;
            if (bytes[p] === MINUS) { es = -1; p++; } else if (bytes[p] === PLUS) p++;
            let e = 0;
            while (p < n && (c = bytes[p] - 48) >= 0 && c <= 9) { e = e * 10 + c; p++; }
            x *= Math.pow(10, es * e);
        }
        return sign * x;
    };
    const integer = () => {
        let sign = 1;
        if (bytes[p] === MINUS) { sign = -1; p++; }
        let x = 0, c, any = false;
        while (p < n && (c = bytes[p] - 48) >= 0 && c <= 9) { x = x * 10 + c; p++; any = true; }
        return any ? sign * x : 0;
    };
    const restOfLine = () => {
        skipSpaces();
        const start = p;
        while (p < n && bytes[p] !== NL && bytes[p] !== CR) p++;
        return new TextDecoder().decode(bytes.subarray(start, p)).trim();
    };
    const endLine = () => { while (p < n && bytes[p] !== NL) p++; p++; };
    // one face: its corners as (v, vt, vn) triples (1-based, 0 = none), fanned into triangles
    const corner = new Int32Array(3 * 64);
    let next = 1 << 22;
    while (p < n) {
        if (p > next) { next = p + (1 << 22); onProgress(p / n); }
        skipSpaces();
        const c0 = bytes[p], c1 = bytes[p + 1];
        if (c0 === NL || c0 === CR || c0 === HASH) { endLine(); continue; }
        if (c0 === 118 /* v */) {
            if (c1 === SP || c1 === TAB) { p += 2; v.push3(number(), number(), number()); endLine(); continue; }
            if (c1 === 116 /* t */) { p += 2; vt.push2(number(), number()); endLine(); continue; }
            if (c1 === 110 /* n */) { p += 2; vn.push3(number(), number(), number()); endLine(); continue; }
        }
        if (c0 === 102 /* f */ && (c1 === SP || c1 === TAB)) {
            p += 2;
            let k = 0;
            const nv = v.length / 3, nt = vt.length / 2, nn = vn.length / 3;
            for (;;) {
                skipSpaces();
                const b = bytes[p];
                if (p >= n || b === NL || b === CR || b === HASH) break;
                let a = integer(), t = 0, m = 0;
                if (bytes[p] === SLASH) {
                    p++;
                    if (bytes[p] !== SLASH) t = integer();
                    if (bytes[p] === SLASH) { p++; m = integer(); }
                }
                if (a < 0) a = nv + a + 1;
                if (t < 0) t = nt + t + 1;
                if (m < 0) m = nn + m + 1;
                if (k < 64) { corner[k * 3] = a; corner[k * 3 + 1] = t; corner[k * 3 + 2] = m; k++; }
                while (p < n && bytes[p] !== SP && bytes[p] !== TAB && bytes[p] !== NL && bytes[p] !== CR) p++;   // stray characters
            }
            if (k >= 3) {
                const pt = currentPart();
                for (let i = 1; i + 1 < k; i++) {
                    pt.corner(corner[0], corner[1], corner[2]);
                    pt.corner(corner[i * 3], corner[i * 3 + 1], corner[i * 3 + 2]);
                    pt.corner(corner[i * 3 + 3], corner[i * 3 + 4], corner[i * 3 + 5]);
                }
            }
            endLine();
            continue;
        }
        // keywords with a name
        const word = keyword(bytes, p);
        if (word === 'o' || word === 'g') { p += 1; newGroup(restOfLine()); endLine(); continue; }
        if (word === 'usemtl') { p += 6; material = restOfLine(); part = null; endLine(); continue; }
        if (word === 'mtllib') { p += 6; const name = restOfLine(); if (name) mtllibs.push(name); endLine(); continue; }
        endLine();
    }
    onProgress(1);
    const V = v.view(), T = vt.view(), N = vn.view();
    const out = [];
    for (const g of groups) {
        const parts = [];
        for (const pt of g.parts.values()) if (pt.size) parts.push(pt.build(V, T, N));
        orientOutward(parts);
        if (parts.length) out.push({ name: g.name, parts });
    }
    return { mtllibs, groups: out, writer };
}

function keyword(bytes, p) {
    let s = '';
    for (let i = p; i < p + 8 && i < bytes.length; i++) {
        const b = bytes[i];
        if (b === SP || b === TAB || b === NL || b === CR) break;
        s += String.fromCharCode(b);
    }
    return s;
}

// growable typed array
class Grow {
    constructor(Type) { this.Type = Type; this.a = new Type(1 << 16); this.length = 0; }
    ensure(k) {
        if (this.length + k <= this.a.length) return;
        const b = new this.Type(Math.max(this.a.length * 2, this.length + k));
        b.set(this.a.subarray(0, this.length));
        this.a = b;
    }
    push2(x, y) { this.ensure(2); this.a[this.length++] = x; this.a[this.length++] = y; }
    push3(x, y, z) { this.ensure(3); this.a[this.length++] = x; this.a[this.length++] = y; this.a[this.length++] = z; }
    view() { return this.a.subarray(0, this.length); }
}

// the corners of one (group, material): triples welded through an open-addressing hash table
class Part {
    constructor(material) {
        this.material = material;
        this.keys = new Grow(Int32Array);    // per vertex: v, vt, vn
        this.index = new Grow(Uint32Array);
        this.table = new Int32Array(1 << 12);   // vertex + 1, 0 = empty
        this.mask = this.table.length - 1;
        this.size = 0;
    }
    corner(a, t, m) {
        let h = Math.imul(a, 73856093) ^ Math.imul(t, 19349663) ^ Math.imul(m, 83492791);
        let slot = (h ^ (h >>> 15)) & this.mask;
        const K = this.keys.a;
        for (;;) {
            const e = this.table[slot];
            if (e === 0) break;
            const i = (e - 1) * 3;
            if (K[i] === a && K[i + 1] === t && K[i + 2] === m) { this.push(e - 1); return; }
            slot = (slot + 1) & this.mask;
        }
        const vi = this.size++;
        this.keys.ensure(3);
        this.keys.a[this.keys.length++] = a; this.keys.a[this.keys.length++] = t; this.keys.a[this.keys.length++] = m;
        this.table[slot] = vi + 1;
        this.push(vi);
        if (this.size * 2 > this.table.length) this.rehash();
    }
    push(vi) { this.index.ensure(1); this.index.a[this.index.length++] = vi; }
    rehash() {
        const table = new Int32Array(this.table.length * 2), mask = table.length - 1, K = this.keys.a;
        for (let vi = 0; vi < this.size; vi++) {
            const a = K[vi * 3], t = K[vi * 3 + 1], m = K[vi * 3 + 2];
            let h = Math.imul(a, 73856093) ^ Math.imul(t, 19349663) ^ Math.imul(m, 83492791);
            let slot = (h ^ (h >>> 15)) & mask;
            while (table[slot] !== 0) slot = (slot + 1) & mask;
            table[slot] = vi + 1;
        }
        this.table = table;
        this.mask = mask;
    }
    build(V, T, N) {
        const n = this.size, K = this.keys.a;
        const positions = new Float32Array(n * 3);
        let hasUv = false, hasNormal = false;
        for (let i = 0; i < n; i++) { if (K[i * 3 + 1] > 0) hasUv = true; if (K[i * 3 + 2] > 0) hasNormal = true; }
        const uvs = hasUv ? new Float32Array(n * 2) : null, normals = hasNormal ? new Float32Array(n * 3) : null;
        for (let i = 0; i < n; i++) {
            const a = (K[i * 3] - 1) * 3, t = (K[i * 3 + 1] - 1) * 2, m = (K[i * 3 + 2] - 1) * 3;
            if (a >= 0 && a + 2 < V.length) { positions[i * 3] = V[a]; positions[i * 3 + 1] = V[a + 1]; positions[i * 3 + 2] = V[a + 2]; }
            if (uvs && t >= 0 && t + 1 < T.length) { uvs[i * 2] = T[t]; uvs[i * 2 + 1] = T[t + 1]; }
            if (normals && m >= 0 && m + 2 < N.length) { normals[i * 3] = N[m]; normals[i * 3 + 1] = N[m + 1]; normals[i * 3 + 2] = N[m + 2]; }
        }
        // free the hash data early (large files)
        const index = this.index.view().slice();
        this.keys = this.index = this.table = null;
        return { material: this.material, positions, normals, uvs, index };
    }
}

/** MTL text → { name: { Kd, Ks, Ke, Ns, d, Ni, Pr, Pm, map_Kd, map_Bump, norm, map_Ke, map_d, map_Pr, map_Pm } } */
export function parseMtl(text) {
    const out = {};
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line[0] === '#') continue;
        const sp = line.search(/\s/);
        const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase(), rest = sp < 0 ? '' : line.slice(sp + 1).trim();
        if (key === 'newmtl') { cur = out[rest] = {}; continue; }
        if (!cur) continue;
        if (key.startsWith('map_') || key === 'bump' || key === 'norm' || key === 'disp' || key === 'refl') {
            // options (-bm 1.0, -s 1 1 1 …) before the file name
            const tokens = rest.split(/\s+/);
            let i = 0;
            const ARGS = { '-bm': 1, '-blendu': 1, '-blendv': 1, '-boost': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-clamp': 1, '-imfchan': 1, '-type': 1 };
            while (i < tokens.length && ARGS[tokens[i]] !== undefined) {
                if (tokens[i] === '-bm') cur.bumpScale = parseFloat(tokens[i + 1]);
                if (tokens[i] === '-s') cur[key + '_scale'] = tokens.slice(i + 1, i + 3).map(Number);
                i += 1 + ARGS[tokens[i]];
            }
            cur[key === 'bump' ? 'map_bump' : key] = tokens.slice(i).join(' ');
            continue;
        }
        const nums = rest.split(/\s+/).map(Number);
        cur[key] = nums.length === 1 ? nums[0] : nums;
    }
    return out;
}
