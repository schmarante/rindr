// Worker of the displacement (displace.js): one job at a time, buffers transferred both ways.
import { displace } from './displace.js';

self.onmessage = e => {
    const { id, job } = e.data;
    try {
        const r = displace(job);
        const transfer = [r.positions.buffer, r.normals.buffer, r.index.buffer];
        if (r.uvs) transfer.push(r.uvs.buffer);
        if (r.colors) transfer.push(r.colors.buffer);
        self.postMessage({ id, result: r }, transfer);
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
