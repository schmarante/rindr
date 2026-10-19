// Worker of the 3MF reader (3mf-parse.js): gets the file buffer (transferred), answers with the scene description and
// the geometry/texture buffers (transferred, no copies).
import { read3mf } from './3mf-parse.js';
import { readZip } from '../splat/splat-formats.js';

self.onmessage = async ({ data }) => {
    try {
        const scene = await read3mf(readZip(data.buffer, { paths: true }), (done, total) => self.postMessage({ type: 'progress', done, total }));
        const transfer = [];
        for (const parts of scene.geometries) for (const p of parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        // texture bytes may be views into the zip buffer (stored entries): own copies
        for (const tex of scene.textures) { tex.bytes = tex.bytes.slice(); transfer.push(tex.bytes.buffer); }
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
