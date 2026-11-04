// Environment maps of pbrt-v4 scenes (pure functions – worker and main thread):
// pbrt's infinite light reads a square image in the equal-area octahedral parameterisation (Clarberg 2008: the square's
// centre is +z of the light's space, its inscribed diamond the equator, the corners −z). RINDR's environment is an
// equirectangular panorama (three.js convention, Y up) → resampled once, with the light's rotation and the scene's
// conversion baked in, and written as a Radiance .hdr (RLE) that the environment loads like any dropped HDRI.

/** point of the unit square [0,1]² → direction on the unit sphere (equal area) */
export function squareToSphere(px, py) {
    const u = 2 * px - 1, v = 2 * py - 1, up = Math.abs(u), vp = Math.abs(v);
    const sd = 1 - (up + vp), r = 1 - Math.abs(sd);
    const phi = (r === 0 ? 1 : (vp - up) / r + 1) * Math.PI / 4;
    const z = sd < 0 ? -(1 - r * r) : 1 - r * r;
    const s = r * Math.sqrt(Math.max(0, 2 - r * r));
    const c = Math.abs(Math.cos(phi)) * (u < 0 ? -1 : 1), sn = Math.abs(Math.sin(phi)) * (v < 0 ? -1 : 1);
    return [c * s, sn * s, z];
}

/** unit direction → point of the unit square (inverse of squareToSphere) */
export function sphereToSquare(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    const r = Math.sqrt(Math.max(0, 1 - az));
    const a = Math.max(ax, ay), b = Math.min(ax, ay);
    let phi = a === 0 ? 0 : Math.atan(b / a) * 2 / Math.PI;
    if (ax < ay) phi = 1 - phi;
    let v = phi * r, u = r - v;
    if (z < 0) { const t = u; u = 1 - v; v = 1 - t; }
    if (x < 0) u = -u;
    if (y < 0) v = -v;
    return [(u + 1) / 2, (v + 1) / 2];
}

/**
 * Octahedral map → equirectangular RGB (Float32Array, rows top to bottom, top = +Y).
 * img: { data (Float32Array), width, height, channels, bottomUp (row 0 = bottom of the picture, as three's EXRLoader) }
 * toLight: 3×3 (row-major) from RINDR's world direction to the light's space.
 */
export function octahedralToEquirect(img, toLight, outWidth) {
    const { data, width: N, channels, bottomUp } = img;
    const W = outWidth, H = W >> 1;
    const out = new Float32Array(W * H * 3);
    // texel with pbrt's octahedral wrap: leaving one side re-enters mirrored on the opposite half
    const texel = (x, y, k) => {
        if (x < 0) { x = -x - 1; y = N - 1 - y; } else if (x >= N) { x = 2 * N - 1 - x; y = N - 1 - y; }
        if (y < 0) { x = N - 1 - x; y = -y - 1; } else if (y >= N) { x = N - 1 - x; y = 2 * N - 1 - y; }
        x = Math.min(Math.max(x, 0), N - 1); y = Math.min(Math.max(y, 0), N - 1);
        const row = bottomUp ? N - 1 - y : y;   // y counts from the top (pbrt's image space)
        const i = (row * N + x) * channels;
        return channels >= 3 ? data[i + k] : data[i];
    };
    const m = toLight;
    for (let j = 0; j < H; j++) {
        const lat = (0.5 - (j + 0.5) / H) * Math.PI;
        const cl = Math.cos(lat), sl = Math.sin(lat);
        for (let i = 0; i < W; i++) {
            const phi = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
            const dx = cl * Math.cos(phi), dy = sl, dz = cl * Math.sin(phi);
            let lx = m[0] * dx + m[1] * dy + m[2] * dz, ly = m[3] * dx + m[4] * dy + m[5] * dz, lz = m[6] * dx + m[7] * dy + m[8] * dz;
            const l = Math.hypot(lx, ly, lz) || 1;
            lx /= l; ly /= l; lz /= l;
            const [su, sv] = sphereToSquare(lx, ly, lz);
            const fx = su * N - 0.5, fy = sv * N - 0.5;
            const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
            const o = 3 * (j * W + i);
            for (let k = 0; k < 3; k++) {
                const v = (texel(x0, y0, k) * (1 - tx) + texel(x0 + 1, y0, k) * tx) * (1 - ty) + (texel(x0, y0 + 1, k) * (1 - tx) + texel(x0 + 1, y0 + 1, k) * tx) * ty;
                out[o + k] = v > 0 ? v : 0;
            }
        }
    }
    return { data: out, width: W, height: H };
}

/** illuminance on a surface facing +z of the light's space, from the octahedral map (each texel the same solid angle) */
export function octahedralIlluminance(img) {
    const { data, width: N, channels, bottomUp } = img;
    let e = 0;
    for (let y = 0; y < N; y++) {
        const row = bottomUp ? N - 1 - y : y;
        for (let x = 0; x < N; x++) {
            const d = squareToSphere((x + 0.5) / N, (y + 0.5) / N);
            if (d[2] <= 0) continue;
            const i = (row * N + x) * channels;
            const lum = channels >= 3 ? 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] : data[i];
            e += lum * d[2];
        }
    }
    return e * 4 * Math.PI / (N * N);
}

/** float RGB rows (top to bottom) → Radiance .hdr with RLE scanlines */
export function encodeRgbe(width, height, rgb) {
    const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
    const parts = [head];
    const scan = new Uint8Array(width * 4);
    let size = head.length;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = 3 * (y * width + x);
            const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
            const v = Math.max(r, g, b);
            if (!(v > 1e-32)) { scan[x] = scan[width + x] = scan[2 * width + x] = scan[3 * width + x] = 0; continue; }
            const e = Math.floor(Math.log2(v)) + 1;
            const s = 256 / 2 ** e;
            scan[x] = Math.min(255, Math.floor(r * s));
            scan[width + x] = Math.min(255, Math.floor(g * s));
            scan[2 * width + x] = Math.min(255, Math.floor(b * s));
            scan[3 * width + x] = Math.min(255, Math.max(0, e + 128));
        }
        const line = rleLine(scan, width);
        parts.push(line);
        size += line.length;
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
function rleLine(scan, width) {
    const out = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c++) {
        const base = c * width;
        let i = 0;
        while (i < width) {
            // run of ≥ 4 equal bytes?
            let run = 1;
            while (i + run < width && run < 127 && scan[base + i + run] === scan[base + i]) run++;
            if (run >= 4) { out.push(128 + run, scan[base + i]); i += run; continue; }
            // literal bytes up to the next run of 4
            let n = 0;
            while (i + n < width && n < 128) {
                const k = base + i + n;
                if (i + n + 3 < width && scan[k] === scan[k + 1] && scan[k] === scan[k + 2] && scan[k] === scan[k + 3]) break;
                n++;
            }
            out.push(n);
            for (let k = 0; k < n; k++) out.push(scan[base + i + k]);
            i += n;
        }
    }
    return Uint8Array.from(out);
}

/** a uniform environment (pbrt infinite light without a map) as a small .hdr */
export function uniformHdr(rgb, width = 64) {
    const h = width >> 1, data = new Float32Array(width * h * 3);
    for (let i = 0; i < width * h; i++) data.set(rgb, 3 * i);
    return encodeRgbe(width, h, data);
}

/** PFM (portable float map) → { data, width, height, channels, bottomUp } (PFM rows run bottom to top) */
export function readPfm(bytes) {
    let pos = 0;
    const word = () => {
        while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
        let s = '';
        while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) s += String.fromCharCode(bytes[pos++]);
        return s;
    };
    const kind = word(), width = +word(), height = +word(), sc = +word();
    pos++;
    const channels = kind === 'PF' ? 3 : 1;
    const little = sc < 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const data = new Float32Array(width * height * channels);
    for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(4 * i, little) * Math.abs(sc || 1);
    return { data, width, height, channels, bottomUp: true };
}
