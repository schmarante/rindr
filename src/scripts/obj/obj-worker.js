// Worker of the .obj reader (obj-parse.js): gets the file bytes (transferred), answers with the groups and their parts as
// typed arrays (transferred, no copies).
import { parseObj } from './obj-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseObj(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const g of scene.groups) for (const p of g.parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
