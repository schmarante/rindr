// Worker side of the STL import in parts (stl-import.js sends the jobs, step/worker.js forwards every 'stl:*' message
// here). A worker keeps its soups (chunks of the file, parts gathered from several chunks) between the jobs – the
// main thread only gets summaries, decisions go back as small arrays. Functions: stl-core.js.
//
//   {type:'stl:read', soup, bytes, offset, count, colors, gstart} -> chunk of a binary STL read and analysed
//   {type:'stl:soup', soup, positions, gstart}                    -> the same for positions (ASCII STL)
//   {type:'stl:join', lists}                                      -> pairs of parts joined across chunks
//   {type:'stl:export', soup, groups}                             -> triangles of parts across chunks
//   {type:'stl:adopt', soup, P, codes, gidx}                      -> such a part, gathered, analysed as a whole
//   {type:'stl:rays', pos, nor, sign, eps, minHit}                -> blocked per sample (this worker's triangles)
//   {type:'stl:orient', flips, parts}                             -> flips applied, fingerprints of the parts
//   {type:'stl:proofData', items}                                 -> vertices + triangles of root parts (copies)
//   {type:'stl:prove', tasks}                                     -> copies proven against those
//   {type:'stl:build', items, bvh}                                -> geometries of parts (normals, UVs, BVH)
//   {type:'stl:clear'}                                            -> all soups dropped

import { readBinary, soupFromPositions, analyzeSoup, joinOpenEdges, exportParts, testRays, applyFlips, fingerprints,
    proofData, proveCopy, partGeometries } from './stl-core.js';

const soups = new Map();   // soup id → analysis (analyzeSoup) + parts / pieces count
export { soups as stlSoups };   // (Node tests: the final triangles)

function analysed(id, soup, gidx) {
    const a = analyzeSoup(soup.P, soup.codes, gidx);
    const s = a.summary;
    delete a.summary;
    a.parts = s.parts.count;
    soups.set(id, a);
    const transfer = [s.parts.tris.buffer, s.parts.first.buffer, s.parts.box.buffer, s.pieces.part.buffer, s.pieces.flipClosed.buffer,
        s.pieces.k.buffer, s.pieces.open.buffer, s.pieces.tris.buffer, s.samples.pos.buffer, s.samples.nor.buffer, s.samples.piece.buffer,
        s.open.bits.buffer, s.open.part.buffer];
    return { reply: { type: 'stl:analysed', soup: id, broken: soup.broken || 0, ...s }, transfer };
}

/** @returns {{ reply: object, transfer: Transferable[] }} */
export function stlJob(m) {
    switch (m.type) {
        case 'stl:read': {
            const soup = readBinary(new Uint8Array(m.bytes), m.offset, m.count, m.colors);
            return analysed(m.soup, soup, m.gstart);
        }
        case 'stl:soup':
            return analysed(m.soup, soupFromPositions(new Float32Array(m.positions)), m.gstart);
        case 'stl:join': {
            const pairs = joinOpenEdges(m.lists);
            return { reply: { type: 'stl:join', pairs }, transfer: [pairs.buffer] };
        }
        case 'stl:export': {
            const soup = soups.get(m.soup);
            const items = m.groups.map(parts => exportParts(soup, parts));
            return { reply: { type: 'stl:export', items }, transfer: items.flatMap(x => [x.P.buffer, x.codes.buffer, x.gidx.buffer]) };
        }
        case 'stl:adopt':
            return analysed(m.soup, { P: new Float32Array(m.P), codes: new Uint16Array(m.codes), broken: 0 }, new Int32Array(m.gidx));
        case 'stl:rays': {
            const blocked = testRays([...soups.values()], m.pos, m.nor, m.sign, m.eps, m.minHit);
            return { reply: { type: 'stl:rays', blocked }, transfer: [blocked.buffer] };
        }
        case 'stl:orient': {
            for (const s of soups.values()) s.rayBvh = null;   // ray test done
            let flipped = 0;
            for (const [id, flip] of Object.entries(m.flips)) flipped += applyFlips(soups.get(Number(id)), flip);
            const prints = {};
            for (const [id, parts] of Object.entries(m.parts)) {
                const soup = soups.get(Number(id));
                prints[id] = fingerprints(soup, parts, soup.parts);
            }
            return { reply: { type: 'stl:orient', flipped, prints }, transfer: [] };
        }
        case 'stl:proofData':
            return { reply: { type: 'stl:proofData', data: m.items.map(({ soup, part }) => proofData(soups.get(soup), part)) }, transfer: [] };
        case 'stl:prove': {
            const results = m.tasks.map(({ A, tol, cands }) => cands.map(({ soup, part }) => proveCopy(A, soups.get(soup), part, tol)));
            return { reply: { type: 'stl:prove', results }, transfer: [] };
        }
        case 'stl:build': {
            const out = m.items.map(({ soup, part }) => partGeometries(soups.get(soup), part, { bvh: m.bvh }));
            const transfer = [];
            for (const list of out) for (const g of list) {
                transfer.push(g.positions.buffer, g.normals.buffer, g.uvs.buffer, g.index.buffer);
                if (g.tangents) transfer.push(g.tangents.buffer);
                if (g.roots) transfer.push(...g.roots);
            }
            return { reply: { type: 'stl:build', geometries: out }, transfer };
        }
        case 'stl:clear':
            soups.clear();
            return { reply: { type: 'stl:clear' }, transfer: [] };
        default:
            throw new Error(`unknown STL job ${m.type}`);
    }
}
