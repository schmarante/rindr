// Worker: builds the cluster LOD of one mesh (cluster-lod.js) off the main thread.
import { buildClusterLod } from './cluster-lod.js';

self.onmessage = async ({ data }) => {
    try {
        const t0 = performance.now();
        const res = await buildClusterLod(data, (stage, info) => self.postMessage({ progress: { stage, ...info } }));
        res.ms = performance.now() - t0;
        const transfer = [res.offsets.buffer, res.spheres.buffer, res.lod.buffer, res.parent.buffer, res.level.buffer, res.indices.buffer];
        if (res.normals) transfer.push(res.normals.buffer);
        self.postMessage({ result: res }, transfer);
    } catch (err) {
        self.postMessage({ error: err?.message || String(err) });
    }
};
