// STEP import without OpenCASCADE: own parser + B-rep tessellator (src/scripts/step/),
// parallelised over a pool of web workers (one worker per CPU core).
//
// Flow:
//  1. One worker indexes the file (byte offsets of all entities – large files: all workers scan a part each, the
//     first joins them) and resolves the product structure (assemblies, transformations, colours, face lists).
//  2. All workers receive file + index. With cross-origin isolation both live in
//     SharedArrayBuffers (no copy), otherwise each worker gets a copy.
//  3. All workers analyse the solids (size → tolerance, edge limits, B-rep signature – analyzePlanSolids).
//  4. Instancing on the B-rep level: solids that are copies of another one in any position (brep-match.js, proven
//     from the exact points and surfaces of the file) are not tessellated – their meshes use the other one's
//     geometry with an alignment matrix (findBrepCopies, brepCopies).
//  5. Faces are distributed dynamically in small batches to idle workers and
//     tessellated there; the main thread assembles the results per solid and colour.
//  6. Optional: build BVHs (for the path tracer) per geometry in parallel in the workers.
//  7. Optional (with BVHs): instancing after tessellating – geometries identical in shape to an earlier one (any
//     position/rotation) are dropped, their meshes use the earlier geometry with an alignment matrix (Instancer).
//     Catches what step 4 cannot prove (other B-rep of the same shape).
//
// Index and structure stay cached, "re-tessellate" starts directly at step 5.

import { t, getLocale } from './i18n.js';
import { Matrix4 } from 'three';
import { Instancer } from './instancer.js';
import { debugLog } from './log.js';
import { memoryBudget, workersWithin, MemoryGate } from './memory-budget.js';
// box UVs live in their own module (also used inside the workers – STL parts); re-exported for the importers
import { boxProject } from './box-project.js';
export { boxProject, UV_TILE } from './box-project.js';

// Tessellation quality levels:
//   rel = chord error relative to the solid diagonal, ang = max. angle between normals (rad)
export const TESS_PRESETS = {
    coarse:   { rel: 0.004,   ang: 0.6 },
    medium:   { rel: 0.0015,  ang: 0.4 },
    fine:     { rel: 0.0005,  ang: 0.25 },
    veryFine: { rel: 0.0002,  ang: 0.15 },
};
// Quality levels used to be stored with their German names (scene states before the i18n refactoring)
const LEGACY_QUALITY = { 'Grob': 'coarse', 'Mittel': 'medium', 'Fein': 'fine', 'Sehr fein': 'veryFine' };
/** Valid TESS_PRESETS key for a stored value (also legacy German names), otherwise null */
export const normalizeQuality = q => (q in TESS_PRESETS ? q : LEGACY_QUALITY[q] || null);

const FACES_PER_JOB = 16;
const PARALLEL_INDEX_BYTES = 32 * 2 ** 20;   // from this file size the index is scanned in parts on all workers
const QUEUED = 3;   // requests waiting per worker while tessellating (tessellateStep)

// Loads the file. With cross-origin isolation directly into a SharedArrayBuffer (read by all
// workers without a copy) – otherwise the file would be in memory twice.
export async function fetchStepFile(url, signal = null) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const length = Number(response.headers.get('Content-Length'));
    const encoded = response.headers.get('Content-Encoding');
    if (self.crossOriginIsolated && length > 0 && !encoded && response.body) {
        const bytes = new Uint8Array(new SharedArrayBuffer(length));
        const reader = response.body.getReader();
        let offset = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            signal?.throwIfAborted();
            if (offset + value.length > length) throw new Error(t('import.step.fileTooLong'));
            bytes.set(value, offset);
            offset += value.length;
        }
        if (offset === length) return bytes;
        return bytes.slice(0, offset);
    }
    return new Uint8Array(await response.arrayBuffer());
}

// Read a dropped file (File/Blob) – like fetchStepFile directly into a SharedArrayBuffer
export async function readStepFile(blob, signal = null) {
    if (!self.crossOriginIsolated || !blob.stream) return new Uint8Array(await blob.arrayBuffer());
    const bytes = new Uint8Array(new SharedArrayBuffer(blob.size));
    const reader = blob.stream().getReader();
    let offset = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) { reader.cancel(); signal.throwIfAborted(); }
        bytes.set(value, offset);
        offset += value.length;
    }
    return bytes;
}

// --- Worker pool ---

const createWorker = () => new Worker(new URL('./step/worker.js', import.meta.url), { type: 'module', name: 'step' });

// Request to a worker, answer as a promise. A worker handles its messages one after the other and answers in that
// order – several requests may wait in its queue (tessellateStep keeps the next job queued: the worker goes on at once
// instead of waiting until the main thread, busy drawing the streamed parts, has taken the answer and sent a new job).
// Pending requests are tracked: abortStepImport() rejects them with AbortError (terminated workers
// never answer – the promises would hang forever otherwise).
const inflight = new Set();
function requestWorker(w, msg, transfer = []) {
    return new Promise((resolve, reject) => {
        const entry = { w, resolve, reject };
        inflight.add(entry);
        const queue = (w.rindrQueue ??= []);
        queue.push(entry);
        if (!w.onmessage) {
            w.onmessage = e => {
                const head = queue.shift();
                if (!head) return;
                inflight.delete(head);
                if (e.data.type === 'error') head.reject(new Error(e.data.message));
                else head.resolve(e.data);
            };
            w.onerror = e => {
                for (const head of queue.splice(0)) {
                    inflight.delete(head);
                    head.reject(new Error(e.message || t('import.step.workerError')));
                }
            };
        }
        w.postMessage(msg, transfer);
    });
}

class WorkerPool {
    constructor(size) {
        this.workers = [];
        for (let i = 0; i < size; i++) this.workers.push(createWorker());
    }
    request(w, msg, transfer = []) {
        return requestWorker(w, msg, transfer);
    }
    terminate() {
        this.workers.forEach(w => w.terminate());
        this.workers = [];
    }
}

let pool = null;
let session = null; // { source, bytes, offsets, plan, ready: Promise }

// Pool size from the device's memory budget (memory-budget.js), not only from the CPU cores: every worker needs
// its own heap (caches, partial results – a large assembly peaked at ~7 GB with 16 workers). Without
// SharedArrayBuffer (no cross-origin isolation) every worker also holds its own copy of the file (a 900 MB STEP got
// 6 copies and failed with "Data cannot be cloned, out of memory"). The file (shared) and the main thread's results
// (~30 % of the budget) are kept free.
const WORKER_BYTES = 450 * 2 ** 20;   // measured: a large assembly peaked ~370 MB higher per worker

/** @param {number} [fileSize] STEP file size (bytes) @param {boolean} [shared] the file is a SharedArrayBuffer */
function poolSize(fileSize = 0, shared = true) {
    // ?workers=N (testing): fixed pool size
    const forced = Number(new URLSearchParams(self.location?.search || '').get('workers'));
    if (forced > 0) return Math.min(forced, 32);
    const cores = navigator.hardwareConcurrency || 4;
    const reserved = memoryBudget() * 0.3 + (shared ? fileSize : 0);
    return workersWithin(WORKER_BYTES + (shared ? 0 : fileSize), reserved, Math.min(cores, shared ? 16 : 6));
}

// Extra memory of one BVH build in a worker (bounds per triangle, reordered index, nodes, tangents; the geometry
// buffers themselves are transferred) – the gate keeps the builds running at once within a share of the budget
const bvhJobBytes = g => 70 * (g.index.length / 3) + 40 * (g.positions.length / 3);
let bvhGate = null;
const gate = () => (bvhGate ??= new MemoryGate(memoryBudget() * 0.3));

async function prepare(source, onStatus, { instancing = false } = {}) {
    if (session && session.source === source) return session.ready;
    const shared = !!self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    // copies per worker: pool size depends on the file size (smaller pool for large files, back for small ones)
    const size = poolSize(source.byteLength, shared);
    if (pool && pool.workers.length !== size) { pool.terminate(); pool = null; }
    pool ??= new WorkerPool(size);
    session = { source };
    session.ready = (async () => {
        let bytes = source;
        if (shared && !(source.buffer instanceof SharedArrayBuffer)) {
            const sab = new SharedArrayBuffer(source.byteLength);
            bytes = new Uint8Array(sab);
            bytes.set(source);
        }
        onStatus(t('import.step.analyzing'));
        const [first, ...rest] = pool.workers;
        const t0 = performance.now();
        // without shared memory: a copy that is transferred (not cloned once more by postMessage)
        const copy = () => source.slice().buffer;
        let res, scanMs = null;
        if (shared && source.byteLength >= PARALLEL_INDEX_BYTES && pool.workers.length > 1) {
            // large file: the index scan in parts on all workers (one linear pass over the bytes – a single worker took
            // ~4 s for 1.5 GB), checked and joined by the first, which then reads the structure (indexFromParts in
            // parser.js – the same index as one scan; a part that started inside a string is scanned again)
            const n = bytes.length, k = pool.workers.length, at = i => (i >= k ? n : Math.floor(i * n / k));
            const parts = await Promise.all(pool.workers.map((w, i) => pool.request(w, { type: 'scan', bytes: bytes.buffer, from: at(i), stop: at(i + 1), first: i === 0 })));
            scanMs = performance.now() - t0;
            res = await pool.request(first, { type: 'index', bytes: bytes.buffer, shared, parts }, parts.flatMap(p => [p.ids.buffer, p.offs.buffer]));
        } else {
            const firstBytes = shared ? bytes.buffer : copy();
            res = await pool.request(first, { type: 'index', bytes: firstBytes, shared }, shared ? [] : [firstBytes]);
        }
        debugLog(`[STEP] Index + structure: ${res.entityCount} entities, ${res.plan.solids.length} solids, ` +
            `${res.plan.instances.length} instances in ${(performance.now() - t0).toFixed(0)} ms ` +
            (scanMs !== null ? `(index in ${pool.workers.length} parts ${scanMs.toFixed(0)} ms, ${res.rescans} scanned again) ` : '') +
            `(${pool.workers.length} workers, ${shared ? 'SharedArrayBuffer' : 'copy per worker'})`);
        const lengthUnits = [...new Set(res.plan.solids.map(s => s.unit || 1))];
        if (lengthUnits.some(u => u !== 1)) debugLog(`[STEP] Length units (mm per file unit): ${lengthUnits.join(', ')} – scaled to mm`);
        // default names of unnamed nodes come from the worker as autoName (no i18n there)
        for (const node of res.plan.nodes) {
            if (node.autoName) node.name = t(`import.step.autoName.${node.autoName[0]}`, { number: node.autoName[1] });
        }
        onStatus(t('import.step.initWorkers', { count: pool.workers.length }));
        const init = (w, data) => pool.request(w, { type: 'init', bytes: data, offsets: res.offsets, angleUnit: res.plan.angleUnit, edgeLimits: null }, shared ? [] : [data]);
        // every worker joins the analysis of the solids once it has the file – without shared memory the copies go out
        // one after another (at most one extra copy here at a time)
        const ready = new Map([[first, Promise.resolve()]]);
        if (shared) for (const w of rest) ready.set(w, init(w, bytes.buffer));
        else {
            let chain = Promise.resolve();
            for (const w of rest) ready.set(w, chain = chain.then(() => init(w, copy())));
        }
        await analyzePlanSolids(res.plan, ready, onStatus);
        if (instancing && BREP_INSTANCING) await findBrepCopies(res.plan, onStatus);
        orientUpAxis(res.plan, bytes);
        session.plan = res.plan;
        return session;
    })();
    try {
        return await session.ready;
    } catch (err) {
        session = null;
        throw err;
    }
}

// Size, edge limits and signature per solid in all workers (analyzeSolids in structure.js) – the part of the structure
// that reads every face, edge and vertex: about 3/4 of the analysis of a large file, done by one worker before.
// Jobs of consecutive solids (~1/8 of a worker's share), largest first; edge limits merged by their minimum.
async function analyzePlanSolids(plan, ready, onStatus) {
    const t0 = performance.now();
    const solids = plan.solids;
    const totalFaces = solids.reduce((n, s) => n + s.faces.length, 0);
    const target = Math.max(2000, Math.ceil(totalFaces / (pool.workers.length * 8)));
    const jobs = [];
    for (let i = 0; i < solids.length;) {
        const start = i;
        let faces = 0;
        while (i < solids.length && (i === start || faces + solids[i].faces.length <= target)) faces += solids[i++].faces.length;
        jobs.push({ start, end: i, faces });
    }
    jobs.sort((a, b) => b.faces - a.faces);
    const limits = [];
    let next = 0, done = 0;
    onStatus(t('import.step.analyzing'), 0);
    await Promise.all(pool.workers.map(async w => {
        await ready.get(w);
        while (next < jobs.length) {
            const job = jobs[next++];
            const r = await pool.request(w, { type: 'solids', solids: solids.slice(job.start, job.end).map(s => ({ faces: Int32Array.from(s.faces) })) });
            for (let k = job.start; k < job.end; k++) {
                solids[k].size = r.sizes[k - job.start];
                solids[k].signature = r.signatures[k - job.start];
            }
            limits.push(r.edgeLimits);
            done += job.faces;
            onStatus(t('import.step.analyzing'), totalFaces ? done / totalFaces : 1);
        }
    }));
    plan.edgeLimits = mergeEdgeLimits(limits);
    await Promise.all(pool.workers.map(w => pool.request(w, { type: 'limits', edgeLimits: plan.edgeLimits })));
    debugLog(`[STEP] Solids analysed in ${(performance.now() - t0).toFixed(0)} ms (${jobs.length} jobs, ${plan.edgeLimits.ids.length} edge limits)`);
}

// Minimum per edge over the edge limits of several jobs (as mergeEdgeLimits in structure.js – not imported: the
// geometry code would come into the main bundle)
function mergeEdgeLimits(parts) {
    const limit = new Map();
    for (const p of parts) {
        for (let i = 0; i < p.ids.length; i++) {
            const l = limit.get(p.ids[i]);
            if (!l) limit.set(p.ids[i], [p.widths[i], p.radii[i]]);
            else { l[0] = Math.min(l[0], p.widths[i]); l[1] = Math.min(l[1], p.radii[i]); }
        }
    }
    const ids = new Int32Array(limit.size), widths = new Float64Array(limit.size), radii = new Float64Array(limit.size);
    let k = 0;
    for (const [id, [w, r]] of limit) { ids[k] = id; widths[k] = w; radii[k++] = r; }
    return { ids, widths, radii };
}

// --- Instancing on the B-rep level (before tessellating) ---
// Groups of solids with the same signature are proven in the workers (brep-match.js). A copy gets
// s.brep = { root, align (root geometry → copy, mm), colors (root face colour key → copy face colour) }, its root
// { root, align: null, colors: null }. A copy needs the same split into face colours (one to one) – otherwise its meshes
// (one per face colour) would differ from those of its own tessellation (keys of scene states, part quality).
const BREP_TOL = 1e-5;          // point tolerance relative to the solid size – 20 × below the finest chord tolerance
// ?brep=0 (testing): no instancing on the B-rep level (the instancing after tessellating stays)
const BREP_INSTANCING = new URLSearchParams(self.location?.search || '').get('brep') !== '0';
const MATCH_JOB_FACES = 20000;  // faces per comparison job (large groups are split, each part keeps the root)
const colorKey = c => (c ? c.join(',') : '');

async function findBrepCopies(plan, onStatus) {
    const t0 = performance.now();
    const groups = new Map();
    plan.solids.forEach((s, i) => {
        if (!s.signature || !s.faces.length) return;
        const key = `${s.signature}/${s.unit || 1}/${s.surface ? 1 : 0}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
    });
    const faces = i => plan.solids[i].faces.length;
    const jobs = [];
    for (const g of groups.values()) {
        if (g.length < 2) continue;
        let part = [g[0]], n = faces(g[0]);
        for (const i of g.slice(1)) {
            if (part.length > 1 && n + faces(i) > MATCH_JOB_FACES) { jobs.push({ members: part, faces: n }); part = [g[0]]; n = faces(g[0]); }
            part.push(i);
            n += faces(i);
        }
        jobs.push({ members: part, faces: n });
    }
    if (!jobs.length) return;
    jobs.sort((a, b) => b.faces - a.faces);
    const total = jobs.reduce((n, j) => n + j.faces, 0);
    let next = 0, done = 0, copies = 0, copyFaces = 0, refused = 0;
    onStatus(t('import.step.matching'), 0);
    await Promise.all(pool.workers.map(async w => {
        while (next < jobs.length) {
            const job = jobs[next++];
            const members = job.members.map(i => ({ index: i, faces: Int32Array.from(plan.solids[i].faces), size: plan.solids[i].size }));
            const r = await pool.request(w, { type: 'match', members, tolRel: BREP_TOL });
            for (const m of r.matches) {
                if (setCopy(plan, m)) { copies++; copyFaces += faces(m.index); } else refused++;
            }
            done += job.faces;
            onStatus(t('import.step.matching'), done / total);
        }
    }));
    plan.brepStats = { copies, copyFaces };
    debugLog(`[STEP] B-rep instancing: ${copies} of ${plan.solids.length} solids are copies (${copyFaces} faces not tessellated` +
        `${refused ? `, ${refused} refused: other face colours` : ''}) – ${jobs.length} groups compared in ${(performance.now() - t0).toFixed(0)} ms`);
}

function setCopy(plan, m) {
    const root = plan.solids[m.root], s = plan.solids[m.index];
    const colors = new Map(), back = new Map();
    for (let fi = 0; fi < root.faces.length; fi++) {
        const rk = colorKey(root.faceColors[fi]), c = s.faceColors[m.faceMap[fi]], ck = colorKey(c);
        if (colors.has(rk)) { if (colorKey(colors.get(rk)) !== ck) return false; }
        else if (back.has(ck)) return false;
        else { colors.set(rk, c); back.set(ck, rk); }
    }
    root.brep ??= { root: m.root, align: null, colors: null };
    s.brep = { root: m.root, align: brepAlignment(m, s.unit || 1), colors };
    return true;
}

// column-major (three.js) matrix of x_copy = R · (x_root − cA) + cB in mm (unit: mm per file unit, the same for both)
function brepAlignment({ R, cA, cB }, unit) {
    const t = [0, 1, 2].map(r => (cB[r] - (R[r * 3] * cA[0] + R[r * 3 + 1] * cA[1] + R[r * 3 + 2] * cA[2])) * unit);
    return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

// Copies among the solids to tessellate: per B-rep group and level the first wanted solid is tessellated (the root, or
// another member if the root is not part of this run – part quality), the others use its geometry.
// → Map(copy → { rep, align (rep geometry → copy, mm), colors (rep face colour key → copy face colour) })
function brepCopies(plan, wanted, presetOf) {
    const reps = new Map(), copies = new Map();
    plan.solids.forEach((s, si) => {
        if (!s.brep || !wanted(si)) return;
        const p = presetOf(si), key = `${s.brep.root}/${p.rel}/${p.ang}`;
        const rep = reps.get(key);
        if (rep === undefined) { reps.set(key, si); return; }
        const a = plan.solids[rep].brep, b = s.brep;
        // rep → copy = (root → copy) · (root → rep)⁻¹
        const align = a.align ? _m.fromArray(b.align).multiply(_align.fromArray(a.align).invert()).toArray() : b.align;
        const colors = new Map();
        for (const [rk, c] of b.colors) colors.set(a.colors ? colorKey(a.colors.get(rk)) : rk, c);
        copies.set(si, { rep, align, colors });
    });
    return copies;
}

// --- Up axis ---
// STEP knows no up axis – coordinates come 1:1 from the CAD system, and its convention decides what
// is "up". The viewer (three.js) uses +Y up. CATIA, NX and Solid Edge model with +Z up – without
// conversion those models lay on their back. The exporting program is in the header
// (FILE_NAME: preprocessor_version, originating_system); for these systems all instance matrices are
// rotated by −90° about X (x, y, z) → (x, z, −y). Others (SolidWorks, Inventor, Creo) stay.
// Converters hide the original program: then the beginning of the data is searched
// for CATIA traces (CATPart/CATProduct names, e.g. 'Product1_AllCATPart').
// Test/override: ?upAxis=z|y.
// FreeCAD: Z up by convention (3D printing test models lay on their side before)
const Z_UP_SYSTEMS = /CATIA|3DEXPERIENCE|\bNX\s*\d*\b|UNIGRAPHICS|SOLID\s*EDGE|FREECAD/i;
const Y_UP_SYSTEMS = /SOLID\s*WORKS|SWSTEP|INVENTOR|CREO|PRO\/?ENGINEER|FUSION/i;
const CATIA_TRACES = /CAT(?:Part|Product)\b|CATIA/;
const TRACE_SCAN_BYTES = 4 * 1024 * 1024;

/** FILE_NAME of the header: { preprocessor, system } (empty strings if not found) */
export function readStepHeader(bytes) {
    const text = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, 65536)))
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const start = text.search(/FILE_NAME\s*\(/i);
    if (start < 0) return { preprocessor: '', system: '' };
    // top-level arguments of FILE_NAME( … ) – strings with '' escapes, nested lists
    const args = [];
    let depth = 0, current = '', inString = false;
    for (let i = text.indexOf('(', start) + 1; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "'" && text[i + 1] === "'") { current += "'"; i++; }
            else if (c === "'") inString = false;
            else current += c;
        } else if (c === "'") inString = true;
        else if (c === '(') depth++;
        else if (c === ')') { if (depth-- === 0) { args.push(current.trim()); break; } }
        else if (c === ',' && depth === 0) { args.push(current.trim()); current = ''; }
        else if (depth === 0 && !/\s/.test(c)) current += c;
    }
    return { preprocessor: args[4] || '', system: args[5] || '' };
}

function orientUpAxis(plan, bytes) {
    const header = readStepHeader(bytes);
    const forced = new URLSearchParams(self.location?.search || '').get('upAxis');
    const programs = `${header.system} ${header.preprocessor}`;
    let up = 'y', reason = 'header';
    if (forced === 'z' || forced === 'y') { up = forced; reason = '?upAxis'; }
    else if (Z_UP_SYSTEMS.test(programs)) up = 'z';
    else if (!Y_UP_SYSTEMS.test(programs)) {
        // unknown program/converter: CATIA traces in the data?
        const text = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, TRACE_SCAN_BYTES)));
        if (CATIA_TRACES.test(text)) { up = 'z'; reason = 'CATIA traces in the data'; }
        else reason = 'unknown program, default';
    }
    plan.upAxis = up;
    plan.originatingSystem = header.system || header.preprocessor;
    debugLog(`[STEP] Originating system: "${header.system}" (${header.preprocessor}) → ${up === 'z' ? '+Z up, rotated to +Y up' : '+Y up'} (${reason})`);
    if (up !== 'z') return;
    // R · M with R = rotation −90° about X (column-major): row y ← z, row z ← −y
    for (const inst of plan.instances) {
        const m = inst.matrix, r = m.slice();
        for (let c = 0; c < 4; c++) { r[c * 4 + 1] = m[c * 4 + 2]; r[c * 4 + 2] = -m[c * 4 + 1]; }
        inst.matrix = r;
    }
}

/**
 * Tessellates a STEP file.
 * Solids are streamed: as soon as all faces of a solid are done, it is assembled, its BVH is built
 * (priority over further face jobs) and onSolid is called with its mesh instances.
 * @param {Uint8Array} content file content
 * @param {string} quality key of TESS_PRESETS
 * @param {(text: string, fraction?: number) => void} onStatus
 * @param {{bvh?: boolean, onPlan?: (plan) => void, onSolid?: (meshes: object[], geometries: object[]) => void,
 *   solidQualities?: (plan) => (string|null)[], onlySolids?: (plan) => Set<number>, instancing?: boolean}} options
 *   bvh: build BVHs (geometries[i].bvh = serialised roots for MeshBVH.deserialize)
 *   instancing: share geometries of identical shapes (only with bvh) – dropped entries of `geometries` are null
 *   onPlan: structure is known (plan.nodes), before tessellating
 *   onQuality: the estimate chose a coarser level (limits.auto) – called with it before tessellating
 *   onSolid: finished solid – entries as in meshes, geometries via geometries[m.geometry]
 *   solidQualities: quality per solid (null = quality) – quality per part
 *   onlySolids: tessellate only these solids (meshes then contains only their instances)
 * @returns {Promise<{geometries: {positions: Float32Array, normals: Float32Array, index: Uint32Array, bvh?: ArrayBuffer[]}[],
 *   meshes: {geometry: number, matrix: number[], color: number[]|null, name: string, node: number, instance: number}[],
 *   nodes: {name: string, parent: number}[], stats: object}>}
 */
export async function tessellateStep(content, quality, onStatus = () => {}, { bvh = false, onPlan, onSolid, onQuality, solidQualities, onlySolids, limits, instancing = false } = {}) {
    const t0 = performance.now();
    const requested = quality;
    const { plan } = await prepare(content, onStatus, { instancing });
    onPlan?.(plan);
    const qualities = solidQualities?.(plan) || [];
    const presetOf = si => TESS_PRESETS[qualities[si] || quality] || TESS_PRESETS.medium;
    const only = onlySolids?.(plan) || null;
    const wanted = si => !only || only.has(si);
    const solidCount = only ? only.size : plan.solids.length;
    // B-rep copies (found while preparing) are not tessellated themselves – they depend on the levels
    let copyOf = instancing ? brepCopies(plan, wanted, presetOf) : new Map();
    const tessellated = si => wanted(si) && !copyOf.has(si);

    // Memory protection: estimate the triangle count from a sample first – opening may choose a coarser
    // level automatically (limits.auto), beyond the hard limit nothing is tessellated at all
    let estimate = null;
    const estimates = {};   // level -> estimated triangles
    if (limits) {
        let sample = sampleFaces(plan, tessellated);
        if (sample) {
            onStatus(t('import.step.estimating'));
            const levels = Object.keys(TESS_PRESETS);
            for (;;) {
                estimate = estimates[quality] = await estimateTriangles(plan, sample, presetOf);
                const coarser = levels[levels.indexOf(quality) - 1];
                if (!limits.auto || estimate <= limits.budget || !coarser) break;
                quality = coarser;
                if (instancing) copyOf = brepCopies(plan, wanted, presetOf);   // part levels may meet the new one
                sample = sampleFaces(plan, tessellated) || sample;
            }
            debugLog(`[STEP] Estimate from ${sample.count} sample faces: ` +
                Object.entries(estimates).map(([q, n]) => `"${q}" ~${Math.round(n).toLocaleString('en')}`).join(', ') +
                ` triangles (budget ${limits.budget.toLocaleString('en')}, limit ${limits.limit.toLocaleString('en')})`);
            if (estimate > limits.limit) throw new ImportLimitError(estimate, limits.limit, quality, false);
        }
    }
    if (quality !== requested) onQuality?.(quality);   // chosen coarser for the model's size – before tessellating
    const copiesOf = new Map();   // rep → its copies
    let copyFaces = 0;
    for (const [c, rel] of copyOf) {
        if (!copiesOf.has(rel.rep)) copiesOf.set(rel.rep, []);
        copiesOf.get(rel.rep).push(c);
        copyFaces += plan.solids[c].faces.length;
    }

    // Instances per solid (for onSolid and the mesh list)
    const instancesBySolid = plan.solids.map(() => []);
    plan.instances.forEach((inst, ii) => instancesBySolid[inst.solid].push(ii));

    // --- Jobs: faces per solid in batches ---
    const jobs = [];
    const faceResults = plan.solids.map(s => new Array(s.faces.length).fill(null));
    const facesLeft = plan.solids.map(s => s.faces.length);
    let totalFaces = 0;
    plan.solids.forEach((s, si) => {
        if (!tessellated(si)) return;
        const preset = presetOf(si);
        // tolerance in the file's length unit (s.size too), positions come back scaled to mm (s.unit)
        const defl = Math.max(preset.rel * s.size, 1e-6);
        for (let i = 0; i < s.faces.length; i += FACES_PER_JOB) {
            const faces = Int32Array.from(s.faces.slice(i, i + FACES_PER_JOB));
            const scale = s.unit && s.unit !== 1 ? new Float64Array(faces.length).fill(s.unit) : null;
            jobs.push({ si, start: i, faces, defl: new Float64Array(faces.length).fill(defl), ang: preset.ang, scale });
        }
        totalFaces += s.faces.length;
    });

    const geometries = [];
    const solidGroups = new Array(plan.solids.length).fill(null);
    const bvhQueue = [];   // finished solids whose BVH is still missing
    let assembleMs = 0, bvhMs = 0, solidsDone = 0, flippedFaces = 0, flippedSolids = 0;

    // Solid finished: one geometry per face colour, then BVH (or report directly)
    const finishSolid = si => {
        const ta = performance.now();
        solidGroups[si] = assembleSolid(plan.solids[si], faceResults[si], geometries, n => { flippedFaces += n; flippedSolids++; });
        faceResults[si] = null;   // free partial results
        assembleMs += performance.now() - ta;
        if (bvh && solidGroups[si].length) bvhQueue.push(si);
        else emitSolid(si);
    };
    const emitSolid = si => {
        solidsDone++;
        if (onSolid && solidGroups[si].length) {
            const out = [];
            for (const ii of instancesBySolid[si]) {
                const inst = plan.instances[ii];
                for (const g of solidGroups[si]) {
                    out.push(meshEntry(inst, ii, g));
                }
            }
            onSolid(out, geometries);
        }
        // B-rep copies: the groups of their rep (after instancing) with the alignment and their own face colours
        for (const c of copiesOf.get(si) || []) {
            const rel = copyOf.get(c);
            solidGroups[c] = solidGroups[si].map(g => ({ geometry: g.geometry, color: rel.colors.get(colorKey(g.color)) ?? null,
                align: g.align ? _m.fromArray(rel.align).multiply(_align.fromArray(g.align)).toArray() : rel.align }));
            emitSolid(c);
        }
    };
    plan.solids.forEach((s, si) => { if (!s.faces.length && tessellated(si)) finishSolid(si); });

    const instancer = bvh && instancing ? new Instancer(geometries) : null;
    const runBVH = async (w, si) => {
        const tb = performance.now();
        // all geometries of the solid at once (the worker answers in order – no wait between them)
        await Promise.all(solidGroups[si].map(g => buildBVH(w, geometries[g.geometry], instancer ? g.geometry + 1 : 0)));
        bvhMs += performance.now() - tb;
        if (instancer) {
            // the same tessellation level is required (a coarse duplicate must not stand in for a fine part)
            const preset = presetOf(si);
            const defl = Math.max(preset.rel * plan.solids[si].size, 1e-6) * (plan.solids[si].unit || 1);   // in mm, like the geometry
            for (const g of solidGroups[si]) instancer.add(g, `${preset.rel}/${preset.ang}`, defl);
        }
        emitSolid(si);
    };

    // --- Dynamic distribution: BVHs of finished solids first, then more faces ---
    // triangles: running count against limits.limit – exceeded = all workers stop after their
    // current job (no request stays open, the pool can be reused), then ImportLimitError
    let next = 0, doneFaces = 0, errors = 0, triangles = 0, stopped = false;
    const t1 = performance.now();
    const fmt = n => n.toLocaleString(getLocale());
    // at most every 100 ms (formatting the numbers after every job cost the main thread ~2 % of a large import)
    let statusAt = 0;
    const status = () => {
        const now = performance.now();
        if (now - statusAt < 100) return;
        statusAt = now;
        onStatus(t('import.step.tessellating', { faces: fmt(doneFaces), totalFaces: fmt(totalFaces), solids: fmt(solidsDone), totalSolids: fmt(solidCount) }),
            totalFaces ? doneFaces / totalFaces : 1);
    };
    const handleFaces = (job, r) => {
        if (stopped) return;
        let vo = 0, io = 0, eo = 0;
        for (let k = 0; k < job.faces.length; k++) {
            const nv = r.counts[k * 3], ni = r.counts[k * 3 + 1], ne = r.counts[k * 3 + 2];
            if (nv > 0 && ni > 0) {
                faceResults[job.si][job.start + k] = {
                    positions: r.positions.subarray(vo * 3, (vo + nv) * 3),
                    normals: r.normals.subarray(vo * 3, (vo + nv) * 3),
                    indices: r.indices.subarray(io, io + ni),
                    edges: r.edges.subarray(eo, eo + ne),
                };
            }
            vo += nv; io += ni; eo += ne;
        }
        triangles += r.indices.length / 3;
        if (limits && triangles > limits.limit) stopped = true;
        if (stopped) return;
        if (r.errors.length) {
            errors += r.errors.length;
            console.warn('[STEP] Faces could not be tessellated:', r.errors);
        }
        doneFaces += job.faces.length;
        facesLeft[job.si] -= job.faces.length;
        if (facesLeft[job.si] === 0) finishSolid(job.si);
        status();
    };
    // QUEUED requests per worker: it answers in order and starts the next one at once – with one at a time it waited
    // for the main thread (drawing the streamed parts) after every job, ~half of the time (large assembly, 8 workers)
    const runWorker = async w => {
        const pending = [];
        const send = () => {
            if (stopped) return null;
            if (bvhQueue.length) return runBVH(w, bvhQueue.shift()).then(status);
            if (next >= jobs.length) return null;
            const job = jobs[next++];
            return pool.request(w, { type: 'faces', job: 0, faces: job.faces, defl: job.defl, ang: job.ang, scale: job.scale }).then(r => handleFaces(job, r));
        };
        try {
            for (;;) {
                while (pending.length < QUEUED) {
                    const p = send();
                    if (!p) break;
                    pending.push(p);
                }
                if (!pending.length) break;
                await pending.shift();
            }
        } finally {
            await Promise.allSettled(pending);   // no request stays open (the pool is reused)
        }
    };
    await Promise.all(pool.workers.map(runWorker));
    if (stopped) {
        console.warn(`[STEP] Triangle limit exceeded: ${triangles.toLocaleString('en')} > ${limits.limit.toLocaleString('en')} after ${doneFaces} of ${totalFaces} faces`);
        throw new ImportLimitError(triangles, limits.limit, quality, true);
    }
    // BVH jobs that were added only after a worker had finished
    await Promise.all(pool.workers.map(async w => { while (bvhQueue.length) await runBVH(w, bvhQueue.shift()); }));
    const t2 = performance.now();

    const meshes = [];
    for (const [ii, inst] of plan.instances.entries()) {
        if (!wanted(inst.solid)) continue;
        for (const g of solidGroups[inst.solid] || []) {
            meshes.push(meshEntry(inst, ii, g));
        }
    }

    // Free the workers' caches – they would otherwise occupy memory until the next import
    await Promise.all(pool.workers.map(w => pool.request(w, { type: 'trim' })));

    let uniqueTriangles = 0;
    for (const g of geometries) if (g) uniqueTriangles += g.index.length / 3;
    instancer?.dispose();
    const stats = {
        workers: pool.workers.length,
        faces: totalFaces,
        solids: solidCount,
        failedFaces: errors,
        flippedFaces, flippedSolids,   // orientation repaired (orientFaces)
        triangles: uniqueTriangles,
        quality,
        brepCopies: copyOf.size, brepCopyFaces: copyFaces,   // solids not tessellated (copies of another one)
        estimate: estimate === null ? null : Math.round(estimate),
        prepareMs: Math.round(t1 - t0),
        tessellateMs: Math.round(t2 - t1),   // incl. BVH (runs interleaved)
        assembleMs: Math.round(assembleMs),
        bvhMs: Math.round(bvhMs),             // sum over all workers
        ...instancer?.stats,                  // instanced geometries / triangles no longer stored
    };
    debugLog('[STEP] Tessellation:', stats);
    if (flippedFaces) debugLog(`[STEP] Orientation repaired: ${flippedFaces} faces in ${flippedSolids} solids flipped (inconsistent same_sense or inward-facing surface model)`);
    return { geometries, meshes, nodes: plan.nodes, stats, quality, estimates };
}

/**
 * Tessellation would exceed the triangle limit (memory protection, IMPORT in config.js).
 * during = false: refused beforehand (estimate), true: aborted while tessellating (counted).
 */
export class ImportLimitError extends Error {
    constructor(triangles, limit, quality, during) {
        super(`Triangle limit exceeded: ${Math.round(triangles)} > ${limit} (${quality})`);
        this.name = 'ImportLimitError';
        Object.assign(this, { triangles: Math.round(triangles), limit, quality, during });
    }
}

// Below this many faces the estimate is skipped: tessellating is quick, the running count protects
const SAMPLE_MIN_FACES = 3000;

/**
 * Random sample of the faces to tessellate (reproducible, fixed seed): 1.5 % of the faces, 400–2000.
 * Returns { faces: [[si, faceIndex]], count, total } or null for small models.
 */
function sampleFaces(plan, wanted) {
    let total = 0;
    plan.solids.forEach((s, si) => { if (wanted(si)) total += s.faces.length; });
    if (total <= SAMPLE_MIN_FACES) return null;
    const count = Math.min(2000, Math.max(400, Math.ceil(total * 0.015)));
    let seed = 0x2545F491;
    const random = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const picks = new Set();
    while (picks.size < count) picks.add(Math.floor(random() * total));
    const sorted = [...picks].sort((a, b) => a - b);
    const faces = [];
    let offset = 0, k = 0;
    plan.solids.forEach((s, si) => {
        if (!wanted(si)) return;
        while (k < sorted.length && sorted[k] < offset + s.faces.length) faces.push([si, sorted[k++] - offset]);
        offset += s.faces.length;
    });
    return { faces, count, total };
}

/** Triangles of the whole model, extrapolated from the sample (tessellated in the pool, results discarded) */
async function estimateTriangles(plan, sample, presetOf) {
    // jobs of FACES_PER_JOB faces with the same angle (ang is per job)
    const byAngle = new Map();
    for (const [si, fi] of sample.faces) {
        const preset = presetOf(si);
        if (!byAngle.has(preset.ang)) byAngle.set(preset.ang, []);
        byAngle.get(preset.ang).push([plan.solids[si].faces[fi], Math.max(preset.rel * plan.solids[si].size, 1e-6)]);
    }
    const jobs = [];
    for (const [ang, list] of byAngle) {
        for (let i = 0; i < list.length; i += FACES_PER_JOB) {
            const part = list.slice(i, i + FACES_PER_JOB);
            jobs.push({ faces: Int32Array.from(part, f => f[0]), defl: Float64Array.from(part, f => f[1]), ang });
        }
    }
    let next = 0, triangles = 0;
    await Promise.all(pool.workers.map(async w => {
        while (next < jobs.length) {
            const job = jobs[next++];
            const r = await pool.request(w, { type: 'faces', job: 0, faces: job.faces, defl: job.defl, ang: job.ang });
            triangles += r.indices.length / 3;
        }
    }));
    return triangles * sample.total / sample.count;
}

// Mesh entry of an instance; key is stable across quality levels (instance + face colour),
// so scene states find their material assignments again
function meshEntry(inst, ii, g) {
    return {
        geometry: g.geometry, matrix: g.align ? _m.fromArray(inst.matrix).multiply(_align.fromArray(g.align)).toArray() : inst.matrix, color: g.color || inst.color || null, name: inst.name, node: inst.node, instance: ii,
        key: `${ii}/${g.color ? g.color.map(c => c.toFixed(4)).join(',') : '-'}`,
    };
}

const _m = new Matrix4(), _align = new Matrix4();

/**
 * Ray test for orientFaces: does the normal of a face point inwards? From the centre of its largest
 * triangle, three slightly scattered rays along the triangle normal; an odd number of hits with the
 * own solid = inside. Bounding box per face as pre-filter, then Möller-Trumbore.
 * Returns (fi) => +1 (inside), -1 (outside), 0 (unclear).
 */
function insideTester(results) {
    const boxes = results.map(r => {
        if (!r) return null;
        const p = r.positions, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < b[c]) b[c] = p[i + c]; if (p[i + c] > b[c + 3]) b[c + 3] = p[i + c]; }
        return b;
    });
    let size = 0;
    for (const b of boxes) if (b) size = Math.max(size, b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    const eps = size * 1e-6;
    const slab = (b, o, d) => {
        let t0 = 0, t1 = Infinity;
        for (let c = 0; c < 3; c++) {
            if (Math.abs(d[c]) < 1e-300) { if (o[c] < b[c] - eps || o[c] > b[c + 3] + eps) return false; continue; }
            let ta = (b[c] - eps - o[c]) / d[c], tb = (b[c + 3] + eps - o[c]) / d[c];
            if (ta > tb) { const t = ta; ta = tb; tb = t; }
            t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
            if (t0 > t1) return false;
        }
        return true;
    };
    const hits = (o, d) => {
        let count = 0;
        for (let fi = 0; fi < results.length; fi++) {
            const b = boxes[fi];
            if (!b || !slab(b, o, d)) continue;
            const { positions: p, indices: ix } = results[fi];
            for (let t = 0; t < ix.length; t += 3) {
                const a = ix[t] * 3, b1 = ix[t + 1] * 3, c = ix[t + 2] * 3;
                const e1x = p[b1] - p[a], e1y = p[b1 + 1] - p[a + 1], e1z = p[b1 + 2] - p[a + 2];
                const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
                const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-18) continue;
                const inv = 1 / det, sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2];
                const u = (sx * px + sy * py + sz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                if ((e2x * qx + e2y * qy + e2z * qz) * inv > eps) count++;
            }
        }
        return count;
    };
    return fi => {
        const { positions: p, indices: ix } = results[fi];
        let best = -1, ba = 0, nx = 0, ny = 0, nz = 0;
        for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, ar = Math.hypot(cx, cy, cz);
            if (ar > ba) { ba = ar; best = t; nx = cx / ar; ny = cy / ar; nz = cz / ar; }
        }
        if (best < 0) return 0;
        const a = ix[best] * 3, b = ix[best + 1] * 3, c = ix[best + 2] * 3;
        const o = [(p[a] + p[b] + p[c]) / 3 + nx * eps * 10, (p[a + 1] + p[b + 1] + p[c + 1]) / 3 + ny * eps * 10, (p[a + 2] + p[b + 2] + p[c + 2]) / 3 + nz * eps * 10];
        let odd = 0;
        for (const [jx, jy, jz] of [[0, 0, 0], [0.013, 0.021, -0.017], [-0.019, 0.011, 0.015]]) {
            const l = Math.hypot(nx + jx, ny + jy, nz + jz);
            if (hits(o, [(nx + jx) / l, (ny + jy) / l, (nz + jz) / l]) % 2) odd++;
        }
        return odd >= 2 ? 1 : -1;
    };
}

/**
 * Boundary edges of all faces of a solid, matched by position (edges are sampled identically per face).
 * Typed open-addressing hash tables instead of a Map with string keys: a car assembly (a single solid
 * with 79 000 faces, millions of edges) needed several GB of JS heap that way – shared with all workers
 * (one 4 GB V8 pointer cage per tab), the tab crashed. Typed arrays live outside the cage.
 * Positions are compared like the former string keys (exact value, -0 = 0).
 * Returns { edgeCount, uses }: per edge 5 entries [count, face0, dir0, face1, dir1] (dir +1: from the lower
 * to the higher vertex id); only the first two uses are stored, count keeps counting.
 */
const HASH_F64 = new Float64Array(1), HASH_U32 = new Uint32Array(HASH_F64.buffer);
const hashNumber = (h, x) => {
    HASH_F64[0] = x + 0;   // -0 → 0
    h = Math.imul(h ^ HASH_U32[0], 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 15) ^ HASH_U32[1], 0x85EBCA77);
    return h ^ (h >>> 13);
};
const growArray = (a, min) => { const b = new a.constructor(Math.max(a.length * 2, min)); b.set(a); return b; };
const pow2Above = x => { let c = 1024; while (c < x) c *= 2; return c; };

function collectEdgeUses(results) {
    let endpoints = 0;
    for (const r of results) if (r && r.edges) endpoints += r.edges.length;
    // vertices: slot -> vertex id (-1 = empty), coordinates per id
    let vMask = pow2Above(endpoints / 2) - 1, vSlots = new Int32Array(vMask + 1).fill(-1);
    let coords = new Float64Array(3072), vCount = 0;
    const vHash = (x, y, z) => hashNumber(hashNumber(hashNumber(0x811C9DC5, x), y), z) & vMask;
    const vertexId = (x, y, z) => {
        let h = vHash(x, y, z);
        for (let id = vSlots[h]; id >= 0; h = (h + 1) & vMask, id = vSlots[h]) {
            if (coords[id * 3] === x && coords[id * 3 + 1] === y && coords[id * 3 + 2] === z) return id;
        }
        const id = vCount++;
        if (vCount * 3 > coords.length) coords = growArray(coords, vCount * 3);
        coords[id * 3] = x; coords[id * 3 + 1] = y; coords[id * 3 + 2] = z;
        vSlots[h] = id;
        if (vCount > (vMask + 1) * 0.6) {
            vMask = vMask * 2 + 1;
            vSlots = new Int32Array(vMask + 1).fill(-1);
            for (let v = 0; v < vCount; v++) {
                let s = vHash(coords[v * 3], coords[v * 3 + 1], coords[v * 3 + 2]);
                while (vSlots[s] >= 0) s = (s + 1) & vMask;
                vSlots[s] = v;
            }
        }
        return id;
    };
    // undirected edges (lower, higher vertex id): slot -> edge id
    let eMask = pow2Above(endpoints / 2) - 1, eSlots = new Int32Array(eMask + 1).fill(-1);
    let ends = new Int32Array(2048), uses = new Int32Array(5120), edgeCount = 0;
    const eHash = (a, b) => { const h = Math.imul(a ^ Math.imul(b, 0x85EBCA77), 0x9E3779B1); return (h ^ (h >>> 15)) & eMask; };
    for (let fi = 0; fi < results.length; fi++) {
        const r = results[fi];
        if (!r || !r.edges) continue;
        const { positions: p, edges: e } = r;
        for (let k = 0; k < e.length; k += 2) {
            const i = e[k] * 3, j = e[k + 1] * 3;
            const A = vertexId(p[i], p[i + 1], p[i + 2]), B = vertexId(p[j], p[j + 1], p[j + 2]);
            if (A === B) continue;
            const lo = A < B ? A : B, hi = A < B ? B : A, dir = A < B ? 1 : -1;
            let h = eHash(lo, hi), ei = eSlots[h];
            for (; ei >= 0; h = (h + 1) & eMask, ei = eSlots[h]) if (ends[ei * 2] === lo && ends[ei * 2 + 1] === hi) break;
            if (ei < 0) {
                ei = edgeCount++;
                if (edgeCount * 2 > ends.length) ends = growArray(ends, edgeCount * 2);
                if (edgeCount * 5 > uses.length) uses = growArray(uses, edgeCount * 5);
                ends[ei * 2] = lo; ends[ei * 2 + 1] = hi;
                eSlots[h] = ei;
                if (edgeCount > (eMask + 1) * 0.6) {
                    eMask = eMask * 2 + 1;
                    eSlots = new Int32Array(eMask + 1).fill(-1);
                    for (let q = 0; q < edgeCount; q++) {
                        let s = eHash(ends[q * 2], ends[q * 2 + 1]);
                        while (eSlots[s] >= 0) s = (s + 1) & eMask;
                        eSlots[s] = q;
                    }
                }
            }
            const c = uses[ei * 5]++;
            if (c < 2) { uses[ei * 5 + 1 + c * 2] = fi; uses[ei * 5 + 2 + c * 2] = dir; }
        }
    }
    // read-only lookup of a position's vertex id (-1: not a boundary vertex)
    const find = (x, y, z) => {
        for (let h = vHash(x, y, z), id = vSlots[h]; id >= 0; h = (h + 1) & vMask, id = vSlots[h]) {
            if (coords[id * 3] === x && coords[id * 3 + 1] === y && coords[id * 3 + 2] === z) return id;
        }
        return -1;
    };
    return { edgeCount, uses, ends, coords, find };
}

/**
 * Close cracks between neighbouring faces whose shared edge got different boundary points: a face on a curved
 * surface adds true curve points where its parametrisation needs them (densifyForSurface in tessellate.js), a
 * seam may be cut at an interpolated point – the neighbour, tessellated independently, keeps the plain edge
 * samples. Then one face has a single open edge A→B where another face has a chain of open edges A→M1→…→B (a
 * crack up to the chord error, or a T-junction). The long edge is split at the chain's points (positions copied
 * bit-exactly), its triangle is triangulated again with them (refan). Only chains of one other face between the
 * same two end points, ordered along the segment and close to it, and only if every new triangle faces like the old one.
 * Changes positions/normals/indices/edges of the affected results in place. Returns the number of split edges.
 */
function weldOpenChains(results, { edgeCount, uses, ends, coords, find }) {
    const open = [];
    for (let ei = 0; ei < edgeCount; ei++) if (uses[ei * 5] === 1) open.push(ei);
    if (!open.length) return 0;
    const at = new Map();   // vertex id -> open edges at it
    const link = (v, ei) => { const l = at.get(v); if (l) l.push(ei); else at.set(v, [ei]); };
    for (const ei of open) { link(ends[ei * 2], ei); link(ends[ei * 2 + 1], ei); }
    const other = (ei, v) => (ends[ei * 2] === v ? ends[ei * 2 + 1] : ends[ei * 2]);
    const splits = new Map();   // face -> [[A, B, chain]] (A→B in the running direction of its triangle)
    for (const ei of open) {
        const F = uses[ei * 5 + 1], fwd = uses[ei * 5 + 2] > 0;
        const A = ends[ei * 2 + (fwd ? 0 : 1)], B = ends[ei * 2 + (fwd ? 1 : 0)];
        const ax = coords[A * 3], ay = coords[A * 3 + 1], az = coords[A * 3 + 2];
        const dx = coords[B * 3] - ax, dy = coords[B * 3 + 1] - ay, dz = coords[B * 3 + 2] - az;
        const L2 = dx * dx + dy * dy + dz * dz;
        if (!(L2 > 0)) continue;
        let chain = null;
        for (const e1 of at.get(A)) {
            const G = uses[e1 * 5 + 1];
            if (e1 === ei || G === F) continue;
            const pts = [];
            let prev = e1, v = other(e1, A), tPrev = 0;
            while (v !== B && pts.length < 64) {
                // ordered along the segment, close to it (a curve point off the chord is fine)
                const wx = coords[v * 3] - ax, wy = coords[v * 3 + 1] - ay, wz = coords[v * 3 + 2] - az;
                const t = (wx * dx + wy * dy + wz * dz) / L2;
                const ex = wx - dx * t, ey = wy - dy * t, ez = wz - dz * t;
                if (!(t > tPrev && t < 1) || ex * ex + ey * ey + ez * ez > 0.0625 * L2) break;
                pts.push(v); tPrev = t;
                let next = -1;
                for (const e2 of at.get(v)) if (e2 !== prev && uses[e2 * 5 + 1] === G) { next = next < 0 ? e2 : -2; if (next === -2) break; }
                if (next < 0) break;
                prev = next; v = other(next, v);
            }
            if (v === B && pts.length) { chain = pts; break; }
        }
        if (!chain) continue;
        let l = splits.get(F);
        if (!l) splits.set(F, l = []);
        l.push([A, B, chain]);
    }
    let welded = 0;
    for (const [F, list] of splits) {
        const r = results[F];
        const P = Array.from(r.positions), N = Array.from(r.normals), E = Array.from(r.edges);
        const tri = Array.from(r.indices);
        let nv = P.length / 3;
        // local vertex per boundary vertex id
        const local = new Map();
        for (const v of r.edges) local.set(find(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]), v);
        // directed edge -> triangle (offset into tri)
        const K = 4294967296, byEdge = new Map();
        const register = o => { for (let k = 0; k < 3; k++) byEdge.set(tri[o + k] * K + tri[o + (k + 1) % 3], o); };
        for (let o = 0; o < tri.length; o += 3) register(o);
        for (const [A, B, chain] of list) {
            const a = local.get(A), b = local.get(B);
            const o = a === undefined || b === undefined ? undefined : byEdge.get(a * K + b);
            if (o === undefined) continue;
            const k = tri.indexOf(a, o) - o, c = tri[o + (k + 2) % 3];
            const tris = refan(P, N, a, b, c, chain.map(v => [coords[v * 3], coords[v * 3 + 1], coords[v * 3 + 2]]));
            if (!tris) continue;
            // new vertices (polygon positions 1..chain.length), then the triangles; the first one takes the old one's place
            const ids = [a];
            for (const { p, n } of tris.points) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); ids.push(nv++); }
            ids.push(b, c);
            tris.faces.forEach(([x, y, z], q) => {
                const off = q === 0 ? o : tri.length;
                tri[off] = ids[x]; tri[off + 1] = ids[y]; tri[off + 2] = ids[z];
                register(off);
            });
            byEdge.delete(a * K + b);
            // boundary edge a→b becomes the chain
            for (let q = 0; q < E.length; q += 2) {
                if (E[q] !== a || E[q + 1] !== b) continue;
                const chainEdges = [];
                for (let m = 0; m < ids.length - 2; m++) chainEdges.push(ids[m], ids[m + 1]);
                E.splice(q, 2, ...chainEdges);
                break;
            }
            welded++;
        }
        r.positions = Float32Array.from(P); r.normals = Float32Array.from(N);
        r.indices = Uint32Array.from(tri); r.edges = Int32Array.from(E);
    }
    return welded;
}

// Ear clipping of a small simple counter-clockwise polygon [{x, y}] → [[i, j, k]] (counter-clockwise), null if stuck
function clipEars(pts) {
    const idx = pts.map((_, i) => i), out = [];
    const cr = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    while (idx.length > 3) {
        let cut = -1;
        for (let k = 0; k < idx.length && cut < 0; k++) {
            const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
            const p = pts[i0], q = pts[i1], r = pts[i2];
            if (!(cr(p, q, r) > 0)) continue;
            // no other vertex inside or on the ear
            let empty = true;
            for (const j of idx) {
                if (j === i0 || j === i1 || j === i2) continue;
                const v = pts[j];
                if (cr(p, q, v) >= 0 && cr(q, r, v) >= 0 && cr(r, p, v) >= 0) { empty = false; break; }
            }
            if (empty) cut = k;
        }
        if (cut < 0) return null;
        out.push([idx[(cut + idx.length - 1) % idx.length], idx[cut], idx[(cut + 1) % idx.length]]);
        idx.splice(cut, 1);
    }
    out.push([idx[0], idx[1], idx[2]]);
    return out;
}

/**
 * Triangulate triangle a,b,c (local vertices of P/N, running a→b→c) again with the points chain between a and b:
 * polygon a, chain…, b, c in the triangle's plane (a fan from c flips where c lies close to a bulging chain).
 * Returns { points: [{ p, n }] (the chain with normals interpolated along a→b), faces: [[i, j, k]] (polygon
 * positions, running like a→b→c) } or null if the polygon is not simple there or a triangle would face differently
 * from the old one (or from the vertex normals, where the old one agreed with them).
 */
function refan(P, N, a, b, c, chain) {
    const pos = i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], nor = i => [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
    const sub3 = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dot3 = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const pa = pos(a), pb = pos(b), pc = pos(c), ab = sub3(pb, pa);
    const n0 = cross3(ab, sub3(pc, pa)), l0 = Math.hypot(...n0), lab = Math.hypot(...ab);
    if (!(l0 > 0) || !(lab > 0)) return null;
    const points = chain.map(p => {
        const t = dot3(sub3(p, pa), ab) / (lab * lab), na = nor(a), nb = nor(b);
        const m = [na[0] * (1 - t) + nb[0] * t, na[1] * (1 - t) + nb[1] * t, na[2] * (1 - t) + nb[2] * t], ml = Math.hypot(...m) || 1;
        return { p, n: [m[0] / ml, m[1] / ml, m[2] / ml] };
    });
    const poly = [pa, ...chain, pb, pc], pn = [nor(a), ...points.map(q => q.n), nor(b), nor(c)];
    // 2D in the triangle's plane: a→b along x, c on the positive side
    const ex = ab.map(x => x / lab), nz = n0.map(x => x / l0), ey = cross3(nz, ex);
    const flat = poly.map(p => { const d = sub3(p, pa); return { x: dot3(d, ex), y: dot3(d, ey) }; });
    let area = 0;
    for (let i = 0; i < flat.length; i++) { const p = flat[i], q = flat[(i + 1) % flat.length]; area += p.x * q.y - q.x * p.y; }
    if (!(area > 0)) return null;
    const faces = clipEars(flat);
    if (!faces) return null;
    const agrees = (n, f) => dot3(n, [pn[f[0]][0] + pn[f[1]][0] + pn[f[2]][0], pn[f[0]][1] + pn[f[1]][1] + pn[f[2]][1], pn[f[0]][2] + pn[f[1]][2] + pn[f[2]][2]]) > 0;
    const strict = agrees(n0, [0, poly.length - 2, poly.length - 1]);
    let sum = 0;
    for (const f of faces) {
        const [x, y, z] = f.map(i => flat[i]);
        let s2 = (y.x - x.x) * (z.y - x.y) - (y.y - x.y) * (z.x - x.x);
        if (s2 < 0) { [f[1], f[2]] = [f[2], f[1]]; s2 = -s2; }
        sum += s2;
        const n = cross3(sub3(poly[f[1]], poly[f[0]]), sub3(poly[f[2]], poly[f[0]])), ln = Math.hypot(...n);
        if (!(ln > 1e-12 * l0) || dot3(n, n0) <= 1e-9 * l0 * ln || (strict && !agrees(n, f))) return null;
    }
    // the triangles must cover the polygon exactly (not simple in this projection otherwise)
    if (Math.abs(sum - area) > 1e-6 * area) return null;
    return { points, faces };
}

/**
 * Make the orientation of a solid's faces consistent (like ShapeFix in OpenCascade).
 * Some exports (CATIA, spline surfaces) state `same_sense` wrongly – the face then points inwards
 * and is invisible with FrontSide materials ("holes", Basic with DoubleSide looks closed).
 * In a correctly oriented shell, two neighbouring faces traverse their shared edge in opposite
 * directions. Shared boundary edges (same boundary points – edges are sampled identically per face;
 * only edges with exactly two faces) determine which faces have to be flipped; the overall direction
 * per shell is chosen so that as few faces as possible flip relative to the file. These candidates
 * are confirmed group-wise by a ray test (insideTester) – only then flipped.
 * Strongest face pairs decide first (union-find with parity); if more than 2 % of a shell's edge
 * weight disagrees, it stays unchanged. Returns the number of flipped faces.
 */
export function orientFaces(s, results) {
    const n = results.length;
    // first close cracks of differently sampled shared edges (same edge matching, then matched again)
    let edgeUses = collectEdgeUses(results);
    if (weldOpenChains(results, edgeUses)) edgeUses = collectEdgeUses(results);
    const { edgeCount, uses } = edgeUses;
    // Face pairs via edges with exactly two faces (otherwise touching sub-solids, seams …):
    // weight = number of opposite minus same-direction shared edges
    const pairW = new Map();
    let openEdges = 0;
    for (let ei = 0; ei < edgeCount; ei++) {
        const count = uses[ei * 5];
        if (count === 1) openEdges++;
        if (count !== 2 || uses[ei * 5 + 1] === uses[ei * 5 + 3]) continue;
        const a = uses[ei * 5 + 1], da = uses[ei * 5 + 2], b = uses[ei * 5 + 3], db = uses[ei * 5 + 4];
        const k = a < b ? a * n + b : b * n + a;
        pairW.set(k, (pairW.get(k) || 0) + (da !== db ? 1 : -1));
    }
    // Union-find with parity: strongest pairs first (maximum spanning forest) – single contradicting
    // edges (folded triangles, edge cases at transitions) are outvoted this way instead of blocking the
    // whole shell. Parity 1 = flip face relative to the root.
    const parent = new Int32Array(n).map((_, i) => i), par = new Uint8Array(n);
    const find = x => {
        let p = 0, r = x;
        while (parent[r] !== r) { p ^= par[r]; r = parent[r]; }
        // path compression
        let y = x, py = p;
        while (parent[y] !== y) { const next = parent[y], pn = py ^ par[y]; parent[y] = r; par[y] = py; y = next; py = pn; }
        return [r, p];
    };
    // strongest first; on a tie, agreeing (opposite) pairs before contradicting ones –
    // otherwise chance decides when all pairs have weight 1 (a circular pattern feature: a single
    // same-direction edge flipped planes that two neighbours confirmed as correct)
    const pairs = [...pairW].filter(([, w]) => w !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || b[1] - a[1]);
    for (const [k, w] of pairs) {
        const a = Math.floor(k / n), b = k % n, rel = w > 0 ? 0 : 1;
        const [ra, pa] = find(a), [rb, pb] = find(b);
        if (ra !== rb) { parent[rb] = ra; par[rb] = pa ^ pb ^ rel; }
    }
    const flipOf = new Uint8Array(n), root = new Int32Array(n);
    for (let fi = 0; fi < n; fi++) { const [r, p] = find(fi); root[fi] = r; flipOf[fi] = p; }
    // local refinement: flip a face if more edge weight agrees with it afterwards
    const adj = Array.from({ length: n }, () => []);
    for (const [k, w] of pairs) { const a = Math.floor(k / n), b = k % n; adj[a].push(b, w); adj[b].push(a, w); }
    const disagree = (fi, f) => { let d = 0; const l = adj[fi]; for (let q = 0; q < l.length; q += 2) { const rel = l[q + 1] > 0 ? 0 : 1; if ((f ^ flipOf[l[q]]) !== rel) d += Math.abs(l[q + 1]); else d -= Math.abs(l[q + 1]); } return d; };
    for (let pass = 0; pass < 10; pass++) {
        let changed = false;
        for (let fi = 0; fi < n; fi++) if (adj[fi].length && disagree(fi, flipOf[fi]) > 0) { flipOf[fi] ^= 1; changed = true; }
        if (!changed) break;
    }
    // collect components (shells), count contradictions after the refinement
    const comps = new Map();
    for (let fi = 0; fi < n; fi++) {
        if (!results[fi]) continue;
        let c = comps.get(root[fi]);
        if (!c) comps.set(root[fi], c = { faces: [], flip: [], weight: 0, bad: 0 });
        c.faces.push(fi); c.flip.push(flipOf[fi]);
    }
    for (const [k, w] of pairs) {
        const a = Math.floor(k / n), b = k % n, c = comps.get(root[a]);
        c.weight += Math.abs(w);
        if ((flipOf[a] ^ flipOf[b]) !== (w > 0 ? 0 : 1)) c.bad += Math.abs(w);
    }
    // Shells with two orientation classes (parity 0/1): the geometry decides which class is wrong –
    // a ray along the normal hitting the own solid an odd number of times = points inwards.
    // Every connected group of a class is checked separately. The edge votes alone were unreliable for
    // SLA/spline data, a majority rule fails for small parts that are mostly wrong
    // (seen: 8 of 10 faces). Only (nearly) closed shells.
    const candidate = new Uint8Array(n);
    for (const c of comps.values()) {
        if (c.faces.length < 2 || c.bad > c.weight * 0.02) continue;
        const ones = c.flip.filter(f => f).length;
        if (ones === 0 || ones === c.faces.length) continue;   // consistent: nothing to do
        for (const fi of c.faces) candidate[fi] = 1;
    }
    const flipFace = fi => {
        const { normals: nr, indices: ix } = results[fi];
        for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
        for (let q = 0; q < nr.length; q++) nr[q] = -nr[q];
    };
    let flipped = 0;
    // Surface models have no inside for the ray test: a skin with two classes is made consistent along its edges
    // (the smaller class by area turns), orientSkins then chooses its side. Seen: a hull of 39 spline patches with
    // half of them reversed – invisible from outside with FrontSide materials.
    if (s.surface) {
        const area = fi => {
            const { positions: p, indices: ix } = results[fi];
            let a = 0;
            for (let t = 0; t < ix.length; t += 3) {
                const i = ix[t] * 3, j = ix[t + 1] * 3, k = ix[t + 2] * 3;
                const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2], vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
                a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            }
            return a;
        };
        for (const c of comps.values()) {
            if (c.faces.length < 2 || c.bad > c.weight * 0.02) continue;
            let a1 = 0, a0 = 0;
            c.faces.forEach((fi, k) => { if (c.flip[k]) a1 += area(fi); else a0 += area(fi); });
            if (!a1 || !a0) continue;
            const turn = a1 <= a0 ? 1 : 0;
            c.faces.forEach((fi, k) => { candidate[fi] = 0; if (c.flip[k] === turn) { flipFace(fi); flipped++; } });
        }
    }
    if (candidate.some(Boolean) && openEdges <= edgeCount * 0.05) {
        const inside = insideTester(results);
        // check connected candidate groups (via adjacency) together
        const seenF = new Uint8Array(n);
        for (let start = 0; start < n; start++) {
            if (!candidate[start] || seenF[start]) continue;
            const group = [start];
            seenF[start] = 1;
            for (let h = 0; h < group.length; h++) {
                const l = adj[group[h]];
                // only neighbours of the same class (same parity)
                for (let q = 0; q < l.length; q += 2) if (candidate[l[q]] && !seenF[l[q]] && flipOf[l[q]] === flipOf[group[h]]) { seenF[l[q]] = 1; group.push(l[q]); }
            }
            // sample: up to 5 faces of the group (largest first), largest triangle of each
            const sample = group.slice().sort((a, b) => results[b].indices.length - results[a].indices.length).slice(0, 5);
            let inward = 0, outward = 0;
            for (const fi of sample) { const v = inside(fi); if (v > 0) inward++; else if (v < 0) outward++; }
            if (inward <= outward) continue;
            for (const fi of group) { flipFace(fi); flipped++; }
        }
    }
    if (s.surface) flipped += orientSkins(results, root, flipFace);
    return flipped;
}

/**
 * Surface models (SHELL_BASED_SURFACE_MODEL, open shells): STEP defines no inside for a skin, CAD systems
 * orient it arbitrarily (a vehicle cabin: a perfectly consistent skin with 97 % of its area facing
 * inward – looks flipped with FrontSide materials). Turn every connected skin (root = component id
 * from orientFaces) so its normals point away from the centre of the whole body (area weighted,
 * measured against the body centre so separate panels like doors match the rest). Only if clearly
 * inward – flat single sheets (no clear side) stay as they are. Returns the number of flipped faces.
 */
function orientSkins(results, root, flipFace) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const r of results) {
        if (!r) continue;
        const p = r.positions;
        for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < mn[c]) mn[c] = p[i + c]; if (p[i + c] > mx[c]) mx[c] = p[i + c]; }
    }
    const C = mn.map((v, c) => (v + mx[c]) / 2);
    const skins = new Map();   // component -> { faces, out (signed), total (abs) }
    results.forEach((r, fi) => {
        if (!r) return;
        let sk = skins.get(root[fi]);
        if (!sk) skins.set(root[fi], sk = { faces: [], out: 0, total: 0 });
        sk.faces.push(fi);
        const { positions: p, indices: ix } = r;
        for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            // (triangle centre − body centre) · (area-weighted normal)
            const m = ((p[a] + p[b] + p[c]) / 3 - C[0]) * (uy * vz - uz * vy)
                + ((p[a + 1] + p[b + 1] + p[c + 1]) / 3 - C[1]) * (uz * vx - ux * vz)
                + ((p[a + 2] + p[b + 2] + p[c + 2]) / 3 - C[2]) * (ux * vy - uy * vx);
            sk.out += m;
            sk.total += Math.abs(m);
        }
    });
    let flipped = 0;
    for (const sk of skins.values()) {
        if (sk.total === 0 || sk.out > -0.2 * sk.total) continue;   // outward or undecided
        for (const fi of sk.faces) { flipFace(fi); flipped++; }
    }
    return flipped;
}

// Assemble the faces of a solid into geometries: one per face colour
function assembleSolid(s, results, geometries, onFlipped) {
    const flipped = orientFaces(s, results);
    if (flipped) onFlipped?.(flipped);
    const byColor = new Map();
    s.faces.forEach((_, fi) => {
        const r = results[fi];
        if (!r) return;
        const c = s.faceColors[fi];
        const key = c ? c.join(',') : '';
        if (!byColor.has(key)) byColor.set(key, { color: c, faces: [] });
        byColor.get(key).faces.push(r);
    });
    const groups = [];
    for (const { color, faces } of byColor.values()) {
        let nv = 0, ni = 0;
        for (const f of faces) { nv += f.positions.length / 3; ni += f.indices.length; }
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), index = new Uint32Array(ni);
        let vo = 0, io = 0;
        for (const f of faces) {
            positions.set(f.positions, vo * 3);
            normals.set(f.normals, vo * 3);
            const src = f.indices;
            for (let k = 0; k < src.length; k++) index[io + k] = src[k] + vo;
            vo += f.positions.length / 3;
            io += src.length;
        }
        groups.push({ geometry: geometries.length, color });
        const g = boxProject({ positions, normals, index });
        geometries.push({ positions: g.positions, normals: g.normals, index: g.index, uvs: g.uvs, name: s.name });
    }
    return groups;
}

// Build BVH (+ tangents) of one geometry in a worker; buffers are transferred there and back.
// shapeSeed > 0: also the shape fingerprint (g.shape, for the Instancer)
async function buildBVH(w, g, shapeSeed = 0) {
    const bytes = bvhJobBytes(g);
    await gate().acquire(bytes);
    let r;
    try {
        r = await requestWorker(w, { type: 'bvh', positions: g.positions, index: g.index, normals: g.normals, uvs: g.uvs, shape: shapeSeed > 0, seed: shapeSeed },
            [g.positions.buffer, g.index.buffer, g.normals.buffer, g.uvs.buffer]);
    } finally {
        gate().release(bytes);
    }
    if (r.shape) g.shape = r.shape;
    g.positions = r.positions;
    g.index = r.index;
    g.bvh = r.roots;
    g.normals = r.normals;
    g.uvs = r.uvs;
    g.tangents = r.tangents;
}

// Distribute the BVHs of all geometries dynamically to the workers, largest first (better utilisation).
async function buildBVHs(geometries, onStatus) {
    const order = geometries.map((_, i) => i)
        .sort((a, b) => geometries[b].index.length - geometries[a].index.length);
    let next = 0, done = 0;
    const runWorker = async w => {
        while (next < order.length) {
            await buildBVH(w, geometries[order[next++]]);
            done++;
            onStatus(t('import.step.buildingBvh', { done, total: order.length }), done / order.length);
        }
    };
    await Promise.all(pool.workers.map(runWorker));
}

/**
 * BVH + tangents of a single geometry in its own short-lived worker – independent of the pool,
 * so an import starting at the same time does not collide with the same worker
 * (e.g. ground disc at startup). g as for buildGeometryBVHs.
 */
export async function buildBVHIsolated(g) {
    const w = createWorker();
    try { await buildBVH(w, g); } finally { w.terminate(); }
}

/**
 * The worker pool for another importer's jobs (STL in parts, stl/stl-import.js – step/worker.js forwards them): the STEP
 * pool, created for this file size if there is none. Abort (abortStepImport) ends its requests like the STEP ones.
 */
export function importPool(fileSize = 0, shared = true) {
    pool ??= new WorkerPool(poolSize(fileSize, shared));
    return pool;
}

/** After such an import: the workers are ended (idle workers hardly ever return their memory) – unless a STEP file is open */
export function releaseImportPool() {
    if (!session) disposeStepImporter();
}

/**
 * Build BVHs + tangents for foreign geometries (glTF/FBX import) in the worker pool.
 * Every geometry needs its own buffers (they are transferred to the worker and replaced).
 */
export async function buildGeometryBVHs(geometries, onStatus = () => {}) {
    pool ??= new WorkerPool(poolSize());
    await buildBVHs(geometries, onStatus);
}

/**
 * Release file and index (large files after the import). The workers are terminated: idle workers
 * practically never collect their memory, so the file (SharedArrayBuffer) would stay in the
 * process – every re-tessellation would have piled up another copy (+400 MB per run).
 * The next call of tessellateStep starts a new pool and rebuilds the index.
 */
export function releaseStepFile() {
    if (!session) return;
    disposeStepImporter();
}

/**
 * Abort a running import immediately (new model dropped): terminate the worker pool, pending requests
 * end with AbortError. The next import starts a new pool.
 */
export function abortStepImport() {
    const err = new DOMException('Import aborted', 'AbortError');
    for (const e of [...inflight]) if (pool?.workers.includes(e.w)) { inflight.delete(e); e.reject(err); }
    disposeStepImporter();
}

// Release worker pool and cache
export function disposeStepImporter() {
    pool?.terminate();
    pool = null;
    bvhGate = null;   // builds of terminated workers never release their share
    session = null;
}
