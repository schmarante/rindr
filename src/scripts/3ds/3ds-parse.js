// 3DS reader (.3ds; own implementation after the widely published chunk description of the format). Chunks: u16 id,
// u32 length (header included), little-endian, nested:
//   4D4D main > 0002 version, 3D3D editor > 0100 master scale, AFFF material, 4000 object (name, then 4100 mesh /
//   4600 light / 4700 camera; 4010 hidden), B000 keyframer
//   4100 mesh: 4110 points (u16 count, xyz), 4140 UVs (u16 count, uv per point), 4120 faces (u16 count, a b c flags per
//        face, then sub-chunks 4130 material faces – name, u16 count, u16 face numbers – and 4150 smoothing groups – u32
//        per face), 4160 the mesh's matrix when it was made (4 × 3 floats: x, y, z axis, origin)
//   AFFF material: A000 name, A010/A020/A030 ambient/diffuse/specular colour (0011/0012 bytes, 0010/0013 floats), A040
//        shininess %, A041 shininess strength %, A050 transparency %, A084 self-illumination %, A081 two-sided, maps A200
//        (colour), A230 (bump), A210 (opacity): A300 file name, A354/A356 u/v scale, A358/A35A u/v offset, 0030 percentage
//   B002 object node: B030 id, B010 name + 2 flags + parent id (−1 = none), B011 instance name (of "$$$DUMMY" nodes),
//        B013 pivot, B020/B021/B022 position/rotation (angle + axis)/scale tracks – the first key places the node
// Points are stored in world coordinates; a node shows its mesh at node matrix · (mesh matrix 4160)⁻¹ (instances of one
// mesh: several nodes). Smoothing groups → normals per corner (faces sharing a group bit at a point are averaged,
// area-weighted; group 0 flat); without them no normals (mesh-importer.js creases at 30°). Up axis / unit: mesh-importer.js.

/** a 3DS file starts with chunk 4D4D (or 3DC2 – a project file) whose length fits the file */
export function is3ds(bytes) {
    if (bytes.length < 16) return false;
    const id = bytes[0] | (bytes[1] << 8);
    const len = (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0;
    return (id === 0x4d4d || id === 0x3dc2) && len >= 16 && len <= bytes.length + 16;
}

export function parse3ds(bytes, progress = () => {}) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length;
    const cstr = (p, end) => {
        let e = p;
        while (e < end && bytes[e] !== 0) e++;
        let s = '';
        for (let i = p; i < e; i++) s += String.fromCharCode(bytes[i]);
        return [s, e + 1];
    };
    const result = { version: 0, masterScale: null, materials: [], objects: [], nodes: [], skipped: {} };
    let lastReport = 0;
    // sub-chunks of [p, end)
    const each = (p, end, fn) => {
        while (p + 6 <= end) {
            const id = dv.getUint16(p, true), len = dv.getUint32(p + 2, true);
            if (len < 6 || p + len > end) break;
            fn(id, p + 6, p + len);
            p += len;
        }
    };
    const color = (p, end) => {
        let out = null, linear = null;
        each(p, end, (id, b) => {
            if (id === 0x0011) out = [bytes[b] / 255, bytes[b + 1] / 255, bytes[b + 2] / 255];
            else if (id === 0x0010) out = [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)];
            else if (id === 0x0012) linear = [bytes[b] / 255, bytes[b + 1] / 255, bytes[b + 2] / 255];
            else if (id === 0x0013) linear = [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)];
        });
        return out ?? linear;   // the gamma-corrected colour first (as the program shows it)
    };
    const percent = (p, end) => {
        let v = null;
        each(p, end, (id, b) => { if (id === 0x0030) v = dv.getInt16(b, true) / 100; else if (id === 0x0031) v = dv.getFloat32(b, true) / 100; });
        return v;
    };
    const map = (p, end) => {
        const m = { file: '', amount: percent(p, end), scale: [1, 1], offset: [0, 0] };
        each(p, end, (id, b, e) => {
            if (id === 0xa300) m.file = cstr(b, e)[0];
            else if (id === 0xa354) m.scale[0] = dv.getFloat32(b, true);
            else if (id === 0xa356) m.scale[1] = dv.getFloat32(b, true);
            else if (id === 0xa358) m.offset[0] = dv.getFloat32(b, true);
            else if (id === 0xa35a) m.offset[1] = dv.getFloat32(b, true);
        });
        return m.file ? m : null;
    };
    const material = (p, end) => {
        const m = { name: '', diffuse: null, specular: null, shininess: null, shinStrength: null, transparency: 0, selfIllum: 0, twoSided: false, map: null, bump: null, opacityMap: null };
        each(p, end, (id, b, e) => {
            if (id === 0xa000) m.name = cstr(b, e)[0];
            else if (id === 0xa020) m.diffuse = color(b, e);
            else if (id === 0xa030) m.specular = color(b, e);
            else if (id === 0xa040) m.shininess = percent(b, e);
            else if (id === 0xa041) m.shinStrength = percent(b, e);
            else if (id === 0xa050) m.transparency = percent(b, e) ?? 0;
            else if (id === 0xa084) m.selfIllum = percent(b, e) ?? 0;
            else if (id === 0xa081) m.twoSided = true;
            else if (id === 0xa200) m.map = map(b, e);
            else if (id === 0xa230) m.bump = map(b, e);
            else if (id === 0xa210) m.opacityMap = map(b, e);
        });
        result.materials.push(m);
    };
    const mesh = (p, end, obj) => {
        let pts = null, uvs = null, faces = null, faceMats = [], smooth = null, matrix = null;
        each(p, end, (id, b, e) => {
            if (id === 0x4110) {
                const c = dv.getUint16(b, true);
                pts = new Float32Array(c * 3);
                for (let i = 0; i < c * 3 && b + 2 + i * 4 + 4 <= e; i++) pts[i] = dv.getFloat32(b + 2 + i * 4, true);
            } else if (id === 0x4140) {
                const c = dv.getUint16(b, true);
                uvs = new Float32Array(c * 2);
                for (let i = 0; i < c * 2 && b + 2 + i * 4 + 4 <= e; i++) uvs[i] = dv.getFloat32(b + 2 + i * 4, true);
            } else if (id === 0x4120) {
                const c = dv.getUint16(b, true);
                faces = new Uint16Array(c * 3);
                for (let i = 0; i < c && b + 2 + i * 8 + 8 <= e; i++) {
                    faces[i * 3] = dv.getUint16(b + 2 + i * 8, true);
                    faces[i * 3 + 1] = dv.getUint16(b + 4 + i * 8, true);
                    faces[i * 3 + 2] = dv.getUint16(b + 6 + i * 8, true);
                }
                each(b + 2 + c * 8, e, (sid, sb, se) => {
                    if (sid === 0x4130) {
                        const [name, q] = cstr(sb, se);
                        const k = dv.getUint16(q, true);
                        const list = new Uint16Array(k);
                        for (let i = 0; i < k && q + 2 + i * 2 + 2 <= se; i++) list[i] = dv.getUint16(q + 2 + i * 2, true);
                        faceMats.push({ name, faces: list });
                    } else if (sid === 0x4150) {
                        smooth = new Uint32Array(c);
                        for (let i = 0; i < c && sb + i * 4 + 4 <= se; i++) smooth[i] = dv.getUint32(sb + i * 4, true);
                    }
                });
            } else if (id === 0x4160) {
                matrix = [];
                for (let i = 0; i < 12; i++) matrix.push(dv.getFloat32(b + i * 4, true));
            }
        });
        if (!pts || !faces) return;
        obj.parts = buildParts(pts, uvs, faces, faceMats, smooth);
        // column-major 4 × 4 from the axes and the origin
        obj.matrix = matrix ? [matrix[0], matrix[1], matrix[2], 0, matrix[3], matrix[4], matrix[5], 0, matrix[6], matrix[7], matrix[8], 0, matrix[9], matrix[10], matrix[11], 1] : null;
    };
    const track = (b, e, k) => {
        // u16 flags, 8 bytes, u32 keys; per key: u32 frame, u16 flags (each set bit of the low 5: one more float), values
        if (b + 14 > e) return null;
        const keys = dv.getUint32(b + 10, true);
        if (!keys) return null;
        let q = b + 14 + 4;
        const flags = dv.getUint16(q, true);
        q += 2;
        for (let bit = 0; bit < 5; bit++) if (flags & (1 << bit)) q += 4;
        if (q + k * 4 > e) return null;
        const out = [];
        for (let i = 0; i < k; i++) out.push(dv.getFloat32(q + i * 4, true));
        return out;
    };
    const node = (p, end) => {
        const nd = { id: result.nodes.length, name: '', instance: '', parent: -1, pivot: [0, 0, 0], pos: null, rot: null, scale: null, dummy: false };
        each(p, end, (id, b, e) => {
            if (id === 0xb030) nd.id = dv.getUint16(b, true);
            else if (id === 0xb010) { const [name, q] = cstr(b, e); nd.name = name; if (q + 6 <= e) nd.parent = dv.getInt16(q + 4, true); }
            else if (id === 0xb011) nd.instance = cstr(b, e)[0];
            else if (id === 0xb013) nd.pivot = [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)];
            else if (id === 0xb020) nd.pos = track(b, e, 3);
            else if (id === 0xb021) nd.rot = track(b, e, 4);
            else if (id === 0xb022) nd.scale = track(b, e, 3);
        });
        nd.dummy = nd.name === '$$$DUMMY';
        result.nodes.push(nd);
    };

    const walk = (p, end) => each(p, end, (id, b, e) => {
        if (b - lastReport > 1 << 22) { lastReport = b; progress(b / n); }
        if (id === 0x4d4d || id === 0x3dc2 || id === 0x3d3d || id === 0xb000) walk(b, e);
        else if (id === 0x0002) result.version = dv.getUint32(b, true);
        else if (id === 0x0100) result.masterScale = dv.getFloat32(b, true);
        else if (id === 0xafff) material(b, e);
        else if (id === 0x4000) {
            const [name, q] = cstr(b, e);
            const obj = { name, hidden: false, parts: null, matrix: null };
            each(q, e, (sid, sb, se) => {
                if (sid === 0x4100) mesh(sb, se, obj);
                else if (sid === 0x4010) obj.hidden = true;
                else if (sid === 0x4600 || sid === 0x4700) result.skipped[sid === 0x4600 ? 'lights' : 'cameras'] = (result.skipped[sid === 0x4600 ? 'lights' : 'cameras'] || 0) + 1;
            });
            if (obj.parts) result.objects.push(obj);
        } else if (id === 0xb002) node(b, e);
    });
    walk(0, n);
    progress(1);
    return result;
}

// faces of one object → parts per material: vertices welded per (point, normal); normals from smoothing groups
function buildParts(pts, uvs, faces, faceMats, smooth) {
    const nf = faces.length / 3, np = pts.length / 3;
    const matOf = new Int32Array(nf).fill(-1);
    faceMats.forEach((m, k) => { for (const f of m.faces) if (f < nf) matOf[f] = k; });
    const names = [...faceMats.map(m => m.name), ''];
    for (let f = 0; f < nf; f++) if (matOf[f] < 0) matOf[f] = faceMats.length;
    // face normals (length = 2 × area)
    const fn = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
        const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
        if (a >= np * 3 || b >= np * 3 || c >= np * 3) continue;
        const ux = pts[b] - pts[a], uy = pts[b + 1] - pts[a + 1], uz = pts[b + 2] - pts[a + 2];
        const vx = pts[c] - pts[a], vy = pts[c + 1] - pts[a + 1], vz = pts[c + 2] - pts[a + 2];
        fn[f * 3] = uy * vz - uz * vy; fn[f * 3 + 1] = uz * vx - ux * vz; fn[f * 3 + 2] = ux * vy - uy * vx;
    }
    // corner normals from the smoothing groups
    let cn = null;
    if (smooth) {
        const start = new Int32Array(np + 1);
        for (let i = 0; i < nf * 3; i++) if (faces[i] < np) start[faces[i] + 1]++;
        for (let v = 0; v < np; v++) start[v + 1] += start[v];
        const fill = start.slice(0, np), around = new Int32Array(nf * 3);
        for (let i = 0; i < nf * 3; i++) if (faces[i] < np) around[fill[faces[i]]++] = (i / 3) | 0;
        cn = new Float32Array(nf * 9);
        for (let i = 0; i < nf * 3; i++) {
            const f = (i / 3) | 0, v = faces[i], g = smooth[f];
            let x = fn[f * 3], y = fn[f * 3 + 1], z = fn[f * 3 + 2];
            if (g && v < np) {
                x = y = z = 0;
                for (let k = start[v]; k < start[v + 1]; k++) {
                    const h = around[k];
                    if (h === f || (smooth[h] & g)) { x += fn[h * 3]; y += fn[h * 3 + 1]; z += fn[h * 3 + 2]; }
                }
            }
            const l = Math.hypot(x, y, z) || 1;
            cn[i * 3] = x / l; cn[i * 3 + 1] = y / l; cn[i * 3 + 2] = z / l;
        }
    }
    return names.map((name, k) => {
        const map = new Map(), verts = [], index = [];
        for (let f = 0; f < nf; f++) {
            if (matOf[f] !== k) continue;
            const tri = [];
            for (let j = 0; j < 3; j++) {
                const i = f * 3 + j, v = faces[i];
                if (v >= np) { tri.length = 0; break; }
                const key = cn ? `${v},${cn[i * 3]},${cn[i * 3 + 1]},${cn[i * 3 + 2]}` : v;
                let w = map.get(key);
                if (w === undefined) { w = verts.length; verts.push(i); map.set(key, w); }
                tri.push(w);
            }
            if (tri.length === 3 && tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) index.push(...tri);
        }
        if (!index.length) return null;
        const positions = new Float32Array(verts.length * 3), normals = cn ? new Float32Array(verts.length * 3) : null;
        const uv = uvs && uvs.length >= np * 2 ? new Float32Array(verts.length * 2) : null;
        verts.forEach((i, w) => {
            const v = faces[i];
            positions[w * 3] = pts[v * 3]; positions[w * 3 + 1] = pts[v * 3 + 1]; positions[w * 3 + 2] = pts[v * 3 + 2];
            if (normals) { normals[w * 3] = cn[i * 3]; normals[w * 3 + 1] = cn[i * 3 + 1]; normals[w * 3 + 2] = cn[i * 3 + 2]; }
            if (uv) { uv[w * 2] = uvs[v * 2]; uv[w * 2 + 1] = uvs[v * 2 + 1]; }
        });
        return { material: name, positions, normals, uvs: uv, index: Uint32Array.from(index) };
    }).filter(Boolean);
}
