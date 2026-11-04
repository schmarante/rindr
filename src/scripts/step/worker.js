// Web worker for the STEP import.
// Messages:
//   {type:'scan', bytes, from, stop, first} -> index of one part of the file (scanEntities; large files, all workers)
//   {type:'index', bytes, shared, parts?}  -> index + product structure (one worker only; parts: the 'scan' results,
//                                             checked and joined – indexFromParts; without the per-solid details –
//                                             those come from all workers with 'solids')
//   {type:'init', bytes, offsets, angleUnit, edgeLimits} -> initialise worker with the finished index
//   {type:'solids', solids}                -> size, edge limits and B-rep signature of these solids (analyzeSolids)
//   {type:'limits', edgeLimits}            -> edge limits of the whole file (merged from all 'solids' answers)
//   {type:'match', members, tolRel}        -> B-rep duplicates within a group of solids with the same signature
//   {type:'faces', job, faces, defl, ang, scale} -> tessellate faces (scale per face: length unit -> mm, optional)
//   {type:'bvh', positions, index, shape}  -> build BVH (three-mesh-bvh, SAH) for one geometry;
//                                             shape: true → also its fingerprint (shape-match.js, instancing)
//   {type:'trim'}                          -> clear all caches (after the import, saves memory)
//   {type:'stl:…'}                         -> STL in parts (stl/stl-jobs.js: chunks, join, orientation, copies, geometries)

import { buildIndex, indexFromParts, scanEntities, resyncEntity, findData, StepFile } from './parser.js';
import { buildPlan, analyzeSolids, INDEX_TYPES } from './structure.js';
import { matchSolids } from './brep-match.js';
import { Tessellator, boundaryEdges } from './tessellate.js';
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import { analyzeShape } from '../shape-match.js';
import { stlJob } from '../stl/stl-jobs.js';

let tess = null;

// Upper limits of the caches per worker. Without a limit, for large files every worker gradually
// parses almost the whole file and holds on to it as JS objects (198 MB STEP: >3 GB in 12 workers
// -> "Out of Memory" in the browser tab). The caches are only accelerators; edges are sampled
// deterministically, so the mesh stays watertight even after clearing.
// Curves/surfaces are limited independently: StepFile clears its entity cache itself at 250 000,
// so a condition coupled to it never triggered – evaluated B-spline surfaces (large control nets)
// piled up without limit (389 MB CATIA file: 1.9 GB heap per worker; in Chrome all workers of a tab
// share ONE 4 GB heap region → "Out of Memory"). The faces of a solid are in consecutive jobs,
// so small limits cost hardly any hits (measured: same run time, at most ~125 MB heap per worker
// instead of 1.9 GB; 175 MB file 6.9 → 6.7 s).
const ENTITY_CACHE_LIMIT = 30000;
const CURVE_CACHE_LIMIT = 5000;
const SURFACE_CACHE_LIMIT = 1000;
const EDGE_CACHE_LIMIT = 20000;

function trimCaches(all = false) {
    if (!tess) return;
    const { step, geo } = tess;
    if (all || step.cache.size > ENTITY_CACHE_LIMIT) step.cache.clear();
    if (all || geo.curves.size > CURVE_CACHE_LIMIT) geo.curves.clear();
    if (all || geo.surfaces.size > SURFACE_CACHE_LIMIT) geo.surfaces.clear();
    if (all || tess.edgeCache.size > EDGE_CACHE_LIMIT) tess.edgeCache.clear();
}

function tessellateFaces({ job, faces, defl, ang, scale }) {
    const results = [];
    let nv = 0, ni = 0;
    const errors = [];
    for (let i = 0; i < faces.length; i++) {
        let r = null;
        try {
            r = tess.face(faces[i], defl[i], ang, scale ? scale[i] : 1);
        } catch (err) {
            errors.push(`#${faces[i]}: ${err.message}`);
        }
        results.push(r);
        if (r) { nv += r.positions.length / 3; ni += r.indices.length; }
    }
    // boundary edges per face
    const bnds = results.map(r => (r ? boundaryEdges(r.indices, r.positions.length / 3) : []));
    const nb = bnds.reduce((s, b) => s + b.length, 0);
    // pack into contiguous buffers (one transfer per job)
    const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3);
    const indices = new Uint32Array(ni), counts = new Int32Array(faces.length * 3), edges = new Int32Array(nb);
    let eo = 0;
    let vo = 0, io = 0;
    results.forEach((r, i) => {
        if (!r) return;
        positions.set(r.positions, vo * 3);
        normals.set(r.normals, vo * 3);
        indices.set(r.indices, io);
        edges.set(bnds[i], eo);
        eo += bnds[i].length;
        counts[i * 3] = r.positions.length / 3;
        counts[i * 3 + 1] = r.indices.length;
        counts[i * 3 + 2] = bnds[i].length;
        vo += r.positions.length / 3;
        io += r.indices.length;
    });
    trimCaches();
    self.postMessage({ type: 'faces', job, positions, normals, indices, counts, edges, errors },
        [positions.buffer, normals.buffer, indices.buffer, counts.buffer, edges.buffer]);
}

// Build the BVH and return it serialised. The index gets reordered in the process;
// positions and index are transferred there and back (no copy).
// Additionally tangents (for normal maps) if normals and UVs are sent along –
// otherwise the path tracer computes them synchronously on the main thread when building the scene.
function buildBVH({ positions, index, normals, uvs, shape, seed }) {
    // fingerprint before the BVH reorders the index (order does not matter, but saves nothing either)
    const fingerprint = shape ? analyzeShape([{ positions, index }], seed) : null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const bvh = new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5 });
    const { roots } = MeshBVH.serialize(bvh, { cloneBuffers: false });
    let tangents = null;
    if (normals && uvs) {
        geometry.setAttribute('normal', new BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
        geometry.computeTangents();
        tangents = geometry.getAttribute('tangent').array;
    }
    const transfer = [positions.buffer, index.buffer, ...roots];
    if (tangents) transfer.push(normals.buffer, uvs.buffer, tangents.buffer);
    self.postMessage({ type: 'bvh', positions, index, roots, normals, uvs, tangents, shape: fingerprint }, transfer);
}

self.onmessage = e => {
    const m = e.data;
    try {
        if (m.type === 'scan') {
            const bytes = new Uint8Array(m.bytes);
            const part = scanEntities(bytes, m.first ? findData(bytes) : resyncEntity(bytes, m.from), m.stop, INDEX_TYPES);
            self.postMessage({ type: 'scan', ...part }, [part.ids.buffer, part.offs.buffer]);
        } else if (m.type === 'index') {
            const bytes = new Uint8Array(m.bytes);
            const idx = m.parts ? indexFromParts(bytes, m.parts, INDEX_TYPES, m.shared) : buildIndex(bytes, INDEX_TYPES, m.shared);
            const step = new StepFile(bytes, idx.offsets);
            const plan = buildPlan(step, idx.typeIds, { solidDetails: false });
            tess = new Tessellator(step, plan.angleUnit, null);
            trimCaches(true); // building the structure parsed almost the whole file
            self.postMessage({ type: 'index', offsets: idx.offsets, plan, entityCount: idx.count, rescans: idx.rescans ?? null });
        } else if (m.type === 'init') {
            tess = new Tessellator(new StepFile(new Uint8Array(m.bytes), m.offsets), m.angleUnit, m.edgeLimits);
            self.postMessage({ type: 'init' });
        } else if (m.type === 'solids') {
            const res = analyzeSolids(tess.step, tess.geo, m.solids, tess.geo.angleUnit);
            trimCaches();
            const { ids, widths, radii } = res.edgeLimits;
            self.postMessage({ type: 'solids', ...res }, [res.sizes.buffer, ids.buffer, widths.buffer, radii.buffer]);
        } else if (m.type === 'limits') {
            tess.setEdgeLimits(m.edgeLimits);
            self.postMessage({ type: 'limits' });
        } else if (m.type === 'match') {
            const matches = matchSolids(tess.step, tess.geo, m.members, m.tolRel);
            trimCaches();
            self.postMessage({ type: 'match', matches });
        } else if (m.type === 'faces') {
            tessellateFaces(m);
        } else if (m.type === 'bvh') {
            buildBVH(m);
        } else if (m.type.startsWith('stl:')) {
            const { reply, transfer } = stlJob(m);
            self.postMessage(reply, transfer);
        } else if (m.type === 'trim') {
            trimCaches(true);
            self.postMessage({ type: 'trim' });
        }
    } catch (err) {
        self.postMessage({ type: 'error', job: m.job, message: err.message, stack: err.stack });
    }
};
