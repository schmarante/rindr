// VDB volumes – one way for both file forms of the VDB tree: OpenVDB (.vdb – the exchange format of simulation and 3D
// programs) and NanoVDB (.nvdb – its GPU form, pbrt's media). The two files differ completely; what they hold is the same: per grid its index
// → world transform and a sparse tree of 8³ leaves plus constant tiles. Each format reader (openvdb.js, nanovdb.js)
// delivers grid sources with the same interface, everything after that is shared:
//   source: { name, gridClass, levelSet, background, matrix (index → world, 4×4 column-major), indexMin, indexMax,
//             forEachLeaf(cb(origin, values Float32Array(512), mask)), forEachTile(cb(origin, size, value)) }
//   → dense grid over an index box, reduced by an integer factor to a voxel budget (box average); level sets (signed
//     distance, negative inside) become fog first: inside 1, ramping to 0 at the surface over the band width
//   → 8-bit values of their maximum (density as its square root) + 8³ block majorants (the volume walk jumps empty
//     space with them)
//   → volume: unit box (−0.5…0.5) → grid world matrix, density (+ temperature for fire) – grid-volumes.js draws it.
// Pure functions, run in a worker (vdb-worker.js for dropped files, pbrt-worker.js for pbrt's media).
import { readNanoVdb, nanoSource } from './nanovdb.js';
import { readOpenVdb } from './openvdb.js';
import { bloscDecompress } from './blosc.js';

export const BLOCK = 8;

/** 'openvdb' | 'nanovdb' | null from the first bytes */
export function vdbFormat(bytes) {
    if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 7)) === 'NanoVDB') return 'nanovdb';
    if (bytes.length >= 8 && bytes[0] === 0x20 && bytes[1] === 0x42 && bytes[2] === 0x44 && bytes[3] === 0x56) return 'openvdb';
    return null;
}

/**
 * Grid sources of a VDB file (either form). unzlib: zlib decompressor (fflate's unzlibSync).
 * @returns {object[]} sources; unsupported grids as { name, unsupported }
 */
export function readVdbGrids(bytes, unzlib) {
    const format = vdbFormat(bytes);
    if (format === 'nanovdb') return readNanoVdb(bytes, unzlib).map(nanoSource);
    if (format === 'openvdb') return readOpenVdb(bytes, { unzlib: d => unzlib(d), blosc: d => bloscDecompress(d, unzlib) });
    throw new Error('not a VDB file');
}

/** Level set (signed distance) → fog density: 1 deep inside, 0 outside, a ramp over the band (OpenVDB's convention) */
export const levelSetFog = (d, band) => (d < 0 ? Math.min(1, -d / band) : 0);

/**
 * Dense samples of a source over an index box (inclusive; default its own), every `factor`-th voxel averaged – factor
 * chosen so that at most maxVoxels remain. Inactive voxels count as 0 (fog volumes: the background); level sets as fog.
 * @returns {{ dims: number[], factor, min: number[], data: Float32Array, max: number }}
 */
export function denseFromSource(src, maxVoxels, box = null, onProgress = null) {
    const lo = box?.min ?? src.indexMin, hi = box?.max ?? src.indexMax;
    const ext = [0, 1, 2].map(i => hi[i] - lo[i] + 1);
    const factor = Math.max(1, Math.ceil(Math.cbrt(ext[0] * ext[1] * ext[2] / maxVoxels)));
    const dims = ext.map(e => Math.ceil(e / factor));
    const data = new Float32Array(dims[0] * dims[1] * dims[2]);
    const w = 1 / factor ** 3, [mx, my, mz] = lo;
    const add = (x, y, z, v) => {
        const i = Math.floor((x - mx) / factor), j = Math.floor((y - my) / factor), k = Math.floor((z - mz) / factor);
        if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return;
        data[(k * dims[1] + j) * dims[0] + i] += v * w;
    };
    const band = Math.abs(src.background) || 1;
    const value = src.levelSet ? v => levelSetFog(v, band) : v => v;
    let leaves = 0;
    src.forEachLeaf((o, values, mask) => {
        if (onProgress && ++leaves % 4096 === 0) onProgress(leaves / src.leafCount);
        for (let n = 0; n < 512; n++) {
            if (!src.levelSet && !((mask[n >>> 5] >>> (n & 31)) & 1)) continue;   // inactive: background
            const v = value(values[n]);
            if (v > 0) add(o[0] + (n >> 6), o[1] + ((n >> 3) & 7), o[2] + (n & 7), v);
        }
    });
    src.forEachTile((o, size, tile) => {
        const v = value(tile);
        if (!(v > 0)) return;
        for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) add(o[0] + x, o[1] + y, o[2] + z, v);
    });
    let max = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    return { dims, factor, min: lo.slice(), data, max };
}

/** A dense grid (x fastest) reduced by an integer factor (box average) to at most maxVoxels */
export function reduceDense(data, dims, maxVoxels) {
    const factor = Math.max(1, Math.ceil(Math.cbrt(dims[0] * dims[1] * dims[2] / maxVoxels)));
    if (factor === 1) {
        let max = 0;
        for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
        return { dims: dims.slice(), factor, data, max };
    }
    const out = dims.map(d => Math.ceil(d / factor));
    const res = new Float32Array(out[0] * out[1] * out[2]), w = 1 / factor ** 3;
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
        res[(Math.floor(z / factor) * out[1] + Math.floor(y / factor)) * out[0] + Math.floor(x / factor)] += data[(z * dims[1] + y) * dims[0] + x] * w;
    }
    let max = 0;
    for (let i = 0; i < res.length; i++) if (res[i] > max) max = res[i];
    return { dims: out, factor, data: res, max };
}

/**
 * For the GPU: √(value / max) as bytes – the readers square it (grid-volumes.js, grid-pt.js): thin smoke keeps its
 * value down to ~4·10⁻⁶ of the maximum; linear bytes rounded the faint noise around a plume up to 1/255 (a haze around
 * it) or lost real wisps. Per block of BLOCK³ samples its largest byte, grown by the neighbours (trilinear filtering
 * reaches one sample into the next block) – squared it bounds the filtered density.
 */
export function quantize(dense) {
    const { dims, data, max } = dense;
    const bytes = new Uint8Array(data.length);
    const k = max > 0 ? 1 / max : 0;
    for (let i = 0; i < data.length; i++) bytes[i] = data[i] > 0 ? Math.min(255, Math.round(255 * Math.sqrt(data[i] * k))) : 0;
    const bd = dims.map(d => Math.ceil(d / BLOCK));
    const blocks = new Uint8Array(bd[0] * bd[1] * bd[2]);
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) {
        const row = (z * dims[1] + y) * dims[0], brow = (Math.floor(z / BLOCK) * bd[1] + Math.floor(y / BLOCK)) * bd[0];
        for (let x = 0; x < dims[0]; x++) {
            const b = brow + Math.floor(x / BLOCK), val = bytes[row + x];
            if (val > blocks[b]) blocks[b] = val;
        }
    }
    const grown = blocks.slice();
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
        let m = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx, Y = y + dy, Z = z + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= bd[0] || Y >= bd[1] || Z >= bd[2]) continue;
            const b = blocks[(Z * bd[1] + Y) * bd[0] + X];
            if (b > m) m = b;
        }
        grown[(z * bd[1] + y) * bd[0] + x] = m;
    }
    return { bytes, blocks: grown, blockDims: bd };
}

// grid names that carry density and temperature (fire) in common simulation exports
const DENSITY_NAMES = ['density', 'smoke', 'soot', 'dens'];
const TEMPERATURE_NAMES = ['temperature', 'heat', 'flame', 'flames', 'fire', 'temp'];

/**
 * The volume of a file's grids: density (the named grid, else the first float fog grid) and temperature (if its
 * transform matches) resampled onto their common index box.
 * onProgress(fraction): while the leaves are resampled.
 * @returns {{ dims, factor, density: Uint8Array, densityMax, blocks, blockDims, temperature: Uint8Array | null,
 *   temperatureMax, boxToWorld: number[] (row-major 4×4: unit box → the grid's world), grids: string[], densityGrid,
 *   temperatureGrid, levelSet }}
 */
export function vdbVolume(sources, maxVoxels, { density: densityName = null, temperature: temperatureName = null, onProgress = null } = {}) {
    const usable = sources.filter(s => !s.unsupported && s.leafCount + (s.tileCount ?? 0) > 0);
    const pick = names => usable.find(s => names.includes(s.name.toLowerCase()));
    const dg = (densityName && usable.find(s => s.name === densityName)) || pick(DENSITY_NAMES) || usable.find(s => s.gridClass !== 'level set') || usable[0];
    if (!dg) throw new Error(sources.length ? `no usable grid (${sources.map(s => `${s.name}${s.unsupported ? ': ' + s.unsupported : ''}`).join(', ')})` : 'no grids');
    const tCand = (temperatureName && usable.find(s => s.name === temperatureName)) || pick(TEMPERATURE_NAMES);
    const tg = tCand && tCand !== dg && tCand.matrix.every((x, i) => Math.abs(x - dg.matrix[i]) < 1e-9) ? tCand : null;
    const box = { min: dg.indexMin.slice(), max: dg.indexMax.slice() };
    if (tg) for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], tg.indexMin[i]); box.max[i] = Math.max(box.max[i], tg.indexMax[i]); }
    const share = tg ? dg.leafCount / (dg.leafCount + tg.leafCount || 1) : 1;
    const density = denseFromSource(dg, maxVoxels, box, onProgress && (f => onProgress(f * share)));
    const temperature = tg ? denseFromSource(tg, maxVoxels, box, onProgress && (f => onProgress(share + f * (1 - share)))) : null;
    // unit box → index space (samples at integer indices, the box spans whole voxels) → the grid's world
    const size = density.dims.map(d => d * density.factor), centre = box.min.map((m, i) => m - 0.5 + size[i] / 2);
    const g = dg.matrix;   // column-major
    const boxToWorld = [0, 1, 2].flatMap(r => [g[r] * size[0], g[4 + r] * size[1], g[8 + r] * size[2], g[r] * centre[0] + g[4 + r] * centre[1] + g[8 + r] * centre[2] + g[12 + r]]).concat([0, 0, 0, 1]);
    return {
        ...packVolume(density, temperature), boxToWorld, grids: usable.map(s => s.name),
        densityGrid: dg.name, temperatureGrid: tg?.name ?? null, levelSet: !!dg.levelSet,
    };
}

/** Dense density (+ temperature on the same samples) → what the GPU gets: bytes of their maxima + block majorants */
export function packVolume(density, temperature = null) {
    const q = quantize(density);
    let tBytes = null;
    if (temperature) {
        tBytes = new Uint8Array(temperature.data.length);
        const k = temperature.max > 0 ? 255 / temperature.max : 0;
        for (let i = 0; i < tBytes.length; i++) tBytes[i] = Math.min(255, Math.round(Math.max(temperature.data[i], 0) * k));
    }
    return {
        dims: density.dims, factor: density.factor, density: q.bytes, densityMax: density.max, blocks: q.blocks, blockDims: q.blockDims,
        temperature: tBytes, temperatureMax: temperature?.max ?? 0,
    };
}
