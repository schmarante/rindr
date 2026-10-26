// Minimal PSD writer, 32 bit per channel (linear float) with layers – written after the open format description: header,
// colour mode data with the HDR toning settings (an image editor writes them in every 32-bit file – without them it
// refused the file as "not compatible"), the resolution as the only image resource, layers in the 32-bit layer block ('Lr32' in the
// additional layer information; the classic layer info stays empty, as image editors write 16/32-bit files), merged
// image at the end. Like the files an image editor writes in 32 bit: layer channels "ZIP with prediction" (each row's
// float bytes in four planes, delta along the row, zlib via CompressionStream('deflate')), blending ranges per layer,
// the merged image raw. Big endian. Only 32 bit makes the light layers add up to the image: in 8/16 bit the layers would
// be sRGB and added too bright. (The first version – ZIP without prediction, no blending ranges, no resources – did not
// open in an image editor.)
// Layers are read one at a time (read(): Float32Array RGBA, rows top down) – the file is assembled from compressed parts.

const enc = new TextEncoder();

class Bytes {
    constructor() { this.parts = []; this.length = 0; }
    push(u8) { this.parts.push(u8); this.length += u8.length; }
    u8(v) { this.push(new Uint8Array([v])); }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); this.push(b); }
    i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); this.push(b); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); this.push(b); }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.push(b); }
    ascii(s) { this.push(enc.encode(s)); }
    pad(multiple, from = 0) { const n = (multiple - ((this.length - from) % multiple)) % multiple; if (n) this.push(new Uint8Array(n)); }
}

// HDR toning settings ('hdrt': method "Linear", 'hdra': its parameters) – the defaults an image editor writes into the
// colour mode data of a 32-bit file
const HDR_TONING = new Uint8Array([
    0x68, 0x64, 0x72, 0x74, 0x00, 0x00, 0x00, 0x03, 0x3e, 0x6b, 0x85, 0x1f, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x07,
    0x00, 0x4c, 0x00, 0x69, 0x00, 0x6e, 0x00, 0x65, 0x00, 0x61, 0x00, 0x72, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0x00, 0xff, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x80, 0x00, 0x00, 0x68, 0x64, 0x72, 0x61, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x00, 0x41, 0xa0, 0x00, 0x00, 0x41, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x3f, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

async function zlib(bytes) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

// one channel of an RGBA float image as big-endian float rows
function channelBytes(rgba, width, height, component, map = v => v) {
    const out = new Uint8Array(width * height * 4);
    const view = new DataView(out.buffer);
    for (let i = 0, o = 0; i < width * height; i++, o += 4) view.setFloat32(o, map(rgba[i * 4 + component]));
    return out;
}

// "ZIP with prediction" for 32 bit: per row the samples' bytes as four planes (all first bytes, all second …), then
// each byte as the difference to the one before along the row (mod 256)
function predict32(bytes, width, height) {
    const out = new Uint8Array(bytes.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
        const base = y * row;
        for (let x = 0; x < width; x++) {
            for (let k = 0; k < 4; k++) out[base + k * width + x] = bytes[base + x * 4 + k];
        }
        for (let i = row - 1; i > 0; i--) out[base + i] = (out[base + i] - out[base + i - 1]) & 255;
    }
    return out;
}

// layer name: Pascal string (max. 255 bytes, padded to 4 with the length byte) + the full name as unicode ('luni')
function nameBlocks(extra, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255);
    const start = extra.length;
    extra.u8(ascii.length);
    extra.ascii(ascii);
    extra.pad(4, start);
    const chars = [...name].map(c => c.charCodeAt(0));
    extra.ascii('8BIMluni');
    const length = 4 + chars.length * 2;
    extra.u32(length + ((4 - length % 4) % 4));
    extra.u32(chars.length);
    for (const c of chars) extra.u16(c);
    extra.pad(4, start);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {{ name: string, blend?: 'add'|'normal', hidden?: boolean, read: () => Promise<Float32Array> }[]} layers bottom first
 * @param {() => Promise<Float32Array>} merged the composite image (RGBA float)
 * @param {{ onProgress?: (p: number, step?: { name?: string, n?: number, total?: number, merged?: boolean }) => void }} [options]
 *   step: the layer about to be written (or the composite image)
 * @returns {Promise<Blob>}
 */
export async function encodePsd(width, height, layers, merged, { onProgress } = {}) {
    // channel data per layer: transparency (-1) and R, G, B – compressed
    const records = [];
    for (let l = 0; l < layers.length; l++) {
        const layer = layers[l];
        onProgress?.(l / (layers.length + 1), { name: layer.name, n: l + 1, total: layers.length });
        const rgba = await layer.read();
        const channels = [];
        for (const [id, component] of [[-1, 3], [0, 0], [1, 1], [2, 2]]) {
            // transparency 0…1 as float like the colour channels
            const data = await zlib(predict32(channelBytes(rgba, width, height, component, id === -1 ? v => Math.min(Math.max(v, 0), 1) : v => v), width, height));
            channels.push({ id, data });
        }
        records.push({ layer, channels });
    }

    // layer info (inside 'Lr32')
    const info = new Bytes();
    info.i16(records.length);
    for (const { layer, channels } of records) {
        info.i32(0); info.i32(0); info.i32(height); info.i32(width);   // top, left, bottom, right
        info.u16(channels.length);
        for (const c of channels) { info.i16(c.id); info.u32(2 + c.data.length); }
        info.ascii('8BIM');
        info.ascii(layer.blend === 'add' ? 'lddg' : 'norm');
        info.u8(255);                          // opacity
        info.u8(0);                            // clipping: base
        info.u8(0x08 | (layer.hidden ? 0x02 : 0x00));   // flags: bit 1 = hidden, bit 3 = bit 4 is meaningful
        info.u8(0);
        const extra = new Bytes();
        extra.u32(0);   // no layer mask
        // blending ranges: grey and each of R, G, B, A – source and destination 0…255 (no restriction)
        extra.u32(40);
        for (let i = 0; i < 10; i++) extra.push(new Uint8Array([0, 0, 255, 255]));
        nameBlocks(extra, layer.name);
        info.u32(extra.length);
        for (const p of extra.parts) info.push(p);
    }
    for (const { channels } of records) {
        for (const c of channels) { info.u16(3); info.push(c.data); }   // 3 = ZIP with prediction
    }
    info.pad(4);

    const file = new Bytes();
    // header
    file.ascii('8BPS');
    file.u16(1);
    file.push(new Uint8Array(6));
    file.u16(3);          // channels of the merged image
    file.u32(height);
    file.u32(width);
    file.u16(32);         // bits per channel
    file.u16(3);          // RGB
    // colour mode data: the HDR toning settings
    file.u32(HDR_TONING.length);
    file.push(HDR_TONING);
    // image resources: the resolution (1005) – 72 dpi horizontally and vertically, shown as pixels per inch
    const res = new Bytes();
    res.ascii('8BIM');
    res.u16(1005);
    res.u16(0);           // empty name (padded to even)
    res.u32(16);
    for (let i = 0; i < 2; i++) { res.u32(72 << 16); res.u16(1); res.u16(1); }
    file.u32(res.length);
    for (const p of res.parts) file.push(p);
    // layer and mask information: empty classic layer info, no global mask, the 32-bit layers. No 'Mt32' block (the image
    // editor writes an empty one, but then expects a transparency channel in the merged image – "unexpected end of file")
    file.u32(4 + 4 + 12 + info.length);
    file.u32(0);
    file.u32(0);
    file.ascii('8BIMLr32');
    file.u32(info.length);
    for (const p of info.parts) file.push(p);
    // merged image: raw, planar R, G, B
    onProgress?.(layers.length / (layers.length + 1), { merged: true });
    const composite = await merged();
    file.u16(0);
    for (const component of [0, 1, 2]) file.push(channelBytes(composite, width, height, component));
    onProgress?.(1);
    return new Blob(file.parts, { type: 'application/octet-stream' });
}
