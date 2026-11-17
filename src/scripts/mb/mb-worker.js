// Worker of the MB reader (mb-parse.js): gets the file bytes (transferred), answers with transforms, meshes (typed arrays,
// transferred) and materials.
import { parseMb } from './mb-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseMb(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const m of scene.meshes) for (const p of m.parts) for (const a of [p.positions, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
