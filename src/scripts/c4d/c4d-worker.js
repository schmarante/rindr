// Worker of the .c4d reader (c4d-parse.js): gets the file buffer (transferred), answers with the scene description –
// points, polygons, UVs, weights and track values as typed arrays (transferred, no copies).
import { parseC4d } from './c4d-parse.js';

self.onmessage = ({ data }) => {
    try {
        const scene = parseC4d(data.buffer, done => self.postMessage({ type: 'progress', done }));
        const transfer = [];
        for (const o of scene.objects) {
            for (const tag of o.tags) {
                for (const a of [tag.points, tag.polys, tag.uvs, tag.normals]) if (a) transfer.push(a.buffer);
                if (tag.joints) for (const j of tag.joints) for (const a of [j.points, j.weights]) if (a) transfer.push(a.buffer);
            }
            for (const t of o.tracks) transfer.push(t.times.buffer, t.values.buffer);
        }
        self.postMessage({ type: 'done', scene }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
