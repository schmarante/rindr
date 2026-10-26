// Closed meshes wound inwards → outwards (winding and normals), for formats that keep whatever winding the faces had (OBJ,
// .blend; Blender draws both sides, a converted scene had 105 of 195 meshes inside out – lit as if from behind here).
// Measure: the signed volume of the triangles against the mesh's centroid over the sum of their absolute volumes – about
// −1 for a closed inward shell, about +1 outward, near 0 for open sheets (left as they are; the threshold −0.5).
// Parts: [{ positions, normals, index }] of one mesh (all parts together form the shell); changed in place.

export function orientOutward(parts) {
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) { cx += p.positions[i]; cy += p.positions[i + 1]; cz += p.positions[i + 2]; n++; }
    if (!n) return false;
    cx /= n; cy /= n; cz /= n;
    let signed = 0, total = 0;
    for (const { positions: P, index: I } of parts) {
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz;
            const bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz;
            const qx = P[c] - cx, qy = P[c + 1] - cy, qz = P[c + 2] - cz;
            const v = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
            signed += v;
            total += Math.abs(v);
        }
    }
    if (!(total > 0) || signed / total > -0.5) return false;
    for (const p of parts) {
        const I = p.index;
        for (let t = 0; t + 2 < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
        if (p.normals) for (let i = 0; i < p.normals.length; i++) p.normals[i] = -p.normals[i];
    }
    return true;
}
