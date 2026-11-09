// Glyph atlas for drawing texts (CAD worker): every character a font needs is drawn once with the browser's own font
// (OffscreenCanvas – no font files shipped) and stored as a signed distance field, so text stays sharp when zoomed in
// (the material reads the edge at half value, cad/annotations.js). Texts are then quads that point into the atlas.
//
// Distances: exact Euclidean distance transform of the coverage (two passes of the 1-D lower envelope of parabolas –
// Felzenszwalb & Huttenlocher), sub-pixel edges from partial coverage; own implementation.

const SIZE = 48;            // font size in the atlas (px)
const PAD = 6;              // distance range around a glyph (px)
const PAGE = 2048;          // atlas width; grows in height up to PAGE
const INF = 1e20;

// CAD font names → a browser font. SHX fonts (stroke fonts of CAD programs) have no browser counterpart: a plain sans
// serif; monospace ones stay monospace. TrueType names are used as they are (the system may have them).
const MONO = /^(monotxt|isocpeur|romans?mono)/i;
export function fontFamily(style) {
    if (style?.family?.trim()) return `"${style.family.trim()}", sans-serif`;   // TrueType family named in the file
    const file = (style?.font || '').trim().replace(/^.*[\\/]/, '');
    if (!file) return 'sans-serif';
    if (/\.shx$/i.test(file) || !/\./.test(file)) return MONO.test(file) ? 'monospace' : 'sans-serif';
    // the font file's name as the family (the system may have it), else sans serif
    const base = file.replace(/\.(ttf|ttc|otf)$/i, '');
    return `"${base.charAt(0).toUpperCase() + base.slice(1)}", sans-serif`;
}

export class TextAtlas {
    constructor() {
        this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE * 3, SIZE * 3) : null;
        this.ctx = this.canvas?.getContext('2d', { willReadFrequently: true }) || null;
        this.glyphs = new Map();    // family + char → glyph
        this.fonts = new Map();     // family → { cap, ascent, descent } in px
        this.data = new Uint8Array(PAGE * 256);
        this.height = 256;
        this.x = 0; this.y = 0; this.row = 0;
        this.full = false;
    }

    get available() { return !!this.ctx; }

    font(family) {
        let f = this.fonts.get(family);
        if (!f) {
            const ctx = this.ctx;
            ctx.font = `${SIZE}px ${family}`;
            const m = ctx.measureText('H');
            const g = ctx.measureText('g');
            f = { cap: m.actualBoundingBoxAscent || SIZE * 0.72, descent: g.actualBoundingBoxDescent || SIZE * 0.2 };
            this.fonts.set(family, f);
        }
        return f;
    }

    /**
     * A glyph in units of the cap height (1 = height of a capital letter): advance, box (x0, y0, x1, y1 with the
     * distance pad) and its atlas rectangle in pixels (null for blanks).
     */
    glyph(family, ch) {
        const key = family + '\u0000' + ch;
        let g = this.glyphs.get(key);
        if (g) return g;
        const ctx = this.ctx;
        const f = this.font(family);
        ctx.font = `${SIZE}px ${family}`;
        const m = ctx.measureText(ch);
        const s = 1 / f.cap;
        const left = Math.floor(-(m.actualBoundingBoxLeft || 0)), right = Math.ceil(m.actualBoundingBoxRight || 0);
        const top = Math.ceil(m.actualBoundingBoxAscent || 0), bottom = Math.ceil(m.actualBoundingBoxDescent || 0);
        g = { advance: m.width * s, rect: null };
        const w = right - left, h = top + bottom;
        if (w > 0 && h > 0 && !/\s/.test(ch)) {
            const rect = this._place(w + PAD * 2, h + PAD * 2);
            if (rect) {
                this._draw(ch, family, left, top, w, h, rect);
                g.rect = rect;
                g.box = [(left - PAD) * s, (-bottom - PAD) * s, (right + PAD) * s, (top + PAD) * s];
            }
        }
        this.glyphs.set(key, g);
        return g;
    }

    // shelf packing; the page grows in height (doubling) up to PAGE × PAGE, then glyphs are left out
    _place(w, h) {
        if (this.x + w > PAGE) { this.x = 0; this.y += this.row; this.row = 0; }
        while (this.y + h > this.height) {
            if (this.height >= PAGE) { this.full = true; return null; }
            const grown = new Uint8Array(PAGE * this.height * 2);
            grown.set(this.data);
            this.data = grown;
            this.height *= 2;
        }
        const rect = [this.x, this.y, w, h];
        this.x += w;
        this.row = Math.max(this.row, h);
        return rect;
    }

    _draw(ch, family, left, top, w, h, [rx, ry, rw, rh]) {
        const ctx = this.ctx, c = this.canvas;
        if (c.width < rw || c.height < rh) { c.width = Math.max(c.width, rw); c.height = Math.max(c.height, rh); }
        ctx.clearRect(0, 0, rw, rh);
        ctx.font = `${SIZE}px ${family}`;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ch, PAD - left, PAD + top);
        const img = ctx.getImageData(0, 0, rw, rh).data;
        const n = rw * rh;
        const outer = new Float64Array(n), inner = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = img[i * 4 + 3] / 255;
            if (a >= 1) { outer[i] = 0; inner[i] = INF; }
            else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
            else {
                const d = 0.5 - a;
                outer[i] = d > 0 ? d * d : 0;
                inner[i] = d < 0 ? d * d : 0;
            }
        }
        edt(outer, rw, rh);
        edt(inner, rw, rh);
        for (let y = 0; y < rh; y++) {
            for (let x = 0; x < rw; x++) {
                const i = y * rw + x;
                const dist = Math.sqrt(inner[i]) - Math.sqrt(outer[i]);   // > 0 inside
                const v = 0.5 + dist / (2 * PAD);
                this.data[(ry + y) * PAGE + rx + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
        }
    }

    /** the atlas as one channel: { width, height, data } (rows used only) */
    image() {
        const used = Math.min(this.height, Math.max(64, nextPow2(this.y + this.row)));
        return { width: PAGE, height: used, data: this.data.slice(0, PAGE * used) };
    }
}

const nextPow2 = v => 2 ** Math.ceil(Math.log2(Math.max(v, 1)));

// 2-D squared Euclidean distance transform in place (columns, then rows)
function edt(grid, w, h) {
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
        edt1d(f, h, d, v, z);
        for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
        edt1d(f, w, d, v, z);
        for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
    }
}

function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
        let r = v[k];
        let s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
        while (s <= z[k]) {   // z[0] = −∞ ends it
            k--;
            r = v[k];
            s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const r = v[k];
        d[q] = (q - r) * (q - r) + f[r];
    }
}
