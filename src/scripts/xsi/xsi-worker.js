// Worker of the .xsi reader (xsi-parse.js): gets the file bytes (transferred), answers with the model tree and the
// meshes' parts as typed arrays (transferred, no copies).
import { parseXsi } from './xsi-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseXsi(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const m of scene.meshes) for (const p of m.parts) for (const a of [p.positions, p.normals, p.uvs, p.colors, p.index]) if (a) transfer.push(a.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
