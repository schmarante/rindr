// SAT bodies (sat-file.js) → STEP text the own STEP kernel reads – the import then goes the STEP way (structure,
// workers, tessellation qualities, copies, streaming, colours), like IGES (iges/iges-to-step.js).
//
// Mapping:
//   body → its lumps; a lump whose shells are closed (every coedge has a partner) → MANIFOLD_SOLID_BREP (more shells:
//   BREP_WITH_VOIDS), sheets → OPEN_SHELLs in one SHELL_BASED_SURFACE_MODEL per body; face → ADVANCED_FACE (same sense =
//   face sense, flipped where the SAT surface normal points the other way than the STEP one), loop → FACE_BOUND of an
//   EDGE_LOOP (coedges in their order, ORIENTED_EDGE with the coedge sense), edge → EDGE_CURVE shared by both faces
//   (vertices → VERTEX_POINT; edges without a curve – poles, apexes – are left out of their loops)
//   surfaces: plane → PLANE, cone → CYLINDRICAL_SURFACE / CONICAL_SURFACE (radius grows by sine / cosine along the axis,
//   a negative cosine turns the normal inwards), sphere / torus → SPHERICAL / TOROIDAL_SURFACE (negative radius: inwards),
//   spline → (rational) B_SPLINE_SURFACE_WITH_KNOTS from the bs3 surface of its subtype (exact, or the approximation a
//   procedural one keeps; control points are stored with u running fastest; a procedural one without: a stand-in from
//   the face's boundary – fillFace)
//   curves: straight → LINE, ellipse → CIRCLE / ELLIPSE, intcurve → B-spline of its bs3 curve (the edge's vertices have to
//   lie on it), else the coedge's parameter curve (exppc) as PCURVE on the face's B-spline surface
//   colours: rgb_color / colour attributes of face, lump or body → STYLED_ITEM; the body transform (affine part, scale,
//   translation) and the caller's placement go into the coordinates, lengths in mm.
// wire(): the edges of a body as polylines (a drawing's solid seen through a layout viewport).
import { SatFile } from './sat-file.js';
import { StepWriter, num, str, list, ref } from '../step-text.js';
import { aciRgb } from '../cad/drawing.js';
import { BSplineCurve } from '../step/geometry.js';

const SPLINE_WORDS = new Set(['nubs', 'nurbs']);
// closure / singularity of a bs3 (words in SAT text, numbers in SAB) – a rational one has its rational direction first
const BS3_FORM = new Set(['open', 'closed', 'periodic', 'none', 'singular', 'unknown']);
const skipRationalWord = c => { const x = c.peek(); if (typeof x === 'string' && !BS3_FORM.has(x) && !Number.isFinite(Number(x))) c.next(); };

// 3 × 4 row-major affine [r00 r01 r02 t0 r10 …]
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const compose = (A, B) => {
    const M = new Array(12);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) M[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c];
        M[r * 4 + 3] = A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3];
    }
    return M;
};
const det3 = M => M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const perpendicular = n => normalize(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
// position key at 0.1 µm (mm): welding of edges and vertices
const posKey = p => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
// n × (n + 1) augmented system → solution (Gauss with partial pivoting; NaN when singular)
function solveSystem(A) {
    const n = A.length;
    for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        [A[i], A[p]] = [A[p], A[i]];
        if (Math.abs(A[i][i]) < 1e-14) return new Array(n).fill(NaN);
        for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let v = A[i][n]; for (let c = i + 1; c < n; c++) v -= A[i][c] * x[c]; x[i] = v / A[i][i]; }
    return x;
}

/**
 * A whole SAT/SAB file → STEP text: one product with every body (the file's name).
 * @param {Uint8Array} bytes
 * @returns {{ bytes: Uint8Array, stats: object }}
 */
export function satToStep(bytes, { name = '', onProgress = null } = {}) {
    const file = new SatFile(bytes);
    const c = new SatStep();
    c.onProgress = onProgress;
    // the up axis as for STEP files (step-importer.js): by the program in the header, unknown ones +Y up – a translator's
    // SAT of a vehicle stood on y (0 … 170 in); bodies inside drawings are always +Z up (cad/)
    c.begin(name || 'SAT', file.product.replace(/\s+/g, ' ').trim());
    const items = [];
    for (const b of c.bodiesOf(file)) items.push(...c.body(file, b, { unit: file.unitMm }));
    c.product(name || 'SAT', items, null);
    return { bytes: c.finish(), stats: c.stats };
}

export class SatStep {
    constructor() {
        this.w = new StepWriter();
        this.stats = { bodies: 0, solids: 0, sheets: 0, faces: 0, edges: 0, skipped: {} };
        this.colorStyle = new Map();
        this.onProgress = null;
    }

    skip(what) {
        this.stats.skipped[what] = (this.stats.skipped[what] || 0) + 1;
        return null;
    }

    /** header + contexts; system = the program written as the originating system (decides the up axis) */
    begin(name, system = 'rindr drawing converter +Z UP') {
        const w = this.w;
        w.text('ISO-10303-21;\nHEADER;\n');
        w.text("FILE_DESCRIPTION(('converted from SAT'),'2;1');\n");
        // "+Z UP" (drawings – step-importer.js turns them to +Y up), else the program of the SAT header
        w.text(`FILE_NAME(${str(name)},'',(''),(''),'rindr SAT converter',${str(system)},'');\n`);
        w.text("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n");
        const mm = w.add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
        const rad = w.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
        const sr = w.add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
        this.ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('',''))`);
        const app = w.add("APPLICATION_CONTEXT('automotive design')");
        this.productCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
        this.pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
    }
    ctx2d() {
        return this.ctx2 ??= this.w.add("(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('2D SPACE',''))");
    }

    /** a product with these representation items; id = its node key (the kernel keeps it) */
    product(name, items, id) {
        const w = this.w;
        const rep = w.add(`SHAPE_REPRESENTATION(${str(name)},${list(items.map(ref))},#${this.ctx})`);
        const prod = w.add(`PRODUCT(${str(id ?? name)},${str(name)},'',(#${this.productCtx}))`);
        const form = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
        const pd = w.add(`PRODUCT_DEFINITION('design','',#${form},#${this.pdCtx})`);
        w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep})`);
        return { rep, pd };
    }
    /** child below parent without a placement of its own */
    occurrence(parent, child, label = '') {
        const w = this.w;
        this.originPl ??= w.add(`AXIS2_PLACEMENT_3D('',#${this.cp([0, 0, 0])},#${this.dir([0, 0, 1])},#${this.dir([1, 0, 0])})`);
        const nauo = w.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${str(label)},${str(label)},'',#${parent.pd},#${child.pd},$)`);
        const op = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${this.originPl},#${this.originPl})`);
        const rel = w.add(`(REPRESENTATION_RELATIONSHIP('','',#${child.rep},#${parent.rep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${op})SHAPE_REPRESENTATION_RELATIONSHIP())`);
        w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)})`);
        return nauo;
    }
    finish() { return this.w.finish(); }

    // --- geometry primitives (through the current transform) ---
    P(p) {
        const M = this.M;
        return [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
    }
    D(d) {
        const M = this.M;
        return [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]];
    }
    cp(p) { return this.w.add(`CARTESIAN_POINT('',${list(p.map(num))})`); }
    dir(d) {
        const n = d.length === 2 ? (() => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; })() : normalize(d);
        return this.w.add(`DIRECTION('',${list(n.map(num))})`);
    }
    axis2(o, z, x) {
        z = normalize(z);
        let xx = sub(x, z.map(c => c * dot(x, z)));
        if (len(xx) < 1e-12) xx = perpendicular(z);
        return this.w.add(`AXIS2_PLACEMENT_3D('',#${this.cp(o)},#${this.dir(z)},#${this.dir(xx)})`);
    }

    // --- bodies ---

    bodiesOf(file) {
        const out = [];
        for (let i = 0; i < file.count; i++) {
            const t = file.type(i);
            if (t === 'body') out.push(i);
            else if (out.length && t !== 'asmheader') break;   // bodies are the first records
        }
        if (!out.length) for (let i = 0; i < file.count; i++) if (file.type(i) === 'body') out.push(i);
        return out;
    }

    /**
     * STEP items of one body. options: unit = mm per SAT unit; transform = 3 × 4 placement (mm, applied after the body's
     * own transform – a block insert); color = [r, g, b] 0…1 (the drawing's colour, attributes of the file win)
     */
    body(file, bi, { unit = 1, transform = null, color = null } = {}) {
        this.file = file;
        this.memo = new Map();   // per file: record → STEP id (the transform is fixed per body)
        this.welded = new Map();   // open edges by geometry
        this.vertexAt = new Map();   // VERTEX_POINT by position
        const b = file.record(bi);
        const lump = b.ptr();
        b.ptr();   // wire
        this.place(file, b.ptr(), unit, transform);
        const bodyColor = this.colorOf(b.attrib) || color;
        this.stats.bodies++;
        const items = [], sheets = [];
        let guard = 0;
        for (let l = lump; l >= 0 && guard++ < 1e7;) {
            const r = file.record(l);
            const next = r.ptr();
            const shell = r.ptr();
            const lumpColor = this.colorOf(r.attrib) || bodyColor;
            const shells = [];
            for (let s = shell; s >= 0;) {
                const sr = file.record(s);
                const nextShell = sr.ptr();
                shells.push(this.shell(s, sr, lumpColor));
                s = nextShell;
            }
            const closed = shells.filter(x => x && x.closed), open = shells.filter(x => x && !x.closed);
            if (closed.length) {
                const outer = this.w.add(`CLOSED_SHELL('',${list(closed[0].faces.map(ref))})`);
                const voids = closed.slice(1).map(x => this.w.add(`ORIENTED_CLOSED_SHELL('',*,#${this.w.add(`CLOSED_SHELL('',${list(x.faces.map(ref))})`)},.F.)`));
                const id = voids.length ? this.w.add(`BREP_WITH_VOIDS('',#${outer},${list(voids.map(ref))})`) : this.w.add(`MANIFOLD_SOLID_BREP('',#${outer})`);
                this.style(id, lumpColor);
                items.push(id);
                this.stats.solids++;
            }
            for (const x of open) sheets.push({ faces: x.faces, color: lumpColor });
            l = next;
        }
        if (sheets.length) {
            // sheets of one colour together in one surface model (a converted shell had one face per lump – 114 000)
            const byColor = new Map();
            for (const s of sheets) {
                const k = s.color ? s.color.map(v => v.toFixed(4)).join(',') : '';
                if (!byColor.has(k)) byColor.set(k, { color: s.color, faces: [] });
                byColor.get(k).faces.push(...s.faces);
            }
            for (const { color: c, faces } of byColor.values()) {
                const shell = this.w.add(`OPEN_SHELL('',${list(faces.map(ref))})`);
                const id = this.w.add(`SHELL_BASED_SURFACE_MODEL('',(#${shell}))`);
                this.style(id, c);
                items.push(id);
                this.stats.sheets++;
            }
        }
        return items;
    }

    // the current transform: unit, the body's own transform (record tr), then the caller's placement
    place(file, tr, unit, transform) {
        let M = [unit, 0, 0, 0, 0, unit, 0, 0, 0, 0, unit, 0];
        if (tr >= 0) {
            const t = file.record(tr);
            // SAB keeps the transform as one long string in SAT form ("1 0 0 … tx ty tz scale no_rotate …")
            const x = t.peek();
            if (x && typeof x === 'object' && typeof x.s === 'string') t.t.splice(t.k, 1, ...x.s.trim().split(/\s+/));
            const a = []; for (let k = 0; k < 9; k++) a.push(t.num());
            const tt = t.vec(), s = t.num();
            // p' = s · (p · A) + t (row vector times the affine part)
            const B = [a[0] * s, a[3] * s, a[6] * s, tt[0], a[1] * s, a[4] * s, a[7] * s, tt[1], a[2] * s, a[5] * s, a[8] * s, tt[2]];
            if (B.every(Number.isFinite)) M = compose(M, B);
        }
        if (transform) M = compose(transform, M);
        this.M = M;
        this.lenScale = Math.cbrt(Math.abs(det3(M))) || 1;
        this.mirror = det3(M) < 0;
    }

    /**
     * The edges of a body as polylines – the wireframe of a drawing's solid seen through a layout viewport (STEP knows
     * no such view): [x, y, z, …] after the body's own transform, in its file's units. Arcs in steps of ≤ 5°,
     * intersection curves in 32 pieces of their approximation, edges without a curve (poles, apexes) left out.
     */
    wire(file, bi) {
        this.file = file;
        const b = file.record(bi);
        const lump = b.ptr();
        b.ptr();
        this.place(file, b.ptr(), 1, null);
        const done = new Set(), out = [];
        const line = ei => {
            const r = file.record(ei);
            const v1 = r.ptr();
            const t0 = file.version >= 500 && !r.peekPtr() ? r.num() : null;
            const v2 = r.ptr();
            const t1 = file.version >= 500 && !r.peekPtr() ? r.num() : null;
            r.ptr();
            const cu = r.ptr();
            const sense = r.flag('reversed');
            if (v1 < 0 || v2 < 0 || cu < 0) return null;
            const a = this.vertexPos(v1), z = this.vertexPos(v2);
            const pts = [a, ...this.edgeSamples(cu, a, z, t0 !== null && t1 !== null ? Math.abs(t1 - t0) : null, sense, true), z];
            return Float64Array.from(pts.flat());
        };
        const faces = f0 => {
            for (let f = f0, g = 0; f >= 0 && g++ < 1e7;) {
                const fr = file.record(f);
                const next = fr.ptr();
                for (let l = fr.ptr(), g2 = 0; l >= 0 && g2++ < 1e6;) {
                    const lr = file.record(l);
                    const nextLoop = lr.ptr(), first = lr.ptr();
                    for (let c = first, n = 0; c >= 0 && n < 1e6; n++) {
                        const cr = file.record(c);
                        const cn = cr.ptr();
                        cr.ptr(); cr.ptr();
                        const e = cr.ptr();
                        if (e >= 0 && !done.has(e)) { done.add(e); const p = line(e); if (p) out.push(p); }
                        c = cn;
                        if (c === first) break;
                    }
                    l = nextLoop;
                }
                f = next;
            }
        };
        const subshells = (s0, seen = new Set()) => {
            for (let k = s0, g = 0; k >= 0 && g++ < 1e6 && !seen.has(k);) {
                seen.add(k);
                const r = file.record(k);
                r.ptr();
                const next = r.ptr(), child = r.ptr();
                faces(r.ptr());
                if (child >= 0) subshells(child, seen);
                k = next;
            }
        };
        for (let l = lump, g = 0; l >= 0 && g++ < 1e7;) {
            const r = file.record(l);
            const next = r.ptr();
            for (let s = r.ptr(), g2 = 0; s >= 0 && g2++ < 1e6;) {
                const sr = file.record(s);
                const nextShell = sr.ptr(), sub = sr.ptr();
                faces(sr.ptr());
                if (sub >= 0) subshells(sub);
                s = nextShell;
            }
            l = next;
        }
        return out;
    }

    // faces of a shell (with its subshells); closed = every coedge has a partner
    shell(si, sr, color) {
        const subshell = sr.ptr();
        const firstFace = sr.ptr();
        const faces = [];
        let closed = true;
        const file = this.file;
        const visitFaces = f0 => {
            for (let f = f0, guard = 0; f >= 0 && guard++ < 1e8;) {
                const fr = file.record(f);
                const next = fr.ptr();
                const res = this.face(f, fr, color);
                if (res) { faces.push(res.id); if (!res.closed) closed = false; }
                f = next;
                if ((++this.stats.faces & 1023) === 0 && this.onProgress) this.onProgress(Math.min(0.99, f / file.count));
            }
        };
        visitFaces(firstFace);
        // subshells: parent, next, child, face …
        const seen = new Set();
        const visitSub = s => {
            for (let k = s, guard = 0; k >= 0 && guard++ < 1e6 && !seen.has(k);) {
                seen.add(k);
                const r = file.record(k);
                r.ptr();   // parent
                const next = r.ptr(), child = r.ptr(), face = r.ptr();
                visitFaces(face);
                if (child >= 0) visitSub(child);
                k = next;
            }
        };
        if (subshell >= 0) visitSub(subshell);
        return faces.length ? { faces, closed } : null;
    }

    face(fi, fr, color) {
        const file = this.file;
        const loop = fr.ptr();
        fr.ptr(); fr.ptr();   // shell, subshell
        const surfRec = fr.ptr();
        const reversed = fr.flag('reversed');
        // loops → coedges first (a surface without data of its own is filled from them)
        const loops = [];
        for (let l = loop, guard = 0; l >= 0 && guard++ < 1e6;) {
            const lr = file.record(l);
            const next = lr.ptr();
            const first = lr.ptr();
            const coedges = [];
            for (let c = first, n = 0; c >= 0 && n < 1e6; n++) {
                const cr = file.record(c);
                const cnext = cr.ptr();
                cr.ptr();   // previous
                const partner = cr.ptr();
                const edge = cr.ptr();
                const sense = cr.flag('reversed');
                cr.ptr();   // loop
                const pcurve = cr.nextPtr();   // (SAB: a count first)
                coedges.push({ partner, edge, sense, pcurve });
                c = cnext;
                if (c === first) break;
            }
            loops.push(coedges);
            l = next;
        }
        let surf = this.surface(surfRec);
        if (surf?.missing) {
            const why = surf.missing;
            surf = this.fillFace(loops, reversed);
            if (!surf) return this.skip(why);
        }
        if (!surf) return this.skip(`surface ${surfRec >= 0 ? file.type(surfRec) : 'none'}`);
        const bounds = [];
        let closed = true;
        for (const coedges of loops) {
            const oes = [];
            for (const { partner, edge, sense, pcurve } of coedges) {
                if (partner < 0) closed = false;
                const e = this.edge(edge, pcurve, surf, partner < 0);
                if (e) oes.push(this.w.add(`ORIENTED_EDGE('',*,*,#${e.id},${sense !== e.flip ? '.F.' : '.T.'})`));
            }
            if (oes.length) bounds.push(this.w.add(`FACE_BOUND('',#${this.w.add(`EDGE_LOOP('',${list(oes.map(ref))})`)},.T.)`));
        }
        const same = !reversed !== surf.flip;
        const id = this.w.add(`ADVANCED_FACE('',${list(bounds.map(ref))},#${surf.id},${same ? '.T.' : '.F.'})`);
        const own = this.colorOf(fr.attrib);
        if (own && !(color && own.every((v, i) => Math.abs(v - color[i]) < 1e-4))) this.style(id, own);
        return { id, closed };
    }

    once(key, make) {
        if (this.memo.has(key)) return this.memo.get(key);
        let v = null;
        try { v = make(); } catch (err) { v = this.skip(`error ${String(err.message).slice(0, 50)}`); }
        this.memo.set(key, v);
        return v;
    }

    // vertices by position: edges welded across faces share them
    vertex(vi) {
        return this.once(`v${vi}`, () => {
            const p = this.vertexPos(vi);
            const k = posKey(p);
            let id = this.vertexAt.get(k);
            if (!id) { id = this.w.add(`VERTEX_POINT('',#${this.cp(p)})`); this.vertexAt.set(k, id); }
            return id;
        });
    }
    vertexPos(vi) {
        const r = this.file.record(vi);
        r.ptr();
        return this.P(this.file.record(r.nextPtr()).vec());
    }

    // an edge → { id of its EDGE_CURVE, flip (the shared one runs the other way) }. Open edges (no partner coedge) are
    // welded by geometry: a translator wrote every face of a vehicle as a lump of its own (114 000, no shared edge) – the
    // kernel could not orient the skin as a whole (patches facing inwards looked like holes); same end points and the
    // same curve → one EDGE_CURVE, the second face uses it the other way round
    edge(ei, pcurve, surf, open = false) {
        if (ei < 0) return null;
        return this.once(`e${ei}`, () => {
            const r = this.file.record(ei);
            const v1 = r.ptr();
            if (this.file.version >= 500 && !r.peekPtr()) r.num();   // start parameter
            const v2 = r.ptr();
            if (this.file.version >= 500 && !r.peekPtr()) r.num();
            r.ptr();   // coedge
            const curveRec = r.ptr();
            const sense = r.flag('reversed');
            if (curveRec < 0 || v1 < 0 || v2 < 0) return null;   // degenerate edge (pole, apex): left out of the loop
            const ends = [this.vertexPos(v1), this.vertexPos(v2)];
            const ka = posKey(ends[0]), kb = posKey(ends[1]);
            let weld = null;
            if (open && ka !== kb) {
                const sig = this.curveSig(curveRec);
                if (sig) {
                    weld = (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`) + '|' + sig;
                    const known = this.welded.get(weld);
                    if (known) { this.stats.welded = (this.stats.welded || 0) + 1; return { id: known.id, flip: known.first !== ka }; }
                }
            }
            let c = this.curve(curveRec, ends, sense);
            if (!c && pcurve >= 0 && surf.bspline) c = this.pcurve(pcurve, surf);
            if (!c) return this.skip(`curve ${this.file.type(curveRec)}`);
            this.stats.edges++;
            const id = this.w.add(`EDGE_CURVE('',#${this.vertex(v1)},#${this.vertex(v2)},#${c.id},${(!sense) !== c.reversed ? '.T.' : '.F.'})`);
            if (weld) this.welded.set(weld, { id, first: ka });
            return { id, flip: false };
        });
    }

    // a short description of a curve's shape for welding (null: not welded)
    curveSig(ci) {
        try {
            const r = this.file.record(ci);
            if (r.type === 'straight-curve') return 'L';
            if (r.type === 'ellipse-curve') { const c = this.P(r.vec()); r.vec(); const m = r.vec(); return `E${posKey(c)}:${(len(m) * this.lenScale).toFixed(4)}`; }
            if (r.type === 'intcurve-curve') {
                r.flag('reversed');
                const data = this.subtypeAt(r);
                if (!data) return null;
                if (['full', 'summary', 'none', 'approx'].includes(String(data.peek()))) data.next();
                if (!SPLINE_WORDS.has(String(data.peek()))) return null;
                return 'B' + this.readBs3Curve(data, null, false, 3, true);
            }
        } catch { /* not welded */ }
        return null;
    }

    // --- surfaces: { id, flip (SAT normal against the STEP one), bspline } ---
    surface(si) {
        if (si < 0) return null;
        return this.once(`s${si}`, () => {
            const r = this.file.record(si);
            switch (r.type) {
                case 'plane-surface': {
                    const o = r.vec(), n = r.vec(), u = r.vec();
                    return { id: this.w.add(`PLANE('',#${this.axis2(this.P(o), this.D(n), this.D(u))})`), flip: false };
                }
                case 'cone-surface': return this.cone(r);
                case 'sphere-surface': {
                    const c = r.vec(), R = r.num(), u = r.vec(), pole = r.vec();
                    const pl = this.axis2(this.P(c), this.D(pole), this.D(u));
                    return { id: this.w.add(`SPHERICAL_SURFACE('',#${pl},${num(Math.abs(R) * this.lenScale)})`), flip: R < 0 };
                }
                case 'torus-surface': {
                    const c = r.vec(), n = r.vec(), R = r.num(), rr = r.num(), u = r.vec();
                    const pl = this.axis2(this.P(c), this.D(n), this.D(u));
                    return { id: this.w.add(`TOROIDAL_SURFACE('',#${pl},${num(Math.abs(R) * this.lenScale)},${num(Math.abs(rr) * this.lenScale)})`), flip: rr < 0 };
                }
                case 'spline-surface': {
                    const reversed = r.flag('reversed');
                    const data = this.subtypeAt(r);
                    const s = data && this.bs3Surface(data);
                    if (!s) return { missing: `spline ${data?.name || '?'}` };   // procedural without data: fillFace
                    return { id: s, flip: reversed !== this.mirror, bspline: true };
                }
                default: return this.skip(r.type);
            }
        });
    }

    // A procedural spline surface without an approximation (seen: vertex blends capping rounded bars) → a stand-in from
    // its boundary: the plane of the boundary when it is flat, else the quadratic height field over that plane that fits
    // the boundary best (least squares; a spherical cap is one up to its rim) as a 3 × 3 Bézier patch. The mesh keeps the
    // exact edges either way (the kernel shares their samples with the neighbouring faces) – only the inside is an
    // estimate. The loops run counter-clockwise around the face's normal: their Newell normal is the face's outward
    // side (a mirroring placement turns the order). Boundaries that fit no height field leave the face out.
    fillFace(loops, reversed) {
        const file = this.file, ring = [], pts = [];
        for (const coedges of loops) {
            for (const { edge, sense } of coedges) {
                if (edge < 0) continue;
                const r = file.record(edge);
                const v1 = r.ptr();
                const t0 = file.version >= 500 && !r.peekPtr() ? r.num() : null;
                const v2 = r.ptr();
                const t1 = file.version >= 500 && !r.peekPtr() ? r.num() : null;
                r.ptr();
                const cu = r.ptr();
                const along = r.flag('reversed');   // the edge against its curve
                if (v1 < 0 || v2 < 0) continue;
                const a = this.vertexPos(v1), b = this.vertexPos(v2);
                if (loops[0] === coedges) ring.push(sense ? b : a);
                pts.push(a, b, ...(cu >= 0 ? this.edgeSamples(cu, a, b, t0 !== null && t1 !== null ? Math.abs(t1 - t0) : null, along) : []));
            }
        }
        if (ring.length < 3) return null;
        const n = [0, 0, 0], c = [0, 0, 0];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
            for (let d = 0; d < 3; d++) c[d] += a[d] / ring.length;
        }
        if (!(len(n) > 0)) return null;
        const N = normalize(this.mirror ? n.map(v => -v) : n), X = perpendicular(N), Y = cross(N, X);
        const loc = pts.map(p => { const d = sub(p, c); return [dot(d, X), dot(d, Y), dot(d, N)]; });
        let size = 0, zmin = Infinity, zmax = -Infinity;
        for (const [x, y, z] of loc) { size = Math.max(size, Math.hypot(x, y)); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
        if (!(size > 0)) return null;
        const tol = Math.max(1e-6, 1e-3 * size);
        this.stats.filled = (this.stats.filled || 0) + 1;
        if (zmax - zmin <= tol) return { id: this.w.add(`PLANE('',#${this.axis2(c, N, X)})`), flip: reversed };
        // z ≈ k0 + k1 x + k2 y + k3 x² + k4 x y + k5 y² (x, y in units of size)
        const A = Array.from({ length: 6 }, () => new Array(7).fill(0));
        for (const [x0, y0, z] of loc) {
            const x = x0 / size, y = y0 / size, f = [1, x, y, x * x, x * y, y * y];
            for (let i = 0; i < 6; i++) { for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j]; A[i][6] += f[i] * z; }
        }
        const k = solveSystem(A);
        const h = (x0, y0) => { const x = x0 / size, y = y0 / size; return k[0] + k[1] * x + k[2] * y + k[3] * x * x + k[4] * x * y + k[5] * y * y; };
        if (!k.every(Number.isFinite) || loc.some(([x, y, z]) => Math.abs(h(x, y) - z) > 0.5 * (zmax - zmin) + tol)) {
            this.stats.filled--;
            return null;
        }
        // the patch over the boundary's box (+5 %): Bézier heights from the values at 0, ½, 1 per direction
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of loc) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const mx = 0.05 * (x1 - x0) + tol, my = 0.05 * (y1 - y0) + tol;
        x0 -= mx; x1 += mx; y0 -= my; y1 += my;
        const xs = [x0, (x0 + x1) / 2, x1], ys = [y0, (y0 + y1) / 2, y1];
        const bez = f => [f[0], 2 * f[1] - (f[0] + f[2]) / 2, f[2]];
        const cols = xs.map(x => bez(ys.map(y => h(x, y))));   // per x: Bézier heights along y
        const H = [0, 1, 2].map(j => bez(cols.map(col => col[j])));   // per y: along x → H[j][i]
        const rows = xs.map((x, i) => list(ys.map((y, j) => ref(this.cp([0, 1, 2].map(d => c[d] + X[d] * x + Y[d] * y + N[d] * H[j][i]))))));
        const id = this.w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',2,2,${list(rows)},.UNSPECIFIED.,.F.,.F.,.F.,(3,3),(3,3),(0.,1.),(0.,1.),.UNSPECIFIED.)`);
        return { id, flip: reversed };   // u along X, v along Y: the normal is N, the face's side
    }
    // points along an edge between its vertices a, b (world): ellipses (the way the edge runs along its curve – sense;
    // unknown: the arc of the edge's parameter span, else the shorter one), intersection curves (their approximation);
    // straight edges add their middle. fine: arcs in steps of ≤ 5°, curves in 32 pieces (else 8 points)
    edgeSamples(ci, a, b, span, sense = null, fine = false) {
        const out = [];
        let K = fine ? 32 : 8;
        try {
            const r = this.file.record(ci);
            if (r.type === 'straight-curve') return [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]];
            if (r.type === 'ellipse-curve') {
                const c0 = r.vec(), nn = r.vec(), m0 = r.vec(), ratio = r.num();
                const c = this.P(c0), m = this.D(m0), q = this.D(cross(normalize(nn), m0).map(v => v * ratio));
                const ang = p => { const d = sub(p, c); return Math.atan2(dot(d, q) / dot(q, q), dot(d, m) / dot(m, m)); };
                const ta = ang(a), TAU = 2 * Math.PI, mod = x => ((x % TAU) + TAU) % TAU;
                let dt = ang(b) - ta;
                const closed = len(sub(a, b)) < 1e-9 * (1 + len(a));
                if (sense !== null) dt = closed ? (sense ? -TAU : TAU) : sense ? -mod(-dt) : mod(dt);   // the curve runs counter-clockwise
                else if (closed) dt = TAU;
                else {
                    dt -= TAU * Math.round(dt / TAU);
                    if (span !== null && span > Math.PI + 1e-6) dt -= Math.sign(dt) * TAU;
                }
                if (fine) K = Math.max(2, Math.ceil(Math.abs(dt) / (Math.PI / 36)));
                for (let i = 1; i < K; i++) {
                    const t = ta + dt * i / K;
                    out.push([0, 1, 2].map(d => c[d] + m[d] * Math.cos(t) + q[d] * Math.sin(t)));
                }
            } else if (r.type === 'intcurve-curve') {
                r.flag('reversed');
                const data = this.subtypeAt(r);
                if (!data) return out;
                if (['full', 'summary', 'none', 'approx'].includes(String(data.peek()))) data.next();
                if (!SPLINE_WORDS.has(String(data.peek()))) return out;
                const bc = this.readBs3Curve(data, null, false, 3, 'curve');
                let ta = bc.closest(a), tb = bc.closest(b);
                if (len(sub(a, b)) < 1e-9 * (1 + len(a))) { ta = bc.t0; tb = bc.t1; }
                for (let i = 1; i < K; i++) out.push(bc.eval(ta + (tb - ta) * i / K));
            }
        } catch { /* the vertices only */ }
        return out;
    }

    // cone: base ellipse (centre, normal, major axis, ratio), curve interval, sine, cosine[, u scale][, reverse u] –
    // circular cylinders and cones, elliptic cylinders (an extrusion); elliptic cones are left out
    cone(r) {
        const c = r.vec(), n = r.vec(), m = r.vec(), ratio = r.num();
        if (r.version >= 106) { r.bound(); r.bound(); }
        const s = r.num(), co = r.num();
        const radius = len(m) * this.lenScale;
        const N = normalize(this.D(n)), U = this.D(m);
        const inward = co < 0;
        if (Math.abs(ratio - 1) > 1e-6) {
            // elliptic cylinder: the base ellipse extruded along the axis (STEP knows no elliptic cylinder; the normal of
            // the extrusion – tangent × axis – points away from the axis like a cylinder's)
            if (Math.abs(s) >= 1e-12) return this.skip('elliptic cone');
            const base = this.w.add(`ELLIPSE('',#${this.axis2(this.P(c), N, U)},${num(radius)},${num(radius * Math.abs(ratio))})`);
            return { id: this.w.add(`SURFACE_OF_LINEAR_EXTRUSION('',#${base},#${this.w.add(`VECTOR('',#${this.dir(N)},1.)`)})`), flip: inward };
        }
        if (Math.abs(s) < 1e-12) {
            return { id: this.w.add(`CYLINDRICAL_SURFACE('',#${this.axis2(this.P(c), N, U)},${num(radius)})`), flip: inward };
        }
        // radius grows by tan along the normal: s / co (a negative cosine also turns the normal inwards)
        const t = s / co;
        const axis = t >= 0 ? N : N.map(v => -v);
        const pl = this.axis2(this.P(c), axis, U);
        return { id: this.w.add(`CONICAL_SURFACE('',#${pl},${num(radius)},${num(Math.atan(Math.abs(t)))})`), flip: inward };
    }

    // the subtype data at the cursor ("{ name … }" or "{ ref n }") → cursor with .name
    subtypeAt(r) {
        while (!r.done && r.peek() !== '{') r.next();
        if (r.done) return null;
        let c = r.sub();
        if (c.peek() === 'ref') {
            // shared with an earlier record: the numbered subtype (its cursor stands on its '{')
            c.next();
            const shared = this.file.subtype(c.int());
            if (!shared) return null;
            c = shared.sub();
        }
        c.name = String(c.next());
        return c;
    }

    // bs3 surface of a spline subtype: right after its name (exact surfaces, "full" approximation), else the first one at
    // its top level (procedural subtypes keep an approximation)
    bs3Surface(c) {
        const start = c.k;
        const tryAt = k => { c.k = k; try { return this.readBs3Surface(c); } catch { return null; } };
        if (['full', 'summary', 'none', 'approx'].includes(String(c.peek()))) c.next();
        let s = SPLINE_WORDS.has(String(c.peek())) ? tryAt(c.k) : null;
        if (!s) {
            let depth = 0;
            for (let k = start; k < c.t.length && !s; k++) {
                const x = c.t[k];
                if (x === '{') depth++;
                else if (x === '}') depth--;
                else if (depth === 0 && SPLINE_WORDS.has(x)) s = tryAt(k);
            }
        }
        return s;
    }
    readBs3Surface(c) {
        const rational = c.next() === 'nurbs';
        const du = c.int(), dv = c.int();
        if (rational) skipRationalWord(c);   // "both" / "u" / "v": the direction with weights (all points carry one)
        c.next(); c.next();   // closure u, v
        c.next(); c.next();   // singularity u, v
        const nku = c.int(), nkv = c.int();
        if (!(du >= 1 && dv >= 1 && nku >= 2 && nkv >= 2 && nku < 1e6 && nkv < 1e6)) throw new Error('bs3 surface header');
        const knots = n => { const k = [], m = []; for (let i = 0; i < n; i++) { k.push(c.num()); m.push(c.int()); } return { k, m }; };
        const U = knots(nku), V = knots(nkv);
        const nu = U.m.reduce((s, x) => s + x, 0) - du + 1, nv = V.m.reduce((s, x) => s + x, 0) - dv + 1;
        if (!(nu >= 2 && nv >= 2) || ![...U.k, ...V.k].every(Number.isFinite)) throw new Error('bs3 surface knots');
        const pts = [], ws = [];
        for (let i = 0; i < nu * nv; i++) {
            const p = [c.num(), c.num(), c.num()];
            const w = rational ? c.num() : 1;
            if (!p.every(Number.isFinite) || !Number.isFinite(w)) throw new Error('bs3 surface points');
            pts.push(p); ws.push(w);
        }
        // ends: multiplicity degree in SAT, degree + 1 clamped in STEP
        U.m[0]++; U.m[U.m.length - 1]++; V.m[0]++; V.m[V.m.length - 1]++;
        const ids = pts.map(p => this.cp(this.P(p)));
        const rows = [], wrows = [];
        for (let a = 0; a < nu; a++) {
            const row = [], wr = [];
            for (let b2 = 0; b2 < nv; b2++) { row.push(ref(ids[a + b2 * nu])); wr.push(num(ws[a + b2 * nu])); }   // u runs fastest
            rows.push(list(row)); wrows.push(list(wr));
        }
        const flags = '.UNSPECIFIED.,.F.,.F.,.F.';
        const kn = `${list(U.m)},${list(V.m)},${list(U.k.map(num))},${list(V.k.map(num))},.UNSPECIFIED.`;
        if (!rational || ws.every(w => Math.abs(w - ws[0]) < 1e-12)) return this.w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${du},${dv},${list(rows)},${flags},${kn})`);
        return this.w.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${du},${dv},${list(rows)},${flags})B_SPLINE_SURFACE_WITH_KNOTS(${kn})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${list(wrows)})REPRESENTATION_ITEM('')SURFACE())`);
    }

    // --- curves: { id, reversed (the STEP curve runs against the SAT one) } ---
    curve(ci, ends, edgeReversed) {
        return this.once(`c${ci}`, () => {
            const r = this.file.record(ci);
            switch (r.type) {
                case 'straight-curve': {
                    const p = r.vec(), d = r.vec();
                    const D = this.D(d);
                    const L = len(D);
                    if (!(L > 0)) return null;
                    const line = this.w.add(`LINE('',#${this.cp(this.P(p))},#${this.w.add(`VECTOR('',#${this.dir(D)},1.)`)})`);
                    return { id: line, reversed: false };
                }
                case 'ellipse-curve': {
                    const c = r.vec(), n = r.vec(), m = r.vec(), ratio = r.num();
                    const R = len(m) * this.lenScale;
                    // a mirror turns the direction of travel: the normal goes with it (z = x × y kept)
                    const N = this.mirror ? this.D(n).map(v => -v) : this.D(n);
                    const pl = this.axis2(this.P(c), N, this.D(m));
                    const id = Math.abs(ratio - 1) < 1e-9
                        ? this.w.add(`CIRCLE('',#${pl},${num(R)})`)
                        : this.w.add(`ELLIPSE('',#${pl},${num(R)},${num(R * ratio)})`);
                    return { id, reversed: false };
                }
                case 'intcurve-curve': {
                    const reversed = r.flag('reversed');
                    const data = this.subtypeAt(r);
                    const id = data && this.bs3Curve(data, ends, edgeReversed !== reversed);
                    return id ? { id, reversed } : null;
                }
                default: return null;
            }
        });
    }

    // bs3 curve of an intcurve subtype: right after the name, else the first at its top level; accepted when its ends
    // meet the edge's vertices (procedural subtypes hold other splines too)
    bs3Curve(c, ends, reversed) {
        const start = c.k;
        const tryAt = k => { c.k = k; try { return this.readBs3Curve(c, ends, reversed); } catch { return null; } };
        if (['full', 'summary', 'none', 'approx'].includes(String(c.peek()))) c.next();
        let id = SPLINE_WORDS.has(String(c.peek())) ? tryAt(c.k) : null;
        if (!id) {
            let depth = 0;
            for (let k = start; k < c.t.length && !id; k++) {
                const x = c.t[k];
                if (x === '{') depth++;
                else if (x === '}') depth--;
                else if (depth === 0 && SPLINE_WORDS.has(x)) id = tryAt(k);
            }
        }
        return id;
    }
    readBs3Curve(c, ends, reversed, dim = 3, dry = false) {
        const rational = c.next() === 'nurbs';
        const deg = c.int();
        if (rational) skipRationalWord(c);
        c.next();   // closure
        const nk = c.int();
        if (!(deg >= 1 && nk >= 2 && nk < 1e7)) throw new Error('bs3 curve header');
        const k = [], m = [];
        for (let i = 0; i < nk; i++) { k.push(c.num()); m.push(c.int()); }
        const n = m.reduce((s, x) => s + x, 0) - deg + 1;
        if (!(n >= 2) || !k.every(Number.isFinite)) throw new Error('bs3 curve knots');
        const pts = [], ws = [];
        for (let i = 0; i < n; i++) {
            const p = []; for (let d = 0; d < dim; d++) p.push(c.num());
            const w = rational ? c.num() : 1;
            if (!p.every(Number.isFinite) || !Number.isFinite(w)) throw new Error('bs3 curve points');
            pts.push(p); ws.push(w);
        }
        m[0]++; m[m.length - 1]++;
        const world = dim === 3 ? pts.map(p => this.P(p)) : pts;
        if (dry && dry !== 'curve') return `${n}:${posKey(world[n >> 1])}`;   // count + middle control point (welding)
        if (dry === 'curve' || (dim === 3 && ends)) {
            // the edge's vertices have to lie on the spline (a procedural subtype holds other splines too): not at its
            // ends – an edge may use a part of a closed curve, and an approximation may stop short of the vertices
            // (seen: 0.04 … 0.15 mm on edges of 5 … 18 mm; the kernel starts the edge at the vertex then)
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (const p of world) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
            const tol = Math.max(1e-3, 0.02 * len(sub(hi, lo)));
            const U = [];
            k.forEach((x, i) => { for (let j = 0; j < m[i]; j++) U.push(x); });
            const bc = new BSplineCurve(deg, world, rational ? ws : null, U);
            if (dry === 'curve') return bc;
            for (const v of ends) if (len(sub(bc.eval(bc.closest(v)), v)) > tol) throw new Error('bs3 curve ends');
        }
        const ids = world.map(p => (dim === 3 ? this.cp(p) : this.w.add(`CARTESIAN_POINT('',${list(p.map(num))})`)));
        const pl = list(ids.map(ref));
        const flags = '.UNSPECIFIED.,.F.,.F.';
        const kn = `${list(m)},${list(k.map(num))},.UNSPECIFIED.`;
        if (!rational || ws.every(w => Math.abs(w - ws[0]) < 1e-12)) return this.w.add(`B_SPLINE_CURVE_WITH_KNOTS('',${deg},${pl},${flags},${kn})`);
        return this.w.add(`(BOUNDED_CURVE()B_SPLINE_CURVE(${deg},${pl},${flags})B_SPLINE_CURVE_WITH_KNOTS(${kn})CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE(${list(ws.map(num))})REPRESENTATION_ITEM(''))`);
    }

    // parameter curve of a coedge (exppc) on the face's B-spline surface → PCURVE (wrapped in a composite curve, as the
    // IGES way does – the kernel reads it bounded by its own range)
    pcurve(pi, surf) {
        return this.once(`p${pi}|${surf.id}`, () => {
            const r = this.file.record(pi);
            const type = r.int();
            if (type !== 0) return null;
            const reversed = r.flag('reversed');
            const data = this.subtypeAt(r);
            if (!data || data.name !== 'exppc') return null;
            let c2 = null;
            try { c2 = this.readBs3Curve(data, null, false, 2); } catch { return null; }
            const seg = this.w.add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${c2})`);
            const comp = this.w.add(`COMPOSITE_CURVE('',(#${seg}),.U.)`);
            const rep = this.w.add(`DEFINITIONAL_REPRESENTATION('',(#${comp}),#${this.ctx2d()})`);
            const pc = this.w.add(`PCURVE('',#${surf.id},#${rep})`);
            const seg3 = this.w.add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${pc})`);
            return { id: this.w.add(`COMPOSITE_CURVE('',(#${seg3}),.U.)`), reversed };
        });
    }

    // --- colours: rgb_color (0…1) and colour (ACI) attributes along the attribute chain ---
    colorOf(ai) {
        const file = this.file;
        for (let a = ai, guard = 0; a >= 0 && guard++ < 64;) {
            const r = file.record(a);
            const next = r.ptr();
            r.ptr(); r.ptr();   // previous, owner
            if (r.type.startsWith('rgb_color')) {
                const c = [r.num(), r.num(), r.num()];
                if (c.every(v => v >= 0 && v <= 1)) return c;
            } else if (r.type.startsWith('colour')) {
                const aci = r.int();
                if (aci > 0 && aci < 256) { const v = aciRgb(aci); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
            } else if (r.type.startsWith('truecolor')) {
                const v = r.int();
                if (Number.isFinite(v) && v >= 0) return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
            }
            a = next;
        }
        return null;
    }
    style(item, rgb) {
        if (!rgb) return;
        const key = rgb.map(v => v.toFixed(4)).join(',');
        let psa = this.colorStyle.get(key);
        if (!psa) {
            const w = this.w;
            const col = w.add(`COLOUR_RGB('',${rgb.map(num).join(',')})`);
            const fill = w.add(`FILL_AREA_STYLE('',(#${w.add(`FILL_AREA_STYLE_COLOUR('',#${col})`)}))`);
            const side = w.add(`SURFACE_SIDE_STYLE('',(#${w.add(`SURFACE_STYLE_FILL_AREA(#${fill})`)}))`);
            psa = w.add(`PRESENTATION_STYLE_ASSIGNMENT((#${w.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)}))`);
            this.colorStyle.set(key, psa);
        }
        this.w.add(`STYLED_ITEM('',(#${psa}),#${item})`);
    }
}

export { SatFile, IDENT };
