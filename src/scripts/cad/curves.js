// Curves of drawings as points (CAD worker): arcs, ellipses, NURBS splines (de Boor, rational), fit-point splines
// (centripetal Catmull-Rom through the points). tol = largest chord deviation in drawing units.

const TAU = Math.PI * 2;

/** segments of an arc of radius r over sweep (radians) for chord deviation tol – at least 8 per full circle */
export function arcSteps(r, sweep, tol) {
    const t = Math.max(tol, Math.abs(r) * 4e-4);
    const step = r > t ? 2 * Math.acos(1 - t / Math.abs(r)) : Math.PI / 4;
    const n = Math.ceil(Math.abs(sweep) / Math.max(step, 1e-4));
    return Math.min(Math.max(n, Math.ceil(Math.abs(sweep) / (Math.PI / 4)), 1), Math.ceil(Math.abs(sweep) / TAU * 720) + 1);
}

/** circle arc in the plane: [x, y, …] from start to end (radians, counter-clockwise) */
export function arcPoints(cx, cy, r, a0, a1, tol, full = false) {
    let sweep = full ? TAU : a1 - a0;
    if (!full) { while (sweep <= 0) sweep += TAU; while (sweep > TAU + 1e-12) sweep -= TAU; }
    const n = arcSteps(r, sweep, tol);
    const out = new Array((n + 1) * 2);
    for (let k = 0; k <= n; k++) {
        const a = a0 + sweep * k / n;
        out[k * 2] = cx + r * Math.cos(a);
        out[k * 2 + 1] = cy + r * Math.sin(a);
    }
    return out;
}

/** ELLIPSE (WCS): [x, y, z, …] */
export function ellipsePoints(e, tol) {
    const [cx, cy, cz] = e.c, [mx, my, mz] = e.major;
    const n0 = e.extrusion || [0, 0, 1];
    const R = Math.hypot(mx, my, mz);
    // minor axis = ratio · (N × major)
    let vx = n0[1] * mz - n0[2] * my, vy = n0[2] * mx - n0[0] * mz, vz = n0[0] * my - n0[1] * mx;
    const lv = Math.hypot(vx, vy, vz) || 1;
    const r = R * e.ratio;
    vx *= r / lv; vy *= r / lv; vz *= r / lv;
    let t0 = e.start, t1 = e.end;
    let sweep = t1 - t0;
    if (Math.abs(Math.abs(sweep) - TAU) < 1e-9 || sweep === 0) sweep = TAU;
    while (sweep < 0) sweep += TAU;
    const n = arcSteps(R, sweep, tol);
    const out = new Array((n + 1) * 3);
    for (let k = 0; k <= n; k++) {
        const t = t0 + sweep * k / n, c = Math.cos(t), s = Math.sin(t);
        out[k * 3] = cx + mx * c + vx * s;
        out[k * 3 + 1] = cy + my * c + vy * s;
        out[k * 3 + 2] = cz + mz * c + vz * s;
    }
    return out;
}

/** SPLINE: [x, y, z, …] – control points (NURBS) or, without them, through the fit points */
export function splinePoints(sp, tol) {
    const ctrl = sp.ctrl || [];
    const nc = ctrl.length / 3;
    if (nc >= 2) {
        const p = Math.min(Math.max(sp.degree | 0, 1), nc - 1);
        let knots = sp.knots && sp.knots.length === nc + p + 1 ? sp.knots : null;
        if (!knots) {
            // clamped uniform knots
            knots = [];
            for (let i = 0; i <= nc + p; i++) knots.push(Math.min(Math.max(i - p, 0), nc - p));
        }
        const w = sp.weights && sp.weights.length === nc ? sp.weights : null;
        const u0 = knots[p], u1 = knots[nc];
        // samples: 12 per span between distinct knots, at least 16
        let spans = 0;
        for (let i = p; i < nc; i++) if (knots[i + 1] > knots[i]) spans++;
        const n = Math.min(Math.max(spans * 12, 16), 4000);
        const out = [];
        for (let k = 0; k <= n; k++) {
            const u = k === n ? u1 : u0 + (u1 - u0) * k / n;
            deBoor(p, knots, ctrl, w, u, out);
        }
        return out;
    }
    const fit = sp.fit || [];
    if (fit.length >= 6) return catmullRom(fit, sp.closed, sp.endTangent || null);
    return ctrl.slice();
}

// point of a (rational) B-spline at u, appended to out
function deBoor(p, U, P, W, u, out) {
    const n = P.length / 3 - 1;
    let k = p;
    if (u >= U[n + 1]) k = n;
    else { while (k < n && !(u >= U[k] && u < U[k + 1])) k++; }
    const d = [];
    for (let j = 0; j <= p; j++) {
        const i = k - p + j;
        const wt = W ? W[i] : 1;
        d.push([P[i * 3] * wt, P[i * 3 + 1] * wt, P[i * 3 + 2] * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = k - p + j;
            const den = U[i + p - r + 1] - U[i];
            const a = den !== 0 ? (u - U[i]) / den : 0;
            for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
        }
    }
    const q = d[p], wq = q[3] || 1;
    out.push(q[0] / wq, q[1] / wq, q[2] / wq);
}

// centripetal Catmull-Rom through the points (fit-point splines without control points)
function catmullRom(F, closed, endTangent = null) {
    const n = F.length / 3;
    // a given end direction (a spline leader runs into its landing): a point beyond the end along it
    const last = n - 1, seg = n > 1 ? Math.hypot(F[last * 3] - F[last * 3 - 3], F[last * 3 + 1] - F[last * 3 - 2], F[last * 3 + 2] - F[last * 3 - 1]) : 0;
    const tl = endTangent ? Math.hypot(endTangent[0], endTangent[1], endTangent[2]) : 0;
    const pt = i => {
        if (!closed && i > last && tl > 0) return [0, 1, 2].map(c => F[last * 3 + c] + endTangent[c] / tl * seg);
        if (closed) i = (i + n) % n;
        else i = Math.min(Math.max(i, 0), n - 1);
        return [F[i * 3], F[i * 3 + 1], F[i * 3 + 2]];
    };
    const out = [];
    const segs = closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
        const p0 = pt(s - 1), p1 = pt(s), p2 = pt(s + 1), p3 = pt(s + 2);
        const dt = (a, b) => Math.max(Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5), 1e-9);
        const t0 = 0, t1 = t0 + dt(p0, p1), t2 = t1 + dt(p1, p2), t3 = t2 + dt(p2, p3);
        const steps = 10;
        for (let k = s === 0 ? 0 : 1; k <= steps; k++) {
            const t = t1 + (t2 - t1) * k / steps;
            const lerp = (a, b, ta, tb) => a.map((v, c) => (tb === ta ? v : (v * (tb - t) + b[c] * (t - ta)) / (tb - ta)));
            const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
            const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
            const c = lerp(b1, b2, t1, t2);
            out.push(c[0], c[1], c[2]);
        }
    }
    return out;
}
