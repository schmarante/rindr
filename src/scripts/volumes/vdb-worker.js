// Worker of dropped VDB files (.vdb, .nvdb): grids read and resampled to the volume the GPU gets (vdb-import.js).
// In: { main: Blob, maxVoxels }. Out: progress messages, then { type: 'done', volume, grids } or { type: 'error' }.
import { unzlibSync } from 'three/addons/libs/fflate.module.js';
import { readVdbGrids, vdbVolume } from './vdb-import.js';

self.onmessage = async ({ data }) => {
    try {
        const bytes = new Uint8Array(await data.main.arrayBuffer());
        const sources = readVdbGrids(bytes, unzlibSync);
        const grids = sources.map(s => ({ name: s.name, type: s.unsupported || 'float', gridClass: s.gridClass || '' }));
        self.postMessage({ type: 'progress', phase: 'grids', grids });
        let last = 0;
        const volume = vdbVolume(sources, data.maxVoxels, {
            onProgress: f => { const now = performance.now(); if (now - last > 100) { last = now; self.postMessage({ type: 'progress', phase: 'volume', fraction: f }); } },
        });
        const transfer = [volume.density.buffer, volume.blocks.buffer];
        if (volume.temperature) transfer.push(volume.temperature.buffer);
        self.postMessage({ type: 'done', volume, grids }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
