// Hatches of drawings (CAD worker): boundary loops → polygons, solid fill as triangles (islands by nesting depth and the
// hatch style), pattern fill as line segments (the pattern lines of the file – already scaled and rotated there – clipped
// to the boundary with even-odd), gradient as colours per vertex. All in the hatch's plane (OCS x/y).
import earcut from 'earcut';
import { arcSteps, splinePoints } from './curves.js';

const TAU = Math.PI * 2;

/** boundary loops of a HATCH record → [{ pts: [x, y, …] }] (curves tessellated) */
export function hatchLoops(e, tol) {
    const loops = [];
    for (const loop of e.loops) {
        const pts = [];
        const add = (x, y) => {
            const n = pts.length;
            if (n >= 2 && Math.abs(pts[n - 2] - x) < 1e-12 && Math.abs(pts[n - 1] - y) < 1e-12) return;
            pts.push(x, y);
        };
        if (loop.poly) {
            const { pts: p, bulges } = loop.poly;
            const n = p.length / 2;
            for (let i = 0; i < n; i++) {
                const x0 = p[i * 2], y0 = p[i * 2 + 1];
                add(x0, y0);
                const b = bulges[i] || 0;
                if (b && (i < n - 1 || n > 2)) {
                    const j = (i + 1) % n;
                    bulgeArc(x0, y0, p[j * 2], p[j * 2 + 1], b, tol, add);
                }
            }
        } else {
            for (const ed of loop.edges) {
                if (ed.type === 'line') { add(ed.a[0], ed.a[1]); add(ed.b[0], ed.b[1]); }
                else if (ed.type === 'arc') {
                    // clockwise arcs are stored with complementary angles (360 − a)
                    let a0 = ed.start * Math.PI / 180, a1 = ed.end * Math.PI / 180;
                    if (!ed.ccw) { a0 = -a0; a1 = -a1; }
                    let sweep = ed.ccw ? a1 - a0 : a1 - a0;
                    if (ed.ccw) { while (sweep <= 0) sweep += TAU; } else { while (sweep >= 0) sweep -= TAU; }
                    if (Math.abs(Math.abs(ed.end - ed.start) - 360) < 1e-9) sweep = ed.ccw ? TAU : -TAU;
                    const n = arcSteps(ed.r, Math.abs(sweep), tol);
                    for (let k = 0; k <= n; k++) {
                        const a = a0 + sweep * k / n;
                        add(ed.c[0] + ed.r * Math.cos(a), ed.c[1] + ed.r * Math.sin(a));
                    }
                } else if (ed.type === 'ellipse') {
                    const [mx, my] = ed.major;
                    const R = Math.hypot(mx, my), r = R * ed.ratio;
                    const rot = Math.atan2(my, mx);
                    // edge angles are angles, not ellipse parameters
                    const param = a => Math.atan2(Math.sin(a) / ed.ratio, Math.cos(a));
                    let t0 = param(ed.start * Math.PI / 180), t1 = param(ed.end * Math.PI / 180);
                    if (!ed.ccw) { t0 = -t0; t1 = -t1; }
                    let sweep = t1 - t0;
                    if (ed.ccw) { while (sweep <= 0) sweep += TAU; } else { while (sweep >= 0) sweep -= TAU; }
                    if (Math.abs(Math.abs(ed.end - ed.start) - 360) < 1e-9) sweep = ed.ccw ? TAU : -TAU;
                    const n = arcSteps(R, Math.abs(sweep), tol);
                    const c = Math.cos(rot), s = Math.sin(rot);
                    for (let k = 0; k <= n; k++) {
                        const t = t0 + sweep * k / n;
                        const x = R * Math.cos(t), y = r * Math.sin(t);
                        add(ed.c[0] + x * c - y * s, ed.c[1] + x * s + y * c);
                    }
                } else if (ed.type === 'spline') {
                    const p = splinePoints(ed.spline, tol);
                    for (let k = 0; k < p.length; k += 3) add(p[k], p[k + 1]);
                }
            }
        }
        // closed: drop a repeated first point at the end
        const n = pts.length;
        if (n >= 4 && Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) pts.length -= 2;
        if (pts.length >= 6) loops.push({ pts });
    }
    return loops;
}

/** arc of a polyline segment with bulge b (tan of a quarter of the included angle; > 0 counter-clockwise) */
export function bulgeArc(x0, y0, x1, y1, b, tol, add) {
    const dx = x1 - x0, dy = y1 - y0;
    const chord = Math.hypot(dx, dy);
    if (!(chord > 0)) return;
    const theta = 4 * Math.atan(b);   // included angle, signed
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // centre on the perpendicular bisector, (chord / 2) · cot(θ / 2) to the left of the chord (sign carries the side)
    const d = (chord / 2) / Math.tan(theta / 2);
    const cx = (x0 + x1) / 2 - dy / chord * d, cy = (y0 + y1) / 2 + dx / chord * d;
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const n = arcSteps(r, Math.abs(theta), tol);
    for (let k = 1; k < n; k++) {
        const a = a0 + theta * k / n;
        add(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
}

// point in polygon (even-odd)
function inside(x, y, pts) {
    let c = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
        const yi = pts[i + 1], yj = pts[j + 1];
        if ((yi > y) !== (yj > y) && x < (pts[j] - pts[i]) * (y - yi) / (yj - yi) + pts[i]) c = !c;
    }
    return c;
}

// nesting depth of every loop (how many other loops contain it)
function depths(loops) {
    return loops.map((l, i) => {
        let d = 0;
        const x = l.pts[0], y = l.pts[1];
        loops.forEach((o, j) => { if (j !== i && inside(x, y, o.pts)) d++; });
        return d;
    });
}

/** loops the hatch style uses: 0 normal (all, parity), 1 outer (depth 0 and 1), 2 ignore (depth 0) */
export function styledLoops(loops, style) {
    const d = depths(loops);
    const max = style === 2 ? 0 : style === 1 ? 1 : Infinity;
    return { loops: loops.filter((_, i) => d[i] <= max), depth: d.filter(x => x <= max) };
}

/** solid fill: triangles in the plane → { pts: [x, y, …], index } */
export function fillTriangles(loops, style) {
    const { loops: used, depth } = styledLoops(loops, style);
    const pts = [], index = [];
    used.forEach((outer, i) => {
        if (depth[i] % 2) return;   // a hole of its parent
        const coords = [...outer.pts];
        const holes = [];
        used.forEach((hole, j) => {
            if (depth[j] !== depth[i] + 1 || !inside(hole.pts[0], hole.pts[1], outer.pts)) return;
            holes.push(coords.length / 2);
            coords.push(...hole.pts);
        });
        const tri = earcut(coords, holes, 2);
        const base = pts.length / 2;
        pts.push(...coords);
        for (const t of tri) index.push(base + t);
    });
    return { pts, index };
}

/**
 * pattern fill: segments [x0, y0, x1, y1, …] of the pattern lines clipped to the loops; null when it would exceed
 * `budget` segments (far too dense for its size – the caller draws the boundary instead)
 */
export function patternSegments(loops, style, patterns, budget) {
    const { loops: used } = styledLoops(loops, style);
    if (!used.length || !patterns.length) return [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of used) for (let i = 0; i < l.pts.length; i += 2) {
        minX = Math.min(minX, l.pts[i]); maxX = Math.max(maxX, l.pts[i]);
        minY = Math.min(minY, l.pts[i + 1]); maxY = Math.max(maxY, l.pts[i + 1]);
    }
    const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    // estimate first
    let estimate = 0;
    for (const p of patterns) {
        const a = p.angle * Math.PI / 180, nx = -Math.sin(a), ny = Math.cos(a);
        const spacing = Math.abs(p.offset[0] * nx + p.offset[1] * ny);
        if (!(spacing > 0)) continue;
        const span = Math.max(...corners.map(c => c[0] * nx + c[1] * ny)) - Math.min(...corners.map(c => c[0] * nx + c[1] * ny));
        const along = Math.hypot(maxX - minX, maxY - minY);
        const period = p.dashes.reduce((s, x) => s + Math.abs(x), 0);
        const perLine = p.dashes.length && period > 0 ? Math.ceil(along / period) * p.dashes.filter(x => x >= 0).length : 1;
        estimate += (span / spacing + 1) * perLine;
    }
    if (estimate > budget) return null;
    const out = [];
    const ts = [];
    for (const p of patterns) {
        const a = p.angle * Math.PI / 180;
        const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
        const [bx, by] = p.base, [ox, oy] = p.offset;
        const spacing = ox * nx + oy * ny;
        if (!(Math.abs(spacing) > 1e-12)) continue;
        const dn = corners.map(c => (c[0] - bx) * nx + (c[1] - by) * ny);
        const k0 = Math.floor(Math.min(...dn) / spacing), k1 = Math.ceil(Math.max(...dn) / spacing);
        const kmin = Math.min(k0, k1), kmax = Math.max(k0, k1);
        const period = p.dashes.reduce((s, x) => s + Math.abs(x), 0);
        for (let k = kmin; k <= kmax; k++) {
            const qx = bx + k * ox, qy = by + k * oy;
            ts.length = 0;
            for (const l of used) {
                const P = l.pts, n = P.length / 2;
                for (let i = 0; i < n; i++) {
                    const j = (i + 1) % n;
                    const s0 = (P[i * 2] - qx) * nx + (P[i * 2 + 1] - qy) * ny;
                    const s1 = (P[j * 2] - qx) * nx + (P[j * 2 + 1] - qy) * ny;
                    if ((s0 > 0) === (s1 > 0)) continue;
                    const f = s0 / (s0 - s1);
                    const x = P[i * 2] + (P[j * 2] - P[i * 2]) * f, y = P[i * 2 + 1] + (P[j * 2 + 1] - P[i * 2 + 1]) * f;
                    ts.push((x - qx) * ux + (y - qy) * uy);
                }
            }
            if (ts.length < 2) continue;
            ts.sort((x, y) => x - y);
            for (let i = 0; i + 1 < ts.length; i += 2) {
                const ta = ts[i], tb = ts[i + 1];
                if (!p.dashes.length || !(period > 0)) { out.push(qx + ux * ta, qy + uy * ta, qx + ux * tb, qy + uy * tb); continue; }
                // dashes from the line's origin (pattern phase)
                let t = Math.floor(ta / period) * period;
                for (let guard = 0; t < tb && guard < 1e6; guard++) {
                    for (const d of p.dashes) {
                        const len = Math.abs(d);
                        if (d >= 0) {
                            const s = Math.max(t, ta), e = Math.min(t + (d === 0 ? 0 : len), tb);
                            if (d === 0 && t >= ta && t <= tb) out.push(qx + ux * t, qy + uy * t, qx + ux * t, qy + uy * t);
                            else if (e > s) out.push(qx + ux * s, qy + uy * s, qx + ux * e, qy + uy * e);
                        }
                        t += len;
                        if (t >= tb) break;
                    }
                }
            }
        }
    }
    return out;
}

/** colour of a gradient at a point (two colours or one colour with tint) – 0xRRGGBB */
export function gradientColor(g, x, y, box) {
    const c0 = g.colors[0] ?? 0x0000ff;
    let c1 = g.colors[1];
    if (c1 === undefined || g.oneColor) {
        // one colour: towards white or black by the tint
        const v = Math.round(g.tint * 255);
        c1 = (v << 16) | (v << 8) | v;
    }
    const [x0, y0, x1, y1] = box;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = Math.max(x1 - x0, 1e-12), h = Math.max(y1 - y0, 1e-12);
    const a = g.angle;
    const u = Math.cos(a), v = Math.sin(a);
    const half = (Math.abs(u) * w + Math.abs(v) * h) / 2 || 1;
    let t;
    const name = g.name.replace(/^INV/, '');
    if (name === 'SPHERICAL' || name === 'HEMISPHERICAL') t = Math.min(Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2)), 1);
    else if (name === 'CYLINDER' || name === 'CURVED') t = Math.abs(((x - cx) * u + (y - cy) * v) / half);
    else t = (((x - cx) * u + (y - cy) * v) / half + 1) / 2;
    if (g.shift) t = Math.min(Math.max(t - g.shift * 0.5, 0), 1);
    t = Math.min(Math.max(t, 0), 1);
    if (g.name.startsWith('INV')) t = 1 - t;
    const mix = (s) => Math.round(((c0 >> s) & 255) * (1 - t) + ((c1 >> s) & 255) * t);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
