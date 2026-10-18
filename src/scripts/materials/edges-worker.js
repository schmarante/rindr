// Worker for the rounded-edge data (edges-build.js): one geometry per message, the result's arrays are transferred.
import { buildEdgeData } from './edges-build.js';

self.onmessage = ({ data: { id, input } }) => {
    try {
        const result = buildEdgeData(input);
        const transfer = [result.data?.buffer, result.index?.buffer].filter(Boolean);
        self.postMessage({ id, result }, transfer);
    } catch (err) {
        self.postMessage({ id, error: String(err?.message || err) });
    }
};
