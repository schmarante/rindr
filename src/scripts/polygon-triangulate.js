// Triangulation of one polygon of a corner mesh (LWO, .xsi readers): corners c0 … c0+n−1 into `cv` (point numbers into
// `pos`, xyz), fn = Newell normals per face (f). Triangles come out as corner numbers in the polygon's turning: quads
// over the diagonal that keeps both halves facing the polygon's way (concave quads), else the shorter one; n-gons with
// earcut in the plane across the largest normal component (fan if earcut fails).
import earcut from 'earcut';

const flat = [];
export function triangulate(pos, cv, c0, n, fn, f, out) {
    if (n === 3) { out.push(c0, c0 + 1, c0 + 2); return; }
    const nx = fn[f * 3], ny = fn[f * 3 + 1], nz = fn[f * 3 + 2];
    const P = c => cv[c] * 3;
    const triNormalDot = (a, b, c) => {
        const A = P(a), B = P(b), C = P(c);
        const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2];
        const vx = pos[C] - pos[A], vy = pos[C + 1] - pos[A + 1], vz = pos[C + 2] - pos[A + 2];
        return (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    };
    if (n === 4) {
        // the diagonal that keeps both halves facing the polygon's way (concave quads), the shorter one otherwise
        const ok02 = triNormalDot(c0, c0 + 1, c0 + 2) > 0 && triNormalDot(c0, c0 + 2, c0 + 3) > 0;
        const ok13 = triNormalDot(c0 + 1, c0 + 2, c0 + 3) > 0 && triNormalDot(c0 + 1, c0 + 3, c0) > 0;
        let use02 = ok02;
        if (ok02 && ok13) {
            const d = (a, b) => { const A = P(a), B = P(b); return (pos[A] - pos[B]) ** 2 + (pos[A + 1] - pos[B + 1]) ** 2 + (pos[A + 2] - pos[B + 2]) ** 2; };
            use02 = d(c0, c0 + 2) <= d(c0 + 1, c0 + 3);
        } else if (!ok02 && !ok13) use02 = true;
        if (use02) out.push(c0, c0 + 1, c0 + 2, c0, c0 + 2, c0 + 3);
        else out.push(c0 + 1, c0 + 2, c0 + 3, c0 + 1, c0 + 3, c0);
        return;
    }
    // n-gons: earcut in the plane across the largest normal component
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const [i, j] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    flat.length = 0;
    for (let k = 0; k < n; k++) { const p = P(c0 + k); flat.push(pos[p + i], pos[p + j]); }
    const t = earcut(flat);
    if (t.length !== (n - 2) * 3) { for (let k = 1; k + 1 < n; k++) out.push(c0, c0 + k, c0 + k + 1); return; }
    for (let k = 0; k < t.length; k += 3) {
        const a = c0 + t[k], b = c0 + t[k + 1], c = c0 + t[k + 2];
        if (triNormalDot(a, b, c) >= 0) out.push(a, b, c); else out.push(a, c, b);
    }
}

