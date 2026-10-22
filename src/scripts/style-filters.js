// Style filters (camera panel "Style filter"): the finished picture redrawn in a look of its own – handheld console
// (4 green tones), pixel / 8 bit, LCD, scanlines (tube monitor), sketch, ASCII art, code rain. All view modes, the
// AI image and the image export see the filtered picture (user's wish: the AI gets what is shown).
//
// The filters work on display values (after tone mapping + sRGB): palettes, dithering and glyph ramps only make
// sense there. Flow (lens-effects.js): with a filter on, end() draws the effect chain linear/HDR into `target`
// (no tone mapping into render targets), the contour lines follow into the same target (viewer.js), then render()
// tone maps per pixel itself (renderer curve + exposure), filters, turns the result back into linear values and
// draws it onto the canvas with the renderer's tone mapping switched off for the rest of the frame – the output pass
// then only applies sRGB, i.e. exactly the filtered display values arrive. restore() (end of the frame, viewer.js)
// puts the curve back. Highlight and gizmo are drawn without the curve meanwhile (their colours barely change);
// the tone mapping must stay the same for the whole frame – every render onto the canvas outputs the complete
// internal framebuffer again (switching back before the gizmo tone mapped the filtered picture twice).
//
// Sizes in pixels scale with the export (setPixelScale) → a larger export looks like the screen, only sharper.
// Glyphs (ASCII, code rain): drawn once with the system's monospace font into an atlas (canvas 2D), sampled with
// an explicit mip level (cell size) – derivatives jump at the cell borders.
import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, vec2, vec3, vec4, float, floor, fract, clamp, mix, step, smoothstep, select, dot, max, min, abs, exp,
    sin, sqrt, pow, log2, screenCoordinate, screenSize, time, sRGBTransferOETF, sRGBTransferEOTF, toneMapping, toneMappingExposure } from 'three/tsl';

export const STYLE_MODES = ['none', 'handheld', 'pixel', 'lcd', 'crt', 'sketch', 'ascii', 'rain'];

const DEFAULTS = {
    handheld: { rows: 144, dither: 0.8, palette: 'green' },
    pixel: { size: 6, levels: 6, dither: 0.5 },
    lcd: { size: 9, gap: 0.4, glow: 0.2 },
    crt: { spacing: 3, strength: 0.7, curvature: 0.35, vignette: 0.5 },
    sketch: { lines: 1, hatching: 0.8, spacing: 7, color: 0.25 },
    ascii: { size: 12, color: 1, brightness: 1.2 },
    rain: { size: 16, speed: 1, image: 0.85 },
};

// own palettes (display sRGB), dark → light
const PALETTES = {
    green: [[0.07, 0.15, 0.08], [0.22, 0.37, 0.15], [0.55, 0.67, 0.24], [0.80, 0.87, 0.52]],
    grey: [[0.09, 0.09, 0.09], [0.35, 0.35, 0.34], [0.63, 0.63, 0.61], [0.89, 0.89, 0.86]],
};

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const ASCII_RAMP = ' .:-=+*#%@';
const ATLAS_CELL = [40, 64];   // glyph cell in the atlas (monospace aspect)

// ordered dithering: 2×2 Bayer value of an integer cell (0, ½, ¾, ¼), nested once more → 4×4 (16 levels in [0, 1))
const bayer2 = a => fract(a.x.mul(0.5).add(a.y.mul(a.y).mul(0.75)));
const bayer4 = a => bayer2(floor(a.mul(0.5))).mul(0.25).add(bayer2(a));
// cheap hash 0…1 of a 2D value
const hash = p => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

function glyphAtlas(chars, columns) {
    const [w, h] = ATLAS_CELL;
    const rows = Math.ceil(chars.length / columns);
    const canvas = document.createElement('canvas');
    canvas.width = w * columns;
    canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(h * 0.78)}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    [...chars].forEach((ch, i) => g.fillText(ch, (i % columns + 0.5) * w, (Math.floor(i / columns) + 0.53) * h, w));
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { tex, columns, rows };
}

// code rain: digits and half-width katakana (fall back to whatever the system font has)
const RAIN_CHARS = (() => {
    let s = '0123456789';
    for (let c = 0xff66; s.length < 64; c++) s += String.fromCharCode(c);
    return s;
})();

export class StyleFilter {
    constructor(renderer) {
        this.renderer = renderer;
        this.mode = 'none';
        this.settings = structuredClone(DEFAULTS);
        this.pixelScale = 1;
        this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.target.texture.name = 'StyleFilter';
        this.input = texture(this.target.texture);
        this.u = {
            a: uniform(0), b: uniform(0), c: uniform(0), d: uniform(0),   // the mode's settings (see _values)
            scale: uniform(1),
            palette: [0, 1, 2, 3].map(() => uniform(new THREE.Color())),
        };
        this.quad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.quad.name = 'StyleFilter';
        this._key = '';
        this._restore = null;   // tone mapping to put back at the end of the frame
        this.pending = false;   // the lens effects drew into `target` this frame
        this._atlases = {};
        this._size = new THREE.Vector2();
    }

    get active() {
        return this.mode !== 'none' && STYLE_MODES.includes(this.mode);
    }

    /** The mode's settings into the uniforms (cheap, every change) */
    apply() {
        const u = this.u;
        const s = this.settings[this.mode];
        u.scale.value = this.pixelScale;
        if (!s) return;
        const v = {
            handheld: [s.rows, s.dither, 0, 0],
            pixel: [s.size, s.levels, s.dither, 0],
            lcd: [s.size, s.gap, s.glow, 0],
            crt: [s.spacing, s.strength, s.curvature, s.vignette],
            sketch: [s.lines, s.hatching, s.spacing, s.color],
            ascii: [s.size, s.color, s.brightness, 0],
            rain: [s.size, s.speed, s.image, 0],
        }[this.mode];
        [u.a.value, u.b.value, u.c.value, u.d.value] = v;
        if (this.mode === 'handheld') (PALETTES[s.palette] || PALETTES.green).forEach((c, i) => u.palette[i].value.setRGB(...c));
    }

    setPixelScale(scale) {
        this.pixelScale = scale;
        this.u.scale.value = scale;
    }

    /** Size of the HDR target = drawing buffer; returns it for end() of the lens effects */
    prepare() {
        this.renderer.getDrawingBufferSize(this._size);
        if (this.target.width !== this._size.x || this.target.height !== this._size.y) this.target.setSize(this._size.x, this._size.y);
        return this.target;
    }

    /** Filter `target` onto the canvas; the tone mapping stays off until restore() */
    render() {
        const r = this.renderer;
        const key = `${this.mode}|${r.toneMapping}`;
        if (key !== this._key) {
            this._key = key;
            this.quad.material.fragmentNode = this._build(r.toneMapping);
            this.quad.material.needsUpdate = true;
        }
        if (this._restore === null) this._restore = r.toneMapping;
        r.toneMapping = THREE.NoToneMapping;
        const autoClear = r.autoClear;
        r.autoClear = true;
        r.setRenderTarget(null);
        this.quad.render(r);
        r.autoClear = autoClear;
    }

    /** End of the frame: the renderer's tone mapping back */
    restore() {
        if (this._restore === null) return;
        this.renderer.toneMapping = this._restore;
        this._restore = null;
    }

    _atlas(name) {
        this._atlases[name] ??= name === 'ascii' ? glyphAtlas(ASCII_RAMP, ASCII_RAMP.length) : glyphAtlas(RAIN_CHARS, 8);
        return this._atlases[name];
    }

    _build(curve) {
        const u = this.u;
        const input = this.input;
        const px = screenCoordinate.xy;
        const size = screenSize;
        // display value (0…1, sRGB) of the HDR picture at uv
        const show = p => clamp(sRGBTransferOETF(toneMapping(curve, toneMappingExposure, vec4(input.sample(p).rgb, 1)).rgb), 0, 1);
        // mean of a cell (4 taps at its quarter points) – calmer than the centre alone
        const cellMean = (idx, cell) => {
            const c = idx.add(0.5).mul(cell);
            const q = cell.mul(0.25);
            return show(c.add(vec2(q.x, q.y).negate()).div(size)).add(show(c.add(vec2(q.x, q.y.negate())).div(size)))
                .add(show(c.add(vec2(q.x.negate(), q.y)).div(size))).add(show(c.add(q).div(size))).mul(0.25);
        };
        const out = c => vec4(sRGBTransferEOTF(clamp(c, 0, 1)), 1);
        const glyph = (atlas, index, f, cellH) => {
            const cell = vec2(index.mod(atlas.columns), floor(index.div(atlas.columns)));
            const p = cell.add(f).div(vec2(atlas.columns, atlas.rows));
            const lod = max(log2(float(ATLAS_CELL[1]).div(cellH)), 0);
            return texture(atlas.tex, p).level(lod).r;
        };

        const build = {
            // 4 tones, ordered dithering on a coarse pixel grid (no gaps between the pixels – user's choice)
            handheld: Fn(() => {
                const cell = size.y.div(max(u.a, 8));
                const idx = floor(px.div(cell));
                const l = dot(cellMean(idx, vec2(cell)), LUMA);
                const q = clamp(floor(l.mul(3).add(0.5).add(bayer4(idx).add(1 / 32 - 0.5).mul(u.b))), 0, 3);
                const [p0, p1, p2, p3] = u.palette;
                return out(select(q.lessThan(0.5), vec3(p0), select(q.lessThan(1.5), vec3(p1), select(q.lessThan(2.5), vec3(p2), vec3(p3)))));
            }),
            // big pixels, few levels per channel, dithered
            pixel: Fn(() => {
                const cell = max(u.a.mul(u.scale), 1);
                const idx = floor(px.div(cell));
                const col = cellMean(idx, vec2(cell));
                const n = max(u.b.sub(1), 1);
                const d = bayer4(idx).add(1 / 32 - 0.5).mul(u.c);
                return out(floor(col.mul(n).add(0.5).add(d)).div(n));
            }),
            // each picture cell = three vertical subpixel stripes R, G, B with dark gaps
            lcd: Fn(() => {
                const cell = max(u.a.mul(u.scale), 1);
                const idx = floor(px.div(cell));
                const col = cellMean(idx, vec2(cell));
                const f = fract(px.div(cell));
                const sub = floor(f.x.mul(3));
                const mask = vec3(step(sub, 0.5), step(abs(sub.sub(1)), 0.5), step(1.5, sub));
                // open part of the subpixel in pixels (1 px soft edge): side gaps per stripe, a gap between the rows
                const ws = cell.div(3);
                const xs = fract(f.x.mul(3)).mul(ws);
                const ys = f.y.mul(cell);
                const gx = u.b.mul(ws).mul(0.5);
                const gy = u.b.mul(cell).mul(0.25);
                const open = smoothstep(gx.sub(0.5), gx.add(0.5), xs).mul(smoothstep(gx.sub(0.5), gx.add(0.5), ws.sub(xs)))
                    .mul(smoothstep(gy.sub(0.5), gy.add(0.5), ys)).mul(smoothstep(gy.sub(0.5), gy.add(0.5), cell.sub(ys)));
                const lit = col.mul(mask).mul(open).mul(mix(2.4, 3.4, u.b));
                const fine = smoothstep(2.5, 5, cell);   // tiny cells: no stripes (moiré)
                return out(mix(col, mix(lit, col, u.c), fine));
            }),
            // tube monitor: curved glass, glowing lines (brighter = wider), aperture grille, vignette
            crt: Fn(() => {
                const uv = px.div(size);
                const q = uv.mul(2).sub(1);
                const aspect = size.x.div(size.y);
                const r2 = dot(q.mul(vec2(aspect, 1)), q.mul(vec2(aspect, 1))).div(aspect.mul(aspect).add(1));
                const w = q.mul(float(1).add(u.c.mul(0.18).mul(r2))).mul(float(1).sub(u.c.mul(0.06)));
                const p = w.mul(0.5).add(0.5);
                const inside = smoothstep(0, 0.004, p.x).mul(smoothstep(1, 0.996, p.x)).mul(smoothstep(0, 0.004, p.y)).mul(smoothstep(1, 0.996, p.y));
                const shift = vec2(u.scale.mul(0.7).div(size.x), 0);
                const col = vec3(show(p.add(shift)).r, show(p).g, show(p.sub(shift)).b);
                const l = dot(col, LUMA);
                const line = fract(p.y.mul(size.y).div(max(u.a.mul(u.scale), 1))).sub(0.5);
                const width = mix(0.05, 0.16, l);
                const beam = exp(line.mul(line).negate().div(width)).mul(1.5);
                const lines = mix(vec3(1), vec3(beam), u.b);
                const column = floor(px.x.div(u.scale)).mod(3);
                const grille = mix(vec3(1), vec3(step(column, 0.5), step(abs(column.sub(1)), 0.5), step(1.5, column)).mul(0.6).add(0.55), u.b.mul(0.35));
                const v = pow(clamp(p.x.mul(p.y).mul(float(1).sub(p.x)).mul(float(1).sub(p.y)).mul(16), 0, 1), u.d.mul(0.45));
                return out(col.mul(lines).mul(grille).mul(v).mul(inside));
            }),
            // pencil: edges (Sobel on brightness) + up to three hatching directions by darkness, on paper
            sketch: Fn(() => {
                const s = u.scale;
                const wobble = vec2(sin(px.y.div(s).mul(0.07)), sin(px.x.div(s).mul(0.05))).mul(s).mul(0.8);
                const p = px.add(wobble);
                const o = s.mul(1.2);
                const L = (dx, dy) => dot(show(p.add(vec2(o.mul(dx), o.mul(dy))).div(size)), LUMA);
                const gx = L(1, -1).add(L(1, 0).mul(2)).add(L(1, 1)).sub(L(-1, -1)).sub(L(-1, 0).mul(2)).sub(L(-1, 1));
                const gy = L(-1, 1).add(L(0, 1).mul(2)).add(L(1, 1)).sub(L(-1, -1)).sub(L(0, -1).mul(2)).sub(L(1, -1));
                const edge = smoothstep(0.1, 0.45, sqrt(gx.mul(gx).add(gy.mul(gy)))).mul(u.a);
                const col = show(p.div(size));
                const l = dot(col, LUMA);
                const spacing = max(u.c.mul(s), 2);
                const hw = s.mul(0.45);
                const stroke = t => float(1).sub(smoothstep(hw, hw.add(s), abs(fract(t).sub(0.5)).mul(spacing).mul(0.7071)));
                const h1 = stroke(p.x.add(p.y).div(spacing)).mul(smoothstep(0.72, 0.55, l));
                const h2 = stroke(p.x.sub(p.y).div(spacing)).mul(smoothstep(0.45, 0.3, l));
                const h3 = stroke(p.y.div(spacing.mul(0.7071))).mul(smoothstep(0.22, 0.1, l));
                const ink = clamp(max(edge, max(h1, max(h2, h3)).mul(u.b)), 0, 1);
                const grain = hash(floor(px.div(s))).mul(0.04);
                const paper = mix(vec3(0.95, 0.93, 0.87), mix(col, vec3(1), 0.35), u.d).sub(grain);
                return out(mix(paper, vec3(0.13, 0.13, 0.16), ink.mul(0.92)));
            }),
            // brightness of a cell → character of the ramp, in the cell's colour (or white)
            ascii: Fn(() => {
                const atlas = this._atlas('ascii');
                const h = max(u.a.mul(u.scale), 4);
                const cell = vec2(h.mul(ATLAS_CELL[0] / ATLAS_CELL[1]), h);
                const idx = floor(px.div(cell));
                const col = cellMean(idx, cell);
                const l = clamp(pow(dot(col, LUMA), float(1).div(u.c)), 0, 0.999);
                const index = floor(l.mul(ASCII_RAMP.length));
                const mask = glyph(atlas, index, fract(px.div(cell)), h);
                const vivid = col.div(max(max(col.r, max(col.g, col.b)), 0.25));
                const fg = mix(vec3(0.88), vivid, u.b);
                return out(mix(vec3(0.015), fg, mask));
            }),
            // falling glyph columns; the picture shows through as brighter, still glyphs
            rain: Fn(() => {
                const atlas = this._atlas('rain');
                const h = max(u.a.mul(u.scale), 6);
                const cell = vec2(h.mul(0.7), h);
                const idx = floor(px.div(cell));
                const rows = size.y.div(h);
                const seed = hash(vec2(idx.x, 1.7));
                const seed2 = hash(vec2(idx.x, 9.1));
                const t = time.mul(u.b).mul(9);
                const period = rows.mul(1.6).add(12);
                const drop = (sd, speed) => {
                    const head = t.mul(speed).add(sd.mul(997)).mod(period);
                    const d = head.sub(idx.y);
                    const trail = select(d.greaterThanEqual(0), exp(d.negate().div(sd.mul(14).add(6))), float(0));
                    return { trail, head: step(0, d).mul(step(d, 1)) };
                };
                const a = drop(seed, seed.mul(0.8).add(0.6));
                const b = drop(seed2, seed2.mul(0.6).add(0.5));
                const trail = max(a.trail, b.trail);
                const head = max(a.head, b.head);
                // picture share: the rain shows mainly where the picture is bright, its bright parts as still dim glyphs
                const img = dot(cellMean(idx, cell), LUMA);
                const vis = mix(float(1), smoothstep(0.12, 0.55, img).mul(0.88).add(0.12), u.c);
                const base = smoothstep(0.1, 0.7, img).mul(u.c).mul(0.45);
                const intensity = clamp(trail.mul(vis).add(base), 0, 1.4);
                const cellSeed = hash(idx.add(3.3));
                const tick = floor(time.mul(cellSeed.mul(5).add(0.5)).add(cellSeed.mul(10)));
                const index = floor(hash(idx.mul(vec2(1, 1.37)).add(tick.mul(0.131))).mul(64));
                const mask = glyph(atlas, index, fract(px.div(cell)), h);
                const green = vec3(0.2, 1, 0.42);
                const col = mix(green.mul(intensity), vec3(0.8, 1, 0.85).mul(vis), head.mul(0.8));
                return out(col.mul(mask).add(green.mul(base).mul(0.08)));
            }),
        };
        return build[this.mode]();
    }

    toJSON() {
        return { mode: this.mode, ...structuredClone(this.settings) };
    }

    fromJSON(s) {
        this.mode = STYLE_MODES.includes(s?.mode) ? s.mode : 'none';
        for (const k of Object.keys(DEFAULTS)) this.settings[k] = { ...DEFAULTS[k], ...(s?.[k] || {}) };
        delete this.settings.handheld.grid;   // older scenes (pixel gaps, removed)
        this.apply();
    }
}

export const STYLE_DEFAULTS = DEFAULTS;
