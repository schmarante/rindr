// Worker of the .blend reader (blend-parse.js): gets the file buffer (transferred), answers with the scene description –
// geometry and packed images as typed arrays (transferred, no copies).
import { parseBlend } from './blend-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseBlend(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const g of scene.geometries) for (const p of g.parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        for (const im of scene.images) if (im.data) transfer.push(im.data.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
