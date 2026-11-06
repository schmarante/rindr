// Worker for hair and bristles (hair-field.js, used by hair.js): the fill mode's ray test through the shape (a BVH of the
// mesh), the fibres, and the BVH of their pieces for the path tracer (built on the main thread it froze the page);
// arrays transferred, the index comes back in the BVH's order; progress in between (fibres 0…0.4, BVH 0.4…1)
import { BufferAttribute, BufferGeometry, Vector3, DoubleSide, Mesh, MeshBasicMaterial, Raycaster } from 'three';
import { MeshBVH, SAH, acceleratedRaycast } from 'three-mesh-bvh';
import { hairFibres } from './hair-field.js';

Mesh.prototype.raycast = acceleratedRaycast;

self.onmessage = ({ data }) => {
    try {
        let last = -1;
        const progress = f => {
            if (f - last < 0.02) return;
            last = f;
            self.postMessage({ id: data.id, progress: f });
        };
        // fill: every hit along a ray through the shape (both sides of its faces), nearest first
        let raycastAll = null;
        if (data.mode === 'fill') {
            const shape = new BufferGeometry();
            shape.setAttribute('position', new BufferAttribute(data.positions, 3));
            if (data.index) shape.setIndex(new BufferAttribute(data.index, 1));
            shape.boundsTree = new MeshBVH(shape, { strategy: SAH });
            const mesh = new Mesh(shape, new MeshBasicMaterial({ side: DoubleSide }));
            const raycaster = new Raycaster();
            raycaster.firstHitOnly = false;
            const o = new Vector3(), d = new Vector3();
            raycastAll = (origin, dir) => {
                raycaster.set(o.fromArray(origin), d.fromArray(dir));
                const hits = raycaster.intersectObject(mesh, false).map(h => h.distance).sort((a, b) => a - b);
                // a ray through an edge meets two triangles at the same distance – one hit each
                return hits.filter((t, i) => i === 0 || t - hits[i - 1] > 1e-7 * (1 + t));
            };
        }
        const h = hairFibres({ ...data, raycastAll }, f => progress(f * 0.4));
        let roots = [];
        if (h.pieces > 0) {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(h.positions, 3));
            geometry.setIndex(new BufferAttribute(h.index, 1));
            roots = MeshBVH.serialize(new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5, onProgress: f => progress(0.4 + f * 0.6) }), { cloneBuffers: false }).roots;
        }
        self.postMessage({ id: data.id, hair: { ...h, roots } },
            [h.positions.buffer, h.normals.buffer, h.tangents.buffer, h.uvs.buffer, h.colors.buffer, h.weights.buffer, h.index.buffer, ...roots]);
    } catch (err) {
        self.postMessage({ id: data.id, error: err.message });
    }
};
