// ACIS model data (SAT text and SAB binary; also the variant of a common shape-modelling kernel fork, "ASM"): records
// indexed once, tokens read on demand (a SAT of hundreds of MB has millions of records). Used by acis-to-step.js.
//
// SAT: three header lines (version · record count · entity count · history flag; product, kernel version and date as
// length-prefixed strings; millimetres per unit · resabs · resnor), then records "[-n] type $attrib [id $pattern] data #"
// up to "End-of-ACIS-data" (or the history marker). From 7.0 on every record carries an id after the attribute pointer,
// and every entity but the attributes a pattern pointer; strings are "@n text". Subtype data stands in { } and is
// numbered in the order it appears in the file ("ref n" points back to one).
// SAB: signature, 4 raw ints, tagged header strings and doubles, then tagged records (tags as in the SAT documentation:
// 4 int, 6 double, 7 string, 10/11 true/false, 12 pointer, 13/14 type name parts, 15/16 subtype braces, 17 record end,
// 18 long string, 19/20 vectors, 21 enum).
//
// Tokens of both forms are the same to the reader: numbers, pointers as "$n", words, '{' '}', 'T'/'F' for SAB logicals.

const SAB_SIGNATURES = ['ACIS BinaryFile', 'ASM BinaryFile4'];
const END_MARKERS = /^(End-of-ACIS-data|End-of-ASM-data|Begin-of-ACIS-History-Data)/;

export class AcisFile {
    /** @param {Uint8Array} bytes */
    constructor(bytes) {
        this.bytes = bytes;
        this.binary = SAB_SIGNATURES.some(sig => startsWith(bytes, sig));
        if (this.binary) this.indexSab();
        else this.indexSat();
    }

    get count() { return this.starts.length; }

    // --- SAT ---

    indexSat() {
        const b = this.bytes, n = b.length;
        // header: three lines (CR, LF or both)
        let p = 0;
        const lines = [];
        while (lines.length < 3 && p < n) {
            let e = p;
            while (e < n && b[e] !== 10 && b[e] !== 13) e++;
            lines.push(latin1(b, p, e));
            p = e;
            while (p < n && (b[p] === 10 || b[p] === 13)) p++;
        }
        const head = lines[0].trim().split(/\s+/).map(Number);
        this.version = head[0] || 0;
        this.unitMm = Number(lines[2]?.trim().split(/\s+/)[0]) || 1;
        if (!(this.unitMm > 0)) this.unitMm = 1;   // "-1": not set – millimetres
        this.product = lines[1] || '';
        // records: '#' ends one (outside "@n" strings); '{' not followed by "ref" opens a numbered subtype
        const starts = new Float64Array(Math.max(1024, Math.min(head[1] || 0, 5e7)) + 16);
        const subs = new Float64Array(Math.max(256, Math.floor(n / 400)));
        let ns = 0, nsub = 0;
        let rs = this.skipBlank(p);
        let start = rs;
        let starts2 = starts, subs2 = subs;
        const v7 = this.version >= 700;
        for (let i = rs; i < n; i++) {
            const c = b[i];
            if (c === 35) {   // '#'
                if (ns >= starts2.length) { const g = new Float64Array(starts2.length * 2); g.set(starts2); starts2 = g; }
                starts2[ns++] = start;
                i = this.skipBlank(i + 1) - 1;
                start = i + 1;
                // end marker?
                if (b[start] === 69 || b[start] === 66) {   // 'E' / 'B'
                    const word = latin1(b, start, Math.min(n, start + 40));
                    if (END_MARKERS.test(word)) break;
                }
            } else if (c === 123) {   // '{'
                let k = i + 1;
                while (k < n && (b[k] === 32 || b[k] === 10 || b[k] === 13 || b[k] === 9)) k++;
                if (!(b[k] === 114 && b[k + 1] === 101 && b[k + 2] === 102 && (b[k + 3] === 32 || b[k + 3] === 10 || b[k + 3] === 13))) {   // not "ref "
                    if (nsub >= subs2.length) { const g = new Float64Array(subs2.length * 2); g.set(subs2); subs2 = g; }
                    subs2[nsub++] = i;
                }
            } else if (c === 64 && v7) {   // '@n ' string: skip its characters
                let k = i + 1, len = 0;
                while (k < n && b[k] >= 48 && b[k] <= 57) { len = len * 10 + b[k] - 48; k++; }
                if (k > i + 1 && b[k] === 32) i = k + len;
            }
        }
        this.starts = starts2.subarray(0, ns);
        this.subs = subs2.subarray(0, nsub);
    }

    skipBlank(i) {
        const b = this.bytes;
        while (i < b.length && (b[i] === 32 || b[i] === 10 || b[i] === 13 || b[i] === 9)) i++;
        return i;
    }

    // tokens from offset `from` up to the record end (SAT), or the matching '}' when `subtype`
    satTokens(from, subtype = false) {
        const b = this.bytes, n = b.length, out = [];
        let depth = 0;
        let i = from;
        const v7 = this.version >= 700;
        while (i < n) {
            while (i < n && (b[i] === 32 || b[i] === 10 || b[i] === 13 || b[i] === 9)) i++;
            if (i >= n) break;
            const c = b[i];
            if (c === 35) break;   // '#'
            if (c === 64 && v7) {
                let k = i + 1, len = 0;
                while (k < n && b[k] >= 48 && b[k] <= 57) { len = len * 10 + b[k] - 48; k++; }
                if (k > i + 1 && b[k] === 32) {
                    out.push({ s: utf8(b, k + 1, k + 1 + len) });
                    i = k + 1 + len;
                    continue;
                }
            }
            let e = i;
            while (e < n && b[e] !== 32 && b[e] !== 10 && b[e] !== 13 && b[e] !== 9 && b[e] !== 35) e++;
            const tok = latin1(b, i, e);
            i = e;
            if (tok === '{') depth++;
            else if (tok === '}') { depth--; if (subtype && depth === 0) { out.push(tok); break; } }
            out.push(tok);
        }
        return out;
    }

    // --- SAB ---

    indexSab() {
        const b = this.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const sig = SAB_SIGNATURES.find(s => startsWith(b, s));
        let p = sig.length;
        this.version = dv.getInt32(p, true); p += 16;
        this.dv = dv;
        // product, kernel version, date (tagged strings), units, resabs, resnor (tagged doubles)
        const strs = [];
        for (let k = 0; k < 3; k++) { if (b[p] === 7) { const len = b[p + 1]; strs.push(latin1(b, p + 2, p + 2 + len)); p += 2 + len; } }
        this.product = strs.join(' ');
        this.unitMm = 1;
        if (b[p] === 6) { this.unitMm = dv.getFloat64(p + 1, true); p += 9; }
        for (let k = 0; k < 2 && b[p] === 6; k++) p += 9;
        if (!(this.unitMm > 0)) this.unitMm = 1;
        const starts = [], subs = [];
        let start = p, first = true;
        while (p < b.length) {
            const tag = b[p];
            if (first) { start = p; first = false; }
            if (tag === 17) {   // record end
                starts.push(start);
                p++;
                first = true;
                continue;
            }
            if (tag === 15) {
                // a numbered subtype unless it is a reference ("ref" as the next word)
                const q = p + 1;
                const isRef = (b[q] === 7 || b[q] === 13 || b[q] === 14) && b[q + 1] === 3 && b[q + 2] === 114 && b[q + 3] === 101 && b[q + 4] === 102;
                if (!isRef) subs.push(p);
            }
            const next = this.sabSkip(p);
            if (next < 0) break;
            // end marker: "End-of-…" as type name parts at a record start
            if (tag === 14 && start === p && b[p + 1] === 3 && latin1(b, p + 2, p + 5) === 'End') break;
            p = next;
        }
        this.starts = Float64Array.from(starts);
        this.subs = Float64Array.from(subs);
    }

    // offset after the token at p (−1: unknown tag)
    sabSkip(p) {
        const b = this.bytes, dv = this.dv;
        switch (b[p]) {
            case 4: case 12: case 21: return p + 5;
            case 6: case 23: return p + 9;
            case 7: case 13: case 14: return p + 2 + b[p + 1];
            case 18: return p + 5 + dv.getUint32(p + 1, true);
            case 19: case 20: return p + 25;
            case 10: case 11: case 15: case 16: case 17: return p + 1;
            case 1: case 2: return p + 2;
            case 3: return p + 3;
            case 5: return p + 5;
            default: return -1;
        }
    }

    sabTokens(from, subtype = false) {
        const b = this.bytes, dv = this.dv, out = [];
        let p = from, depth = 0, typeParts = [];
        while (p < b.length) {
            const tag = b[p];
            if (tag === 17) break;
            switch (tag) {
                case 4: case 21: out.push(dv.getInt32(p + 1, true)); break;
                case 12: out.push('$' + dv.getInt32(p + 1, true)); break;
                case 6: case 23: out.push(dv.getFloat64(p + 1, true)); break;
                case 7: out.push(latin1(b, p + 2, p + 2 + b[p + 1])); break;
                case 18: { const len = dv.getUint32(p + 1, true); out.push({ s: utf8(b, p + 5, p + 5 + len) }); break; }
                case 14: typeParts.push(latin1(b, p + 2, p + 2 + b[p + 1])); break;
                case 13: typeParts.push(latin1(b, p + 2, p + 2 + b[p + 1])); out.push(typeParts.join('-')); typeParts = []; break;
                case 19: case 20: out.push(dv.getFloat64(p + 1, true), dv.getFloat64(p + 9, true), dv.getFloat64(p + 17, true)); break;
                case 10: out.push('T'); break;
                case 11: out.push('F'); break;
                case 15: depth++; out.push('{'); break;
                case 16: depth--; out.push('}'); if (subtype && depth === 0) return out; break;
                default: break;
            }
            const next = this.sabSkip(p);
            if (next < 0) break;
            p = next;
        }
        return out;
    }

    // --- records ---

    /** a record as a cursor: type, attribute pointer, then its data (id and pattern of 7.0+ skipped) */
    record(i) {
        const t = this.binary ? this.sabTokens(this.starts[i]) : this.satTokens(this.starts[i]);
        let k = 0;
        // optional sequence number "-n"
        if (typeof t[0] === 'string' && /^-\d+$/.test(t[0]) && typeof t[1] === 'string' && /[a-z]/.test(t[1])) k = 1;
        const type = String(t[k++]);
        const c = new Cursor(t, k, this.version);
        c.type = type;
        c.attrib = c.ptr();
        if (this.version >= 700) {
            c.num();   // id
            if (!type.endsWith('attrib') && c.peekPtr()) c.ptr();   // pattern
        }
        return c;
    }

    type(i) {
        const t = this.binary ? this.sabTokens(this.starts[i]) : this.satTokens(this.starts[i]);
        const k = typeof t[0] === 'string' && /^-\d+$/.test(t[0]) && typeof t[1] === 'string' && /[a-z]/.test(t[1]) ? 1 : 0;
        return String(t[k]);
    }

    /** the tokens of subtype n ("ref n"), from its '{' */
    subtype(n) {
        if (!(n >= 0 && n < this.subs.length)) return null;
        const t = this.binary ? this.sabTokens(this.subs[n], true) : this.satTokens(this.subs[n], true);
        return new Cursor(t, 0, this.version);
    }
}

/** reading position over the tokens of a record or subtype */
export class Cursor {
    constructor(tokens, k, version) {
        this.t = tokens;
        this.k = k;
        this.version = version;
    }
    get done() { return this.k >= this.t.length; }
    peek() { return this.t[this.k]; }
    next() { return this.t[this.k++]; }
    peekPtr() { const x = this.t[this.k]; return typeof x === 'string' && x[0] === '$'; }
    ptr() {
        const x = this.t[this.k++];
        if (typeof x === 'string' && x[0] === '$') return parseInt(x.slice(1), 10);
        return -1;
    }
    /** the next pointer, skipping a few other tokens before it (SAB records hold counts SAT leaves out – vertex, coedge) */
    nextPtr() {
        for (let i = 0; i < 3 && !this.done && !this.peekPtr(); i++) this.k++;
        return this.ptr();
    }
    num() {
        const x = this.t[this.k++];
        if (typeof x === 'number') return x;
        const v = Number(x);
        return Number.isFinite(v) ? v : NaN;
    }
    int() { return Math.round(this.num()); }
    vec() { return [this.num(), this.num(), this.num()]; }
    word() { const x = this.t[this.k++]; return typeof x === 'object' && x ? x.s : String(x); }
    /** a logical: SAB T/F, SAT keywords (`trueWords` = the words meaning true) or 0/1 (old files) */
    flag(...trueWords) {
        const x = this.t[this.k++];
        if (x === 'T' || x === 1 || x === '1') return true;
        if (x === 'F' || x === 0 || x === '0') return false;
        return trueWords.includes(x);
    }
    /** an interval bound: "I" infinite (null) or "F value" */
    bound() {
        const x = this.t[this.k++];
        if (x === 'I' || x === 'T') return null;
        if (x === 'F') return this.num();
        return typeof x === 'number' ? x : Number(x);
    }
    /** skip a '{ … }' (or anything up to the matching one when already inside) */
    skipSubtype() {
        if (this.t[this.k] !== '{') return;
        let depth = 0;
        while (this.k < this.t.length) {
            const x = this.t[this.k++];
            if (x === '{') depth++;
            else if (x === '}' && --depth === 0) return;
        }
    }
    /** the tokens of the subtype starting here as a cursor of its own (positioned after its '{') */
    sub() {
        const from = this.k;
        this.skipSubtype();
        return new Cursor(this.t.slice(from + 1, this.k - 1), 0, this.version);
    }
}

function startsWith(b, s) {
    for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
    return true;
}
function latin1(b, s, e) {
    let out = '';
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
}
const decoder = new TextDecoder();
function utf8(b, s, e) {
    return decoder.decode(b.buffer instanceof ArrayBuffer ? b.subarray(s, e) : b.slice(s, e));
}
