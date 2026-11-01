// IES editor (free window like the HDRI and node editor, float-window.js): the light distribution of an IES light.
// Left the polar diagram as on luminaire data sheets (0° pointing down, intensity per angle – the luminaire's
// "silhouette"): the shown plane pair solid (C0–C180 or C90–C270), the other pair dashed. Control points on the curves
// (scene-lights.js: monotone cubic between them) – drag changes angle and value, double click adds one on that half, Del
// removes the selected one; the first and last point stay at 0° / 180°. Symmetry: rotationally symmetric (one curve),
// two axes (C0 = C180, C90 = C270 – mirrored left/right) or free (four planes C0, C90, C180, C270; around the axis
// blended between neighbours, scene-lights.js planesValues). The right half is C0 / C90, the left half C180 / C270; in
// the symmetric modes the mirrored points edit the same curve. Right the light image: the light on the floor (seen from
// above, luminaire one height above it) and on a wall one height away towards the right half's plane (lower edge =
// floor, line = the luminaire's height), optionally in false colours. Values of the shown right plane: beam angle (50 %
// of the peak), field angle (10 %), share of the light going up. Header: template (own profiles), export as .ies.
// Changes act live on the light (raster at once, path tracing after release), one undo step per change (hooks.onCommit).
import { t } from './i18n.js';
import { SELECT } from './ui-controls.js';
import { floatWindow } from './float-window.js';
import { icon } from './icons.js';
import { curveValues } from './scene-lights.js';

const BUTTON = 'rounded px-2 py-0.5 text-white/80 hover:bg-white/15 disabled:opacity-40';
const STORE_KEY = 'rindr.iesEditor.window';
const ICON_CLOSE = icon('close', 'size-3.5');
const D = Math.PI / 180;
const IMAGE = 128;   // light image resolution (per view)

export class IesEditor {
    /**
     * @param {HTMLElement} root
     * @param {{ profile: (light) => { rows: number, values: Float32Array },
     *           shape: (light) => { mode: 'rot'|'axes'|'free', planes: number[][][] },
     *           presets: string[], onPreview: (light, shape) => void, onDrag: (active: boolean) => void,
     *           onCommit: (light, before, after) => void, onPreset: (light, id) => Promise<void>,
     *           onExport: (light, text) => void, onClose?: () => void }} hooks
     */
    constructor(root, hooks) {
        this.root = root;
        this.hooks = hooks;
        this.light = null;
        this.mode = 'rot';       // symmetry: 'rot' (one curve) | 'axes' (C0 = C180, C90 = C270) | 'free' (four planes)
        this.planes = null;      // [C0, C90, C180, C270] – curves [[angle°, value], …] (the symmetric modes keep copies)
        this.view = 0;           // shown plane pair: 0 = C0–C180, 1 = C90–C270
        this.profile = null;     // { rows, values } shown
        this.sel = null;         // { p: plane index (canonical), i: point }
        this.falseColour = false;
        root.hidden = true;
        root.innerHTML = `
            <div data-head class="flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-white/10 px-2 py-1.5 whitespace-nowrap select-none">
                <span class="shrink-0 px-1 font-medium text-white/60">${t('iesEditor.title')}</span>
                <span data-name class="min-w-0 truncate text-white/90"></span>
                <span class="ml-3 shrink-0 text-white/50">${t('iesEditor.template')}</span>
                <select data-preset class="${SELECT.replace('w-full', 'w-auto')}"></select>
                <span class="ml-3 shrink-0 text-white/50">${t('iesEditor.symmetry')}</span>
                <select data-mode class="${SELECT.replace('w-full', 'w-auto')}" title="${t('iesEditor.symmetryTitle')}">
                    <option value="rot">${t('iesEditor.modes.rot')}</option>
                    <option value="axes">${t('iesEditor.modes.axes')}</option>
                    <option value="free">${t('iesEditor.modes.free')}</option>
                </select>
                <span class="ml-2 flex shrink-0 rounded ring-1 ring-white/15">
                    <button data-view="0" class="${BUTTON} rounded-r-none" title="${t('iesEditor.viewTitle')}">C0–C180</button>
                    <button data-view="1" class="${BUTTON} rounded-l-none" title="${t('iesEditor.viewTitle')}">C90–C270</button>
                </span>
                <button data-export class="${BUTTON} ml-2 shrink-0" title="${t('iesEditor.exportTitle')}">${t('iesEditor.export')}</button>
                <span class="ml-auto"></span>
                <button data-close class="${BUTTON} flex items-center py-1" title="${t('iesEditor.close')}">${ICON_CLOSE}</button>
            </div>
            <div class="flex min-h-0 flex-1">
                <div class="flex min-w-0 flex-1 flex-col">
                    <div data-area class="relative min-h-0 flex-1 p-2">
                        <canvas data-polar class="absolute inset-2 size-[calc(100%-1rem)] touch-none"></canvas>
                    </div>
                    <div data-values class="shrink-0 border-t border-white/10 px-3 py-1.5 text-white/60"></div>
                </div>
                <div class="flex w-64 shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-white/10 px-3 py-2">
                    <div class="text-white/60">${t('iesEditor.floor')}</div>
                    <canvas data-floor width="${IMAGE}" height="${IMAGE}" class="aspect-square w-full rounded ring-1 ring-white/10 [image-rendering:auto]"></canvas>
                    <div class="text-white/60">${t('iesEditor.wall')}</div>
                    <canvas data-wall width="${IMAGE}" height="${IMAGE}" class="aspect-square w-full rounded ring-1 ring-white/10"></canvas>
                    <label class="flex cursor-pointer items-center gap-1.5 text-white/60"><input data-false type="checkbox" class="size-3.5 cursor-pointer accent-sky-400">${t('iesEditor.falseColour')}</label>
                    <div data-note class="mt-1 text-white/40">${t('iesEditor.hint')}</div>
                </div>
            </div>`;
        this.$ = s => root.querySelector(s);
        this.polar = this.$('[data-polar]');
        this.window = floatWindow(root, this.$('[data-head]'), { storeKey: STORE_KEY, width: 920, height: 560, minWidth: 560, minHeight: 360 });
        const preset = this.$('[data-preset]');
        preset.append(new Option(t('iesEditor.choose'), ''));
        for (const id of hooks.presets) preset.append(new Option(t(`properties.light.iesProfiles.${id}`), id));
        preset.onchange = async () => {
            const id = preset.value;
            preset.value = '';
            if (!id || !this.light) return;
            await hooks.onPreset(this.light, id);
            this.load(this.light);
        };
        this.$('[data-export]').onclick = () => this.light && hooks.onExport(this.light, this._iesText());
        this.$('[data-close]').onclick = () => this.close();
        this.$('[data-false]').onchange = e => { this.falseColour = e.target.checked; this._drawImages(); };
        // symmetry: the curves carry over (to rotational: the C0 plane), one undo step
        this.$('[data-mode]').onchange = e => {
            if (!this.light) return;
            const before = this._shape();
            const mode = e.target.value, [c0, c90] = this.planes;
            this.planes = mode === 'rot' ? [c0, c0, c0, c0] : mode === 'axes' ? [c0, c90, c0, c90] : this.planes;
            this.planes = this.planes.map(c => c.map(q => [...q]));
            this.mode = mode;
            if (mode === 'rot') this.view = 0;
            this.sel = null;
            this._edited();
            this.hooks.onCommit(this.light, before, this._shape());
        };
        for (const b of root.querySelectorAll('[data-view]')) b.onclick = () => { this.view = Number(b.dataset.view); this.sel = null; this._refresh(); };
        this._setupPolar();
        new ResizeObserver(() => this._drawPolar()).observe(this.$('[data-area]'));
        this.window.apply();
    }

    get isOpen() { return !this.root.hidden; }

    /** edit this IES light */
    open(light) {
        this.root.hidden = false;
        this.window.apply();
        this.load(light);
    }

    /** (re)read the light – after opening, a template, undo/redo */
    load(light) {
        this.light = light;
        this.$('[data-name]').textContent = light.name;
        this.profile = this.hooks.profile(light);
        const shape = this.hooks.shape(light);
        this.mode = shape.mode;
        this.planes = shape.planes.map(c => c.map(q => [...q]));
        if (this.mode === 'rot') this.view = 0;
        if (this.sel && !this.planes[this.sel.p]?.[this.sel.i]) this.sel = null;
        this._refresh();
    }

    close() {
        if (this.root.hidden) return;
        this.root.hidden = true;
        this.light = null;
        this.hooks.onClose?.();
    }

    // plane index whose curve a plane shows (the symmetric modes share curves)
    _canonical(p) {
        return this.mode === 'rot' ? 0 : this.mode === 'axes' ? p % 2 : p;
    }

    // the edited shape for the light (scene-lights.js setIesShape)
    _shape() {
        const copy = c => c.map(q => [...q]);
        if (this.mode === 'rot') return { curve: copy(this.planes[0]) };
        const [c0, c90, c180, c270] = this.planes;
        return { planes: this.mode === 'axes' ? [c0, c90, c0, c90].map(copy) : [c0, c90, c180, c270].map(copy), mode: this.mode };
    }

    // the shown halves: right = C0 / C90, left = C180 / C270 – plane index and its angle φ
    _halves() {
        return [{ side: 1, p: this.view, phi: this.view * 90 }, { side: -1, p: this.view + 2, phi: this.view * 90 + 180 }];
    }

    _refresh() {
        this.$('[data-mode]').value = this.mode;
        for (const b of this.root.querySelectorAll('[data-view]')) {
            const on = Number(b.dataset.view) === this.view;
            b.classList.toggle('bg-sky-500/40', on);
            b.classList.toggle('text-white', on);
            b.disabled = this.mode === 'rot';
        }
        this._drawPolar();
        this._drawImages();
        this._drawValues();
    }

    // intensity (0…1, peak 1) at θ (degrees from the axis) in the C-plane φ (degrees)
    _sampler() {
        const { rows, values } = this.profile;
        let max = 0;
        for (const v of values) max = Math.max(max, v);
        const k = max > 0 ? 1 / max : 0;
        return (theta, phi = 0) => {
            const x = Math.min(Math.max(theta, 0), 180) * 179 / 180;
            const x0 = Math.floor(x), x1 = Math.min(x0 + 1, 179), fx = x - x0;
            const row = rows === 1 ? 0 : ((Math.round(((phi % 360) + 360) % 360)) % rows);
            const a = values[row * 180 + x0], b = values[row * 180 + x1];
            return (a + (b - a) * fx) * k;
        };
    }

    // --- polar diagram ---------------------------------------------------------------------------------------------
    _geometry() {
        const c = this.polar, dpr = devicePixelRatio || 1;
        const w = c.clientWidth, h = c.clientHeight;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const r = Math.max(Math.min(w, h) / 2 - 22, 10);
        return { dpr, w, h, cx: w / 2, cy: h / 2, r };
    }

    // canvas point of (θ, value) on the right (C0) or left (C180) half
    _point(g, theta, value, side = 1) {
        return [g.cx + side * Math.sin(theta * D) * value * g.r, g.cy + Math.cos(theta * D) * value * g.r];
    }

    _drawPolar() {
        if (this.root.hidden || !this.profile) return;
        const g = this._geometry(), ctx = this.polar.getContext('2d');
        ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
        ctx.clearRect(0, 0, g.w, g.h);
        // grid: rings at 25 % steps, rays every 15° (labels every 30°)
        ctx.lineWidth = 1;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        for (let k = 1; k <= 4; k++) {
            ctx.strokeStyle = k === 4 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
            ctx.beginPath();
            ctx.arc(g.cx, g.cy, g.r * k / 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillText(`${k * 25} %`, g.cx + g.r * k / 4 - 26, g.cy - 4);   // along the 90° axis (the top holds 180°)
        }
        for (let a = 0; a < 360; a += 15) {
            const [x, y] = [g.cx + Math.sin(a * D) * g.r, g.cy + Math.cos(a * D) * g.r];
            ctx.strokeStyle = a % 90 === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)';
            ctx.beginPath();
            ctx.moveTo(g.cx, g.cy);
            ctx.lineTo(x, y);
            ctx.stroke();
            if (a % 30 === 0 && a <= 180) {
                const [lx, ly] = [g.cx + Math.sin(a * D) * (g.r + 12), g.cy + Math.cos(a * D) * (g.r + 12)];
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`${a}°`, lx, ly);
            }
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // curves: the shown pair solid, the other one dashed (asymmetric profiles)
        const at = this._sampler();
        const plane = (phi, side, dash, colour) => {
            ctx.setLineDash(dash);
            ctx.strokeStyle = colour;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let a = 0; a <= 180; a += 1) {
                const [x, y] = this._point(g, a, at(a, phi), side);
                if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        };
        const colour = 'rgb(56,189,248)';
        const [right, left] = this._halves();
        if (this.profile.rows > 1) {
            const other = (this.view + 1) % 2;
            plane(other * 90, 1, [5, 4], 'rgba(251,191,36,0.85)');
            plane(other * 90 + 180, -1, [5, 4], 'rgba(251,191,36,0.85)');
        }
        plane(right.phi, 1, [], colour);
        plane(left.phi, -1, [], colour);
        // labels of the halves
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText(`C${right.phi}`, g.cx + g.r * 0.72, g.cy + g.r * 0.95);
        ctx.fillText(`C${left.phi}`, g.cx - g.r * 0.95, g.cy + g.r * 0.95);
        // control points of both halves; mirrored copies (the same curve) a little fainter
        for (const half of [left, right]) {
            const p = this._canonical(half.p), copy = half.side < 0 && this._canonical(right.p) === p;
            this.planes[p].forEach(([a, v], i) => {
                const [x, y] = this._point(g, a, v, half.side);
                const selected = this.sel?.p === p && this.sel.i === i;
                ctx.beginPath();
                ctx.arc(x, y, selected ? 5.5 : 4, 0, Math.PI * 2);
                ctx.fillStyle = selected ? '#fff' : copy ? 'rgba(14,165,233,0.45)' : 'rgb(14,165,233)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 1;
                ctx.stroke();
            });
        }
    }

    _setupPolar() {
        const c = this.polar;
        const local = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        // (θ, value) of a canvas point and the half it lies on
        const polarOf = (g, [x, y]) => {
            const dx = Math.abs(x - g.cx), dy = y - g.cy;
            return [Math.atan2(dx, dy) / D, Math.min(Math.hypot(dx, dy) / g.r, 1), x < g.cx ? -1 : 1];
        };
        // nearest control point (within 9 px) – { p (canonical plane), i, side }
        const nearest = (g, pt) => {
            let best = null, dist = 9;
            for (const half of this._halves()) {
                const p = this._canonical(half.p);
                this.planes[p].forEach(([a, v], i) => {
                    const [x, y] = this._point(g, a, v, half.side);
                    const d = Math.hypot(x - pt[0], y - pt[1]);
                    if (d < dist) { dist = d; best = { p, i, side: half.side }; }
                });
            }
            return best;
        };
        let drag = null;
        c.addEventListener('pointerdown', e => {
            if (!this.light || e.button !== 0) return;
            const g = this._geometry(), hit = nearest(g, local(e));
            this.sel = hit && { p: hit.p, i: hit.i };
            this._drawPolar();
            if (!hit) return;
            c.setPointerCapture(e.pointerId);
            drag = { before: this._shape() };
            this.hooks.onDrag(true);
        });
        c.addEventListener('pointermove', e => {
            if (!drag || !this.sel) return;
            const g = this._geometry();
            let [a, v] = polarOf(g, local(e));
            const curve = this.planes[this.sel.p], i = this.sel.i, last = curve.length - 1;
            // the ends stay at 0° / 180°, the others between their neighbours
            if (i === 0) a = 0;
            else if (i === last) a = 180;
            else a = Math.min(Math.max(a, curve[i - 1][0] + 0.5), curve[i + 1][0] - 0.5);
            curve[i] = [a, Math.max(v, 0)];
            this._syncCopies();
            this._edited();
        });
        const end = () => {
            if (!drag) return;
            const before = drag.before;
            drag = null;
            this.hooks.onDrag(false);
            const after = this._shape();
            if (JSON.stringify(before) !== JSON.stringify(after)) this.hooks.onCommit(this.light, before, after);
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        // double click: a point on the curve of that half at that angle
        c.addEventListener('dblclick', e => {
            if (!this.light) return;
            const g = this._geometry();
            const [a, , side] = polarOf(g, local(e));
            const half = this._halves().find(h => h.side === side), p = this._canonical(half.p), curve = this.planes[p];
            if (a <= 0.5 || a >= 179.5 || curve.some(q => Math.abs(q[0] - a) < 1)) return;
            const before = this._shape();
            curve.push([a, curveValues(curve)[Math.round(a * 179 / 180)]]);
            curve.sort((q, r) => q[0] - r[0]);
            this.sel = { p, i: curve.findIndex(q => q[0] === a) };
            this._syncCopies();
            this._edited();
            this.hooks.onCommit(this.light, before, this._shape());
        });
        // Del: remove the selected point (not the ends)
        this.root.tabIndex = -1;
        this.root.addEventListener('keydown', e => {
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.target.closest('input, select, textarea')) return;
            const curve = this.sel && this.planes[this.sel.p];
            if (!curve || this.sel.i <= 0 || this.sel.i >= curve.length - 1) return;
            e.preventDefault();
            e.stopPropagation();
            const before = this._shape();
            curve.splice(this.sel.i, 1);
            this.sel = null;
            this._syncCopies();
            this._edited();
            this.hooks.onCommit(this.light, before, this._shape());
        });
        c.addEventListener('pointerdown', () => this.root.focus({ preventScroll: true }));
    }

    // symmetric modes: the copies follow their curve (rot: all four from C0, axes: C180 = C0, C270 = C90)
    _syncCopies() {
        for (let p = 0; p < 4; p++) {
            const q = this._canonical(p);
            if (q !== p) this.planes[p] = this.planes[q].map(x => [...x]);
        }
    }

    // the shape changed: onto the light (live), shown from its profile
    _edited() {
        this.hooks.onPreview(this.light, this._shape());
        this.profile = this.hooks.profile(this.light);
        this._refresh();
    }

    // --- light image -------------------------------------------------------------------------------------------------
    _drawImages() {
        if (this.root.hidden || !this.profile) return;
        const at = this._sampler(), R = 2.5;
        const floor = new Float32Array(IMAGE * IMAGE), wall = new Float32Array(IMAGE * IMAGE);
        let max = 0;
        // floor seen from above, luminaire one height above the centre: E = I(θ) cos³θ / h²
        for (let j = 0; j < IMAGE; j++) for (let i = 0; i < IMAGE; i++) {
            const x = ((i + 0.5) / IMAGE * 2 - 1) * R, z = ((j + 0.5) / IMAGE * 2 - 1) * R;
            const r = Math.hypot(x, z), cos = 1 / Math.hypot(1, r);
            const e = at(Math.acos(cos) / D, Math.atan2(z, x) / D) * cos * cos * cos;
            floor[j * IMAGE + i] = e;
            max = Math.max(max, e);
        }
        // wall one height away towards the right half's plane (C0 / C90), from the floor to 2.5 heights up, seen from the
        // front: E = I cos(incidence) / d²
        for (let j = 0; j < IMAGE; j++) for (let i = 0; i < IMAGE; i++) {
            const z = ((i + 0.5) / IMAGE * 2 - 1) * R, y = (1 - (j + 0.5) / IMAGE) * R - 1;   // relative to the luminaire
            const d2 = 1 + y * y + z * z, d = Math.sqrt(d2);
            const theta = Math.acos(Math.min(Math.max(-y / d, -1), 1)) / D;
            wall[j * IMAGE + i] = at(theta, this.view * 90 + Math.atan2(z, 1) / D) * (1 / d) / d2;
        }
        let wmax = 0;
        for (const v of wall) wmax = Math.max(wmax, v);
        const scale = Math.max(max, wmax) || 1;   // one scale for both: the wall is lit less than the floor below
        this._paint(this.$('[data-floor]'), floor, scale, null);
        this._paint(this.$('[data-wall]'), wall, scale, 1 - 1 / R);   // line at the luminaire's height (the floor is the lower edge)
    }

    _paint(canvas, values, scale, lineAt) {
        const ctx = canvas.getContext('2d'), img = ctx.createImageData(IMAGE, IMAGE);
        for (let k = 0; k < values.length; k++) {
            const v = Math.min(values[k] / scale, 1);
            const [r, g, b] = this.falseColour ? falseColour(v) : grey(v);
            img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        if (lineAt !== null) {
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.beginPath();
            ctx.moveTo(0, lineAt * IMAGE);
            ctx.lineTo(IMAGE, lineAt * IMAGE);
            ctx.stroke();
        }
        // luminaire position: centre of the floor view / top middle of the wall view
        if (lineAt === null) {
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.beginPath();
            ctx.arc(IMAGE / 2, IMAGE / 2, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // --- values ------------------------------------------------------------------------------------------------------
    _drawValues() {
        const at = this._sampler(), [right, left] = this._halves();
        // in the shown plane: peak (both halves), beam/field angle = where each half falls to 50 % / 10 % of it
        let max = 0, peakAt = 0;
        for (const phi of [right.phi, left.phi]) for (let a = 0; a <= 180; a++) { const v = at(a, phi); if (v > max) { max = v; peakAt = a; } }
        const reach = (phi, share) => { let last = 0; for (let a = 0; a <= 180; a++) if (at(a, phi) >= share * max) last = a; return last; };
        const beam = Math.min(reach(right.phi, 0.5) + reach(left.phi, 0.5), 360), field = Math.min(reach(right.phi, 0.1) + reach(left.phi, 0.1), 360);
        // share going up: over the whole sphere (every 10° around the axis)
        let up = 0, all = 0;
        for (let phi = 0; phi < 360; phi += 10) for (let a = 0; a < 180; a++) {
            const f = at(a + 0.5, phi) * Math.sin((a + 0.5) * D);
            all += f;
            if (a >= 90) up += f;
        }
        this.$('[data-values]').textContent = t('iesEditor.values', {
            plane: `C${right.phi}–C${left.phi}`, beam: beam.toFixed(0), field: field.toFixed(0), up: all > 0 ? (up / all * 100).toFixed(0) : 0, peak: peakAt,
        });
    }

    // --- export ------------------------------------------------------------------------------------------------------
    // LM-63-2002 text: rotationally symmetric (one horizontal angle) from the curve, or every 1° of the shown profile;
    // relative candela (peak 1000), absolute photometry (lumens −1)
    _iesText() {
        const at = this._sampler();
        const vertical = Array.from({ length: 181 }, (_, i) => i);
        const symmetric = this.profile.rows === 1;
        const horizontal = symmetric ? [0] : Array.from({ length: 360 }, (_, i) => i);
        const lines = ['IESNA:LM-63-2002', `[LUMINAIRE] ${this.light.name}`, '[MANUFAC] RINDR IES editor', 'TILT=NONE',
            `1 -1 1 ${vertical.length} ${horizontal.length} 1 2 0 0 0`, '1 1 0'];
        const wrap = list => { const out = []; for (let i = 0; i < list.length; i += 10) out.push(list.slice(i, i + 10).join(' ')); return out; };
        lines.push(...wrap(vertical), ...wrap(horizontal));
        for (const phi of horizontal) lines.push(...wrap(vertical.map(a => (at(a, phi) * 1000).toFixed(2))));
        return lines.join('\n') + '\n';
    }
}

function grey(v) {
    const g = Math.round(Math.sqrt(v) * 255);
    return [g, g, g];
}
// false colours (dark blue → blue → cyan → green → yellow → red), steps of 10 % like isolux bands
function falseColour(v) {
    const stops = [[0, [10, 10, 40]], [0.15, [30, 60, 200]], [0.35, [20, 190, 220]], [0.55, [40, 200, 80]], [0.75, [240, 220, 40]], [1, [230, 50, 30]]];
    const q = Math.min(Math.floor(v * 10) / 10 + 0.05, 1);
    for (let i = 1; i < stops.length; i++) {
        if (q <= stops[i][0]) {
            const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (q - a) / (b - a);
            return ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
        }
    }
    return stops.at(-1)[1];
}
