// Gaussian splats → density + colour grid for the path tracer (splat-volume.js). Every splat brings its opacity as an
// "optical mass": seen face-on a splat with opacity α has the optical depth τ = −ln(1 − α) at its centre – a 3D
// Gaussian with that line integral along its thinnest axis holds τ · 2π · s₁ · s₂ (the two largest axes). The mass is
// spread over the voxels its ellipsoid covers (2.5σ, weights of the Gaussian, normalised), small splats trilinear into
// the eight nearest voxel centres. Overlapping splats add up – transmittances multiply, like the raster's blending.
// Colour = mass-weighted mean of the splats' colours (base colour, no view-dependent part).
// In:  { a (xyz float bits + rgba8 per splat, 4 words), b (log scales + rotation as halfs, 4 words), count, min, max
//        (largest grid box, data units – narrowed to where the mass is), n (voxels per axis), block }
// Out: { density (half floats, 0…1 of the maximum), color (rgba8, sRGB), majorant (half floats per block, 0…1), sigma
//        (maximum density, per data unit), min, max (the grid box used) }; meanwhile { progress } (0…1)

const halfToFloat = h => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * 6.103515625e-5 * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + m / 1024);
};
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
const floatToHalf = v => {
    _f[0] = v;
    const x = _u[0], sign = (x >> 16) & 0x8000, e = ((x >> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return sign;   // tiny → 0
    if (e >= 31) return sign | 0x7bff;
    return sign | (e << 10) | (m >> 13);
};
const toLinear = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float32Array.from({ length: 256 }, (_, i) => toLinear(i));
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// tight box: where 99.98 % of the optical mass lies per axis (weighted histograms over the given box) + a margin – the
// box capped at 5× the core for a faint haze left the dense core only few voxels (a dot pattern in HQ)
function massBox(words, pos, bw, count, min, max) {
    const BINS = 1024, hist = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
    const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let total = 0;
    for (let i = 0; i < count; i++) {
        const o = i * 4, alpha = (words[o + 3] >>> 24) / 255;
        if (alpha < 1 / 255) continue;
        const s0 = Math.exp(halfToFloat(bw[o] & 0xffff)), s1 = Math.exp(halfToFloat(bw[o] >>> 16)), s2 = Math.exp(halfToFloat(bw[o + 1] & 0xffff));
        const m = -Math.log(1 - Math.min(alpha, 0.99)) * s0 * s1 * s2 / Math.min(s0, s1, s2);
        total += m;
        for (let k = 0; k < 3; k++) hist[k][Math.min(BINS - 1, Math.max(0, Math.floor((pos[o + k] - min[k]) / span[k] * BINS)))] += m;
    }
    const lo = [], hi = [];
    for (let k = 0; k < 3; k++) {
        let sum = 0, a0 = 0, a1 = BINS - 1;
        for (let bin = 0; bin < BINS; bin++) { sum += hist[k][bin]; if (sum >= total * 0.0001) { a0 = bin; break; } }
        sum = 0;
        for (let bin = BINS - 1; bin >= 0; bin--) { sum += hist[k][bin]; if (sum >= total * 0.0001) { a1 = bin; break; } }
        const pad = (min[k] + (a1 + 1) / BINS * span[k] - (min[k] + a0 / BINS * span[k])) * 0.12;   // of the mass box
        lo.push(Math.max(min[k], min[k] + a0 / BINS * span[k] - pad));
        hi.push(Math.min(max[k], min[k] + (a1 + 1) / BINS * span[k] + pad));
    }
    return { min: lo, max: hi };
}

self.onmessage = ({ data }) => {
    const { a, b, count, n, block } = data;
    const words = new Uint32Array(a.buffer, a.byteOffset, count * 4);
    const pos = new Float32Array(a.buffer, a.byteOffset, count * 4);
    const bw = new Uint32Array(b.buffer, b.byteOffset, count * 4);
    const { min, max } = massBox(words, pos, bw, count, data.min, data.max);
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const vox = size.map(s => s / n);
    const n2 = n * n, total = n2 * n;
    const mass = new Float32Array(total);
    const rgb = new Float32Array(total * 3);
    const add = (idx, m, r, g, bl) => { mass[idx] += m; rgb[idx * 3] += m * r; rgb[idx * 3 + 1] += m * g; rgb[idx * 3 + 2] += m * bl; };
    const R = new Float32Array(9);
    const weights = new Float32Array(4096), cells = new Int32Array(4096);
    const report = Math.max(1, Math.floor(count / 50));
    for (let i = 0; i < count; i++) {
        if (i % report === 0) self.postMessage({ progress: 0.05 + 0.85 * i / count });   // progress display (viewer.js)
        const o = i * 4;
        const col = words[o + 3];
        const alpha = (col >>> 24) / 255;
        if (alpha < 1 / 255) continue;
        const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
        // grid coordinates of the centre (voxel centres at integer + 0.5)
        const gx = (px - min[0]) / vox[0], gy = (py - min[1]) / vox[1], gz = (pz - min[2]) / vox[2];
        if (gx < -2 || gy < -2 || gz < -2 || gx > n + 2 || gy > n + 2 || gz > n + 2) continue;
        const s0 = Math.exp(halfToFloat(bw[o] & 0xffff)), s1 = Math.exp(halfToFloat(bw[o] >>> 16)), s2 = Math.exp(halfToFloat(bw[o + 1] & 0xffff));
        const w = halfToFloat(bw[o + 2] & 0xffff), x = halfToFloat(bw[o + 2] >>> 16), y = halfToFloat(bw[o + 3] & 0xffff), z = halfToFloat(bw[o + 3] >>> 16);
        const smallest = Math.min(s0, s1, s2);
        const tau = -Math.log(1 - Math.min(alpha, 0.99));
        const m = tau * 2 * Math.PI * (s0 * s1 * s2 / smallest);
        const r = LIN[col & 0xff], g = LIN[(col >>> 8) & 0xff], bl = LIN[(col >>> 16) & 0xff];
        // rotation columns (as the splat vertex shader)
        R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y + w * z); R[2] = 2 * (x * z - w * y);
        R[3] = 2 * (x * y - w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z + w * x);
        R[6] = 2 * (x * z + w * y); R[7] = 2 * (y * z - w * x); R[8] = 1 - 2 * (x * x + y * y);
        // half extent per axis of the 2.5σ ellipsoid, in voxels
        const ex = 2.5 * Math.hypot(R[0] * s0, R[3] * s1, R[6] * s2) / vox[0];
        const ey = 2.5 * Math.hypot(R[1] * s0, R[4] * s1, R[7] * s2) / vox[1];
        const ez = 2.5 * Math.hypot(R[2] * s0, R[5] * s1, R[8] * s2) / vox[2];
        if (ex < 1 && ey < 1 && ez < 1) {
            // small: trilinear into the eight nearest voxel centres
            const fx = gx - 0.5, fy = gy - 0.5, fz = gz - 0.5;
            const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
            const tx = fx - ix, ty = fy - iy, tz = fz - iz;
            for (let k = 0; k < 8; k++) {
                const cx = ix + (k & 1), cy = iy + ((k >> 1) & 1), cz = iz + (k >> 2);
                if (cx < 0 || cy < 0 || cz < 0 || cx >= n || cy >= n || cz >= n) continue;
                const wt = (k & 1 ? tx : 1 - tx) * ((k >> 1) & 1 ? ty : 1 - ty) * (k >> 2 ? tz : 1 - tz);
                if (wt > 0) add(cz * n2 + cy * n + cx, m * wt, r, g, bl);
            }
            continue;
        }
        // larger: Gaussian weights over the voxels of its box (every step-th voxel per axis when it covers very many).
        // Normalised over the whole ellipsoid, also the part outside the grid – normalising over the inside only piled
        // the mass of splats reaching over the edge into the border voxels (bright slabs in HQ)
        const x0 = Math.floor(gx - ex), x1 = Math.floor(gx + ex);
        const y0 = Math.floor(gy - ey), y1 = Math.floor(gy + ey);
        const z0 = Math.floor(gz - ez), z1 = Math.floor(gz + ez);
        if (x1 < 0 || y1 < 0 || z1 < 0 || x0 >= n || y0 >= n || z0 >= n) continue;
        const step = Math.max(1, Math.ceil(Math.cbrt((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) / 4096)));
        let cnt = 0, sum = 0;
        for (let cz = z0; cz <= z1; cz += step) {
            const dz = (cz + 0.5) * vox[2] + min[2] - pz;
            for (let cy = y0; cy <= y1; cy += step) {
                const dy = (cy + 0.5) * vox[1] + min[1] - py;
                for (let cx = x0; cx <= x1; cx += step) {
                    const dx = (cx + 0.5) * vox[0] + min[0] - px;
                    // in the splat's frame: coordinates along its axes over their scale
                    const l0 = (R[0] * dx + R[1] * dy + R[2] * dz) / s0;
                    const l1 = (R[3] * dx + R[4] * dy + R[5] * dz) / s1;
                    const l2 = (R[6] * dx + R[7] * dy + R[8] * dz) / s2;
                    const q = l0 * l0 + l1 * l1 + l2 * l2;
                    if (q > 6.25) continue;
                    const wt = Math.exp(-0.5 * q);
                    sum += wt;
                    if (cx < 0 || cy < 0 || cz < 0 || cx >= n || cy >= n || cz >= n || cnt >= 4096) continue;
                    weights[cnt] = wt;
                    cells[cnt++] = cz * n2 + cy * n + cx;
                }
            }
        }
        if (sum <= 0) {
            // falls between the sampled voxel centres: the nearest voxel takes it (if inside)
            const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
            if (cx >= 0 && cy >= 0 && cz >= 0 && cx < n && cy < n && cz < n) add(cz * n2 + cy * n + cx, m, r, g, bl);
            continue;
        }
        for (let k = 0; k < cnt; k++) add(cells[k], m * weights[k] / sum, r, g, bl);
    }
    self.postMessage({ progress: 0.92 });
    const rgbMass = mass.slice();   // the colour's weights (before the fade)
    // soft edge: the outermost voxels fade out (a faint haze reaching over the grid ended in straight edges)
    const fade = new Float32Array(n);
    const band = Math.max(2, Math.round(n * 0.1));
    for (let i = 0; i < n; i++) { const d = Math.min(i + 0.5, n - i - 0.5) / band; fade[i] = d >= 1 ? 1 : d * d * (3 - 2 * d); }
    for (let cz = 0; cz < n; cz++) for (let cy = 0; cy < n; cy++) {
        const f = fade[cz] * fade[cy];
        for (let cx = 0; cx < n; cx++) mass[cz * n2 + cy * n + cx] *= f * fade[cx];   // colour: from rgb / mass, unfaded weights
    }
    // density per data unit = mass / voxel volume; colour = mass-weighted mean
    const volume = vox[0] * vox[1] * vox[2];
    let sigma = 0;
    for (let i = 0; i < total; i++) sigma = Math.max(sigma, mass[i] / volume);
    // colours grown into the empty neighbours (two passes, mean of the coloured ones): the trilinear lookup at the edge
    // of a dense region mixed in the black of empty voxels – dark rims and cubes in HQ
    for (let pass = 0; pass < 2; pass++) {
        const grown = [];
        for (let cz = 0; cz < n; cz++) for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
            const i = cz * n2 + cy * n + cx;
            if (rgbMass[i] > 0) continue;
            let r = 0, g = 0, bl = 0, k = 0;
            for (const [dx, dy, dz] of NEIGHBOURS) {
                const x = cx + dx, y = cy + dy, z = cz + dz;
                if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) continue;
                const j = z * n2 + y * n + x, w = rgbMass[j];
                if (w <= 0) continue;
                r += rgb[j * 3] / w; g += rgb[j * 3 + 1] / w; bl += rgb[j * 3 + 2] / w; k++;
            }
            if (k) grown.push(i, r / k, g / k, bl / k);
        }
        for (let q = 0; q < grown.length; q += 4) {
            const i = grown[q];
            rgb[i * 3] = grown[q + 1]; rgb[i * 3 + 1] = grown[q + 2]; rgb[i * 3 + 2] = grown[q + 3];
            rgbMass[i] = 1;
        }
    }
    const density = new Uint16Array(total), color = new Uint8Array(total * 4);
    const toSrgb = v => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    for (let i = 0; i < total; i++) {
        const mi = mass[i];
        density[i] = sigma > 0 ? floatToHalf(mi / volume / sigma) : 0;
        if (rgbMass[i] > 0) {
            const wsum = rgbMass[i];
            color[i * 4] = toSrgb(rgb[i * 3] / wsum);
            color[i * 4 + 1] = toSrgb(rgb[i * 3 + 1] / wsum);
            color[i * 4 + 2] = toSrgb(rgb[i * 3 + 2] / wsum);
        }
        color[i * 4 + 3] = 255;
    }
    // majorant per block: the largest density the trilinear lookup can return in it (block + one voxel around)
    const nb = Math.ceil(n / block);
    const majorant = new Uint16Array(nb * nb * nb);
    for (let bz = 0; bz < nb; bz++) for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
        let mx = 0;
        for (let cz = Math.max(0, bz * block - 1); cz <= Math.min(n - 1, (bz + 1) * block); cz++)
            for (let cy = Math.max(0, by * block - 1); cy <= Math.min(n - 1, (by + 1) * block); cy++)
                for (let cx = Math.max(0, bx * block - 1); cx <= Math.min(n - 1, (bx + 1) * block); cx++) mx = Math.max(mx, mass[cz * n2 + cy * n + cx]);
        majorant[(bz * nb + by) * nb + bx] = sigma > 0 ? floatToHalf(Math.min(mx / volume / sigma * 1.001, 1)) : 0;
    }
    self.postMessage({ density, color, majorant, sigma, nb, min, max }, [density.buffer, color.buffer, majorant.buffer]);
};
