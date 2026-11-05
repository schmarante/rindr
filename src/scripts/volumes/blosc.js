// Blosc (version 1 frames) – the compressor OpenVDB uses for leaf values: own decoder after the published frame layout.
// Frame: 16-byte header (version, codec version, flags, type size, uncompressed size, block size, compressed size),
// then either the raw data (flag "memcpyed") or the start offset of every block, each block split into `typesize`
// streams (unless flag 0x10 or the short last block), each stream: int32 compressed size + data (size = stream size:
// stored raw). Codecs: BloscLZ, LZ4 (OpenVDB's defaults in different versions) and zlib; byte shuffle undone per block
// (bit shuffle not supported).

const FLAG_SHUFFLE = 0x1, FLAG_MEMCPYED = 0x2, FLAG_BITSHUFFLE = 0x4, FLAG_DONT_SPLIT = 0x10;
const CODEC_BLOSCLZ = 0, CODEC_LZ4 = 1, CODEC_ZLIB = 3;
const BLOSCLZ_MAX_DISTANCE = 8191;

/**
 * BloscLZ block (Blosc's own LZ77 codec, FastLZ family): control byte < 32 = a literal run of ctrl + 1 bytes; else a
 * match of (ctrl >> 5) + 2 bytes (7 → extended by following bytes until one is not 255) at distance
 * ((ctrl & 31) << 8) + next byte + 1, or – that byte 255 and the high bits all set – a 16-bit distance + 8191 + 1.
 */
export function blosclzBlock(src, out, at, size) {
    let s = 0, d = at;
    const end = at + size;
    let ctrl = src[s++] & 31;
    for (;;) {
        if (ctrl >= 32) {
            let len = (ctrl >> 5) - 1;
            let ofs = (ctrl & 31) << 8;
            if (len === 6) { let code; do { code = src[s++]; len += code; } while (code === 255); }
            const code = src[s++];
            len += 3;
            let ref = d - ofs - code;
            if (code === 255 && ofs === (31 << 8)) {
                ofs = (src[s] << 8) + src[s + 1];
                s += 2;
                ref = d - ofs - BLOSCLZ_MAX_DISTANCE;
            }
            ref--;
            for (let k = 0; k < len; k++) out[d++] = out[ref++];   // may overlap
            if (s >= src.length || d >= end) break;
            ctrl = src[s++];
        } else {
            const n = ctrl + 1;
            out.set(src.subarray(s, s + n), d);
            s += n; d += n;
            if (s >= src.length || d >= end) break;
            ctrl = src[s++];
        }
    }
    return d - at;
}

/** LZ4 block (no frame): decode src into out[at, at + size) */
export function lz4Block(src, out, at, size) {
    let s = 0, d = at;
    const end = at + size;
    while (s < src.length) {
        const token = src[s++];
        let lit = token >> 4;
        if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
        out.set(src.subarray(s, s + lit), d);
        s += lit; d += lit;
        if (s >= src.length || d >= end) break;   // the last sequence has literals only
        const offset = src[s] | (src[s + 1] << 8);
        s += 2;
        let len = (token & 15) + 4;
        if ((token & 15) === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
        let from = d - offset;
        if (offset >= len) { out.copyWithin(d, from, from + len); d += len; }
        else for (let k = 0; k < len; k++) out[d++] = out[from++];   // overlapping copy
    }
    return d - at;
}

/**
 * @param {Uint8Array} frame
 * @param {(data: Uint8Array) => Uint8Array} unzlib  for zlib-coded blocks
 * @returns {Uint8Array} the uncompressed data
 */
export function bloscDecompress(frame, unzlib) {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const flags = frame[2], typesize = frame[3] || 1;
    const nbytes = dv.getUint32(4, true), blocksize = dv.getUint32(8, true);
    const out = new Uint8Array(nbytes);
    if (flags & FLAG_MEMCPYED) { out.set(frame.subarray(16, 16 + nbytes)); return out; }
    if (flags & FLAG_BITSHUFFLE) throw new Error('Blosc bit shuffle not supported');
    const codec = flags >> 5;
    if (codec !== CODEC_LZ4 && codec !== CODEC_ZLIB && codec !== CODEC_BLOSCLZ) throw new Error(`Blosc codec ${codec} not supported`);
    const nblocks = Math.ceil(nbytes / blocksize);
    const tmp = new Uint8Array(blocksize);
    for (let b = 0; b < nblocks; b++) {
        const bsize = Math.min(blocksize, nbytes - b * blocksize);
        const leftover = bsize < blocksize;   // the short last block is never split
        const streams = flags & FLAG_DONT_SPLIT || leftover ? 1 : typesize;
        const neblock = Math.floor(bsize / streams);
        let s = dv.getInt32(16 + 4 * b, true);
        const target = flags & FLAG_SHUFFLE ? tmp : out, base = flags & FLAG_SHUFFLE ? 0 : b * blocksize;
        for (let j = 0; j < streams; j++) {
            const csize = dv.getInt32(s, true);
            s += 4;
            const chunk = frame.subarray(s, s + csize);
            if (csize === neblock) target.set(chunk, base + j * neblock);
            else if (codec === CODEC_LZ4) lz4Block(chunk, target, base + j * neblock, neblock);
            else if (codec === CODEC_BLOSCLZ) blosclzBlock(chunk, target, base + j * neblock, neblock);
            else target.set(unzlib(chunk).subarray(0, neblock), base + j * neblock);
            s += csize;
        }
        if (flags & FLAG_SHUFFLE) {
            const n = Math.floor(bsize / typesize), o = b * blocksize;
            for (let i = 0; i < n; i++) for (let k = 0; k < typesize; k++) out[o + i * typesize + k] = tmp[k * n + i];
            for (let i = n * typesize; i < bsize; i++) out[o + i] = tmp[i];
        }
    }
    return out;
}
