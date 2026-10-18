// Worker: rounded edges of one body (round-edges.js). In: { positions, index, tags, radius, fillet }; out: progress
// messages, then { parts: [[tag, positions, normals, index]], triangles } (buffers transferred) or { error }.
import { roundEdges } from './round-edges.js';

self.onmessage = ({ data }) => {
    try {
        const { parts, triangles } = roundEdges(data.positions, data.index, data.tags, {
            radius: data.radius, fillet: data.fillet,
            onProgress: f => self.postMessage({ progress: f }),
        });
        const list = [...parts].map(([tag, p]) => [tag, p.positions, p.normals, p.index]);
        self.postMessage({ parts: list, triangles }, list.flatMap(([, a, b, c]) => [a.buffer, b.buffer, c.buffer]));
    } catch (err) {
        self.postMessage({ error: err.message });
    }
};
