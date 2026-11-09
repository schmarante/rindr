// Bit stream of DWG object data (after the public DWG format description, chapter 2 "bit codes"): most values are bit
// coded – a 2-bit prefix tells the size or a common value (BS/BL/BD), doubles with a default (DD), modular chars and
// shorts (MC/MS, byte aligned in the object map and size prefixes), handle references (code · counter · bytes), text
// (8-bit with the code page up to 2004, UTF-16 from 2007 on – then read from the object's string stream), colours,
// extrusion and thickness with their one-bit shortcuts (2000+). Bits are read from the most significant one of a byte.

// release numbers of the version strings
export const R13 = 1012, R14 = 1014, R2000 = 1015, R2004 = 1018, R2007 = 1021, R2010 = 1024, R2013 = 1027, R2018 = 1032;
export const versionNumber = s => Number(String(s).slice(2)) || 0;

const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);

export class BitReader {
    /**
     * @param {Uint8Array} bytes
     * @param {number} version release number (R2000 …)
     * @param {number} bit start position in bits
     */
    constructor(bytes, version, bit = 0, decoder = null) {
        this.b = bytes;
        this.v = version;
        this.p = bit;
        this.decoder = decoder;
        this.strings = null;   // the string stream (R2007+): a BitReader of its own, set by the object reader
    }

    get byte() { return this.p >> 3; }
    seek(bit) { this.p = bit; }

    B() {
        const p = this.p++;
        return (this.b[p >> 3] >> (7 - (p & 7))) & 1;
    }
    BB() { return (this.B() << 1) | this.B(); }
    /** 1 to 3 bits until a zero (R2010+ object type and BLL) */
    B3() {
        let v = 0;
        for (let i = 0; i < 3; i++) { const bit = this.B(); v = (v << 1) | bit; if (!bit) break; }
        return v;
    }
    RC() {
        const p = this.p;
        this.p += 8;
        const i = p >> 3, s = p & 7;
        if (!s) return this.b[i];
        return ((this.b[i] << s) | (this.b[i + 1] >> (8 - s))) & 0xff;
    }
    RS() { const lo = this.RC(); return lo | (this.RC() << 8); }
    RSs() { const v = this.RS(); return v & 0x8000 ? v - 0x10000 : v; }
    RL() { const a = this.RC(), b = this.RC(), c = this.RC(), d = this.RC(); return (a | (b << 8) | (c << 16) | (d << 24)); }
    RLu() { return this.RL() >>> 0; }
    RD() {
        for (let i = 0; i < 8; i++) u8[i] = this.RC();
        return f64[0];
    }
    BS() {
        switch (this.BB()) {
            case 0: return this.RSs();
            case 1: return this.RC();
            case 2: return 0;
            default: return 256;
        }
    }
    BL() {
        switch (this.BB()) {
            case 0: return this.RL();
            case 1: return this.RC();
            default: return 0;
        }
    }
    // length in a fixed 3-bit field (the 2013 header: 3 bits for a zero length – not the 1-to-3-bit code)
    BLL() {
        const n = (this.B() << 2) | (this.B() << 1) | this.B();
        let v = 0, m = 1;
        for (let i = 0; i < n; i++) { v += this.RC() * m; m *= 256; }
        return v;
    }
    BD() {
        switch (this.BB()) {
            case 0: return this.RD();
            case 1: return 1;
            case 2: return 0;
            default: return 0;
        }
    }
    /** double with a default: 00 the default, 01 4 bytes patched in, 10 6 bytes, 11 a full RD */
    DD(def) {
        const code = this.BB();
        if (code === 0) return def;
        if (code === 3) return this.RD();
        f64[0] = def;
        if (code === 1) { for (let i = 0; i < 4; i++) u8[i] = this.RC(); }
        else { u8[4] = this.RC(); u8[5] = this.RC(); for (let i = 0; i < 4; i++) u8[i] = this.RC(); }
        return f64[0];
    }
    RD2() { return [this.RD(), this.RD()]; }
    RD3() { return [this.RD(), this.RD(), this.RD()]; }
    BD2() { return [this.BD(), this.BD()]; }
    BD3() { return [this.BD(), this.BD(), this.BD()]; }
    DD3(d) { return [this.DD(d[0]), this.DD(d[1]), this.DD(d[2])]; }
    /** extrusion: 3BD up to R14, from 2000 a bit for (0, 0, 1) */
    BE() {
        if (this.v >= R2000 && this.B()) return [0, 0, 1];
        return this.BD3();
    }
    /** thickness: BD up to R14, from 2000 a bit for 0 */
    BT() {
        if (this.v >= R2000 && this.B()) return 0;
        return this.BD();
    }
    /** object type: BS up to 2007, from 2010 two bits + 1 or 2 bytes */
    OT() {
        if (this.v < R2010) return this.BS();
        switch (this.BB()) {
            case 0: return this.RC();
            case 1: return this.RC() + 0x1f0;
            default: return this.RS();
        }
    }
    /** handle reference → { code, value } (value: the absolute handle for codes 2–5, an offset otherwise) */
    H() {
        const head = this.RC();
        const code = head >> 4, n = head & 15;
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + this.RC();
        return { code, value: v };
    }
    /** handle reference resolved against the referencing object's handle */
    Href(own) {
        const { code, value } = this.H();
        switch (code) {
            case 6: return own + 1;
            case 8: return own - 1;
            case 0xa: return own + value;
            case 0xc: return own - value;
            default: return value;
        }
    }
    /** text: 8-bit up to 2004 (code page), UTF-16 from 2007 – read from the string stream when there is one */
    TV() {
        if (this.v >= R2007) {
            const s = this.strings || this;
            return s.TU();
        }
        const n = this.BS();
        if (n <= 0) return '';
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = this.RC();
        let len = n;
        while (len > 0 && out[len - 1] === 0) len--;
        return this.decoder ? this.decoder.decode(out.subarray(0, len)) : String.fromCharCode(...out.subarray(0, len));
    }
    TU() {
        const n = this.BS();
        if (n <= 0) return '';
        let s = '';
        for (let i = 0; i < n; i++) {
            const c = this.RS();
            if (c) s += String.fromCharCode(c);
        }
        return s;
    }
    /** colour of tables (CMC): index up to R2000; from 2004 index, RGB, flags (+ names) */
    CMC() {
        const index = this.BS();
        if (this.v < R2004) return { index, rgb: null };
        const rgb = this.BL();
        const flags = this.RC();
        if (flags & 1) this.TV();
        if (flags & 2) this.TV();
        // RGB value with the colour method in the top byte (0xC2 = true colour, 0xC3 = index)
        const method = (rgb >>> 24) & 0xff;
        if (method === 0xc2) return { index: 257, rgb: rgb & 0xffffff };
        if (method === 0xc3) return { index: rgb & 0xff, rgb: null };
        if (method === 0xc0) return { index: 256, rgb: null };
        if (method === 0xc1) return { index: 0, rgb: null };
        return { index, rgb: null };
    }
    /** colour of entities (ENC, 2004+): flags + index; RGB, a colour object handle, transparency follow by flags */
    ENC() {
        if (this.v < R2004) return { index: this.BS(), rgb: null, book: false };
        const v = this.BS();
        const flags = v & 0xe000, index = v & 0x1fff;   // index up to 256 (BYLAYER): 9 bits
        let rgb = null;
        if (flags & 0x8000) {
            const c = this.BL();
            const method = (c >>> 24) & 0xff;
            if (method === 0xc2 || method === 0) rgb = c & 0xffffff;
            else if (method === 0xc3) return { index: c & 0xff, rgb: null, book: !!(flags & 0x4000), transparency: flags & 0x2000 ? this.BL() : null };
        }
        const transparency = flags & 0x2000 ? this.BL() : null;
        return { index: rgb !== null ? 257 : index, rgb, book: !!(flags & 0x4000), transparency };
    }
}

/** modular char at byte offset → [value, next offset] (signed when `signed`: the 0x40 bit of the last byte) */
export function readMC(b, p, signed = true) {
    let v = 0, shift = 1, c;
    for (let i = 0; i < 8; i++) {
        c = b[p++];
        if (!(c & 0x80)) {
            if (signed && (c & 0x40)) return [-(v + (c & 0x3f) * shift), p];
            return [v + (c & 0x7f) * shift, p];
        }
        v += (c & 0x7f) * shift;
        shift *= 128;
    }
    return [v, p];
}

/** modular short at byte offset (object sizes) → [value, next offset] */
export function readMS(b, p) {
    let v = 0, shift = 1;
    for (let i = 0; i < 4; i++) {
        const s = b[p] | (b[p + 1] << 8);
        p += 2;
        if (!(s & 0x8000)) return [v + s * shift, p];
        v += (s & 0x7fff) * shift;
        shift *= 32768;
    }
    return [v, p];
}
