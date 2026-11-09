// Drawing model (drawing.js) → scene data (CAD worker): one node per layer; per node the lines (by width), the flat
// fills (hatches, filled polylines, 2D solids, wipeouts) and the texts – drawn over the picture by cad/annotations.js in
// raster and HQ – and the 3D surfaces (3D faces, polyface/polygon meshes, MESH, thickness) as real meshes with a colour
// material. ACIS bodies are collected for the STEP way (stage 2). Model space, or a layout: its paper sheet, its own
// objects and the model seen through its viewports (scaled, turned, clipped to the viewport; 3D as wireframe).
//
// Output coordinates: millimetres, +Y up (the drawing's +Z), relative to `origin` (Float32 keeps its precision for
// drawings far from the world origin – survey coordinates).
import { ocsMatrix, ocsBasis, aciRgb, ACI_BYBLOCK, ACI_BYLAYER, ACI_BYOBJECT, LW_BYLAYER, LW_BYBLOCK } from './drawing.js';
import { arcPoints, ellipsePoints, splinePoints } from './curves.js';
import { hatchLoops, fillTriangles, patternSegments, gradientColor, bulgeArc } from './hatch.js';
import { layoutText, layoutMText } from './text-layout.js';
import { TextAtlas } from './text-atlas.js';
import { creaseCornerNormals } from '../crease-normals.js';
import { boxProject } from '../box-project.js';
import earcut from 'earcut';

const DEG = Math.PI / 180;
const WHITE = 0xffffff, BLACK = 0x000000;
const MAX_DEPTH = 16;
const PAPER_COLOR = 0xffffff;
const WIPEOUT_MODEL = 0x262626;

// --- 4 × 4 matrices, column-major ---
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
}
const translate = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale3 = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const rotZ = deg => { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const withOcs = (m, extrusion) => { const o = ocsMatrix(extrusion); return o ? mul(m, o) : m; };

// growable typed array
class Buf {
    constructor(Type = Float64Array, size = 1024) { this.T = Type; this.a = new Type(size); this.n = 0; }
    reserve(k) {
        if (this.n + k <= this.a.length) return;
        let size = this.a.length * 2;
        while (size < this.n + k) size *= 2;
        const b = new this.T(size);
        b.set(this.a.subarray(0, this.n));
        this.a = b;
    }
    push(v) { this.reserve(1); this.a[this.n++] = v; }
    push3(x, y, z) { this.reserve(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
    view() { return this.a.subarray(0, this.n); }
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

/** spaces to choose from: model space and every layout with objects */
export function listSpaces(d) {
    const out = [{ id: 'model', name: null, count: d.modelSpace.length }];
    for (const l of d.layouts) {
        const key = String(l.block || '').toUpperCase();
        if (!key || key === '*MODEL_SPACE') continue;
        const list = d.paperSpace.get(key) || [];
        // the sheet's own viewport (id 1) alone is no content
        const count = list.filter(e => !(e.type === 'VIEWPORT' && e.id === 1)).length;
        if (count) out.push({ id: `layout:${key}`, name: l.name, count });
    }
    return out;
}

/**
 * @param {import('./drawing.js').Drawing} d
 * @param {{ space?: string, maxSegments?: number, maxGlyphs?: number, maxTriangles?: number, onProgress?: (f: number) => void }} options
 */
export function buildDrawing(d, { space = 'model', maxSegments = 2e7, maxGlyphs = 2e6, maxTriangles = 3e7, onProgress = () => {} } = {}) {
    const b = new Builder(d, { maxSegments, maxGlyphs, maxTriangles, onProgress });
    if (space.startsWith('layout:')) b.layout(space.slice(7));
    else b.model();
    return b.finish();
}

class Builder {
    constructor(d, limits) {
        this.d = d;
        this.limits = limits;
        this.nodes = [];
        this.nodeIndex = new Map();
        this.lines = new Map();    // node|width → { node, width, pos: Buf, col: Buf }
        this.fills = new Map();    // node → { pos, col, idx }
        this.texts = new Map();    // node → { pos, uv, col, idx }
        this.meshes = new Map();   // node|rgb → { node, rgb, pos, idx }
        this.acis = [];
        this.atlas = new TextAtlas();
        this.counts = { segments: 0, glyphs: 0, triangles: 0, truncated: false, denseHatches: 0, noFont: 0, xrefs: 0, missingBlocks: 0 };
        this.unit = d.unitMm;
        this.ltscale = d.header.ltscale || 1;
        this.size = this.estimateSize();
        this.tol = Math.max(this.size * 1e-5, 1e-9);
        this.done = 0;
        this.total = 1;
    }

    // rough size of the drawing (tolerances): header extents when sensible, else the points of the objects
    estimateSize() {
        const { extmin, extmax } = this.d.header;
        if (extmin && extmax && extmax[0] > extmin[0] && extmax[0] - extmin[0] < 1e15) {
            return Math.hypot(extmax[0] - extmin[0], extmax[1] - extmin[1], (extmax[2] || 0) - (extmin[2] || 0)) || 1;
        }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const see = p => { if (p && Number.isFinite(p[0])) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } };
        for (const e of this.d.modelSpace) {
            see(e.a); see(e.b); see(e.c); see(e.p);
            if (e.pts) for (let i = 0; i < Math.min(e.pts.length, 30); i += e.kind === '2d' ? 2 : 3) see([e.pts[i], e.pts[i + 1]]);
        }
        return x1 > x0 ? Math.hypot(x1 - x0, y1 - y0) : 1000;
    }

    node(name, { key = `L:${name.toUpperCase()}`, hidden = null } = {}) {
        let i = this.nodeIndex.get(key);
        if (i === undefined) {
            const layer = this.d.layer(name);
            i = this.nodes.length;
            this.nodes.push({ name, parent: -1, key, hidden: hidden ?? !!(layer && (layer.off || layer.frozen)) });
            this.nodeIndex.set(key, i);
        }
        return i;
    }

    progress() {
        if (++this.done % 2000 === 0) this.limits.onProgress(Math.min(this.done / this.total, 1));
    }

    // --- spaces ---

    model() {
        const ctx = { m: IDENT, layer: null, rgb: WHITE, lw: 25, lt: '', node: null, depth: 0, paper: false, clip: null, wire: false, frozen: null, stack: new Set() };
        this.total = this.d.modelSpace.length;
        for (const e of this.d.modelSpace) { this.entity(e, ctx); this.progress(); }
    }

    layout(blockKey) {
        const d = this.d;
        const list = d.paperSpace.get(blockKey) || [];
        const layout = d.layouts.find(l => String(l.block || '').toUpperCase() === blockKey);
        // the sheet: limits of the layout (paper units), else the paper size from the plot settings
        let sheet = null;
        if (layout?.limits && layout.limits[2] > layout.limits[0]) sheet = layout.limits;
        else if (layout?.paper?.[0] > 0) {
            const [w, h] = layout.rotation % 2 ? [layout.paper[1], layout.paper[0]] : layout.paper;
            const [ml, , , mb] = [layout.margins[0], 0, 0, layout.margins[1]];
            sheet = [-ml, -mb, w - ml, h - mb];
        }
        if (sheet) {
            const n = this.node(layout?.name || 'Sheet', { key: 'S:SHEET', hidden: false });
            const [x0, y0, x1, y1] = sheet;
            this.fill(n, [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], [0, 1, 2, 0, 2, 3], PAPER_COLOR, IDENT);
        }
        const ctx = { m: IDENT, layer: null, rgb: BLACK, lw: 25, lt: '', node: null, depth: 0, paper: true, clip: null, wire: false, frozen: null, stack: new Set() };
        this.total = list.length + d.modelSpace.length * list.filter(e => e.type === 'VIEWPORT').length;
        for (const e of list) {
            if (e.type === 'VIEWPORT') { if (e.id !== 1 && e.status !== 0) this.viewport(e, ctx); continue; }
            this.entity(e, ctx);
            this.progress();
        }
    }

    // the model seen through a viewport: DCS of the view direction, twist, scale; clipped to the viewport
    viewport(vp, parent) {
        if (!(vp.w > 0 && vp.h > 0 && vp.viewHeight > 0)) return;
        const k = vp.h / vp.viewHeight;
        const basis = ocsBasis(vp.viewDir);
        const [tx, ty, tz] = vp.target;
        // model → DCS (rows of the basis), then scale, twist and offset; z flattened
        let dcs = basis
            ? [basis.ax[0], basis.ay[0], 0, 0, basis.ax[1], basis.ay[1], 0, 0, basis.ax[2], basis.ay[2], 0, 0, 0, 0, 0, 1]
            : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        dcs = mul(dcs, translate(-tx, -ty, -tz));
        let m = mul(scale3(k, k, k), dcs);
        if (vp.twist) m = mul(rotZ(vp.twist), m);
        m = mul(translate(vp.center[0] - vp.viewCenter[0] * k, vp.center[1] - vp.viewCenter[1] * k, 0), m);
        const clip = [vp.center[0] - vp.w / 2, vp.center[1] - vp.h / 2, vp.center[0] + vp.w / 2, vp.center[1] + vp.h / 2];
        const frozen = new Set((vp.frozen || []).map(n => n.toUpperCase()));
        const ctx = { ...parent, m, clip, wire: true, frozen, stack: new Set() };
        for (const e of this.d.modelSpace) { this.entity(e, ctx); this.progress(); }
    }

    // --- object properties ---

    layerOf(e, ctx) {
        return e.layer === '0' && ctx.layer ? ctx.layer : e.layer;
    }

    rgbOf(e, ctx) {
        const c = e.color;
        if (c === ACI_BYOBJECT && e.rgb !== null) return e.rgb;
        if (c === ACI_BYBLOCK) return ctx.rgb;
        let aci = c;
        if (c === ACI_BYLAYER || c === ACI_BYOBJECT) {
            const layer = this.d.layer(this.layerOf(e, ctx));
            if (layer?.rgb !== null && layer?.rgb !== undefined) return layer.rgb;
            aci = layer ? layer.color : 7;
        }
        if (aci === 7) return ctx.paper ? BLACK : WHITE;
        return aciRgb(aci);
    }

    lwOf(e, ctx) {
        let lw = e.lineweight;
        if (lw === LW_BYBLOCK) lw = ctx.lw;
        else if (lw === LW_BYLAYER) lw = this.d.layer(this.layerOf(e, ctx))?.lineweight ?? -3;
        return lw < 0 ? 25 : lw;
    }

    // line width in CSS pixels (lineweights shown: 0.25 mm and less = 1 px)
    widthOf(e, ctx) {
        if (!this.d.header.lwdisplay) return 1;
        const lw = this.lwOf(e, ctx);
        if (lw <= 25) return 1;
        return Math.max(1, Math.round(lw / 100 * 3.78 * 2) / 2);
    }

    // dash pattern (drawing units) or null for continuous
    patternOf(e, ctx) {
        let name = e.linetype;
        if (!name || name.toUpperCase() === 'BYLAYER') name = this.d.layer(this.layerOf(e, ctx))?.linetype || '';
        else if (name.toUpperCase() === 'BYBLOCK') name = ctx.lt;
        const lt = name ? this.d.linetypes.get(name.toUpperCase()) : null;
        if (!lt || !lt.pattern.length || !(lt.total > 0)) return null;
        const s = this.ltscale * (e.ltscale || 1);
        return { dashes: lt.pattern.map(x => x * s), total: lt.total * s };
    }

    nodeOf(e, ctx) {
        return this.node(ctx.node || this.layerOf(e, ctx));
    }

    visible(e, ctx) {
        if (e.invisible) return false;
        if (ctx.frozen?.size && ctx.frozen.has(this.layerOf(e, ctx).toUpperCase())) return false;
        return true;
    }

    // --- output ---

    apply(m, x, y, z, out) {
        out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        return out;
    }

    lineBatch(node, width) {
        const key = `${node}|${width}`;
        let l = this.lines.get(key);
        if (!l) { l = { node, width, pos: new Buf(), col: new Buf(Uint32Array, 256) }; this.lines.set(key, l); }
        return l;
    }

    // one segment in world coordinates (clipped to the viewport in layouts)
    segment(batch, a, b, rgb, clip) {
        if (this.counts.segments >= this.limits.maxSegments) { this.counts.truncated = true; return; }
        let [ax, ay, az] = a, [bx, by, bz] = b;
        if (clip) {
            // Liang–Barsky against the rectangle (x, y)
            let t0 = 0, t1 = 1;
            const dx = bx - ax, dy = by - ay;
            const edges = [[-dx, ax - clip[0]], [dx, clip[2] - ax], [-dy, ay - clip[1]], [dy, clip[3] - ay]];
            for (const [p, q] of edges) {
                if (p === 0) { if (q < 0) return; continue; }
                const r = q / p;
                if (p < 0) { if (r > t1) return; if (r > t0) t0 = r; } else { if (r < t0) return; if (r < t1) t1 = r; }
            }
            const dz = bz - az;
            const nax = ax + dx * t0, nay = ay + dy * t0, naz = az + dz * t0;
            bx = ax + dx * t1; by = ay + dy * t1; bz = az + dz * t1;
            ax = nax; ay = nay; az = naz;
        }
        batch.pos.push3(ax, ay, az);
        batch.pos.push3(bx, by, bz);
        batch.col.push(rgb);
        this.counts.segments++;
    }

    /** polyline (local points, dim 2 with z or 3) through matrix m, with the dash pattern */
    polyline(e, ctx, pts, dim, z, closed, m, { pattern = this.patternOf(e, ctx) } = {}) {
        const n = pts.length / dim;
        if (n < 2) return;
        const batch = this.lineBatch(this.nodeOf(e, ctx), this.widthOf(e, ctx));
        const rgb = this.rgbOf(e, ctx);
        const P = [0, 0, 0], Q = [0, 0, 0];
        const get = (i, out) => this.apply(m, pts[i * dim], pts[i * dim + 1], dim === 3 ? pts[i * dim + 2] : z, out);
        const count = closed ? n : n - 1;
        // dashes only when the pattern repeats a sensible number of times
        let length = 0;
        if (pattern) {
            for (let i = 0; i < count; i++) {
                const j = (i + 1) % n;
                length += Math.hypot(pts[j * dim] - pts[i * dim], pts[j * dim + 1] - pts[i * dim + 1], dim === 3 ? pts[j * dim + 2] - pts[i * dim + 2] : 0);
            }
            if (!(length > 0) || length / pattern.total > 2000) pattern = null;
        }
        if (!pattern) {
            for (let i = 0; i < count; i++) this.segment(batch, get(i, P), get((i + 1) % n, Q), rgb, ctx.clip);
            return;
        }
        // walk the pattern along the polyline (continuous over the vertices)
        let k = 0, left = Math.abs(pattern.dashes[0]);
        const L = [0, 0, 0], R = [0, 0, 0];
        for (let i = 0; i < count; i++) {
            const j = (i + 1) % n;
            const x0 = pts[i * dim], y0 = pts[i * dim + 1], z0 = dim === 3 ? pts[i * dim + 2] : z;
            const x1 = pts[j * dim], y1 = pts[j * dim + 1], z1 = dim === 3 ? pts[j * dim + 2] : z;
            const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
            let t = 0;
            while (t < len) {
                const step = Math.min(left, len - t);
                const d = pattern.dashes[k];
                if (d > 0 || d === 0) {
                    const s = t / len, e2 = (t + (d === 0 ? 0 : step)) / len;
                    this.apply(m, x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, z0 + (z1 - z0) * s, L);
                    this.apply(m, x0 + (x1 - x0) * e2, y0 + (y1 - y0) * e2, z0 + (z1 - z0) * e2, R);
                    if (d > 0 || (d === 0 && left === Math.abs(d))) this.segment(batch, L, R, rgb, ctx.clip);
                }
                t += step;
                left -= step;
                if (left <= 1e-12) {
                    k = (k + 1) % pattern.dashes.length;
                    left = Math.abs(pattern.dashes[k]);
                    if (left === 0 && pattern.dashes[k] === 0) {
                        // a dot: zero length segment, then the next entry
                        this.apply(m, x0 + (x1 - x0) * (t / len), y0 + (y1 - y0) * (t / len), z0 + (z1 - z0) * (t / len), L);
                        this.segment(batch, L, L, rgb, ctx.clip);
                        k = (k + 1) % pattern.dashes.length;
                        left = Math.abs(pattern.dashes[k]);
                    }
                }
            }
        }
    }

    /** flat fill (annotation): local points [x, y, z, …] + triangles, through m */
    fill(node, pts, index, rgb, m, clip = null, colors = null) {
        let f = this.fills.get(node);
        if (!f) { f = { node, pos: new Buf(), col: new Buf(Uint32Array, 256), idx: new Buf(Uint32Array, 256) }; this.fills.set(node, f); }
        const P = [0, 0, 0];
        if (!clip) {
            const base = f.pos.n / 3;
            for (let i = 0; i < pts.length; i += 3) {
                this.apply(m, pts[i], pts[i + 1], pts[i + 2], P);
                f.pos.push3(P[0], P[1], P[2]);
                f.col.push(colors ? colors[i / 3] : rgb);
            }
            for (const i of index) f.idx.push(base + i);
            return;
        }
        // clip every triangle to the rectangle (Sutherland–Hodgman), fan the rest
        const world = [];
        for (let i = 0; i < pts.length; i += 3) world.push(this.apply(m, pts[i], pts[i + 1], pts[i + 2], [0, 0, 0]).concat([colors ? colors[i / 3] : rgb]));
        for (let t = 0; t < index.length; t += 3) {
            const poly = clipPolygon([world[index[t]], world[index[t + 1]], world[index[t + 2]]], clip, 3);
            if (poly.length < 3) continue;
            const base = f.pos.n / 3;
            for (const p of poly) { f.pos.push3(p[0], p[1], p[2]); f.col.push(p[3]); }
            for (let k = 1; k + 1 < poly.length; k++) { f.idx.push(base); f.idx.push(base + k); f.idx.push(base + k + 1); }
        }
    }

    /** 3D surface: world triangles of a polygon list (each polygon = list of [x,y,z]); wire = its visible edges as lines */
    surface(e, ctx, polygons, m, hiddenEdges = null) {
        if (ctx.wire) {
            const batch = this.lineBatch(this.nodeOf(e, ctx), this.widthOf(e, ctx));
            const rgb = this.rgbOf(e, ctx);
            const A = [0, 0, 0], B = [0, 0, 0];
            polygons.forEach((poly, pi) => {
                for (let i = 0; i < poly.length; i++) {
                    if (hiddenEdges?.[pi]?.[i]) continue;
                    const p = poly[i], q = poly[(i + 1) % poly.length];
                    this.segment(batch, this.apply(m, p[0], p[1], p[2], A), this.apply(m, q[0], q[1], q[2], B), rgb, ctx.clip);
                }
            });
            return;
        }
        if (this.counts.triangles >= this.limits.maxTriangles) { this.counts.truncated = true; return; }
        const node = this.nodeOf(e, ctx), rgb = this.rgbOf(e, ctx);
        const key = `${node}|${rgb}`;
        let s = this.meshes.get(key);
        if (!s) { s = { node, rgb, pos: new Buf(), idx: new Buf(Uint32Array, 1024) }; this.meshes.set(key, s); }
        const P = [0, 0, 0];
        for (const poly of polygons) {
            if (poly.length < 3) continue;
            const base = s.pos.n / 3;
            for (const p of poly) { this.apply(m, p[0], p[1], p[2], P); s.pos.push3(P[0], P[1], P[2]); }
            if (poly.length <= 4) {
                for (let k = 1; k + 1 < poly.length; k++) { s.idx.push(base); s.idx.push(base + k); s.idx.push(base + k + 1); this.counts.triangles++; }
            } else {
                // flat n-gon: earcut in its best projection plane
                const tri = triangulate(poly);
                for (const t of tri) s.idx.push(base + t);
                this.counts.triangles += tri.length / 3;
            }
        }
    }

    glyphs(e, ctx, laid, m) {
        if (!laid) return;
        if (this.counts.glyphs + laid.rects.length > this.limits.maxGlyphs) { this.counts.truncated = true; return; }
        const node = this.nodeOf(e, ctx);
        let t = this.texts.get(node);
        if (!t) { t = { node, pos: new Buf(), uv: new Buf(Float32Array, 512), col: new Buf(Uint32Array, 256), idx: new Buf(Uint32Array, 256) }; this.texts.set(node, t); }
        const P = [0, 0, 0];
        for (let g = 0; g < laid.rects.length; g++) {
            const q = laid.quads, o = g * 8;
            const [rx, ry, rw, rh] = laid.rects[g];
            const uv = [rx, ry + rh, rx + rw, ry + rh, rx + rw, ry, rx, ry];   // pixels; y down in the atlas
            let corners = [];
            for (let k = 0; k < 4; k++) {
                this.apply(m, q[o + k * 2], q[o + k * 2 + 1], 0, P);
                corners.push([P[0], P[1], P[2], uv[k * 2], uv[k * 2 + 1]]);
            }
            if (ctx.clip) {
                corners = clipPolygon(corners, ctx.clip);
                if (corners.length < 3) continue;
            }
            const base = t.pos.n / 3;
            for (const c of corners) { t.pos.push3(c[0], c[1], c[2]); t.uv.push(c[3]); t.uv.push(c[4]); t.col.push(laid.colors[g]); }
            for (let k = 1; k + 1 < corners.length; k++) { t.idx.push(base); t.idx.push(base + k); t.idx.push(base + k + 1); }
            this.counts.glyphs++;
        }
    }

    // --- objects ---

    entity(e, ctx) {
        if (!this.visible(e, ctx)) return;
        try {
            this.entityUnsafe(e, ctx);
        } catch (err) {
            this.d.skip(`${e.type} (error)`);
            if (this.d.skipped[`${e.type} (error)`] === 1) console.warn('[CAD] object could not be built:', e.type, err);
        }
    }

    entityUnsafe(e, ctx) {
        const tol = this.tol;
        switch (e.type) {
            case 'LINE': {
                this.polyline(e, ctx, [...e.a, ...e.b], 3, 0, false, ctx.m);
                if (e.thickness) this.extrude(e, ctx, [...e.a, ...e.b], 3, 0, false, ctx.m, e.extrusion);
                break;
            }
            case 'XLINE': case 'RAY': {
                const L = this.size * 2;
                const [px, py, pz] = e.p, [dx, dy, dz] = e.dir;
                const from = e.type === 'RAY' ? 0 : -L;
                this.polyline(e, ctx, [px + dx * from, py + dy * from, pz + dz * from, px + dx * L, py + dy * L, pz + dz * L], 3, 0, false, ctx.m, { pattern: null });
                break;
            }
            case 'POINT': this.point(e, ctx); break;
            case 'CIRCLE': case 'ARC': {
                const m = withOcs(ctx.m, e.extrusion);
                const full = e.type === 'CIRCLE';
                const pts = arcPoints(e.c[0], e.c[1], e.r, full ? 0 : e.start * DEG, full ? Math.PI * 2 : e.end * DEG, tol, full);
                if (full) pts.length -= 2;   // closed below
                this.polyline(e, ctx, pts, 2, e.c[2], full, m);
                if (e.thickness) this.extrude(e, ctx, pts, 2, e.c[2], full, m, [0, 0, 1], true);
                break;
            }
            case 'ELLIPSE': {
                const pts = ellipsePoints(e, tol);
                this.polyline(e, ctx, pts, 3, 0, false, ctx.m);
                break;
            }
            case 'SPLINE': this.polyline(e, ctx, splinePoints(e, tol), 3, 0, e.closed && !e.ctrl?.length, ctx.m); break;
            case 'POLYLINE': this.polylineEntity(e, ctx); break;
            case '3DFACE': {
                const p = e.pts;
                const poly = [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[6], p[7], p[8]]];
                if (Math.hypot(p[9] - p[6], p[10] - p[7], p[11] - p[8]) > 1e-12) poly.push([p[9], p[10], p[11]]);
                const hidden = [[!!(e.hidden & 1), !!(e.hidden & 2), !!(e.hidden & 4), !!(e.hidden & 8)]];
                this.surface(e, ctx, [poly], ctx.m, hidden);
                break;
            }
            case 'SOLID': case 'TRACE': {
                const p = e.pts;
                // drawing order 1, 2, 4, 3
                const quad = [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[9], p[10], p[11]], [p[6], p[7], p[8]]];
                const m = withOcs(ctx.m, e.extrusion);
                if (e.thickness) { this.prism(e, ctx, quad, m); break; }
                if (!this.d.header.fillmode) { this.polyline(e, ctx, quad.flat(), 3, 0, true, m, { pattern: null }); break; }
                this.fill(this.nodeOf(e, ctx), quad.flat(), [0, 1, 2, 0, 2, 3], this.rgbOf(e, ctx), m, ctx.clip);
                break;
            }
            case 'INSERT': this.insert(e, ctx); break;
            case 'DIMENSION': {
                const block = this.d.blocks.get(e.block.toUpperCase());
                if (!block) { this.counts.missingBlocks++; break; }
                const m = withOcs(ctx.m, e.extrusion);
                this.blockContent(block, e, ctx, m);
                break;
            }
            case 'TEXT': case 'ATTRIB': case 'ATTDEF': {
                if (e.type === 'ATTDEF' && ctx.depth > 0) break;   // definitions show only outside of blocks
                if (!this.atlas.available) { this.counts.noFont++; break; }
                const style = this.d.styles.get(String(e.style).toUpperCase());
                const laid = layoutText(e, style, this.atlas, this.rgbOf(e, ctx));
                if (!laid) break;
                let m = withOcs(ctx.m, e.extrusion);
                m = mul(m, translate(laid.origin[0], laid.origin[1], laid.origin[2] || 0));
                m = mul(m, rotZ(laid.rotation));
                if (laid.mirrorX || laid.mirrorY) m = mul(m, scale3(laid.mirrorX ? -1 : 1, laid.mirrorY ? -1 : 1, 1));
                this.glyphs(e, ctx, laid, m);
                break;
            }
            case 'MTEXT': {
                if (!this.atlas.available) { this.counts.noFont++; break; }
                const style = this.d.styles.get(String(e.style).toUpperCase());
                const laid = layoutMText(e, style, this.atlas, this.rgbOf(e, ctx));
                if (!laid) break;
                const n = e.extrusion || [0, 0, 1];
                const ln = Math.hypot(n[0], n[1], n[2]) || 1;
                const N = [n[0] / ln, n[1] / ln, n[2] / ln];
                let X;
                if (e.dir && Math.hypot(...e.dir) > 0) {
                    // x direction (WCS) projected into the text plane
                    const d = e.dir, dn = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
                    X = [d[0] - N[0] * dn, d[1] - N[1] * dn, d[2] - N[2] * dn];
                } else {
                    const b = ocsBasis(N) || { ax: [1, 0, 0], ay: [0, 1, 0] };
                    const c = Math.cos(e.rot * DEG), s = Math.sin(e.rot * DEG);
                    X = [b.ax[0] * c + b.ay[0] * s, b.ax[1] * c + b.ay[1] * s, b.ax[2] * c + b.ay[2] * s];
                }
                const lx = Math.hypot(...X) || 1;
                X = X.map(v => v / lx);
                const Y = [N[1] * X[2] - N[2] * X[1], N[2] * X[0] - N[0] * X[2], N[0] * X[1] - N[1] * X[0]];
                const local = [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, N[0], N[1], N[2], 0, e.p[0], e.p[1], e.p[2], 1];
                this.glyphs(e, ctx, laid, mul(ctx.m, local));
                break;
            }
            case 'HATCH': this.hatch(e, ctx); break;
            case 'MESH': {
                const p = e.pts;
                const polys = e.faces.map(f => f.map(i => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]));
                this.surface(e, ctx, polys, ctx.m);
                break;
            }
            case 'LEADER': this.leader(e, ctx); break;
            case 'MLINE': {
                const n = e.pts.length / 3;
                const elements = e.params[0]?.length || 0;
                for (let el = 0; el < elements; el++) {
                    const pts = [];
                    for (let i = 0; i < n; i++) {
                        const o = e.params[i]?.[el] ?? 0;
                        pts.push(e.pts[i * 3] + e.miters[i * 3] * o, e.pts[i * 3 + 1] + e.miters[i * 3 + 1] * o, e.pts[i * 3 + 2] + e.miters[i * 3 + 2] * o);
                    }
                    this.polyline(e, ctx, pts, 3, 0, e.closed, ctx.m);
                }
                break;
            }
            case 'WIPEOUT': {
                const p = e.polygon;
                if (p.length < 9) break;
                const poly = [];
                for (let i = 0; i < p.length; i += 3) poly.push([p[i], p[i + 1], p[i + 2]]);
                const tri = triangulate(poly);
                this.fill(this.nodeOf(e, ctx), p, tri, ctx.paper ? PAPER_COLOR : WIPEOUT_MODEL, ctx.m, ctx.clip);
                break;
            }
            case 'VIEWPORT': break;
            default:
                if (e.acis) { this.acis.push({ entity: e, matrix: ctx.m, node: this.nodeOf(e, ctx), rgb: this.rgbOf(e, ctx), wire: ctx.wire }); break; }
                this.d.skip(e.type);
        }
    }

    point(e, ctx) {
        const mode = this.d.header.pdmode;
        if (mode === 1) return;
        let s = this.d.header.pdsize;
        if (!(s > 0)) s = this.size * (s < 0 ? -s / 100 : 0.005);
        const [x, y, z] = e.p, h = s / 2;
        const shapes = [];
        const base = mode & 7;
        if (base === 0) shapes.push([x - h / 4, y, z, x + h / 4, y, z], [x, y - h / 4, z, x, y + h / 4, z]);
        if (base === 2) shapes.push([x - h, y, z, x + h, y, z], [x, y - h, z, x, y + h, z]);
        if (base === 3) shapes.push([x - h, y - h, z, x + h, y + h, z], [x - h, y + h, z, x + h, y - h, z]);
        if (base === 4) shapes.push([x, y, z, x, y + h, z]);
        if (mode & 32) shapes.push(arcPoints(x, y, h, 0, Math.PI * 2, this.tol, true).flatMap((v, i) => (i % 2 ? [v, z] : [v])));
        if (mode & 64) shapes.push([x - h, y - h, z, x + h, y - h, z, x + h, y + h, z, x - h, y + h, z, x - h, y - h, z]);
        for (const pts of shapes) this.polyline(e, ctx, pts, 3, 0, false, ctx.m, { pattern: null });
    }

    polylineEntity(e, ctx) {
        if (e.kind === '3d') { this.polyline(e, ctx, e.pts, 3, 0, e.closed, ctx.m); return; }
        if (e.kind === 'pface') {
            const p = e.pts, nv = p.length / 3;
            const polys = [], hidden = [];
            for (const f of e.faces) {
                const poly = [], hid = [];
                for (const i of f) {
                    if (!i) continue;
                    const v = Math.abs(i) - 1;
                    if (v >= nv) continue;
                    poly.push([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
                    hid.push(i < 0);
                }
                if (poly.length >= 3) { polys.push(poly); hidden.push(hid); }
                else if (poly.length === 2 && ctx.wire) this.polyline(e, ctx, poly.flat(), 3, 0, false, ctx.m, { pattern: null });
            }
            this.surface(e, ctx, polys, ctx.m, hidden);
            return;
        }
        if (e.kind === 'mesh') {
            const { m: M, n: N, pts: p } = e;
            const at = (i, j) => { const k = ((i % M) * N + (j % N)) * 3; return [p[k], p[k + 1], p[k + 2]]; };
            const polys = [];
            const mi = e.closedM ? M : M - 1, nj = e.closedN ? N : N - 1;
            for (let i = 0; i < mi; i++) for (let j = 0; j < nj; j++) polys.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
            this.surface(e, ctx, polys, ctx.m);
            return;
        }
        // 2D (LWPOLYLINE, 2D POLYLINE): OCS with elevation, bulges → arcs, widths → filled band
        const m = withOcs(ctx.m, e.extrusion);
        const pts = [];
        const n = e.pts.length / 2;
        const add = (x, y) => pts.push(x, y);
        const segs = e.closed ? n : n - 1;
        for (let i = 0; i < n; i++) {
            add(e.pts[i * 2], e.pts[i * 2 + 1]);
            const b = e.bulges[i];
            if (b && i < segs) {
                const j = (i + 1) % n;
                bulgeArc(e.pts[i * 2], e.pts[i * 2 + 1], e.pts[j * 2], e.pts[j * 2 + 1], b, this.tol, add);
            }
        }
        const z = e.elevation || 0;
        if (e.widths && this.d.header.fillmode && e.widths.some(w => w > 0)) this.widePolyline(e, ctx, m, z);
        else this.polyline(e, ctx, pts, 2, z, e.closed, m);
        if (e.thickness) this.extrude(e, ctx, pts, 2, z, e.closed, m, [0, 0, 1], true);
    }

    // a polyline with widths: a filled band (per segment a quad, widths interpolated; arcs widened radially)
    widePolyline(e, ctx, m, z) {
        const n = e.pts.length / 2;
        const segs = e.closed ? n : n - 1;
        const pts = [], index = [];
        for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            const x0 = e.pts[i * 2], y0 = e.pts[i * 2 + 1], x1 = e.pts[j * 2], y1 = e.pts[j * 2 + 1];
            const w0 = e.widths[i * 2] / 2, w1 = e.widths[i * 2 + 1] / 2;
            const path = [x0, y0];
            if (e.bulges[i]) bulgeArc(x0, y0, x1, y1, e.bulges[i], this.tol, (x, y) => path.push(x, y));
            path.push(x1, y1);
            const k = path.length / 2;
            let total = 0;
            const lens = [0];
            for (let q = 1; q < k; q++) { total += Math.hypot(path[q * 2] - path[q * 2 - 2], path[q * 2 + 1] - path[q * 2 - 1]); lens.push(total); }
            for (let q = 0; q < k; q++) {
                // direction at the point: average of the neighbouring pieces
                const a = Math.max(q - 1, 0), b = Math.min(q + 1, k - 1);
                let dx = path[b * 2] - path[a * 2], dy = path[b * 2 + 1] - path[a * 2 + 1];
                const l = Math.hypot(dx, dy) || 1;
                dx /= l; dy /= l;
                const w = w0 + (w1 - w0) * (total > 0 ? lens[q] / total : 0);
                pts.push(path[q * 2] - dy * w, path[q * 2 + 1] + dx * w, z, path[q * 2] + dy * w, path[q * 2 + 1] - dx * w, z);
                if (q > 0) {
                    const v = pts.length / 3 - 4;
                    index.push(v, v + 1, v + 3, v, v + 3, v + 2);
                }
            }
        }
        if (index.length) this.fill(this.nodeOf(e, ctx), pts, index, this.rgbOf(e, ctx), m, ctx.clip);
    }

    // walls of an object with thickness: quads from the curve up along the OCS z (or the extrusion for lines)
    extrude(e, ctx, pts, dim, z, closed, m, dir, ocsZ = false) {
        const t = e.thickness;
        const n = pts.length / dim;
        const ex = ocsZ ? [0, 0, t] : (() => { const d = e.extrusion || [0, 0, 1]; const l = Math.hypot(...d) || 1; return d.map(v => v / l * t); })();
        const at = i => [pts[i * dim], pts[i * dim + 1], dim === 3 ? pts[i * dim + 2] : z];
        const polys = [];
        const count = closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
            const a = at(i), b = at((i + 1) % n);
            polys.push([a, b, [b[0] + ex[0], b[1] + ex[1], b[2] + ex[2]], [a[0] + ex[0], a[1] + ex[1], a[2] + ex[2]]]);
        }
        this.surface(e, ctx, polys, m);
        // the top edge as a line too
        const top = [];
        for (let i = 0; i < n; i++) { const p = at(i); top.push(p[0] + ex[0], p[1] + ex[1], p[2] + ex[2]); }
        this.polyline(e, ctx, top, 3, 0, closed, m);
    }

    // a 2D solid with thickness: closed prism
    prism(e, ctx, quad, m) {
        const t = e.thickness;
        const top = quad.map(p => [p[0], p[1], p[2] + t]);
        const polys = [quad.slice().reverse(), top];
        for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; polys.push([quad[i], quad[j], top[j], top[i]]); }
        this.surface(e, ctx, polys, m);
    }

    insert(e, ctx) {
        const block = this.d.blocks.get(e.name.toUpperCase());
        if (!block) { this.counts.missingBlocks++; return; }
        if (block.flags & 4) { this.counts.xrefs++; return; }   // external reference – not in this file
        if (ctx.depth >= MAX_DEPTH || ctx.stack.has(block)) return;
        const base = withOcs(ctx.m, e.extrusion);
        const [sx, sy, sz] = e.scale;
        const local = mul(scale3(sx || 1, sy || 1, sz || 1), translate(-block.base[0], -block.base[1], -block.base[2]));
        for (let r = 0; r < e.rows; r++) {
            for (let c = 0; c < e.cols; c++) {
                let m = mul(base, translate(e.p[0], e.p[1], e.p[2]));
                m = mul(m, rotZ(e.rot));
                if (r || c) m = mul(m, translate(c * e.colSpacing, r * e.rowSpacing, 0));
                this.blockContent(block, e, ctx, mul(m, local));
            }
        }
        // attributes are placed in the parent's coordinates
        for (const a of e.attribs || []) this.entity(a, this.childCtx(e, ctx, ctx.m, block));
    }

    childCtx(e, ctx, m, block) {
        const layer = this.layerOf(e, ctx);
        const lay = this.d.layer(layer);
        // an insert on a frozen layer: everything in it belongs to that layer's node (hiding it hides all)
        const node = ctx.node || (lay?.frozen ? layer : null);
        const stack = new Set(ctx.stack);
        stack.add(block);
        let lt = e.linetype;
        if (!lt || lt.toUpperCase() === 'BYLAYER') lt = lay?.linetype || '';
        else if (lt.toUpperCase() === 'BYBLOCK') lt = ctx.lt;
        return { ...ctx, m, layer, rgb: this.rgbOf(e, ctx), lw: this.lwOf(e, ctx), lt, node, depth: ctx.depth + 1, stack };
    }

    blockContent(block, e, ctx, m) {
        const child = this.childCtx(e, ctx, m, block);
        for (const x of block.entities) this.entity(x, child);
    }

    hatch(e, ctx) {
        const m = mul(withOcs(ctx.m, e.extrusion), translate(0, 0, e.elevation || 0));
        const loops = hatchLoops(e, this.tol);
        if (!loops.length) return;
        const node = this.nodeOf(e, ctx);
        const rgb = this.rgbOf(e, ctx);
        if (e.solid || e.gradient) {
            const { pts, index } = fillTriangles(loops, e.style);
            if (!index.length) return;
            const p3 = [];
            for (let i = 0; i < pts.length; i += 2) p3.push(pts[i], pts[i + 1], 0);
            let colors = null;
            if (e.gradient) {
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
                const g = e.gradient.colors.length ? e.gradient : { ...e.gradient, colors: [rgb] };
                colors = [];
                for (let i = 0; i < pts.length; i += 2) colors.push(gradientColor(g, pts[i], pts[i + 1], [x0, y0, x1, y1]));
            }
            this.fill(node, p3, index, rgb, m, ctx.clip, colors);
            return;
        }
        const segs = patternSegments(loops, e.style, e.patterns, Math.max(0, Math.min(2e6, this.limits.maxSegments - this.counts.segments)));
        if (segs === null) {
            this.counts.denseHatches++;
            for (const l of loops) this.polyline(e, ctx, l.pts, 2, 0, true, m, { pattern: null });
            return;
        }
        const batch = this.lineBatch(node, this.widthOf(e, ctx));
        const A = [0, 0, 0], B = [0, 0, 0];
        for (let i = 0; i < segs.length; i += 4) this.segment(batch, this.apply(m, segs[i], segs[i + 1], 0, A), this.apply(m, segs[i + 2], segs[i + 3], 0, B), rgb, ctx.clip);
    }

    leader(e, ctx) {
        let pts = e.pts;
        if (pts.length < 6) return;
        if (e.spline) pts = splinePoints({ fit: pts, ctrl: [] }, this.tol);
        this.polyline(e, ctx, pts, 3, 0, false, ctx.m);
        if (!e.arrow) return;
        // closed filled arrowhead at the first point, pointing away from the second
        const [x0, y0, z0] = pts, [x1, y1] = [pts[3], pts[4]];
        const dx = x0 - x1, dy = y0 - y1, l = Math.hypot(dx, dy);
        if (!(l > 0)) return;
        const s = e.arrowSize, ux = dx / l, uy = dy / l;
        const bx = x0 - ux * s, by = y0 - uy * s, w = s / 6;
        const tri = [x0, y0, z0, bx - uy * w, by + ux * w, z0, bx + uy * w, by - ux * w, z0];
        this.fill(this.nodeOf(e, ctx), tri, [0, 1, 2], this.rgbOf(e, ctx), ctx.m, ctx.clip);
    }

    // --- result ---

    finish() {
        const u = this.unit;
        // world (drawing units, Z up) → millimetres, Y up: (x, y, z) → (x, z, −y) · unit; relative to the origin
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        const grow = (a) => {
            for (let i = 0; i < a.length; i += 3) {
                const x = a[i] * u, y = a[i + 2] * u, z = -a[i + 1] * u;
                if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
                if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
                if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
            }
        };
        for (const l of this.lines.values()) grow(l.pos.view());
        for (const f of this.fills.values()) grow(f.pos.view());
        for (const t of this.texts.values()) grow(t.pos.view());
        for (const s of this.meshes.values()) grow(s.pos.view());
        const empty = !(max[0] >= min[0]);
        const origin = empty ? [0, 0, 0] : min.map((v, i) => (v + max[i]) / 2);
        const toLocal = (a) => {
            const out = new Float32Array(a.length);
            for (let i = 0; i < a.length; i += 3) {
                out[i] = a[i] * u - origin[0];
                out[i + 1] = a[i + 2] * u - origin[1];
                out[i + 2] = -a[i + 1] * u - origin[2];
            }
            return out;
        };
        const colorsOf = (col, perVertex) => {
            const c = col.view();
            const out = new Float32Array(c.length * 3 * perVertex);
            for (let i = 0; i < c.length; i++) {
                const v = c[i];
                for (let k = 0; k < perVertex; k++) {
                    out[(i * perVertex + k) * 3] = LIN[(v >> 16) & 255];
                    out[(i * perVertex + k) * 3 + 1] = LIN[(v >> 8) & 255];
                    out[(i * perVertex + k) * 3 + 2] = LIN[v & 255];
                }
            }
            return out;
        };
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1];
        const lines = [...this.lines.values()].filter(l => l.pos.n).map(l => ({
            node: l.node, width: l.width, key: `cad:l:${this.nodes[l.node].key}:${l.width}`, matrix,
            positions: toLocal(l.pos.view()), colors: colorsOf(l.col, 2),
        }));
        const fills = [...this.fills.values()].filter(f => f.idx.n).map(f => ({
            node: f.node, key: `cad:f:${this.nodes[f.node].key}`, sheet: this.nodes[f.node].key === 'S:SHEET', matrix, positions: toLocal(f.pos.view()), colors: colorsOf(f.col, 1), index: f.idx.view().slice(),
        }));
        const atlas = this.texts.size ? this.atlas.image() : null;
        const texts = [...this.texts.values()].filter(t => t.idx.n).map(t => {
            const uv = t.uv.view().slice();
            for (let i = 0; i < uv.length; i += 2) { uv[i] /= atlas.width; uv[i + 1] /= atlas.height; }
            return { node: t.node, key: `cad:t:${this.nodes[t.node].key}`, matrix, positions: toLocal(t.pos.view()), uvs: uv, colors: colorsOf(t.col, 1), index: t.idx.view().slice() };
        });
        const geometries = [], meshes = [];
        for (const s of this.meshes.values()) {
            if (!s.idx.n) continue;
            const g = meshGeometry(toLocal(s.pos.view()), s.idx.view());
            if (!g) continue;
            const r = ((s.rgb >> 16) & 255) / 255, gr = ((s.rgb >> 8) & 255) / 255, b = (s.rgb & 255) / 255;
            meshes.push({ geometry: geometries.length, matrix, color: [r, gr, b], name: '', node: s.node, instance: -1, key: `cad:m:${this.nodes[s.node].key}:${s.rgb.toString(16)}` });
            geometries.push(g);
        }
        // only 2D: every point in one plane parallel to the ground and no 3D surfaces
        const is2D = !meshes.length && !this.acis.length && !empty && max[1] - min[1] <= Math.max(max[0] - min[0], max[2] - min[2]) * 1e-6;
        return {
            nodes: this.nodes, origin, lines, fills, texts, atlas, geometries, meshes, acis: this.acis,
            bounds: empty ? null : [...min, ...max], is2D, counts: this.counts, skipped: this.d.skipped, unit: u,
        };
    }
}

// geometry of a mesh batch: vertices welded by position, crease normals (30°), box UVs in mm
function meshGeometry(positions, index) {
    // weld by exact position
    const map = new Map();
    const remap = new Uint32Array(positions.length / 3);
    const P = [];
    for (let i = 0; i < positions.length / 3; i++) {
        const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
        let v = map.get(key);
        if (v === undefined) { v = P.length / 3; map.set(key, v); P.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); }
        remap[i] = v;
    }
    const pos = Float32Array.from(P);
    const idx = [];
    for (let t = 0; t < index.length; t += 3) {
        const a = remap[index[t]], b = remap[index[t + 1]], c = remap[index[t + 2]];
        if (a !== b && b !== c && a !== c) idx.push(a, b, c);
    }
    if (!idx.length) return null;
    const tri = Uint32Array.from(idx);
    orientFaces(pos, tri);
    const cn = creaseCornerNormals(pos, tri);
    // vertex per (position, normal)
    const bits = new Uint32Array(cn.buffer);
    const seen = new Map();
    const outP = [], outN = [], outI = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) {
        const v = tri[i];
        const key = `${v}|${bits[i * 3]}|${bits[i * 3 + 1]}|${bits[i * 3 + 2]}`;
        let o = seen.get(key);
        if (o === undefined) {
            o = outP.length / 3;
            seen.set(key, o);
            outP.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
            outN.push(cn[i * 3], cn[i * 3 + 1], cn[i * 3 + 2]);
        }
        outI[i] = o;
    }
    const g = boxProject({ positions: Float32Array.from(outP), normals: Float32Array.from(outN), index: outI });
    return { positions: g.positions, normals: g.normals, uvs: g.uvs, index: g.index instanceof Uint32Array ? g.index : Uint32Array.from(g.index) };
}

// Drawings keep whatever winding their faces had (a polyface model had 43 of 67 shells inside out and 10 % of its shared
// edges wound the same way in both faces – drawn black by the path tracer). Per connected piece: the faces made consistent
// with their neighbours (breadth first over edges shared by exactly two faces), then outwards – closed pieces by their
// signed volume, open ones by the winding most of their faces had. In place.
function orientFaces(pos, tri) {
    const nt = tri.length / 3, nv = pos.length / 3;
    const edges = new Map();   // undirected edge → [face, face] (more: not followed)
    const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
    for (let t = 0; t < nt; t++) {
        for (let k = 0; k < 3; k++) {
            const e = key(tri[t * 3 + k], tri[t * 3 + (k + 1) % 3]);
            const list = edges.get(e);
            if (!list) edges.set(e, [t]);
            else list.push(t);
        }
    }
    // direction of edge a–b in face t: +1 if a → b appears in its winding
    const dirIn = (t, a, b) => {
        for (let k = 0; k < 3; k++) {
            const x = tri[t * 3 + k], y = tri[t * 3 + (k + 1) % 3];
            if (x === a && y === b) return 1;
            if (x === b && y === a) return -1;
        }
        return 0;
    };
    const flip = new Int8Array(nt);   // 0 not seen, 1 keep, −1 flip
    const queue = new Int32Array(nt);
    for (let start = 0; start < nt; start++) {
        if (flip[start]) continue;
        flip[start] = 1;
        let head = 0, tail = 0;
        queue[tail++] = start;
        const members = [];
        while (head < tail) {
            const t = queue[head++];
            members.push(t);
            for (let k = 0; k < 3; k++) {
                const a = tri[t * 3 + k], b = tri[t * 3 + (k + 1) % 3];
                const list = edges.get(key(a, b));
                if (!list || list.length !== 2) continue;
                const u = list[0] === t ? list[1] : list[0];
                if (flip[u]) continue;
                // effective a → b in t; u must run b → a
                flip[u] = dirIn(u, a, b) * flip[t] === 1 ? -1 : 1;
                queue[tail++] = u;
            }
        }
        // outwards: signed volume against the piece's centre when (nearly) closed – edges with two faces, the sign holds for
        // thin shells too (a watch band: |signed| / total far below 0.5) – else the majority of the original winding
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const t of members) for (let k = 0; k < 3; k++) { const v = tri[t * 3 + k] * 3; cx += pos[v]; cy += pos[v + 1]; cz += pos[v + 2]; n++; }
        cx /= n; cy /= n; cz /= n;
        let signed = 0, total = 0, kept = 0;
        for (const t of members) {
            const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
            const ax = pos[a] - cx, ay = pos[a + 1] - cy, az = pos[a + 2] - cz;
            const bx = pos[b] - cx, by = pos[b + 1] - cy, bz = pos[b + 2] - cz;
            const qx = pos[c] - cx, qy = pos[c + 1] - cy, qz = pos[c + 2] - cz;
            const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) * flip[t];
            signed += v;
            total += Math.abs(v);
            if (flip[t] === 1) kept++;
        }
        let open = 0, all = 0;
        for (const t of members) for (let k = 0; k < 3; k++) { all++; if (edges.get(key(tri[t * 3 + k], tri[t * 3 + (k + 1) % 3])).length !== 2) open++; }
        const closed = total > 0 && (open <= all * 0.02 ? Math.abs(signed) / total > 1e-3 : Math.abs(signed) / total > 0.5);
        const invert = closed ? signed < 0 : kept * 2 < members.length;
        for (const t of members) {
            if ((flip[t] === -1) === invert) continue;   // final winding = raw · flip · (invert ? −1 : 1)
            const x = tri[t * 3 + 1]; tri[t * 3 + 1] = tri[t * 3 + 2]; tri[t * 3 + 2] = x;
        }
    }
}

// flat polygon (list of [x,y,z]) → triangle indices (earcut in the plane of its largest projection)
function triangulate(poly) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const [i, j] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const flat = [];
    for (const p of poly) flat.push(p[i], p[j]);
    return earcut(flat);
}

// Sutherland–Hodgman against an axis-aligned rectangle (x, y); vertices [x, y, z, …extra] interpolated up to `lerpTo`
// components, the rest (packed colours) taken from the nearer end
function clipPolygon(poly, [x0, y0, x1, y1], lerpTo = Infinity) {
    const planes = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];
    let out = poly;
    for (const [axis, v, sign] of planes) {
        const input = out;
        out = [];
        if (!input.length) break;
        for (let i = 0; i < input.length; i++) {
            const a = input[i], b = input[(i + 1) % input.length];
            const da = (a[axis] - v) * sign, db = (b[axis] - v) * sign;
            if (da >= 0) out.push(a);
            if ((da >= 0) !== (db >= 0)) {
                const t = da / (da - db);
                out.push(a.map((x, k) => (k < lerpTo ? x + (b[k] - x) * t : (t < 0.5 ? x : b[k]))));
            }
        }
    }
    return out;
}
