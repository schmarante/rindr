// Cluster LOD of the model geometries (cluster-lod.js) – built in the background after loading, used by
// render-batcher.js: every batched instance is drawn with the coarsest version of its geometry whose error stays
// below LOD.threshold pixels on screen (camera distance).
//
// A version ("cut") is the set of clusters with lodError ≤ E < parentError for an allowed error E (own units) –
// consistent across the whole geometry, no cracks. All levels index the original vertex buffer, so a cut is just
// another index buffer: its BufferGeometry shares the source's attributes (positions, normals, UVs, tangents → the
// real material draws it, same shader) and only owns its index. Triangle soups were welded for the simplification
// (cluster-lod.js): their cuts index the first vertex at each position and get smooth normals of their own.
//
// Cuts are cached per bucket of E (BUCKETS per octave, rounded down = a little finer than needed) and dropped
// when unused for a while (trim). Cut geometries are never disposed with their attributes: three.js deletes the GPU
// buffers of all attributes of a disposed geometry – the source still draws with them.
import * as THREE from 'three/webgpu';
import { LOD } from '../config.js';
import { memoryBudget, workersWithin } from '../memory-budget.js';
import { debugLog } from '../log.js';

const BUCKETS = 2;               // cuts per octave of the allowed error (each new cut costs a render object)
const BYTES_PER_TRIANGLE = 48;   // LOD data in RAM (indices of all levels ~2×, clusters) + cuts on the GPU
const TRIM_FRAMES = 1200;        // cut unused for this many frames → dropped (render-batcher drops its meshes at 300)

export class ClusterLods {
    constructor() {
        this.entries = new Map();   // source geometry → entry (built)
        this.queue = [];            // geometries waiting
        this.queued = new Set();    // waiting or building
        this.failed = new WeakSet();
        this.onReady = null;        // called when entries were added (render-batcher picks them up)
        this.stats = { built: 0, failed: 0, triangles: 0, buildMs: 0, cuts: 0 };
        this._workers = 0;
        this._bytes = 0;
        this._trimmed = 0;
    }

    get busy() {
        return this.queued.size > 0;
    }

    /** built LOD of a geometry or undefined. Positions changed since the build (animation.js writes the settled pose of
     *  deformed parts into the geometry) → the simplification no longer fits: dropped and built anew in the background */
    get(geometry) {
        const entry = this.entries.get(geometry);
        if (entry && entry.version !== geometry.getAttribute('position').version) {
            this._drop(geometry);
            this.want(geometry);
            return undefined;
        }
        return entry;
    }

    /** does the entry still fit its geometry? (cheap – per batch and frame) */
    fresh(entry) {
        return entry.version === entry.geometry.getAttribute('position').version;
    }

    /** would building the LOD of these geometries (unique triangles) stay within the memory budget? */
    fits(triangles) {
        return this._bytes + triangles * BYTES_PER_TRIANGLE < memoryBudget() * LOD.memoryShare;
    }

    /** queue a geometry (indexed, ≥ LOD.minPartTriangles) – built in the background, largest first */
    want(geometry) {
        if (this.entries.has(geometry) || this.queued.has(geometry) || this.failed.has(geometry)) return;
        const pos = geometry.getAttribute('position');
        if (!geometry.index || !pos?.array?.length || pos.isInterleavedBufferAttribute || pos.itemSize !== 3) return;
        if (geometry.index.count / 3 < LOD.minPartTriangles) return;
        this.queued.add(geometry);
        this.queue.push(geometry);
        this._bytes += geometry.index.count / 3 * BYTES_PER_TRIANGLE;
        geometry.addEventListener('dispose', this._onDispose ??= e => this._drop(e.target));
        this._pump();
    }

    _pump() {
        // background work: half the cores at most, within the memory budget (meshoptimizer copies per worker)
        const max = workersWithin(256 * 2 ** 20, 0, Math.max(1, Math.min(LOD.maxWorkers, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
        while (this._workers < max && this.queue.length) {
            this._workers++;
            this._run().finally(() => { this._workers--; });
        }
    }

    async _run() {
        const worker = new Worker(new URL('./lod-worker.js', import.meta.url), { type: 'module', name: 'cluster-lod' });
        try {
            while (this.queue.length) {
                // largest first (the ones that save most)
                let k = 0;
                for (let i = 1; i < this.queue.length; i++) if (this.queue[i].index.count > this.queue[k].index.count) k = i;
                const geometry = this.queue.splice(k, 1)[0];
                if (!this.queued.has(geometry)) continue;   // disposed meanwhile
                const t0 = performance.now();
                try {
                    const { lod, version } = await build(worker, geometry);
                    if (!this.queued.has(geometry)) continue;
                    this.queued.delete(geometry);
                    const entry = makeEntry(geometry, lod);
                    entry.version = version;
                    this.entries.set(geometry, entry);
                    this.stats.built++;
                    this.stats.triangles += geometry.index.count / 3;
                    this.stats.buildMs += performance.now() - t0;
                    this.onReady?.();
                } catch (err) {
                    this.queued.delete(geometry);
                    this.failed.add(geometry);
                    this.stats.failed++;
                    console.warn('[LOD] build failed:', err.message);
                }
            }
        } finally {
            worker.terminate();
            if (!this.queued.size) debugLog('[LOD] built', { ...this.stats, buildMs: Math.round(this.stats.buildMs) });
        }
    }

    /** bucket of an allowed error E (units of the geometry); ≤ entry.sourceBucket = the source geometry */
    bucket(entry, E) {
        return E >= entry.minError ? Math.floor(Math.log2(E) * BUCKETS) : entry.sourceBucket;
    }

    /** geometry of a bucket: the source itself when no cluster can be coarser, otherwise a cut. frame: marks it used (trim) */
    cut(entry, b, frame) {
        if (b <= entry.sourceBucket) return entry.geometry;
        let rec = entry.cuts.get(b);
        if (!rec) {
            rec = makeCut(entry, 2 ** (b / BUCKETS));
            entry.cuts.set(b, rec);
            if (rec.fresh) this.stats.cuts++;
        }
        rec.used = frame;
        return rec.geometry;
    }

    /** drop cuts not used for TRIM_FRAMES frames (checked every few seconds) */
    trim(frame) {
        if (frame - this._trimmed < 300) return;
        this._trimmed = frame;
        for (const entry of this.entries.values()) {
            for (const [b, rec] of entry.cuts) {
                if (frame - rec.used <= TRIM_FRAMES) continue;
                entry.cuts.delete(b);
                // same geometry under another bucket still in use → keep it
                if (rec.geometry === entry.geometry || [...entry.cuts.values()].some(r => r.geometry === rec.geometry)) continue;
                releaseCut(entry, rec.geometry);
                this.stats.cuts--;
            }
        }
    }

    _drop(geometry) {
        geometry.removeEventListener('dispose', this._onDispose);
        if (this.queued.delete(geometry)) {
            const i = this.queue.indexOf(geometry);
            if (i >= 0) this.queue.splice(i, 1);
        }
        const entry = this.entries.get(geometry);
        this._bytes -= geometry.index ? geometry.index.count / 3 * BYTES_PER_TRIANGLE : 0;
        if (!entry) return;
        this.entries.delete(geometry);
        const done = new Set();
        for (const rec of entry.cuts.values()) {
            if (rec.geometry === geometry || done.has(rec.geometry)) continue;
            done.add(rec.geometry);
            releaseCut(entry, rec.geometry);
            this.stats.cuts--;
        }
        this.stats.built--;
        this.stats.triangles -= geometry.index ? geometry.index.count / 3 : 0;
    }
}

// resolves the LOD + the position version it was built from
function build(worker, geometry) {
    let version = 0;
    return new Promise((resolve, reject) => {
        worker.onmessage = ({ data: msg }) => {
            if (msg.progress) return;
            if (msg.error) reject(new Error(msg.error)); else resolve({ lod: msg.result, version });
        };
        worker.onerror = e => reject(new Error(e.message || 'LOD worker crashed'));
        const pos = geometry.getAttribute('position');
        version = pos.version;
        const positions = new Float32Array(pos.array.subarray(0, pos.count * 3));
        const indices = Uint32Array.from(geometry.index.array.subarray(0, geometry.index.count));
        const nor = geometry.getAttribute('normal');
        const normals = nor && !nor.isInterleavedBufferAttribute && nor.itemSize === 3 ? new Float32Array(nor.array.subarray(0, nor.count * 3)) : null;
        worker.postMessage({ positions, indices, normals }, normals ? [positions.buffer, indices.buffer, normals.buffer] : [positions.buffer, indices.buffer]);
    });
}

function makeEntry(geometry, lod) {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    // smallest error at which any cluster gets coarser (below: the source geometry)
    let minError = Infinity;
    for (let c = 0; c < lod.count; c++) if (lod.level[c] === 0) minError = Math.min(minError, lod.parent[c * 5 + 4]);
    return {
        geometry, lod, minError, sourceBucket: Number.isFinite(minError) ? Math.floor(Math.log2(minError) * BUCKETS) - 1 : Infinity,
        cuts: new Map(), byContent: new Map(),
        // welded triangle soup: its own normals for all cuts (they index the first vertex at each position)
        normal: lod.normals ? new THREE.BufferAttribute(lod.normals, 3) : null,
        triangles: geometry.index.count / 3,
    };
}

// clusters with lodError ≤ e < parentError → one index buffer (clusters in order, their ranges are contiguous)
function makeCut(entry, e) {
    const { lod } = entry;
    let tris = 0, hash = 0, coarse = false;
    const ids = [];
    for (let c = 0; c < lod.count; c++) {
        if (lod.lod[c * 5 + 4] <= e && lod.parent[c * 5 + 4] > e) {
            ids.push(c);
            tris += lod.offsets[c * 2 + 1];
            hash = (Math.imul(hash, 31) + c) | 0;
            if (lod.level[c] > 0) coarse = true;
        }
    }
    if (!coarse || !ids.length) return { geometry: entry.geometry, used: 0 };
    const sig = `${ids.length}/${tris}/${hash}`;
    const known = entry.byContent.get(sig);
    if (known) return { geometry: known, used: 0 };
    const index = new Uint32Array(tris * 3);
    let o = 0;
    for (let k = 0; k < ids.length;) {
        // run of consecutive clusters = one contiguous range
        let j = k;
        while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
        const from = lod.offsets[ids[k] * 2] * 3, to = (lod.offsets[ids[j] * 2] + lod.offsets[ids[j] * 2 + 1]) * 3;
        index.set(lod.indices.subarray(from, to), o);
        o += to - from;
        k = j + 1;
    }
    const src = entry.geometry;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, name === 'normal' && entry.normal ? entry.normal : attr);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = src.boundingSphere;
    g.boundingBox = src.boundingBox;
    g.name = `${src.name || 'geometry'} LOD`;
    g.userData.lodSig = sig;
    g.userData.lodSource = src;   // per-geometry data keyed by the source (edge rounding: materials/edges.js)
    g.userData.lodTriangles = tris;
    entry.byContent.set(sig, g);
    return { geometry: g, used: 0, fresh: true };
}

// free the cut's own index buffer only (shared attributes are removed first – see the note at the top)
function releaseCut(entry, g) {
    entry.byContent.delete(g.userData.lodSig);
    for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
    g.dispose();
}
