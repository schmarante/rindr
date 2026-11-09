// DXF reader: ASCII (R12 … current, any line ends) and binary DXF → drawing model (drawing.js). Runs in the CAD worker.
//
// A DXF file is a sequence of group pairs: a group code (an integer – its range gives the value type) and a value. Objects
// start with code 0 (type name), sections with 0 SECTION / 2 <name> and end with 0 ENDSEC. Each object is collected as its
// list of pairs (codes + typed values), then converted by type into the records described in drawing.js.
// Bytes only up to the pairs (no string per line): files of several hundred MB stay manageable.
import { Drawing, ACI_BYLAYER, ACI_BYBLOCK, ACI_BYOBJECT, LW_BYLAYER } from './drawing.js';

const BINARY_SENTINEL = [65, 117, 116, 111, 67, 65, 68, 32, 66, 105, 110, 97, 114, 121, 32, 68, 88, 70, 13, 10, 26, 0];

// value type of a group code: 's' string, 'f' double, 'i' integer, 'b' binary chunk (hex in ASCII files)
function codeType(c) {
    if (c < 10) return 's';
    if (c < 60) return 'f';
    if (c < 100) return 'i';
    if (c < 110) return 's';             // 100 subclass, 101, 102 groups, 105 handle
    if (c < 150) return 'f';
    if (c < 160) return 'f';
    if (c < 180) return 'i';
    if (c < 210) return 's';
    if (c < 240) return 'f';
    if (c < 300) return 'i';             // 270–289 int16, 290–299 bool
    if (c < 310) return 's';
    if (c < 320) return 'b';
    if (c < 370) return 's';             // handles
    if (c < 390) return 'i';
    if (c < 400) return 's';
    if (c < 410) return 'i';
    if (c < 420) return 's';
    if (c < 430) return 'i';
    if (c < 440) return 's';
    if (c < 460) return 'i';
    if (c < 470) return 'f';
    if (c < 482) return 's';
    if (c === 999) return 's';
    if (c === 1004) return 'b';
    if (c < 1010) return 's';
    if (c < 1060) return 'f';
    if (c < 1072) return 'i';
    return 's';
}
const TYPES = new Array(1072);
for (let c = 0; c < 1072; c++) TYPES[c] = codeType(c);
const typeOf = c => (c >= 0 && c < 1072 ? TYPES[c] : 's');

// binary DXF value sizes (R13+: 2-byte codes; R12: 1 byte, 255 = 2 more)
function binarySize(c) {
    if ((c >= 290 && c < 300)) return 1;
    if ((c >= 60 && c < 80) || (c >= 170 && c < 180) || (c >= 270 && c < 290) || (c >= 370 && c < 390) || (c >= 400 && c < 410) || (c >= 1060 && c < 1071)) return 2;
    if ((c >= 90 && c < 100) || (c >= 420 && c < 430) || (c >= 440 && c < 460) || c === 1071) return 4;
    if (c >= 160 && c < 170) return -8;   // int64
    if ((c >= 10 && c < 60) || (c >= 110 && c < 150) || (c >= 210 && c < 240) || (c >= 460 && c < 470) || (c >= 1010 && c < 1060)) return 8;
    return 0;   // string / binary
}

// code page of older files ($DWGCODEPAGE) → TextDecoder label
const CODEPAGES = { ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', ANSI_1250: 'windows-1250',
    ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
    ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258', DOS437: 'ibm866', DOS850: 'windows-1252' };

const ascii = (b, s, e) => {
    let out = '';
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
};
// \U+XXXX escapes (non-ASCII characters in files before 2007)
const unescape = s => (s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);

class AsciiPairs {
    constructor(bytes, decoder) {
        this.b = bytes;
        this.pos = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
        this.decoder = decoder;
        this.code = 0;
        this.value = null;
    }
    next() {
        const b = this.b, n = b.length;
        let p = this.pos;
        // skip empty lines before a code (some writers end with blank lines)
        let e;
        for (;;) {
            if (p >= n) return false;
            e = b.indexOf(10, p);
            if (e < 0) e = n;
            let s = p;
            while (s < e && (b[s] === 32 || b[s] === 9 || b[s] === 13)) s++;
            if (s < e) { p = s; break; }
            p = e + 1;
        }
        let code = 0, neg = false, i = p;
        if (b[i] === 45) { neg = true; i++; }
        for (; i < e; i++) {
            const c = b[i];
            if (c < 48 || c > 57) break;
            code = code * 10 + c - 48;
        }
        code = neg ? -code : code;
        const vs = e + 1;
        let ve = vs < n ? b.indexOf(10, vs) : n;
        if (ve < 0) ve = n;
        this.pos = ve + 1;
        let end = ve;
        if (end > vs && b[end - 1] === 13) end--;
        this.code = code;
        const t = typeOf(code);
        if (t === 's') this.value = unescape(this.decoder.decode(b.subarray(vs, end)));
        else if (t === 'b') this.value = ascii(b, vs, end).trim();
        else {
            const v = Number(ascii(b, vs, end));
            this.value = t === 'i' ? (Number.isFinite(v) ? Math.trunc(v) : 0) : (Number.isFinite(v) ? v : 0);
        }
        return true;
    }
}

class BinaryPairs {
    constructor(bytes, decoder, r12) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = BINARY_SENTINEL.length;
        this.decoder = decoder;
        this.r12 = r12;
    }
    next() {
        const b = this.b, dv = this.dv;
        let p = this.pos;
        if (p >= b.length) return false;
        let code;
        if (this.r12) {
            code = b[p++];
            if (code === 255) { code = dv.getInt16(p, true); p += 2; }
        } else { code = dv.getInt16(p, true); p += 2; }
        this.code = code;
        const t = typeOf(code);
        if (t === 'b') {
            const len = b[p++];
            let hex = '';
            for (let i = 0; i < len; i++) hex += b[p + i].toString(16).padStart(2, '0');
            this.value = hex;
            p += len;
        } else {
            const size = binarySize(code);
            if (size === 1) { this.value = b[p]; p += 1; }
            else if (size === 2) { this.value = dv.getInt16(p, true); p += 2; }
            else if (size === 4) { this.value = dv.getInt32(p, true); p += 4; }
            else if (size === -8) { this.value = Number(dv.getBigInt64(p, true)); p += 8; }
            else if (size === 8) { this.value = dv.getFloat64(p, true); p += 8; }
            else {
                let e = b.indexOf(0, p);
                if (e < 0) e = b.length;
                this.value = unescape(this.decoder.decode(b.subarray(p, e)));
                p = e + 1;
            }
        }
        this.pos = p;
        return true;
    }
}

function isBinary(bytes) {
    for (let i = 0; i < BINARY_SENTINEL.length; i++) if (bytes[i] !== BINARY_SENTINEL[i]) return false;
    return true;
}

// $ACADVER and $DWGCODEPAGE from the beginning of the file (the encoding is needed before reading the strings)
function sniff(bytes, binary) {
    const head = ascii(bytes, 0, Math.min(bytes.length, 1 << 16));
    const after = (name) => {
        const i = head.indexOf(name);
        if (i < 0) return null;
        const m = binary ? head.slice(i + name.length).match(/[A-Za-z0-9_]{3,}/) : head.slice(i + name.length).match(/\n\s*\d+\s*\r?\n([^\r\n]*)/);
        return m ? (binary ? m[0] : m[1].trim()) : null;
    };
    const version = after('$ACADVER') || 'AC1009';
    const codepage = after('$DWGCODEPAGE');
    return { version, codepage };
}

/**
 * @param {Uint8Array} bytes the whole file
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Drawing}
 */
export function readDxf(bytes, onProgress = () => {}) {
    const binary = isBinary(bytes);
    const { version, codepage } = sniff(bytes, binary);
    let label = version >= 'AC1021' ? 'utf-8' : CODEPAGES[(codepage || '').toUpperCase()] || 'windows-1252';
    let decoder;
    try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder('windows-1252'); }
    // R12 binary: 1-byte codes ("SECTION" follows a single 0 byte)
    const r12 = binary && bytes[BINARY_SENTINEL.length + 1] !== 0;
    const pairs = binary ? new BinaryPairs(bytes, decoder, r12) : new AsciiPairs(bytes, decoder);
    const drawing = new Drawing();
    drawing.header.version = version;
    const reader = new Reader(pairs, drawing, bytes.length, onProgress);
    reader.run();
    return drawing;
}

// --- objects as lists of pairs ---

class Rec {
    constructor(type) {
        this.type = type;
        this.c = [];
        this.v = [];
    }
    get(code, fallback) {
        const i = this.c.indexOf(code);
        return i < 0 ? fallback : this.v[i];
    }
    has(code) { return this.c.includes(code); }
    /** all values of a code */
    all(code) {
        const out = [];
        for (let i = 0; i < this.c.length; i++) if (this.c[i] === code) out.push(this.v[i]);
        return out;
    }
    point(code, fallback = [0, 0, 0]) {
        const i = this.c.indexOf(code);
        if (i < 0) return fallback;
        const p = [this.v[i], 0, 0];
        if (this.c[i + 1] === code + 10) p[1] = this.v[i + 1];
        if (this.c[i + 2] === code + 20) p[2] = this.v[i + 2];
        return p;
    }
}

class Reader {
    constructor(pairs, drawing, size, onProgress) {
        this.p = pairs;
        this.d = drawing;
        this.size = size;
        this.onProgress = onProgress;
        this.peeked = false;
        this.lastProgress = 0;
        this.blockRecords = new Map();   // block record handle → name
        this.layoutRecs = [];
        this.viewportClips = new Map();   // handle → polygon (non-rectangular viewport clips)
    }

    // next pair (with one pair of look-ahead: an object ends at the next code 0)
    read() {
        if (this.peeked) { this.peeked = false; return true; }
        return this.p.next();
    }
    unread() { this.peeked = true; }

    progress() {
        const pos = this.p.pos || 0;
        if (pos - this.lastProgress > (4 << 20)) { this.lastProgress = pos; this.onProgress(Math.min(pos / this.size, 1)); }
    }

    // the object starting after a code 0 (its type already read): pairs up to the next code 0
    record(type) {
        const r = new Rec(type);
        while (this.read()) {
            if (this.p.code === 0) { this.unread(); break; }
            r.c.push(this.p.code);
            r.v.push(this.p.value);
        }
        return r;
    }

    run() {
        while (this.read()) {
            if (this.p.code !== 0 || this.p.value !== 'SECTION') continue;
            if (!this.read()) break;
            const name = String(this.p.value).toUpperCase();
            if (name === 'HEADER') this.header();
            else if (name === 'TABLES') this.tables();
            else if (name === 'BLOCKS') this.blocks();
            else if (name === 'ENTITIES') this.entitiesSection();
            else if (name === 'OBJECTS') this.objects();
            else if (name === 'ACDSDATA') this.acdsData();
            else this.skipSection();
        }
        this.finish();
    }

    skipSection() {
        while (this.read()) if (this.p.code === 0 && this.p.value === 'ENDSEC') return;
    }

    header() {
        const h = this.d.header;
        let name = null;
        const values = [];
        const flush = () => {
            if (!name) return;
            const v = values[0]?.[1];
            switch (name) {
                case '$INSUNITS': h.insunits = v | 0; break;
                case '$LTSCALE': h.ltscale = v || 1; break;
                case '$LWDISPLAY': h.lwdisplay = !!v; break;
                case '$PDMODE': h.pdmode = v | 0; break;
                case '$PDSIZE': h.pdsize = v || 0; break;
                case '$FILLMODE': h.fillmode = v !== 0; break;
                case '$MEASUREMENT': h.measurement = v | 0; break;
                case '$DIMSCALE': h.dimscale = v || 1; break;
                case '$DIMASZ': h.dimasz = v; break;
                case '$EXTMIN': h.extmin = values.map(x => x[1]); break;
                case '$EXTMAX': h.extmax = values.map(x => x[1]); break;
                case '$CLAYOUT': break;
                default: break;
            }
        };
        while (this.read()) {
            const { code, value } = this.p;
            if (code === 0) { if (value === 'ENDSEC') break; continue; }
            if (code === 9) { flush(); name = String(value).toUpperCase(); values.length = 0; continue; }
            values.push([code, value]);
        }
        flush();
    }

    tables() {
        while (this.read()) {
            const { code, value } = this.p;
            if (code !== 0) continue;
            if (value === 'ENDSEC') return;
            if (value === 'TABLE' || value === 'ENDTAB') { this.record(value); continue; }
            const r = this.record(value);
            this.tableEntry(r);
        }
    }

    tableEntry(r) {
        const d = this.d;
        const name = String(r.get(2, ''));
        const key = name.toUpperCase();
        switch (r.type) {
            case 'LAYER': {
                const color = r.get(62, 7);
                const flags = r.get(70, 0);
                const rgb = r.get(420, null);
                const layer = { name, color: Math.abs(color) || 7, rgb: rgb === null ? null : rgb & 0xffffff, off: color < 0, frozen: !!(flags & 1),
                    linetype: String(r.get(6, 'CONTINUOUS')), lineweight: r.get(370, -3), handle: String(r.get(5, '')).toUpperCase() };
                d.layers.set(key, layer);
                if (layer.handle) d.layerByHandle.set(layer.handle, name);
                break;
            }
            case 'LTYPE': {
                const pattern = r.all(49);
                d.linetypes.set(key, { name, pattern, total: Math.abs(r.get(40, 0)) || pattern.reduce((s, x) => s + Math.abs(x), 0) });
                break;
            }
            case 'STYLE': {
                // xdata of TrueType styles: 1001 ACAD, 1000 family name, 1071 flags
                let family = '';
                const xi = r.c.indexOf(1001);
                if (xi >= 0) {
                    for (let i = xi + 1; i < r.c.length && r.c[i] !== 1001; i++) if (r.c[i] === 1000) { family = String(r.v[i]); break; }
                }
                const flags = r.get(70, 0);
                d.styles.set(key, { name, font: String(r.get(3, '')), bigFont: String(r.get(4, '')), family, height: r.get(40, 0), width: r.get(41, 1) || 1,
                    oblique: r.get(50, 0), flags, gen: r.get(71, 0) });
                break;
            }
            case 'DIMSTYLE':
                d.dimstyles.set(key, { name, asz: r.get(41, null), scale: r.get(40, null), txt: r.get(140, null) });
                break;
            case 'BLOCK_RECORD': {
                const handle = String(r.get(5, '')).toUpperCase();
                if (handle) this.blockRecords.set(handle, name);
                break;
            }
            default: break;
        }
    }

    blocks() {
        let block = null;
        const sink = [];
        while (this.read()) {
            const { code, value } = this.p;
            if (code !== 0) continue;
            if (value === 'ENDSEC') return;
            if (value === 'BLOCK') {
                const r = this.record('BLOCK');
                const name = String(r.get(2, '') || r.get(3, ''));
                block = { name, base: r.point(10), entities: [], flags: r.get(70, 0), record: String(r.get(330, '')).toUpperCase(), layer: String(r.get(8, '0')) };
                this.d.blocks.set(name.toUpperCase(), block);
                continue;
            }
            if (value === 'ENDBLK') { this.record('ENDBLK'); block = null; continue; }
            this.unread();
            this.entity(block ? block.entities : sink, true);
            this.progress();
        }
    }

    entitiesSection() {
        const model = [], paper = [];
        const route = { push: e => (e.paper ? paper : model).push(e) };
        while (this.read()) {
            if (this.p.code !== 0) continue;
            if (this.p.value === 'ENDSEC') break;
            this.unread();
            this.entity(route, false);
            this.progress();
        }
        this.d.modelSpace.push(...model);
        if (paper.length) {
            const list = this.d.paperSpace.get('*PAPER_SPACE') || [];
            list.push(...paper);
            this.d.paperSpace.set('*PAPER_SPACE', list);
        }
    }

    // one entity (with its following VERTEX/ATTRIB … SEQEND) into list
    entity(list) {
        if (!this.read() || this.p.code !== 0) return;
        const type = String(this.p.value).toUpperCase();
        const r = this.record(type);
        if (type === 'POLYLINE') {
            const vertices = [];
            while (this.read()) {
                if (this.p.code === 0 && this.p.value === 'VERTEX') { vertices.push(this.record('VERTEX')); continue; }
                if (this.p.code === 0 && this.p.value === 'SEQEND') { this.record('SEQEND'); break; }
                this.unread();
                break;
            }
            const e = convertPolyline(r, vertices);
            if (e) list.push(e);
            return;
        }
        if (type === 'INSERT' && r.get(66, 0)) {
            const attribs = [];
            while (this.read()) {
                if (this.p.code === 0 && this.p.value === 'ATTRIB') { attribs.push(this.record('ATTRIB')); continue; }
                if (this.p.code === 0 && this.p.value === 'SEQEND') { this.record('SEQEND'); break; }
                this.unread();
                break;
            }
            const e = convert(r, this.d);
            if (e) {
                e.attribs = attribs.map(a => convert(a, this.d)).filter(Boolean);
                list.push(e);
            }
            return;
        }
        if (type === 'VERTEX' || type === 'SEQEND' || type === 'ATTRIB') return;   // stray
        const e = convert(r, this.d);
        if (e) list.push(e);
    }

    objects() {
        while (this.read()) {
            if (this.p.code !== 0) continue;
            const type = String(this.p.value).toUpperCase();
            if (type === 'ENDSEC') return;
            const r = this.record(type);
            if (type === 'LAYOUT') this.layoutRecs.push(r);
        }
    }

    // ACDSDATA: ACIS data of solids in files from 2013 on (SAB, binary chunks 310 per record, owner handle 320)
    acdsData() {
        while (this.read()) {
            if (this.p.code !== 0) continue;
            const type = String(this.p.value).toUpperCase();
            if (type === 'ENDSEC') return;
            const r = this.record(type);
            if (type !== 'ACDSRECORD') continue;
            const owner = String(r.get(320, '')).toUpperCase();
            const chunks = r.all(310);
            if (!owner || !chunks.length) continue;
            let len = 0;
            for (const h of chunks) len += h.length >> 1;
            const sab = new Uint8Array(len);
            let o = 0;
            for (const h of chunks) for (let i = 0; i + 1 < h.length; i += 2) sab[o++] = parseInt(h.substr(i, 2), 16);
            this.d.acisBlobs.set(owner, sab);
        }
    }

    finish() {
        const d = this.d;
        for (const [handle, name] of this.blockRecords) d.blockByRecord.set(handle, name);
        // layouts: name, tab order, block of the layout (through its block record)
        for (const r of this.layoutRecs) {
            // plot settings first (page setup name in 1, paper size, margins), then the layout part (its name in 1, tab order, limits)
            const at = r.c.findIndex((c, i) => c === 100 && r.v[i] === 'AcDbLayout');
            const lay = new Rec('LAYOUT');
            if (at >= 0) { lay.c = r.c.slice(at); lay.v = r.v.slice(at); }
            const name = String(lay.get(1, '') || r.get(1, ''));
            const owners = lay.all(330).map(h => String(h).toUpperCase());
            let block = null;
            for (const h of owners) { const b = this.blockRecords.get(h); if (b) block = b; }
            const limits = lay.has(10) ? [lay.get(10), lay.get(20), lay.get(11), lay.get(21)] : null;
            d.layouts.push({ name, order: lay.get(71, 0), block, limits, paper: [r.get(44, 0), r.get(45, 0)], margins: [r.get(40, 0), r.get(41, 0), r.get(42, 0), r.get(43, 0)],
                units: r.get(76, null), rotation: r.get(73, 0) });
        }
        d.layouts.sort((a, b) => a.order - b.order);
        // paper space objects of the inactive layouts live in their blocks (*Paper_Space0, …)
        for (const [key, block] of d.blocks) {
            if (key.startsWith('*PAPER_SPACE') && key !== '*PAPER_SPACE' && block.entities.length) d.paperSpace.set(key, block.entities);
            if (key === '*PAPER_SPACE' && block.entities.length) {
                const list = d.paperSpace.get(key) || [];
                list.push(...block.entities);
                d.paperSpace.set(key, list);
            }
        }
        // R12 and files without layout objects: the model space block may hold objects too
        const ms = d.blocks.get('*MODEL_SPACE');
        if (ms?.entities.length) d.modelSpace.push(...ms.entities);
        if (!d.layers.has('0')) d.layers.set('0', { name: '0', color: 7, rgb: null, off: false, frozen: false, linetype: 'CONTINUOUS', lineweight: -3, handle: '' });
    }
}

// --- conversion of an object's pairs into a record (drawing.js) ---

function common(r, type) {
    const color = r.get(62, ACI_BYLAYER);
    const rgb = r.get(420, null);
    return {
        type,
        layer: String(r.get(8, '0')),
        color: rgb !== null ? ACI_BYOBJECT : color,
        rgb: rgb !== null ? rgb & 0xffffff : null,
        linetype: String(r.get(6, '')),
        ltscale: r.get(48, 1),
        lineweight: r.get(370, LW_BYLAYER),
        invisible: r.get(60, 0) === 1,
        paper: r.get(67, 0) === 1,
        extrusion: r.has(210) ? r.point(210, [0, 0, 1]) : null,
        thickness: r.get(39, 0),
        handle: String(r.get(5, '')).toUpperCase(),
    };
}

function convert(r, d) {
    const t = r.type;
    switch (t) {
        case 'LINE': return { ...common(r, t), a: r.point(10), b: r.point(11) };
        case 'POINT': return { ...common(r, t), p: r.point(10) };
        case 'CIRCLE': return { ...common(r, t), c: r.point(10), r: r.get(40, 0) };
        case 'ARC': return { ...common(r, t), c: r.point(10), r: r.get(40, 0), start: r.get(50, 0), end: r.get(51, 360) };
        case 'ELLIPSE': return { ...common(r, t), c: r.point(10), major: r.point(11), ratio: r.get(40, 1), start: r.get(41, 0), end: r.get(42, Math.PI * 2) };
        case 'XLINE': case 'RAY': return { ...common(r, t), p: r.point(10), dir: r.point(11, [1, 0, 0]) };
        case 'LWPOLYLINE': return lwpolyline(r);
        case 'SPLINE': case 'HELIX': return spline(r);
        case '3DFACE': {
            const pts = [...r.point(10), ...r.point(11), ...r.point(12), ...r.point(13, r.point(12))];
            return { ...common(r, t), pts, hidden: r.get(70, 0) };
        }
        case 'SOLID': case 'TRACE': {
            const p2 = r.point(12);
            return { ...common(r, t), pts: [...r.point(10), ...r.point(11), ...p2, ...r.point(13, p2)] };
        }
        case 'INSERT': return {
            ...common(r, t), name: String(r.get(2, '')), p: r.point(10), scale: [r.get(41, 1), r.get(42, 1), r.get(43, 1)], rot: r.get(50, 0),
            cols: Math.max(r.get(70, 1), 1), rows: Math.max(r.get(71, 1), 1), colSpacing: r.get(44, 0), rowSpacing: r.get(45, 0), attribs: [],
        };
        case 'TEXT': case 'ATTRIB': case 'ATTDEF': return text(r);
        case 'MTEXT': return mtext(r);
        case 'ACAD_TABLE': {
            // a table is drawn by its anonymous block (*T…), placed like an insert: point, horizontal direction
            const dir = r.point(11, [1, 0, 0]);
            return { ...common(r, 'INSERT'), name: String(r.get(2, '')), p: r.point(10), scale: [1, 1, 1], rot: Math.atan2(dir[1], dir[0]) * 180 / Math.PI, cols: 1, rows: 1, colSpacing: 0, rowSpacing: 0, attribs: [] };
        }
        case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION':
            return { ...common(r, t), type: 'DIMENSION', block: String(r.get(2, '')), p: r.point(12, [0, 0, 0]) };
        case 'HATCH': return hatch(r);
        case 'MESH': return mesh(r);
        case 'LEADER': return leader(r, d);
        case 'MLINE': return mline(r);
        case 'WIPEOUT': return wipeout(r);
        case 'VIEWPORT': return viewport(r, d);
        case '3DSOLID': case 'REGION': case 'BODY': case 'SURFACE': case 'EXTRUDEDSURFACE': case 'LOFTEDSURFACE': case 'REVOLVEDSURFACE':
        case 'SWEPTSURFACE': case 'PLANESURFACE': case 'NURBSURFACE':
            return acis(r);
        default:
            d.skip(t);
            return null;
    }
}

function lwpolyline(r) {
    const e = common(r, 'LWPOLYLINE');
    const pts = [], bulges = [], widths = [];
    let hasWidth = false;
    for (let i = 0; i < r.c.length; i++) {
        const c = r.c[i];
        if (c === 10) {
            pts.push(r.v[i], r.c[i + 1] === 20 ? r.v[i + 1] : 0);
            bulges.push(0);
            widths.push(0, 0);
        } else if (c === 42 && bulges.length) bulges[bulges.length - 1] = r.v[i];
        else if (c === 40 && pts.length) { widths[widths.length - 2] = r.v[i]; hasWidth ||= r.v[i] !== 0; }
        else if (c === 41 && pts.length) { widths[widths.length - 1] = r.v[i]; hasWidth ||= r.v[i] !== 0; }
    }
    const constant = r.get(43, 0);
    if (constant && !hasWidth) { widths.fill(constant); hasWidth = true; }
    return { ...e, type: 'POLYLINE', kind: '2d', pts, bulges, widths: hasWidth ? widths : null, closed: !!(r.get(70, 0) & 1), elevation: r.get(38, 0) };
}

function convertPolyline(r, vertices) {
    const e = common(r, 'POLYLINE');
    const flags = r.get(70, 0);
    const vflag = v => v.get(70, 0);
    if (flags & 64) {
        // polyface mesh: vertices with flag 64|128 are points, flag 128 alone are faces (71–74: 1-based, negative = edge invisible)
        const pts = [], faces = [];
        for (const v of vertices) {
            const f = vflag(v);
            if (f & 64) pts.push(...v.point(10));
            else if (f & 128) faces.push([v.get(71, 0), v.get(72, 0), v.get(73, 0), v.get(74, 0)]);
        }
        return { ...e, kind: 'pface', pts, faces };
    }
    if (flags & 16) {
        // polygon mesh M × N; smoothed: the surface vertices (flag 8) instead of the control frame (flag 16)
        let m = r.get(71, 0), n = r.get(72, 0);
        let use = vertices;
        const smooth = r.get(75, 0);
        if (smooth && vertices.some(v => vflag(v) & 8)) {
            use = vertices.filter(v => vflag(v) & 8);
            m = r.get(73, 0) || m;
            n = r.get(74, 0) || n;
        }
        const pts = [];
        for (const v of use) pts.push(...v.point(10));
        if (m * n !== pts.length / 3) { n = Math.max(1, Math.round(pts.length / 3 / Math.max(m, 1))); m = Math.floor(pts.length / 3 / n); }
        return { ...e, kind: 'mesh', pts, m, n, closedM: !!(flags & 1), closedN: !!(flags & 32) };
    }
    // 2D / 3D polyline: spline-fit leaves out the frame control points (flag 16)
    const fitted = flags & 4;
    const pts = [], bulges = [], widths = [];
    let hasWidth = false;
    const is3d = !!(flags & 8);
    const w0 = r.get(40, 0), w1 = r.get(41, 0);
    for (const v of vertices) {
        const f = vflag(v);
        if (fitted && (f & 16)) continue;
        const p = v.point(10);
        if (is3d) pts.push(p[0], p[1], p[2]);
        else pts.push(p[0], p[1]);
        bulges.push(v.get(42, 0));
        const a = v.get(40, w0), b = v.get(41, w1);
        widths.push(a, b);
        hasWidth ||= a !== 0 || b !== 0;
    }
    if (is3d) return { ...e, kind: '3d', pts, closed: !!(flags & 1) };
    return { ...e, kind: '2d', pts, bulges, widths: hasWidth ? widths : null, closed: !!(flags & 1), elevation: r.point(10)[2] };
}

function spline(r) {
    const e = common(r, 'SPLINE');
    const flags = r.get(70, 0);
    const ctrl = [], fit = [], knots = r.all(40), weights = r.all(41);
    for (let i = 0; i < r.c.length; i++) {
        if (r.c[i] === 10) ctrl.push(r.v[i], r.c[i + 1] === 20 ? r.v[i + 1] : 0, r.c[i + 2] === 30 ? r.v[i + 2] : 0);
        else if (r.c[i] === 11) fit.push(r.v[i], r.c[i + 1] === 21 ? r.v[i + 1] : 0, r.c[i + 2] === 31 ? r.v[i + 2] : 0);
    }
    return { ...e, type: 'SPLINE', degree: r.get(71, 3), closed: !!(flags & 1), periodic: !!(flags & 2), knots, ctrl,
        weights: weights.length === ctrl.length / 3 ? weights : null, fit: fit.length ? fit : null };
}

function text(r) {
    const e = common(r, r.type);
    const flags = r.get(70, 0);
    return {
        ...e,
        p: r.point(10), p2: r.has(11) ? r.point(11) : null, h: r.get(40, 1), rot: r.get(50, 0), width: r.get(41, 1) || 1, oblique: r.get(51, 0),
        style: String(r.get(7, 'STANDARD')), hAlign: r.get(72, 0), vAlign: r.type === 'TEXT' ? r.get(73, 0) : r.get(74, 0), mirror: r.get(71, 0),
        text: String(r.type === 'ATTDEF' ? r.get(1, '') || r.get(2, '') : r.get(1, '')),
        invisible: e.invisible || (r.type !== 'TEXT' && !!(flags & 1)),
        tag: r.type !== 'TEXT' ? String(r.get(2, '')) : null,
    };
}

function mtext(r) {
    const e = common(r, 'MTEXT');
    // the text in chunks: 3 (250 characters each) then 1
    let s = '';
    for (let i = 0; i < r.c.length; i++) if (r.c[i] === 3) s += r.v[i];
    s += r.get(1, '');
    return {
        ...e, p: r.point(10), dir: r.has(11) ? r.point(11) : null, rot: r.get(50, 0) * 180 / Math.PI, h: r.get(40, 1), width: r.get(41, 0),
        attach: r.get(71, 1), spacing: r.get(44, 1), style: String(r.get(7, 'STANDARD')), text: s,
    };
}

// HATCH: boundary loops (polylines with bulges, or edges: line, arc, elliptic arc, spline), pattern lines, gradient
function hatch(r) {
    const e = common(r, 'HATCH');
    const c = r.c, v = r.v;
    let i = c.indexOf(91);
    const loops = [];
    const patterns = [];
    let gradient = null;
    const at = (code, from) => (c[from] === code ? v[from] : undefined);
    if (i >= 0) {
        const count = v[i++];
        for (let l = 0; l < count && i < c.length; l++) {
            while (i < c.length && c[i] !== 92) i++;
            const flags = v[i++];
            const loop = { flags, edges: [] };
            if (flags & 2) {
                // polyline: 72 has bulge, 73 closed, 93 count, 10/20 [42]
                const hasBulge = at(72, i) ?? 0; if (c[i] === 72) i++;
                if (c[i] === 73) i++;
                const n = at(93, i) ?? 0; if (c[i] === 93) i++;
                const pts = [], bulges = [];
                for (let k = 0; k < n && i < c.length; k++) {
                    while (i < c.length && c[i] !== 10) i++;
                    pts.push(v[i], v[i + 1]);
                    i += 2;
                    let b = 0;
                    if (hasBulge && c[i] === 42) { b = v[i]; i++; }
                    bulges.push(b);
                }
                loop.poly = { pts, bulges };
            } else {
                const n = at(93, i) ?? 0; if (c[i] === 93) i++;
                for (let k = 0; k < n && i < c.length; k++) {
                    while (i < c.length && c[i] !== 72) i++;
                    const type = v[i++];
                    const num = code => { while (i < c.length && c[i] !== code) i++; return v[i++]; };
                    if (type === 1) {
                        const x0 = num(10), y0 = num(20), x1 = num(11), y1 = num(21);
                        loop.edges.push({ type: 'line', a: [x0, y0], b: [x1, y1] });
                    } else if (type === 2) {
                        const cx = num(10), cy = num(20), rad = num(40), s = num(50), en = num(51), ccw = num(73);
                        loop.edges.push({ type: 'arc', c: [cx, cy], r: rad, start: s, end: en, ccw: !!ccw });
                    } else if (type === 3) {
                        const cx = num(10), cy = num(20), mx = num(11), my = num(21), ratio = num(40), s = num(50), en = num(51), ccw = num(73);
                        loop.edges.push({ type: 'ellipse', c: [cx, cy], major: [mx, my], ratio, start: s, end: en, ccw: !!ccw });
                    } else if (type === 4) {
                        const degree = num(94);
                        const rational = c[i] === 73 ? v[i++] : 0;
                        if (c[i] === 74) i++;
                        const nk = num(95), nc = num(96);
                        const knots = [], ctrl = [], weights = [], fit = [];
                        for (let q = 0; q < nk; q++) knots.push(num(40));
                        for (let q = 0; q < nc; q++) {
                            ctrl.push(num(10), num(20), 0);
                            if (rational && c[i] === 42) weights.push(v[i++]);
                        }
                        if (c[i] === 97) {
                            const nf = v[i++];
                            for (let q = 0; q < nf; q++) fit.push(num(11), num(21), 0);
                        }
                        loop.edges.push({ type: 'spline', spline: { degree, knots, ctrl, weights: weights.length === nc ? weights : null, fit: fit.length && !nc ? fit : null, closed: false, periodic: false } });
                    }
                }
            }
            // source boundary objects: 97 count + 330 handles (skipped)
            if (c[i] === 97) {
                const n = v[i++];
                for (let k = 0; k < n && c[i] === 330; k++) i++;
            }
            loops.push(loop);
        }
        // pattern data after the loops
        for (let k = i; k < c.length; k++) {
            if (c[k] === 53) {
                const line = { angle: v[k], base: [v[k + 1], v[k + 2]], offset: [v[k + 3], v[k + 4]], dashes: [] };
                let q = k + 5;
                const nd = c[q] === 79 ? v[q++] : 0;
                for (let n = 0; n < nd && c[q] === 49; n++) line.dashes.push(v[q++]);
                patterns.push(line);
                k = q - 1;
            }
        }
    }
    if (r.get(450, 0)) {
        const rgbs = r.all(421).map(x => x & 0xffffff);
        gradient = { name: String(r.get(470, 'LINEAR')).toUpperCase(), angle: r.get(460, 0), shift: r.get(461, 0), oneColor: r.get(452, 0) === 1, tint: r.get(462, 0), colors: rgbs };
    }
    const elevation = r.has(30) ? r.get(30) : (r.c.indexOf(10) >= 0 ? r.point(10)[2] : 0);
    return { ...e, elevation, solid: !!r.get(70, 0), pattern: String(r.get(2, '')), loops, style: r.get(75, 0), patterns, gradient };
}

function mesh(r) {
    const e = common(r, 'MESH');
    const c = r.c, v = r.v;
    // 92 vertex count, 10/20/30 …, 93 face list size, 90 entries (n, i0 … in-1) – kept as the flat face list
    let i = c.indexOf(92);
    const pts = [], faces = [];
    if (i >= 0) {
        const n = v[i++];
        for (let k = 0; k < n && i < c.length; k++) {
            while (i < c.length && c[i] !== 10) i++;
            pts.push(v[i], v[i + 1], v[i + 2]);
            i += 3;
        }
        while (i < c.length && c[i] !== 93) i++;
        const size = v[i++];
        while (faces.length < size && i < c.length && c[i] === 90) faces.push(v[i++]);
    }
    return { ...e, pts, faces };
}

function leader(r, d) {
    const e = common(r, 'LEADER');
    const pts = [];
    for (let i = 0; i < r.c.length; i++) if (r.c[i] === 10) pts.push(r.v[i], r.c[i + 1] === 20 ? r.v[i + 1] : 0, r.c[i + 2] === 30 ? r.v[i + 2] : 0);
    const style = d.dimstyles.get(String(r.get(3, 'STANDARD')).toUpperCase());
    return { ...e, pts, arrow: r.get(71, 1) === 1, spline: r.get(72, 0) === 1, arrowSize: (style?.asz ?? d.header.dimasz ?? 2.5) * (style?.scale || d.header.dimscale || 1) };
}

function mline(r) {
    const e = common(r, 'MLINE');
    const c = r.c, v = r.v;
    const n = r.get(72, 0), elements = r.get(73, 0);
    const pts = [], miters = [], params = [];
    let i = c.indexOf(11);
    for (let k = 0; k < n && i >= 0 && i < c.length; k++) {
        while (i < c.length && c[i] !== 11) i++;
        pts.push(v[i], v[i + 1], v[i + 2]);
        i += 3;
        while (i < c.length && c[i] !== 13) i++;
        miters.push(v[i], v[i + 1], v[i + 2]);
        i += 3;
        const per = [];
        for (let el = 0; el < elements; el++) {
            while (i < c.length && c[i] !== 74) i++;
            const np = v[i++];
            const ps = [];
            for (let q = 0; q < np && c[i] === 41; q++) ps.push(v[i++]);
            per.push(ps[0] ?? 0);
            if (c[i] === 75) { const nf = v[i++]; for (let q = 0; q < nf && c[i] === 42; q++) i++; }
        }
        params.push(per);
    }
    return { ...e, pts, miters, params, closed: !!(r.get(71, 0) & 2) };
}

function wipeout(r) {
    const e = common(r, 'WIPEOUT');
    const p = r.point(10), u = r.point(11), w = r.point(12);
    const size = [r.get(13, 1), r.get(23, 1)];
    const clip = [];
    for (let i = 0; i < r.c.length; i++) if (r.c[i] === 14) clip.push(r.v[i], r.c[i + 1] === 24 ? r.v[i + 1] : 0);
    // clip vertices in pixel units relative to the image centre (-0.5 … size − 0.5) → world
    let pix = clip;
    if (clip.length === 4) pix = [clip[0], clip[1], clip[2], clip[1], clip[2], clip[3], clip[0], clip[3]];
    if (!pix.length) pix = [-0.5, -0.5, size[0] - 0.5, -0.5, size[0] - 0.5, size[1] - 0.5, -0.5, size[1] - 0.5];
    const polygon = [];
    for (let i = 0; i < pix.length; i += 2) {
        const x = pix[i] + 0.5, y = pix[i + 1] + 0.5;
        // image rows go down: v points up from the bottom-left corner
        polygon.push(p[0] + u[0] * x + w[0] * (size[1] - y), p[1] + u[1] * x + w[1] * (size[1] - y), p[2] + u[2] * x + w[2] * (size[1] - y));
    }
    return { ...e, polygon };
}

function viewport(r, d) {
    const e = common(r, 'VIEWPORT');
    const frozen = r.all(331).map(h => d.layerByHandle.get(String(h).toUpperCase())).filter(Boolean);
    return {
        ...e, center: r.point(10), w: r.get(40, 0), h: r.get(41, 0), status: r.get(68, 1), id: r.get(69, 0), viewCenter: [r.get(12, 0), r.get(22, 0)],
        viewDir: r.point(16, [0, 0, 1]), target: r.point(17, [0, 0, 0]), viewHeight: r.get(45, 1), twist: r.get(51, 0), frozen,
        clip: String(r.get(340, '')).toUpperCase() || null, flags: r.get(90, 0),
    };
}

// ACIS solids: SAT text in 1/3 groups (encoded – 159 − c), or (2013+) the SAB data in ACDSDATA by handle
function acis(r) {
    const e = common(r, r.type);
    const lines = [];
    let cur = '';
    for (let i = 0; i < r.c.length; i++) {
        if (r.c[i] === 1) { cur += r.v[i]; lines.push(cur); cur = ''; }
        else if (r.c[i] === 3) cur += r.v[i];
    }
    if (cur) lines.push(cur);
    // 159 − c for every character but the space; an encoded 'A' (0x5E) is followed by an extra space
    const decoded = lines.map(s => {
        let out = '';
        for (let k = 0; k < s.length; k++) {
            const ch = s.charCodeAt(k);
            if (ch === 32) { out += ' '; continue; }
            out += String.fromCharCode(159 - ch);
            if (ch === 0x5e && s.charCodeAt(k + 1) === 32) k++;
        }
        return out;
    });
    return { ...e, acis: decoded.length ? { sat: decoded.join('\n') } : { ref: e.handle } };
}

export { ACI_BYBLOCK };
