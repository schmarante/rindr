// Rounded edges per object (properties panel): the meshes below a scene-graph node get rounded geometry
// (round-edges.js in round-edges-worker.js), the original stays for radius 0 / undo.
//  - a body = the meshes with the same world matrix (a solid of several colour groups is several meshes): rounded
//    as one, the result is split back per mesh (tags)
//  - meshes sharing a geometry (instances of the same part) share the rounded geometry too – the rounding of a part
//    applies to all its instances
//  - radius in scene units (mm for CAD), converted into the geometry's own units by the mesh scale
//  - setting kept on the node (userData.roundEdges = { radius, fillet })
import * as THREE from 'three/webgpu';
import { boxUVs, UV_TILE, buildGeometryBVHs } from './step-importer.js';

export class EdgeRounding {
    /**
     * @param {{ modelMeshes: () => THREE.Mesh[], makeGeometry: (g) => THREE.BufferGeometry,
     *           onReplaced: () => void, onProgress: (fraction: number) => void }} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.busy = Promise.resolve();
    }

    /** setting of a node: { radius, fillet } (radius 0 = off) */
    get(object) {
        return object?.userData.roundEdges || { radius: 0, fillet: true };
    }

    /** round (radius > 0) or restore (0) the meshes below object; runs after a running one */
    set(object, { radius, fillet = true }) {
        const run = this.busy.then(() => this._apply(object, Math.max(0, radius || 0), fillet));
        this.busy = run.catch(() => {});
        return run;
    }

    async _apply(object, radius, fillet) {
        const all = this.ctx.modelMeshes();
        const own = new Set();
        object.traverse(o => { if (o.isMesh) own.add(o); });
        const meshes = all.filter(m => own.has(m));
        if (radius > 0) object.userData.roundEdges = { radius, fillet }; else delete object.userData.roundEdges;
        const original = m => m.userData.roundOriginal || m.geometry;
        const replace = new Map();   // original geometry → new geometry (or itself = restore)
        if (radius <= 0) {
            for (const m of meshes) replace.set(original(m), original(m));
        } else {
            object.updateWorldMatrix(true, true);
            // bodies: meshes with the same world matrix; the same set of geometries is rounded once (instances)
            const bodies = new Map();
            for (const m of meshes) {
                const k = m.matrixWorld.elements.map(v => Math.round(v * 1e6)).join(',');
                if (!bodies.has(k)) bodies.set(k, []);
                bodies.get(k).push(m);
            }
            // the same set of geometries once (instances); bodies in parallel workers, the biggest first
            const jobs = new Map();
            for (const body of bodies.values()) {
                const geometries = [...new Set(body.map(original))];
                const key = geometries.map(g => g.uuid).sort().join('|');
                if (!jobs.has(key)) jobs.set(key, { geometries, scale: body[0].matrixWorld.getMaxScaleOnAxis() || 1 });
            }
            const list = [...jobs.values()].sort((a, b) => size(b.geometries) - size(a.geometries));
            const progress = new Array(list.length).fill(0);
            const report = () => this.ctx.onProgress(progress.reduce((s, f) => s + f, 0) / list.length);
            let next = 0;
            const run = async () => {
                while (next < list.length) {
                    const j = next++, { geometries, scale } = list[j];
                    const parts = await roundBody(geometries, radius / scale, fillet, f => { progress[j] = f * 0.9; report(); });
                    const data = geometries.map((g, i) => {
                        const p = parts.get(i);
                        return p ? { positions: p.positions, normals: p.normals, index: p.index, uvs: boxUVs(p.positions, p.normals, UV_TILE / scale) } : null;
                    });
                    await buildGeometryBVHs(data.filter(Boolean));
                    geometries.forEach((g, i) => { if (data[i]) replace.set(g, this.ctx.makeGeometry(data[i])); });
                    progress[j] = 1;
                    report();
                }
            };
            const workers = Math.max(1, Math.min(list.length, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
            await Promise.all(Array.from({ length: workers }, run));
        }
        // swap on every model mesh using one of the geometries (instances elsewhere in the model too)
        const dropped = new Set();
        for (const m of all) {
            const orig = original(m), next = replace.get(orig);
            if (!next || next === m.geometry) continue;
            if (m.geometry !== orig) dropped.add(m.geometry);
            m.geometry = next;
            if (next === orig) delete m.userData.roundOriginal; else m.userData.roundOriginal = orig;
        }
        for (const m of all) dropped.delete(m.geometry);
        dropped.forEach(g => { g.boundsTree = null; g.dispose(); });
        this.ctx.onReplaced();
    }
}

const size = geometries => geometries.reduce((s, g) => s + (g.index ? g.index.count : g.attributes.position.count), 0);

// one body in the worker: geometries (same space) → Map(tag → { positions, normals, index })
function roundBody(geometries, radius, fillet, onProgress) {
    let count = 0, tris = 0;
    for (const g of geometries) { count += g.attributes.position.count; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
    const positions = new Float32Array(count * 3), index = new Uint32Array(tris * 3), tags = new Uint32Array(tris);
    let v = 0, t = 0;
    geometries.forEach((g, gi) => {
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { positions[(v + i) * 3] = p.getX(i); positions[(v + i) * 3 + 1] = p.getY(i); positions[(v + i) * 3 + 2] = p.getZ(i); }
        const n = g.index ? g.index.count : p.count;
        for (let i = 0; i < n; i++) index[t * 3 + i] = v + (g.index ? g.index.getX(i) : i);
        tags.fill(gi, t, t + n / 3);
        v += p.count;
        t += n / 3;
    });
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./round-edges-worker.js', import.meta.url), { type: 'module', name: 'round-edges' });
        worker.onmessage = ({ data }) => {
            if (data.progress !== undefined) { onProgress(data.progress); return; }
            worker.terminate();
            if (data.error) { reject(new Error(data.error)); return; }
            resolve(new Map(data.parts.map(([tag, positions, normals, index]) => [tag, { positions, normals, index }])));
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
        worker.postMessage({ positions, index, tags, radius, fillet }, [positions.buffer, index.buffer, tags.buffer]);
    });
}
