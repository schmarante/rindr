// Worker of the LWO reader (lwo-parse.js): gets the file bytes (transferred), answers with the layers and their
// parts as typed arrays (transferred, no copies).
import { parseLwo } from './lwo-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseLwo(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const l of scene.layers) for (const p of l.parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
