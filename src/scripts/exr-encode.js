// Minimal EXR writer (scanline, one part, layers by channel name "layer.R") – linear float images for compositing
// (light passes, docs/export-ki.md). Written after the open format description: header attributes, offset table,
// chunks of 16 scanlines, ZIP compression (bytes split into two halves, delta predictor, zlib via the browser's
// CompressionStream('deflate') – a chunk that does not shrink is stored as it is). Channels half or float, little endian.
// Large images: the layers are read in bands (read(y0, rows)), not held whole.
import { toHalf } from './light-mix.js';

const LINES = 16;          // scanlines per chunk (ZIP)
const BAND = LINES * 8;    // rows read per layer at a time
const TYPE = { half: 1, float: 2 };

const ascii = s => new TextEncoder().encode(s);
// channel names: plain ASCII (umlauts spelled out, other characters as _)
export function exrName(s) {
    return s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
        .replace(/ß/g, 'ss').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'layer';
}

class Bytes {
    constructor() { this.parts = []; this.length = 0; }
    push(u8) { this.parts.push(u8); this.length += u8.length; }
    u8(v) { this.push(new Uint8Array([v])); }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.push(b); }
    f32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.push(b); }
    str(s) { this.push(ascii(s)); this.u8(0); }
    concat() { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

function attribute(h, name, type, write) {
    const value = new Bytes();
    write(value);
    h.str(name);
    h.str(type);
    h.i32(value.length);
    for (const p of value.parts) h.push(p);
}

async function zlib(bytes) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

// ZIP preprocessing: even bytes to the first half, odd to the second, then each byte as the difference to the one before
function zipPrepare(raw) {
    const out = new Uint8Array(raw.length);
    const half = (raw.length + 1) >> 1;
    for (let i = 0, a = 0, b = half; i < raw.length; i += 2) {
        out[a++] = raw[i];
        if (i + 1 < raw.length) out[b++] = raw[i + 1];
    }
    let p = out[0];
    for (let i = 1; i < out.length; i++) {
        const v = out[i];
        out[i] = (v - p + 384) & 255;
        p = v;
    }
    return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {{ name: string, channels: { name: string, type?: 'half'|'float', source: number }[], read: (y0: number, rows: number) => Promise<Float32Array> }[]} layers
 *   each layer: its channel names (full, e.g. "Key.R") with the component they take from read()'s RGBA rows (source 0–3)
 * @param {{ onProgress?: (p: number) => void, compression?: 'zip'|'none' }} [options]
 * @returns {Promise<Blob>}
 */
export async function encodeExr(width, height, layers, { onProgress, compression = 'zip' } = {}) {
    // channels sorted by name (the format wants them in that order), each knows its layer and component
    const channels = [];
    layers.forEach((layer, l) => {
        for (const c of layer.channels) channels.push({ name: c.name, type: c.type || 'half', layer: l, source: c.source });
    });
    channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const zip = compression === 'zip';
    const linesPerChunk = zip ? LINES : 1;
    const chunks = Math.ceil(height / linesPerChunk);
    const longNames = channels.some(c => c.name.length > 31);

    const h = new Bytes();
    h.push(new Uint8Array([0x76, 0x2f, 0x31, 0x01]));
    h.i32(2 | (longNames ? 0x400 : 0));
    attribute(h, 'channels', 'chlist', v => {
        for (const c of channels) {
            v.str(c.name);
            v.i32(TYPE[c.type]);
            v.push(new Uint8Array([0, 0, 0, 0]));   // pLinear, reserved
            v.i32(1);
            v.i32(1);
        }
        v.u8(0);
    });
    attribute(h, 'compression', 'compression', v => v.u8(zip ? 3 : 0));
    attribute(h, 'dataWindow', 'box2i', v => { v.i32(0); v.i32(0); v.i32(width - 1); v.i32(height - 1); });
    attribute(h, 'displayWindow', 'box2i', v => { v.i32(0); v.i32(0); v.i32(width - 1); v.i32(height - 1); });
    attribute(h, 'lineOrder', 'lineOrder', v => v.u8(0));
    attribute(h, 'pixelAspectRatio', 'float', v => v.f32(1));
    attribute(h, 'screenWindowCenter', 'v2f', v => { v.f32(0); v.f32(0); });
    attribute(h, 'screenWindowWidth', 'float', v => v.f32(1));
    h.u8(0);
    const header = h.concat();

    const lineBytes = channels.reduce((n, c) => n + width * (c.type === 'float' ? 4 : 2), 0);
    const parts = [];
    const offsets = new BigUint64Array(chunks);
    let position = header.length + chunks * 8;
    for (let y0 = 0; y0 < height; y0 += BAND) {
        const rows = Math.min(BAND, height - y0);
        const bands = [];
        for (const layer of layers) bands.push(await layer.read(y0, rows));
        for (let c0 = 0; c0 < rows; c0 += linesPerChunk) {
            const lines = Math.min(linesPerChunk, rows - c0);
            const raw = new Uint8Array(lineBytes * lines);
            const view = new DataView(raw.buffer);
            let o = 0;
            for (let r = 0; r < lines; r++) {
                const row = c0 + r;
                for (const c of channels) {
                    const data = bands[c.layer];
                    let s = (row * width) * 4 + c.source;
                    if (c.type === 'float') {
                        for (let x = 0; x < width; x++, s += 4, o += 4) view.setFloat32(o, data[s], true);
                    } else {
                        for (let x = 0; x < width; x++, s += 4, o += 2) view.setUint16(o, toHalf(data[s]), true);
                    }
                }
            }
            let payload = raw;
            if (zip) {
                const packed = await zlib(zipPrepare(raw));
                if (packed.length < raw.length) payload = packed;
            }
            const chunk = new Uint8Array(8 + payload.length);
            const cv = new DataView(chunk.buffer);
            cv.setInt32(0, y0 + c0, true);
            cv.setInt32(4, payload.length, true);
            chunk.set(payload, 8);
            offsets[(y0 + c0) / linesPerChunk] = BigInt(position);
            position += chunk.length;
            parts.push(chunk);
        }
        onProgress?.(Math.min((y0 + rows) / height, 1));
    }
    const table = new Uint8Array(offsets.buffer);
    // the offsets are little endian (BigUint64Array uses the platform's order – every browser platform is little endian)
    return new Blob([header, table, ...parts], { type: 'image/x-exr' });
}
