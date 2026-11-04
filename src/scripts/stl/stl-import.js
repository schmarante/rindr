// STL import in parts on all workers – main thread: sends the jobs (stl-jobs.js in the STEP worker pool), unites the
// parts across chunks, decides the orientation of open pieces from the ray tests, finds copies, builds the result in
// the structure of the other importers (nodes / geometries / meshes, mesh-importer.js). Steps: stl-core.js.
// No i18n or pool here (mesh-importer.js passes them in – this file also runs in Node tests).

import { debugLog } from '../log.js';
import { DEFAULT_COLOR, NO_COLOR } from './stl-core.js';

// chunks of a fixed size (≈ 80 MB of temporary arrays while analysing), independent of the worker count: parts across
// chunks are joined, but a few cases differ from one whole analysis (a two-sided sheet whose back is in another chunk
// stays two parts) – with fixed borders the parts, their numbers and so the mesh keys of scene states are the same on
// every device
const CHUNK_TRIANGLES = 1 << 19;
const MAX_ROOTS = 8;                 // copy search: shapes tried per group of equal fingerprints
const FEATURE_TOL = 1e-4;            // fingerprints (area, spread, extent) equal within this
const BUILD_TRIANGLES = 1 << 18;     // triangles per build job (progress, several jobs per worker)

export { DEFAULT_COLOR, NO_COLOR };

/**
 * Colour of a code (sRGB 0..1): 15-bit RGB of the facet (red in the low bits, as three's STLLoader), the header's
 * default colour, null without colours.
 */
export function colorOfCode(code, defaultRgb) {
    if (code === NO_COLOR) return null;
    if (code === DEFAULT_COLOR) return defaultRgb;
    return [(code & 31) / 31, ((code >> 5) & 31) / 31, ((code >> 10) & 31) / 31];
}

/**
 * Layout of an STL from its first bytes (up to 1 KB) and the file size: { kind: 'binary', count, colors, defaultRgb,
 * header } | { kind: 'text' }. Binary when the face count of the header matches the length; text when the start is
 * only text bytes; otherwise binary with as many faces as the length holds (a warning, like normalizeStl).
 */
export function stlLayout(head, size) {
    const count = size >= 84 ? new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(80, true) : -1;
    const exact = size >= 84 && 84 + count * 50 === size;
    if (!exact && !head.subarray(0, Math.min(head.length, 1024)).some(b => b === 0 || b < 9 || (b > 13 && b < 32))) return { kind: 'text' };
    if (size < 84) throw new Error('STL file too short');
    const faces = exact ? count : Math.floor((size - 84) / 50);
    if (!exact) console.warn(`[STL] header face count ${count} does not match the file length – reading ${faces} faces`);
    // "COLOR=rgba" in the header: facet colours with this default (three's STLLoader reads the same)
    let colors = false, defaultRgb = null;
    for (let i = 0; i <= 70; i++) {
        if (head[i] === 0x43 && head[i + 1] === 0x4F && head[i + 2] === 0x4C && head[i + 3] === 0x4F && head[i + 4] === 0x52 && head[i + 5] === 0x3D) {
            colors = true;
            defaultRgb = [head[i + 6] / 255, head[i + 7] / 255, head[i + 8] / 255];
        }
    }
    return { kind: 'binary', count: faces, colors, defaultRgb, header: new TextDecoder().decode(head.slice(0, 80)) };
}

/**
 * @param {{ bytes?: Uint8Array, count?: number, colors?: boolean, positions?: Float32Array }} input binary: the file
 *   bytes (shared or not), face count, colour flag; text: positions (9 per triangle)
 * @param {object} hooks { pool ({ workers, request(w, msg, transfer) }), shared (bytes are a SharedArrayBuffer),
 *   status(step, fraction), checkSize(uniqueTriangles) → Promise<boolean>, limit (the triangles above which checkSize
 *   asks – given: certain parts are built before the copies are known), bvh, onLarge, largeAbove,
 *   onPlan({ count, box }) once the parts are known, onParts([{ index, copyOf, align, geometries }], geometries) for
 *   finished parts (streaming) }
 * @returns {{ parts, box, geometries, instances, stats }} parts in file order: { tris, copyOf, align }; geometries per
 *   part: [{ code, gi }]; instances: per part { geometries: [{ code, gi }], align (column-major 4 × 4 or null) }
 */
export async function importStlParts(input, hooks) {
    const { pool } = hooks;
    try {
        return await run(input, hooks);
    } finally {
        // the workers drop their soups – also after an error or a cancelled size check (a terminated pool – aborted import –
        // has no workers any more: requests there would never be answered)
        if (pool.workers.length) await Promise.allSettled(pool.workers.map(w => pool.request(w, { type: 'stl:clear' })));
    }
}

async function run(input, hooks) {
    const { pool, status = () => {} } = hooks;
    const workers = pool.workers, k = workers.length;
    const times = {};
    let t = performance.now();
    const lap = name => { const now = performance.now(); times[name] = Math.round(now - t); t = now; };
    const n = input.positions ? input.positions.length / 9 : input.count;

    // 1. chunks: read + analyse on all workers (the next chunk to the next free worker)
    const size = hooks.chunkTriangles || CHUNK_TRIANGLES;   // (tests: other sizes)
    const chunks = Math.max(1, Math.ceil(n / size));
    const at = i => Math.min(n, i * size);
    const soupWorker = [], reads = [];
    let done = 0, next = 0;
    status('analyzing', 0);
    const readChunk = (w, c) => {
        const from = at(c), to = at(c + 1);
        soupWorker[c] = w;
        let msg, transfer = [];
        if (input.positions) {
            const positions = input.positions.slice(from * 9, to * 9);
            msg = { type: 'stl:soup', soup: c, positions: positions.buffer, gstart: from };
            transfer = [positions.buffer];
        } else if (hooks.shared) {
            msg = { type: 'stl:read', soup: c, bytes: input.bytes.buffer, offset: input.bytes.byteOffset + 84 + from * 50, count: to - from, colors: input.colors, gstart: from };
        } else {
            // without shared memory: a copy of just this chunk, transferred
            const bytes = input.bytes.slice(84 + from * 50, 84 + to * 50);
            msg = { type: 'stl:read', soup: c, bytes: bytes.buffer, offset: 0, count: to - from, colors: input.colors, gstart: from };
            transfer = [bytes.buffer];
        }
        return pool.request(w, msg, transfer).then(r => { reads[c] = r; status('analyzing', ++done / chunks); });
    };
    await Promise.all(workers.map(async w => { while (next < chunks) await readChunk(w, next++); }));
    input = null;   // the file is no longer needed here (the workers have their chunks)
    lap('analyse');

    // 2. join the chunks: (soup, part) nodes united over edges used once in two chunks
    const summaries = [...reads];
    const base = [0];
    for (const r of summaries) base.push(base[base.length - 1] + r.parts.count);
    const parent = new Int32Array(base[base.length - 1]);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    let joins = 0;
    if (chunks > 1) {
        status('joining', null);
        const lists = reads.map(r => r.open);
        const { pairs } = await pool.request(workers[0], { type: 'stl:join', lists }, lists.flatMap(l => [l.bits.buffer, l.part.buffer]));
        for (let i = 0; i < pairs.length; i += 4) {
            const a = find(base[pairs[i]] + pairs[i + 1]), b = find(base[pairs[i + 2]] + pairs[i + 3]);
            if (a !== b) { parent[Math.max(a, b)] = Math.min(a, b); joins++; }
        }
    }
    // groups of more than one node: gathered into the worker of the soup holding most of their triangles
    const groupOf = new Map();   // root → [node]
    for (let s = 0; s < reads.length; s++) {
        for (let p = 0; p < reads[s].parts.count; p++) {
            const node = base[s] + p, r = find(node);
            if (!groupOf.has(r)) groupOf.set(r, []);
            groupOf.get(r).push(node);
        }
    }
    const soupOfNode = node => { let lo = 0, hi = reads.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (base[m] <= node) lo = m; else hi = m - 1; } return lo; };
    const spanning = [...groupOf.values()].filter(g => g.length > 1);
    const moved = new Set();   // nodes whose triangles went into a gathered soup
    if (spanning.length) {
        const exports = new Map();   // soup → [[parts of group g], …] in the order of `spanning`
        spanning.forEach((g, gi) => {
            for (const node of g) {
                moved.add(node);
                const s = soupOfNode(node);
                if (!exports.has(s)) exports.set(s, new Map());
                const m = exports.get(s);
                if (!m.has(gi)) m.set(gi, []);
                m.get(gi).push(node - base[s]);
            }
        });
        // per soup one job; pieces in soup order = file order
        const pieces = new Map();   // group → [{ P, codes, gidx }] in soup order
        const soups = [...exports.keys()].sort((a, b) => a - b);
        const answers = await Promise.all(soups.map(s => pool.request(soupWorker[s], { type: 'stl:export', soup: s, groups: [...exports.get(s).values()] })));
        soups.forEach((s, i) => [...exports.get(s).keys()].forEach((gi, j) => {
            if (!pieces.has(gi)) pieces.set(gi, []);
            pieces.get(gi).push({ s, ...answers[i].items[j] });
        }));
        const adopted = await Promise.all(spanning.map((g, gi) => {
            const list = pieces.get(gi).sort((a, b) => a.s - b.s);
            const m = list.reduce((x, l) => x + l.codes.length, 0);
            const P = new Float32Array(m * 9), codes = new Uint16Array(m), gidx = new Int32Array(m);
            let w = 0;
            for (const l of list) { P.set(l.P, w * 9); codes.set(l.codes, w); gidx.set(l.gidx, w); w += l.codes.length; }
            // owner: the soup with most triangles of the group
            const tris = new Map();
            for (const node of g) { const s = soupOfNode(node); tris.set(s, (tris.get(s) || 0) + reads[s].parts.tris[node - base[s]]); }
            const owner = [...tris].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
            const id = summaries.length + gi;
            soupWorker[id] = soupWorker[owner];
            return pool.request(soupWorker[id], { type: 'stl:adopt', soup: id, P: P.buffer, codes: codes.buffer, gidx: gidx.buffer }, [P.buffer, codes.buffer, gidx.buffer]);
        }));
        summaries.push(...adopted);
    }
    lap('join');

    // valid parts in file order (first triangle)
    const parts = [];
    let box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], dead = 0, broken = 0;
    summaries.forEach((r, s) => {
        if (s < reads.length) { dead += r.dead; broken += r.broken; }
        for (let p = 0; p < r.parts.count; p++) {
            if (s < reads.length && moved.has(base[s] + p)) continue;
            const b = Array.from(r.parts.box.subarray(p * 6, p * 6 + 6));
            parts.push({ soup: s, part: p, tris: r.parts.tris[p], first: r.parts.first[p], box: b });
            for (let i = 0; i < 3; i++) { box[i] = Math.min(box[i], b[i]); box[i + 3] = Math.max(box[i + 3], b[i + 3]); }
        }
    });
    parts.sort((a, b) => a.first - b.first);
    if (!parts.length) return { parts, box: null, stats: { triangles: n } };
    const diag = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) || 1;
    hooks.onPlan?.({ count: parts.length, box });   // the viewer sets up the nodes – parts stream in from step 5

    // 3. orientation: closed pieces decided in the workers, open ones by the ray test (all workers' triangles)
    status('orienting', null);
    const valid = summaries.map(() => new Set());
    for (const p of parts) valid[p.soup].add(p.part);
    const flips = summaries.map((r, s) => {
        const f = new Uint8Array(r.pieces.count);
        for (let q = 0; q < r.pieces.count; q++) if (valid[s].has(r.pieces.part[q]) && r.pieces.flipClosed[q]) f[q] = 1;
        return f;
    });
    // samples of the valid open pieces
    let ns = 0;
    summaries.forEach((r, s) => { for (let i = 0; i < r.samples.piece.length; i++) if (valid[s].has(r.pieces.part[r.samples.piece[i]])) ns++; });
    const pos = new Float32Array(ns * 3), nor = new Float32Array(ns * 3), sSoup = new Int32Array(ns), sPiece = new Int32Array(ns);
    {
        let w = 0;
        summaries.forEach((r, s) => {
            for (let i = 0; i < r.samples.piece.length; i++) {
                const q = r.samples.piece[i];
                if (!valid[s].has(r.pieces.part[q])) continue;
                pos.set(r.samples.pos.subarray(i * 3, i * 3 + 3), w * 3);
                nor.set(r.samples.nor.subarray(i * 3, i * 3 + 3), w * 3);
                sSoup[w] = s; sPiece[w] = q; w++;
            }
        });
    }
    let rays = 0, openFlipped = 0, closedFlipped = 0;
    for (const f of flips) for (const x of f) closedFlipped += x;
    if (ns) {
        const eps = diag * 1e-5, minHit = eps * 2;
        const cast = async (P, N, sign) => {
            rays += P.length / 3;
            const answers = await Promise.all(workers.map(w => pool.request(w, { type: 'stl:rays', pos: P, nor: N, sign, eps, minHit })));
            const blocked = new Uint8Array(P.length / 3);
            for (const a of answers) for (let i = 0; i < blocked.length; i++) blocked[i] |= a.blocked[i];
            return blocked;
        };
        const forward = await cast(pos, nor, 1);
        const back = [];
        for (let i = 0; i < ns; i++) if (forward[i]) back.push(i);
        const bp = new Float32Array(back.length * 3), bn = new Float32Array(back.length * 3);
        back.forEach((i, j) => { bp.set(pos.subarray(i * 3, i * 3 + 3), j * 3); bn.set(nor.subarray(i * 3, i * 3 + 3), j * 3); });
        const backward = back.length ? await cast(bp, bn, -1) : new Uint8Array(0);
        // votes per piece: the side whose rays escape more often is outside
        const votes = new Map();   // soup:piece → [out, in]
        const vote = (i, side) => { const key = sSoup[i] * 2 ** 26 + sPiece[i]; const v = votes.get(key) || [0, 0]; v[side]++; votes.set(key, v); };
        for (let i = 0; i < ns; i++) if (!forward[i]) vote(i, 0);
        back.forEach((i, j) => { if (!backward[j]) vote(i, 1); });
        for (const [key, [out, inside]] of votes) {
            const s = Math.floor(key / 2 ** 26), q = key % 2 ** 26, kq = summaries[s].pieces.k[q];
            if (inside > out && inside >= Math.max(1, kq / 4)) { flips[s][q] = 1; openFlipped++; }
        }
    }
    lap('orient');

    // flips applied in the workers, fingerprints of the parts back
    const perWorker = new Map();   // worker → { flips: {soup: arr}, parts: {soup: [part]} }
    const job = w => { if (!perWorker.has(w)) perWorker.set(w, { flips: {}, parts: {} }); return perWorker.get(w); };
    summaries.forEach((r, s) => { if (flips[s].some(x => x)) job(soupWorker[s]).flips[s] = flips[s]; });
    for (const p of parts) { const j = job(soupWorker[p.soup]); (j.parts[p.soup] ??= []).push(p.part); }
    let flippedTriangles = 0;
    const printOf = new Map();   // soup:part → fingerprint
    await Promise.all([...perWorker].map(async ([w, j]) => {
        const r = await pool.request(w, { type: 'stl:orient', ...j });
        flippedTriangles += r.flipped;
        for (const [s, list] of Object.entries(j.parts)) {
            const f = r.prints[s];
            list.forEach((p, i) => printOf.set(`${s}:${p}`, { tris: f.tris[i], verts: f.verts[i], sig: f.sig[i], area: f.area[i], spread: f.spread[i], radius: f.radius[i] }));
        }
    }));
    lap('flip');

    // 4. copies and 5. geometries overlap: a part that cannot be a copy (no equal fingerprint, or the first of its group)
    // is built while the copies are proven; every finished part and its proven copies go to the viewer at once
    // (hooks.onParts – streamed like the STEP solids)
    status('matching', null);
    const copyOf = new Array(parts.length).fill(-1), align = new Array(parts.length).fill(null);
    const byKey = new Map();
    parts.forEach((p, i) => {
        const f = printOf.get(`${p.soup}:${p.part}`);
        p.print = f;
        if (f.verts < 3 || !(f.radius > 0)) return;
        const key = `${f.tris}|${f.verts}|${f.sig}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(i);
    });
    const close = (a, b) => Math.abs(a - b) <= FEATURE_TOL * Math.max(Math.abs(a), Math.abs(b));
    let groups = [];
    for (const list of byKey.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => parts[a].print.area - parts[b].print.area || a - b);
        let cur = [list[0]];
        for (let j = 1; j < list.length; j++) {
            const a = parts[cur[0]].print, b = parts[list[j]].print;
            if (close(a.area, b.area) && close(a.spread, b.spread) && close(a.radius, b.radius)) cur.push(list[j]);
            else { if (cur.length > 1) groups.push(cur); cur = [list[j]]; }
        }
        if (cur.length > 1) groups.push(cur);
    }
    for (const g of groups) g.sort((a, b) => a - b);   // root = first in the file
    const candidate = new Uint8Array(parts.length);
    for (const g of groups) for (const c of g.slice(1)) candidate[c] = 1;

    // builder: per worker a queue of parts, jobs of a few hundred thousand triangles
    const geometries = [], geometriesOf = new Array(parts.length).fill(null);
    const waiting = new Map();   // root → copies proven before it was built
    // stopped: after an error or an abort no new jobs (a terminated pool never answers – the import would hang)
    let streamed = [], builtTris = 0, unique = 0, building = false, buildError = null, stopped = false;
    const flush = () => {
        if (streamed.length && hooks.onParts) {
            hooks.onParts(streamed.map(i => ({ index: i, copyOf: copyOf[i], align: align[i], geometries: geometriesOf[copyOf[i] >= 0 ? copyOf[i] : i] })), geometries);
        }
        streamed = [];
    };
    const queue = new Map(), running = new Map();
    const loop = async w => {
        const q = queue.get(w);
        while (!stopped && !buildError && q.head < q.items.length) {
            const items = [];
            let tris = 0;
            while (q.head < q.items.length && (!items.length || tris < BUILD_TRIANGLES)) { const i = q.items[q.head++]; items.push(i); tris += parts[i].tris; }
            const r = await pool.request(w, { type: 'stl:build', bvh: !!hooks.bvh, items: items.map(i => ({ soup: parts[i].soup, part: parts[i].part })) });
            items.forEach((i, j) => {
                geometriesOf[i] = r.geometries[j].map(g => {
                    geometries.push({ positions: g.positions, normals: g.normals, uvs: g.uvs, index: g.index, tangents: g.tangents, bvh: g.roots });
                    return { code: g.code, gi: geometries.length - 1 };
                });
                streamed.push(i, ...(waiting.get(i) || []));
                waiting.delete(i);
            });
            builtTris += tris;
            if (building) status('building', builtTris / unique);
            flush();
        }
    };
    const start = w => {
        const p = loop(w).catch(err => { buildError ??= err; }).finally(() => { if (running.get(w) === p) running.delete(w); });
        running.set(w, p);
    };
    const enqueue = list => {
        for (const i of list) {
            const w = soupWorker[parts[i].soup];
            if (!queue.has(w)) queue.set(w, { items: [], head: 0 });
            queue.get(w).items.push(i);
        }
        if (stopped || buildError) return;
        for (const [w, q] of queue) if (!running.has(w) && q.head < q.items.length) start(w);
    };
    const drain = async () => {
        for (;;) {
            if (!buildError) for (const [w, q] of queue) if (!running.has(w) && q.head < q.items.length) start(w);   // added as a loop ended
            if (!running.size) break;
            await Promise.all([...running.values()]);
        }
        if (buildError) throw buildError;
    };

    // size: with the device's limit known (hooks.limit), what is certainly unique is checked first and built at once –
    // memory beyond the limit only after the question; otherwise (no limit given) asked once the copies are known
    let asked = false, large = false;
    const sizeCheck = async tris => {
        if (!large && hooks.largeAbove && tris > hooks.largeAbove) { large = true; hooks.onLarge?.(); }
        if (asked || !hooks.checkSize || tris <= hooks.limit) return;
        asked = true;
        if (!await hooks.checkSize(tris)) throw new DOMException('Import cancelled', 'AbortError');
    };
    // an error or abort while proving or building (cancelled size check, new model): the build queue stops
    let copies = 0;
    try {
        const early = hooks.limit !== undefined;
        if (early) {
            const certain = [];
            parts.forEach((p, i) => { if (!candidate[i]) certain.push(i); });
            await sizeCheck(certain.reduce((x, i) => x + parts[i].tris, 0));
            enqueue(certain);
        }

        const tolOf = (a, b) => {
            const pa = parts[a], pb = parts[b];
            const size = Math.max(Math.hypot(pa.box[3] - pa.box[0], pa.box[4] - pa.box[1], pa.box[5] - pa.box[2]), Math.hypot(pb.box[3] - pb.box[0], pb.box[4] - pb.box[1], pb.box[5] - pb.box[2]));
            const far = Math.max(...pa.box.map(Math.abs), ...pb.box.map(Math.abs));
            return 1e-5 * size + 4e-7 * far;   // float32 coordinates: rounding ~6e-8 × magnitude in each copy
        };
        for (let round = 0; groups.length && round < MAX_ROOTS; round++) {
            // root data from its worker (one job per worker)
            const rootsBy = new Map();
            for (const g of groups) { const w = soupWorker[parts[g[0]].soup]; if (!rootsBy.has(w)) rootsBy.set(w, []); rootsBy.get(w).push(g[0]); }
            const dataOf = new Map();
            await Promise.all([...rootsBy].map(async ([w, roots]) => {
                const r = await pool.request(w, { type: 'stl:proofData', items: roots.map(i => ({ soup: parts[i].soup, part: parts[i].part })) });
                roots.forEach((i, j) => dataOf.set(i, r.data[j]));
            }));
            // candidates per worker
            const tasksBy = new Map();
            for (const g of groups) {
                const byW = new Map();
                for (const c of g.slice(1)) { const w = soupWorker[parts[c].soup]; if (!byW.has(w)) byW.set(w, []); byW.get(w).push(c); }
                for (const [w, cands] of byW) {
                    if (!tasksBy.has(w)) tasksBy.set(w, []);
                    tasksBy.get(w).push({ root: g[0], cands });
                }
            }
            const matched = new Set();
            await Promise.all([...tasksBy].map(async ([w, tasks]) => {
                const r = await pool.request(w, { type: 'stl:prove', tasks: tasks.map(x => ({
                    A: dataOf.get(x.root), tol: Math.max(...x.cands.map(c => tolOf(x.root, c))),
                    cands: x.cands.map(c => ({ soup: parts[c].soup, part: parts[c].part })) })) });
                tasks.forEach((x, ti) => x.cands.forEach((c, ci) => {
                    const m = r.results[ti][ci];
                    if (!m) return;
                    copyOf[c] = x.root;
                    align[c] = alignmentMatrix(m);
                    matched.add(c);
                    // to the viewer with its root – now if that is built, else when it is
                    if (geometriesOf[x.root]) streamed.push(c);
                    else { if (!waiting.has(x.root)) waiting.set(x.root, []); waiting.get(x.root).push(c); }
                }));
                flush();
            }));
            groups = groups.map(g => g.slice(1).filter(c => !matched.has(c))).filter(g => g.length > 1);
        }
        parts.forEach((p, i) => { if (copyOf[i] < 0) unique += p.tris; else copies++; });
        lap('copies');

        // the rest: candidates that are no copy (some the roots of later rounds)
        if (early) await sizeCheck(unique);
        else {
            if (hooks.largeAbove && unique > hooks.largeAbove) hooks.onLarge?.();
            if (hooks.checkSize && !await hooks.checkSize(unique)) throw new DOMException('Import cancelled', 'AbortError');
        }
        building = true;
        status('building', builtTris / unique);
        const rest = [];
        parts.forEach((p, i) => { if (copyOf[i] < 0 && (candidate[i] || !early)) rest.push(i); });
        enqueue(rest);
        await drain();
    } catch (err) {
        stopped = true;
        throw err;
    }
    lap('build');

    const stats = {
        triangles: n, broken, dropped: dead, chunks, workers: k, parts: parts.length, joins, gathered: spanning.length,
        closedFlipped, openFlipped, flippedTriangles, rays, copies, uniqueTriangles: unique, ms: times,
    };
    debugLog('[STL] parts:', stats);
    return {
        box, geometries, stats,
        parts: parts.map((p, i) => ({ tris: p.tris, copyOf: copyOf[i], align: align[i], geometries: geometriesOf[copyOf[i] >= 0 ? copyOf[i] : i] })),
    };
}

// column-major 4 × 4 (three.js order) of x_B = R · (x_A − cA) + cB
function alignmentMatrix({ R, cA, cB }) {
    const tr = [0, 1, 2].map(r => cB[r] - (R[r * 3] * cA[0] + R[r * 3 + 1] * cA[1] + R[r * 3 + 2] * cA[2]));
    return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, tr[0], tr[1], tr[2], 1];
}
