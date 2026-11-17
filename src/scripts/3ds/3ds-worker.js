// Worker of the 3DS reader (3ds-parse.js): gets the file bytes (transferred), answers with objects, nodes and materials
// (typed arrays transferred, no copies).
import { parse3ds } from './3ds-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parse3ds(new Uint8Array(data.buffer), done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const o of scene.objects) for (const p of o.parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
