// IGES reader (Initial Graphics Exchange Specification 5.x): the file's sections and entities, parameters read on demand.
//
// An IGES file is a sequence of 80-column records: columns 1–72 data, column 73 the section letter (S start, G global,
// D directory entry, P parameter data, T terminate), columns 74–80 the sequence number. Every entity has two D records
// (fields of 8 columns: type, parameter pointer, …, transformation matrix, …, status / line weight, colour, parameter
// line count, form, label, subscript) and its parameters in P records (columns 1–64, ends with the record delimiter).
// Entities are addressed by the sequence number of their first D record ("DE pointer", odd: 1, 3, 5, …).
//
// Used by iges-to-step.js in a worker. Bytes only (no string per line): a large assembly has millions of records.

const C_NL = 10, C_CR = 13, C_SPACE = 32;

/** units flag of the global section → millimetres per model unit (3 = named in the next parameter) */
const UNIT_MM = { 1: 25.4, 2: 1, 4: 304.8, 5: 1609344, 6: 1000, 7: 1e6, 8: 0.0254, 9: 0.001, 10: 10, 11: 2.54e-5 };
const UNIT_NAMES = { IN: 25.4, INCH: 25.4, MM: 1, FT: 304.8, MI: 1609344, M: 1000, KM: 1e6, MIL: 0.0254, UM: 0.001, CM: 10, UIN: 2.54e-5 };

export class IgesFile {
    /** @param {Uint8Array} bytes */
    constructor(bytes) {
        this.bytes = bytes;
        this.indexLines();
        this.readGlobal();
        this.indexEntities();
    }

    // start offset of every record; the section letter is at offset + 72. Records end with a line break – or not at all
    // (fixed 80 columns, some writers)
    indexLines() {
        const b = this.bytes, n = b.length;
        let breaks = 0;
        for (let i = 0; i < Math.min(n, 4096); i++) if (b[i] === C_NL) breaks++;
        let starts;
        if (!breaks) {
            starts = new Float64Array(Math.floor(n / 80));
            for (let i = 0; i < starts.length; i++) starts[i] = i * 80;
        } else {
            let count = 1;
            for (let i = 0; i < n; i++) if (b[i] === C_NL) count++;
            starts = new Float64Array(count);
            let k = 0;
            starts[k++] = 0;
            for (let i = 0; i < n; i++) if (b[i] === C_NL && i + 1 < n) starts[k++] = i + 1;
            starts = starts.subarray(0, k);
        }
        // per section: first record and count (records of a section are consecutive)
        this.lines = starts;
        this.section = {};
        for (let i = 0; i < starts.length; i++) {
            const c = String.fromCharCode(b[starts[i] + 72] || C_SPACE);
            if (!'SGDPT'.includes(c)) continue;
            const s = this.section[c] ??= { first: i, count: 0 };
            s.count = i - s.first + 1;
        }
        if (!this.section.D || !this.section.P) throw new Error('IGES file without directory or parameter section');
    }

    // column range [c0, c1) of record i as text
    text(i, c0, c1) {
        const s = this.lines[i], b = this.bytes;
        let out = '';
        for (let c = c0; c < c1; c++) { const x = b[s + c]; if (x === C_NL || x === C_CR || x === undefined) break; out += String.fromCharCode(x); }
        return out;
    }

    readGlobal() {
        const g = this.section.G;
        let text = '';
        if (g) for (let i = g.first; i < g.first + g.count; i++) text += this.text(i, 0, 72);
        // delimiters: parameter 1 and 2, default ',' and ';' (written as 1H, and 1H; – or left empty)
        let pd = ',', rd = ';', pos = 0;
        const hollerith = () => {
            const m = /^\s*(\d+)H/.exec(text.slice(pos));
            if (!m) return null;
            const v = text.substr(pos + m[0].length, Number(m[1]));
            pos += m[0].length + Number(m[1]);
            return v;
        };
        const first = hollerith();
        if (first !== null) pd = first;
        if (text[pos] === pd) pos++;
        const second = text[pos] === pd ? null : hollerith();
        if (second !== null) rd = second;
        this.paramDelim = pd.charCodeAt(0);
        this.recordDelim = rd.charCodeAt(0);
        this.global = parseParams(new TextEncoder().encode(text), [[0, text.length]], this.paramDelim, this.recordDelim);
        const G = i => this.global[i - 1];
        const flag = Number(G(14)) || 2;
        let unit = UNIT_MM[flag];
        if (!unit) unit = UNIT_NAMES[String(G(15) || '').trim().toUpperCase()] || 1;
        this.unit = unit;                                   // mm per model unit
        this.system = [G(5), G(6)].filter(x => typeof x === 'string' && x.trim()).join(' / ');   // native system, preprocessor
        this.sender = typeof G(3) === 'string' ? G(3) : '';
        this.resolution = Number(G(19)) || 0;               // minimum user-intended resolution (model units)
    }

    // directory entries: per entity (index k = (DE − 1) / 2) the fields that matter
    indexEntities() {
        const d = this.section.D, n = Math.floor(d.count / 2);
        this.count = n;
        this.type = new Int16Array(n);
        this.pStart = new Int32Array(n);    // first parameter record (1-based sequence number within P)
        this.pLines = new Int32Array(n);
        this.xform = new Int32Array(n);     // DE pointer of the transformation matrix (0 = none)
        this.color = new Int32Array(n);     // colour number (> 0) or −DE pointer to a colour definition (314)
        this.form = new Int16Array(n);
        this.status = new Int32Array(n);    // 8 digits: blank, subordinate, use, hierarchy (2 each)
        this.labels = new Array(n);
        const field = (i, f) => {
            const s = this.lines[i] + f * 8, b = this.bytes;
            let v = 0, sign = 1, seen = false;
            for (let c = 0; c < 8; c++) {
                const x = b[s + c];
                if (x === 45) sign = -1;
                else if (x >= 48 && x <= 57) { v = v * 10 + x - 48; seen = true; }
            }
            return seen ? sign * v : 0;
        };
        for (let k = 0; k < n; k++) {
            const i = d.first + 2 * k, j = i + 1;
            this.type[k] = field(i, 0);
            this.pStart[k] = field(i, 1);
            this.xform[k] = field(i, 6);
            this.status[k] = field(i, 8);
            this.color[k] = field(j, 2);
            this.pLines[k] = field(j, 3);
            this.form[k] = field(j, 4);
            const label = this.text(j, 56, 64).trim(), sub = field(j, 8);
            this.labels[k] = label ? (sub ? `${label}(${sub})` : label) : '';
        }
    }

    /** entity index of a DE pointer (−1 if out of range) */
    index(de) {
        const k = (de - 1) / 2;
        return de > 0 && Number.isInteger(k) && k < this.count ? k : -1;
    }
    typeOf(de) { const k = this.index(de); return k < 0 ? 0 : this.type[k]; }
    formOf(de) { const k = this.index(de); return k < 0 ? 0 : this.form[k]; }
    blanked(de) { const k = this.index(de); return k >= 0 && Math.floor(this.status[k] / 1e6) === 1; }
    subordinate(de) { const k = this.index(de); return k < 0 ? 0 : Math.floor(this.status[k] / 1e4) % 100; }
    use(de) { const k = this.index(de); return k < 0 ? 0 : Math.floor(this.status[k] / 100) % 100; }
    label(de) { const k = this.index(de); return k < 0 ? '' : this.labels[k]; }

    /** parameters of an entity: [type, p1, p2, …] (numbers, Hollerith strings, null for empty fields) */
    params(de) {
        const k = this.index(de);
        if (k < 0) return null;
        const p = this.section.P, first = p.first + this.pStart[k] - 1;
        const ranges = [];
        for (let i = first; i < first + Math.max(1, this.pLines[k]) && i < p.first + p.count; i++) ranges.push([this.lines[i], this.lines[i] + 64]);
        return parseParams(this.bytes, ranges, this.paramDelim, this.recordDelim);
    }
}

/**
 * Free-format parameters over byte ranges (the P columns of consecutive records): numbers (also 1.5D3 exponents),
 * Hollerith strings (nH…, may contain delimiters and span records), empty fields → null. Stops at the record delimiter.
 */
export function parseParams(bytes, ranges, pd, rd) {
    const out = [];
    let r = 0, i = ranges.length ? ranges[0][0] : 0, end = ranges.length ? ranges[0][1] : 0;
    const next = () => {   // next byte across ranges (−1 at the end)
        while (i >= end) {
            if (++r >= ranges.length) return -1;
            i = ranges[r][0]; end = ranges[r][1];
        }
        const c = bytes[i++];
        return c === C_NL || c === C_CR ? C_SPACE : c;   // short records: line break = blank
    };
    let tok = '', hasTok = false;
    for (;;) {
        let c = next();
        if (c === -1) { if (hasTok) out.push(value(tok)); break; }
        if (c === pd || c === rd) {
            out.push(hasTok ? value(tok) : null);
            tok = ''; hasTok = false;
            if (c === rd) break;
            continue;
        }
        if (c === C_SPACE) continue;
        // Hollerith: digits followed by H
        if (c === 72 || c === 104) {
            if (hasTok && /^\d+$/.test(tok)) {
                let n = Number(tok), s = '';
                while (n-- > 0) { const x = next(); if (x === -1) break; s += String.fromCharCode(x); }
                out.push(s);
                tok = ''; hasTok = false;
                // skip to the delimiter after the string
                for (;;) {
                    c = next();
                    if (c === -1 || c === pd || c === rd) break;
                }
                if (c === rd || c === -1) return out;
                continue;
            }
        }
        tok += String.fromCharCode(c);
        hasTok = true;
    }
    return out;
}

function value(tok) {
    if (tok === '') return null;
    const v = Number(tok.replace(/[dD]/, 'e'));
    return Number.isNaN(v) ? tok : v;
}
