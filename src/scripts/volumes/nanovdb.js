// NanoVDB files (the GPU-friendly, linearised form of OpenVDB grids – pbrt's "nanovdb" media, density/temperature of
// smoke, clouds and fire) → dense grids. Own reader after the published format (NanoVDB 32.x, float grids); pure
// functions, run in the import worker.
//
// File: segments of { header "NanoVDB0" + version + grid count + codec (0 none, 1 zlib), per grid meta data (176 bytes)
// + name, then the grid (zlib: int64 compressed size + stream) }. Grid: GridData (672 bytes: index → world map,
// bounds, class/type), TreeData (64 bytes: byte offsets of the leaf, lower, upper and root node arrays, counts), the
// node arrays. Not followed as a tree: the leaves (8³ values + activity mask, origin from their bounding box) and the
// active tiles of the internal nodes (a constant value over a child's region – the inside of a dense cloud) are read
// straight from their arrays.

const META_SIZE = 176, GRID_DATA = 672;
const LEAF_SIZE = 2144;                         // LeafData<float>: bbox min (12) + dif (3) + flags (1) + mask (64) + 4 stats + 512 values
const internalSize = log2dim => {                // InternalData<float>: bbox (24) + flags (8) + 2 masks + 4 stats, table aligned to 32
    const n = 1 << (3 * log2dim), mask = n / 8;
    const head = 24 + 8 + 2 * mask + 16;
    return { n, mask, table: Math.ceil(head / 32) * 32, size: Math.ceil(head / 32) * 32 + 8 * n };
};
const LOWER = internalSize(4), UPPER = internalSize(5);
const GRID_TYPE_FLOAT = 1;

/**
 * @param {Uint8Array} bytes  the whole file
 * @param {(data: Uint8Array) => Uint8Array} unzlib  zlib decompressor (codec 1)
 * @returns {{ name, gridType, gridClass, indexMin: number[], indexMax: number[], matrix: number[] (4×4 column-major,
 *   index → world), voxelCount, grid: Uint8Array, view: DataView }[]}
 */
export function readNanoVdb(bytes, unzlib) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const grids = [];
    let o = 0;
    while (o + 16 <= bytes.length) {
        const magic = String.fromCharCode(...bytes.subarray(o, o + 7));
        if (magic !== 'NanoVDB') throw new Error('not a NanoVDB file');
        const count = dv.getUint16(o + 12, true), codec = dv.getUint16(o + 14, true);
        o += 16;
        const metas = [];
        for (let g = 0; g < count; g++, o += META_SIZE) {
            metas.push({
                gridSize: Number(dv.getBigUint64(o, true)), fileSize: Number(dv.getBigUint64(o + 8, true)),
                voxelCount: Number(dv.getBigUint64(o + 24, true)), gridType: dv.getUint32(o + 32, true), gridClass: dv.getUint32(o + 36, true),
                indexMin: [0, 1, 2].map(i => dv.getInt32(o + 88 + 4 * i, true)), indexMax: [0, 1, 2].map(i => dv.getInt32(o + 100 + 4 * i, true)),
                nameSize: dv.getUint32(o + 136, true),
            });
        }
        for (const m of metas) { m.name = String.fromCharCode(...bytes.subarray(o, o + m.nameSize)).replace(/\0+$/, ''); o += m.nameSize; }
        for (const m of metas) {
            let grid;
            if (codec === 1) grid = unzlib(bytes.subarray(o + 8, o + 8 + Number(dv.getBigInt64(o, true))));
            else if (codec === 0) grid = bytes.subarray(o, o + m.gridSize);
            else throw new Error(`NanoVDB codec ${codec} not supported`);
            o += m.fileSize;
            const view = new DataView(grid.buffer, grid.byteOffset, grid.byteLength);
            // index → world: the map's double matrix (row-major 3×3) and translation
            const M = [...Array(9)].map((_, i) => view.getFloat64(384 + 8 * i, true));
            const t = [0, 1, 2].map(i => view.getFloat64(384 + 144 + 8 * i, true));
            const matrix = [M[0], M[3], M[6], 0, M[1], M[4], M[7], 0, M[2], M[5], M[8], 0, t[0], t[1], t[2], 1];
            grids.push({ ...m, matrix, grid, view });
        }
    }
    return grids;
}

/**
 * Dense samples of a float grid over an index box (default: its own), every `factor`-th voxel averaged (box filter) –
 * factor chosen so that at most maxVoxels remain. Inactive voxels count as 0 (fog volumes: the background).
 * @param {{ min: number[], max: number[] }} [box]  index box (inclusive) – e.g. the union with a second grid
 * @returns {{ dims: number[], factor, min: number[], data: Float32Array, max: number }}
 */
export function denseGrid(g, maxVoxels, box = null) {
    if (g.gridType !== GRID_TYPE_FLOAT) throw new Error(`NanoVDB grid "${g.name}": only float grids (type ${g.gridType})`);
    const lo = box?.min ?? g.indexMin, hi = box?.max ?? g.indexMax;
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
    const v = g.view, tree = GRID_DATA;
    const offset = n => tree + Number(v.getBigUint64(tree + 8 * n, true));
    const counts = [0, 1, 2].map(n => v.getUint32(tree + 32 + 4 * n, true));
    // leaves: 8³ values, x-major (index n = x·64 + y·8 + z), origin = bbox min rounded down to the leaf
    for (let l = 0, base = offset(0); l < counts[0]; l++, base += LEAF_SIZE) {
        const ox = v.getInt32(base, true) & ~7, oy = v.getInt32(base + 4, true) & ~7, oz = v.getInt32(base + 8, true) & ~7;
        for (let n = 0; n < 512; n++) {
            if (!(v.getUint8(base + 16 + (n >> 3)) & (1 << (n & 7)))) continue;   // inactive: background
            const val = v.getFloat32(base + 96 + 4 * n, true);
            if (val !== 0) add(ox + (n >> 6), oy + ((n >> 3) & 7), oz + (n & 7), val);
        }
    }
    // active tiles of the internal nodes: a value over a whole child (lower: 8³, upper: 128³)
    const tiles = (level, info, childDim) => {
        const log = info === LOWER ? 4 : 5, nodeDim = childDim << log;
        for (let c = 0, base = offset(level); c < counts[level]; c++, base += info.size) {
            const ox = Math.floor(v.getInt32(base, true) / nodeDim) * nodeDim, oy = Math.floor(v.getInt32(base + 4, true) / nodeDim) * nodeDim, oz = Math.floor(v.getInt32(base + 8, true) / nodeDim) * nodeDim;
            const valueMask = base + 32, childMask = base + 32 + info.mask;
            for (let n = 0; n < info.n; n++) {
                const byte = n >> 3, bit = 1 << (n & 7);
                if (!(v.getUint8(valueMask + byte) & bit) || (v.getUint8(childMask + byte) & bit)) continue;
                const val = v.getFloat32(base + info.table + 8 * n, true);
                if (val === 0) continue;
                const tx = ox + (n >> (2 * log)) * childDim, ty = oy + ((n >> log) & ((1 << log) - 1)) * childDim, tz = oz + (n & ((1 << log) - 1)) * childDim;
                for (let x = 0; x < childDim; x++) for (let y = 0; y < childDim; y++) for (let z = 0; z < childDim; z++) add(tx + x, ty + y, tz + z, val);
            }
        }
    };
    tiles(1, LOWER, 8);
    tiles(2, UPPER, 128);
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
 * For the GPU: values / max as bytes (rounded up where the value is not 0 – thin smoke stays) and per block of
 * BLOCK³ samples its largest byte (the majorant the volume walk jumps empty space with).
 */
export const BLOCK = 8;
export function quantize(dense) {
    const { dims, data, max } = dense;
    const bytes = new Uint8Array(data.length);
    const k = max > 0 ? 255 / max : 0;
    for (let i = 0; i < data.length; i++) bytes[i] = data[i] > 0 ? Math.min(255, Math.max(1, Math.round(data[i] * k))) : 0;
    const bd = dims.map(d => Math.ceil(d / BLOCK));
    const blocks = new Uint8Array(bd[0] * bd[1] * bd[2]);
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) {
        const row = (z * dims[1] + y) * dims[0], brow = (Math.floor(z / BLOCK) * bd[1] + Math.floor(y / BLOCK)) * bd[0];
        for (let x = 0; x < dims[0]; x++) {
            const b = brow + Math.floor(x / BLOCK), val = bytes[row + x];
            if (val > blocks[b]) blocks[b] = val;
        }
    }
    // trilinear filtering reaches one sample into the neighbour block: a block's majorant covers its neighbours' edges
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
