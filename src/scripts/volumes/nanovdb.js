// NanoVDB files (the GPU-friendly, linearised form of OpenVDB grids – pbrt's "nanovdb" media, density/temperature of
// smoke, clouds and fire) → VDB grid sources (vdb-import.js). Own reader after the published format (NanoVDB 32.x,
// float grids); pure functions, run in a worker.
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
const ROOT_BACKGROUND = 28;                      // RootData<float>: bbox (24) + table size (4), then the background value
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
 * A float grid as a VDB grid source (vdb-import.js): its leaves (8³ values + activity mask, x-major: n = x·64 + y·8 + z,
 * origin = bbox min rounded down to the leaf) and the active tiles of its internal nodes (a value over a whole child:
 * lower 8³, upper 128³) straight from the node arrays.
 */
export function nanoSource(g) {
    if (g.gridType !== GRID_TYPE_FLOAT) return { name: g.name, unsupported: `NanoVDB grid type ${g.gridType}` };
    const v = g.view, tree = GRID_DATA;
    const offset = n => tree + Number(v.getBigUint64(tree + 8 * n, true));
    const counts = [0, 1, 2].map(n => v.getUint32(tree + 32 + 4 * n, true));
    // level sets: the inside counts too (inactive voxels and tiles hold −background there)
    const levelSet = g.gridClass === 1, background = v.getFloat32(offset(3) + ROOT_BACKGROUND, true);
    return {
        name: g.name, gridClass: g.gridClass === 2 ? 'fog volume' : levelSet ? 'level set' : '', levelSet, background, matrix: g.matrix,
        indexMin: g.indexMin, indexMax: g.indexMax, leafCount: counts[0],
        forEachLeaf(cb) {
            const values = new Float32Array(512), mask = new Uint32Array(16);
            for (let l = 0, base = offset(0); l < counts[0]; l++, base += LEAF_SIZE) {
                const origin = [v.getInt32(base, true) & ~7, v.getInt32(base + 4, true) & ~7, v.getInt32(base + 8, true) & ~7];
                for (let w = 0; w < 16; w++) mask[w] = v.getUint32(base + 16 + 4 * w, true);
                for (let n = 0; n < 512; n++) values[n] = levelSet || (mask[n >>> 5] >>> (n & 31)) & 1 ? v.getFloat32(base + 96 + 4 * n, true) : 0;
                cb(origin, values, mask);
            }
        },
        forEachTile(cb) {
            for (const [level, info, childDim] of [[1, LOWER, 8], [2, UPPER, 128]]) {
                const log = info === LOWER ? 4 : 5, nodeDim = childDim << log;
                for (let c = 0, base = offset(level); c < counts[level]; c++, base += info.size) {
                    const o = [0, 1, 2].map(k => Math.floor(v.getInt32(base + 4 * k, true) / nodeDim) * nodeDim);
                    const valueMask = base + 32, childMask = base + 32 + info.mask;
                    for (let n = 0; n < info.n; n++) {
                        const byte = n >> 3, bit = 1 << (n & 7);
                        if (v.getUint8(childMask + byte) & bit) continue;
                        const active = v.getUint8(valueMask + byte) & bit, val = v.getFloat32(base + info.table + 8 * n, true);
                        if ((active && val !== 0) || (levelSet && val < 0)) cb([o[0] + (n >> (2 * log)) * childDim, o[1] + ((n >> log) & ((1 << log) - 1)) * childDim, o[2] + (n & ((1 << log) - 1)) * childDim], childDim, val);
                    }
                }
            }
        },
    };
}
