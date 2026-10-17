// Worker for the grass blades (grass-field.js, used by grass.js): the blades and their BVH (the path tracer needs one per
// geometry – built on the main thread it froze the page for seconds); arrays transferred, the index comes back in the
// BVH's order; progress messages in between (blades 0…0.2, BVH 0.2…1 – the BVH takes most of the time)
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import { grassBlades } from './grass-field.js';

self.onmessage = ({ data }) => {
    try {
        let last = -1;
        const progress = f => {
            if (f - last < 0.02) return;
            last = f;
            self.postMessage({ id: data.id, progress: f });
        };
        const g = grassBlades(data, f => progress(f * 0.2));
        let roots = [];
        if (g.blades > 0) {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(g.positions, 3));
            geometry.setIndex(new BufferAttribute(g.index, 1));
            roots = MeshBVH.serialize(new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5, onProgress: f => progress(0.2 + f * 0.8) }), { cloneBuffers: false }).roots;
        }
        self.postMessage({ id: data.id, grass: { ...g, roots } }, [g.positions.buffer, g.normals.buffer, g.colors.buffer, g.index.buffer, ...roots]);
    } catch (err) {
        self.postMessage({ id: data.id, error: err.message });
    }
};
