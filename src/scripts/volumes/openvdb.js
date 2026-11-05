// OpenVDB files (.vdb – the common exchange format of simulation and 3D programs for smoke, clouds, fire) → VDB grid sources (see
// vdb-import.js). Own reader after the published format (file versions 222+, float trees 5-4-3, saved as float or
// half; fog volumes and level sets); pure functions, run in a worker.
//
// File: magic + version + library version + "has offsets" + UUID, file metadata, grid count; per grid a descriptor
// (unique name, type – "_HalfFloat" suffix: values stored as half –, instance parent, stream positions) followed by
// the grid: compression flags (1 zip, 2 active mask, 4 blosc), metadata (class …), transform (map type + its values),
// topology (root: background, tiles, children; internal nodes: child mask, value mask, compressed values, then their
// children; leaves: value mask) and the buffers (per leaf, in topology order: value mask again + compressed values).
// Compressed values: a metadata byte (how inactive values are restored), optional inactive values and selection mask,
// then the active (mask compression) or all values – raw, zip or blosc, each with an int64 byte count.

const MAGIC = 0x56444220;
const COMPRESS_ZIP = 1, COMPRESS_ACTIVE_MASK = 2, COMPRESS_BLOSC = 4;
const LEVELS = [5, 4];   // upper and lower internal nodes (log2 of the children per axis); leaves 3

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.o = 0;
    }
    u8() { return this.view.getUint8(this.o++); }
    i32() { const v = this.view.getInt32(this.o, true); this.o += 4; return v; }
    u32() { const v = this.view.getUint32(this.o, true); this.o += 4; return v; }
    i64() { const v = Number(this.view.getBigInt64(this.o, true)); this.o += 8; return v; }
    f32() { const v = this.view.getFloat32(this.o, true); this.o += 4; return v; }
    f64() { const v = this.view.getFloat64(this.o, true); this.o += 8; return v; }
    str() { const n = this.u32(); const s = String.fromCharCode(...this.bytes.subarray(this.o, this.o + n)); this.o += n; return s; }
    take(n) { const b = this.bytes.subarray(this.o, this.o + n); this.o += n; return b; }
    vec3d() { return [this.f64(), this.f64(), this.f64()]; }
}

// metadata map: count, then name, type name, byte size, value – only what we use is decoded
function readMeta(r) {
    const meta = {};
    const count = r.u32();
    for (let i = 0; i < count; i++) {
        const name = r.str(), type = r.str(), size = r.u32(), end = r.o + size;
        if (type === 'string') meta[name] = String.fromCharCode(...r.bytes.subarray(r.o, end));
        else if (type === 'bool') meta[name] = r.view.getUint8(r.o) !== 0;
        else if (type === 'int32') meta[name] = r.view.getInt32(r.o, true);
        else if (type === 'int64') meta[name] = Number(r.view.getBigInt64(r.o, true));
        else if (type === 'float') meta[name] = r.view.getFloat32(r.o, true);
        else if (type === 'double') meta[name] = r.view.getFloat64(r.o, true);
        else if (type === 'vec3i') meta[name] = [0, 1, 2].map(k => r.view.getInt32(r.o + 4 * k, true));
        r.o = end;
    }
    return meta;
}

// grid transform → index → world, 4×4 column-major (OpenVDB maps act on row vectors: world = index · M)
function readTransform(r) {
    const type = r.str();
    const scaleTranslate = (t, s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, t[0], t[1], t[2], 1];
    if (type === 'UniformScaleMap' || type === 'ScaleMap') {
        const s = r.vec3d(); r.o += 4 * 24;   // voxel size, inverse scale, inverse scale², inverse twice scale
        return scaleTranslate([0, 0, 0], s);
    }
    if (type === 'UniformScaleTranslateMap' || type === 'ScaleTranslateMap') {
        const t = r.vec3d(), s = r.vec3d(); r.o += 4 * 24;
        return scaleTranslate(t, s);
    }
    if (type === 'TranslationMap') return scaleTranslate(r.vec3d(), [1, 1, 1]);
    if (type === 'AffineMap' || type === 'UnitaryMap') {
        const m = [...Array(16)].map(() => r.f64());   // row-major, translation in the last row (row vectors) = column-major for column vectors
        return m;
    }
    throw new Error(`OpenVDB transform "${type}" not supported`);
}

// node masks: words of 64 bits, bit i of word w = index 64·w + i
function readMask(r, log2dim) {
    const words = (1 << (3 * log2dim)) / 64;
    const m = new Uint32Array(words * 2);
    for (let w = 0; w < words * 2; w++) m[w] = r.u32();
    return m;
}
const bit = (mask, i) => (mask[i >>> 5] >>> (i & 31)) & 1;
const countOn = mask => { let n = 0; for (let w of mask) { while (w) { w &= w - 1; n++; } } return n; };

/**
 * Values of a node (leaf 512, internal node 32³ / 16³): how OpenVDB writes them (readCompressedValues).
 * @returns {Float32Array} all values (inactive ones restored from the background / stored inactive values)
 */
function readValues(r, count, valueMask, ctx) {
    const { compression, half, background, codecs } = ctx;
    const meta = r.u8();
    let inactive0 = meta === 0 ? background : -background, inactive1 = background;
    // metadata: 0 no mask, no inactive values; 1 no mask, −background; 2 no mask, one inactive value; 3 mask, no inactive
    // values; 4 mask, one inactive value; 5 mask, two inactive values; 6 no mask, all values
    if (meta === 2 || meta === 4 || meta === 5) {   // stored as full floats, also in half grids
        inactive0 = r.f32();
        if (meta === 5) inactive1 = r.f32();
    }
    let selection = null;
    if (meta === 3 || meta === 4 || meta === 5) selection = readMask(r, Math.round(Math.log2(count) / 3));
    const stored = (compression & COMPRESS_ACTIVE_MASK) && meta !== 6 ? countOn(valueMask) : count;
    const size = (half ? 2 : 4) * stored;
    let data;
    if (half && stored === 0) data = new Uint8Array(0);   // half values: nothing at all is written for none (not even a size)
    else if (compression & (COMPRESS_BLOSC | COMPRESS_ZIP)) {
        const n = r.i64();
        if (n <= 0) data = r.take(-n);   // stored uncompressed
        else data = (compression & COMPRESS_BLOSC ? codecs.blosc : codecs.unzlib)(r.take(n), size);
    } else data = r.take(size);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Float32Array(count);
    if (stored === count) {
        for (let i = 0; i < count; i++) out[i] = half ? halfToFloat(dv.getUint16(2 * i, true)) : dv.getFloat32(4 * i, true);
    } else {
        for (let i = 0, k = 0; i < count; i++) {
            if (bit(valueMask, i)) { out[i] = half ? halfToFloat(dv.getUint16(2 * k, true)) : dv.getFloat32(4 * k, true); k++; }
            else out[i] = selection && bit(selection, i) ? inactive1 : inactive0;
        }
    }
    return out;
}

function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * @param {Uint8Array} bytes
 * @param {{ unzlib: (d: Uint8Array, size: number) => Uint8Array, blosc: (d: Uint8Array, size: number) => Uint8Array }} codecs
 * @returns {object[]} grid sources (vdb-import.js): { name, gridClass, matrix, indexMin, indexMax, forEachLeaf, forEachTile }
 */
export function readOpenVdb(bytes, codecs) {
    const r = new Reader(bytes);
    if (r.u32() !== MAGIC || r.u32() !== 0) throw new Error('not an OpenVDB file');
    const version = r.u32();
    if (version < 222) throw new Error(`OpenVDB file version ${version} too old (222 or newer)`);
    r.o += 8;                      // library version
    const hasOffsets = r.u8() !== 0;
    r.o += 36;                     // UUID
    readMeta(r);                   // file metadata
    if (!hasOffsets) throw new Error('OpenVDB file without grid offsets');
    const count = r.u32();
    const grids = [];
    for (let g = 0; g < count; g++) {
        const unique = r.str();
        let type = r.str();
        const half = type.endsWith('_HalfFloat');
        if (half) type = type.slice(0, -'_HalfFloat'.length);
        const parent = r.str();
        const gridPos = r.i64(), blockPos = r.i64(), endPos = r.i64();
        const name = unique.split('\x1e')[0];
        r.o = endPos;
        if (parent) continue;      // an instance of another grid
        if (type !== 'Tree_float_5_4_3') { grids.push({ name, unsupported: type }); continue; }
        grids.push(readGrid(bytes, gridPos, blockPos, { name, half, codecs }));
    }
    return grids;
}

// one float grid: metadata, transform, topology (leaf origins/masks, active tiles) – the leaf values are decoded when
// the source is walked (forEachLeaf), straight into the caller's dense grid
function readGrid(bytes, gridPos, blockPos, { name, half, codecs }) {
    const r = new Reader(bytes);
    r.o = gridPos;
    const compression = r.u32();
    const meta = readMeta(r);
    const matrix = readTransform(r);
    if (r.i32() !== 1) throw new Error('OpenVDB: one buffer per tree expected');
    const background = r.f32();
    const ctx = { compression, half, background, codecs };
    const numTiles = r.u32(), numChildren = r.u32();
    const tiles = [], leaves = [];
    // tiles that count: active ones with a value – and for level sets the inside (inactive, negative)
    const levelSet = meta.class === 'level set';
    const counts = (active, value) => (active && value !== 0) || (levelSet && value < 0);
    for (let t = 0; t < numTiles; t++) {
        const origin = [r.i32(), r.i32(), r.i32()], value = r.f32(), active = r.u8() !== 0;
        if (counts(active, value)) tiles.push({ origin, size: 4096, value });
    }
    // internal node: masks, values (tiles of the inactive/active children), then the children in mask order
    const node = (origin, level) => {
        const log = LEVELS[level], childLog = level === 0 ? LEVELS[1] + 3 : 3, n = 1 << (3 * log);
        const childMask = readMask(r, log), valueMask = readMask(r, log);
        const values = readValues(r, n, valueMask, ctx);
        const dim = 1 << log, cdim = 1 << childLog;
        const at = i => [origin[0] + ((i >> (2 * log)) & (dim - 1)) * cdim, origin[1] + ((i >> log) & (dim - 1)) * cdim, origin[2] + (i & (dim - 1)) * cdim];
        for (let i = 0; i < n; i++) if (!bit(childMask, i) && counts(bit(valueMask, i), values[i])) tiles.push({ origin: at(i), size: cdim, value: values[i] });
        for (let i = 0; i < n; i++) {
            if (!bit(childMask, i)) continue;
            if (level === 0) node(at(i), 1);
            else leaves.push({ origin: at(i), mask: readMask(r, 3) });
        }
    };
    for (let c = 0; c < numChildren; c++) node([r.i32(), r.i32(), r.i32()], 0);
    // index bounds of the active data
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const grow = (o, size) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], o[k]); hi[k] = Math.max(hi[k], o[k] + size - 1); } };
    for (const l of leaves) grow(l.origin, 8);
    for (const t of tiles) grow(t.origin, t.size);
    const empty = !Number.isFinite(lo[0]);
    return {
        name, gridClass: meta.class || '', levelSet, matrix, background,
        indexMin: empty ? [0, 0, 0] : lo, indexMax: empty ? [0, 0, 0] : hi, leafCount: leaves.length, tileCount: tiles.length,
        forEachTile(cb) { for (const t of tiles) cb(t.origin, t.size, t.value); },
        // the buffers: per leaf (topology order) its mask again, then the compressed values
        forEachLeaf(cb) {
            const b = new Reader(bytes);
            b.o = blockPos;
            for (const l of leaves) {
                b.o += 64;
                cb(l.origin, readValues(b, 512, l.mask, ctx), l.mask);
            }
        },
    };
}

export const VDB_MASK_BIT = bit;
