// Zip writing: BCF issues (bcf/bcf-format.js), material packages (materialx.js). Reading: readZip in
// splat/splat-formats.js.
import { crc32 } from './png-encode.js';

/** zip without compression (PNGs are compressed already, XML/JSON are small); UTF-8 names. entries: { name, data: Uint8Array } */
export function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBytes = enc.encode(name);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);   // UTF-8 names
        lv.setUint16(8, 0, true);        // stored
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        cd.set(nameBytes, 46);
        parts.push(local, data);
        central.push(cd);
        offset += local.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    for (const part of [...parts, ...central, end]) { out.set(part, p); p += part.length; }
    return out;
}
