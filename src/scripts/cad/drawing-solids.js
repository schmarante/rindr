// SAT bodies of a drawing (3DSOLID, REGION, BODY, SURFACE …) → STEP text (CAD worker): one product per layer node,
// keyed like the drawing's nodes ('L:<LAYER>' – the viewer hangs the lines and texts of that layer on the same node), all
// below a root named like the drawing. Every body is placed by its block/insert matrix (drawing units → mm); the SAT text
// (DXF up to 2010) or the SAB data (2013 on: ACDSDATA by handle) is read by sat/sat-file.js. Drawings are +Z up.
import { SatFile } from '../sat/sat-file.js';
import { SatStep } from '../sat/sat-to-step.js';

/**
 * @param {import('./drawing.js').Drawing} d
 * @param {object} built result of buildDrawing (satBodies, nodes, unit)
 * @returns {{ bytes: Uint8Array, stats: object } | null}
 */
export function solidsToStep(d, built, name = 'Drawing') {
    const list = built.satBodies.filter(s => !s.wire);
    if (!list.length) return null;
    const c = new SatStep();
    c.begin(name);
    const byNode = new Map();
    const encoder = new TextEncoder();
    const u = built.unit;
    for (const s of list) {
        const a = s.entity.satData;
        const bytes = a.sab || (a.sat ? encoder.encode(a.sat) : d.satBlobs.get(a.ref) || null);   // SAB inline (DWG), SAT text, or by handle
        if (!bytes?.length) { c.skip(`${s.entity.type} without SAT data`); continue; }
        let file;
        try { file = new SatFile(bytes); } catch { c.skip(`${s.entity.type} unreadable`); continue; }
        // column-major 4 × 4 in drawing units → row-major 3 × 4 in mm
        const m = s.matrix;
        const T = [m[0] * u, m[4] * u, m[8] * u, m[12] * u, m[1] * u, m[5] * u, m[9] * u, m[13] * u, m[2] * u, m[6] * u, m[10] * u, m[14] * u];
        const color = [(s.rgb >> 16 & 255) / 255, (s.rgb >> 8 & 255) / 255, (s.rgb & 255) / 255];
        const items = byNode.get(s.node) || [];
        try {
            for (const bi of c.bodiesOf(file)) items.push(...c.body(file, bi, { unit: 1, transform: T, color }));
        } catch (err) {
            c.skip(`${s.entity.type} (${String(err.message).slice(0, 40)})`);
        }
        byNode.set(s.node, items);
    }
    if (![...byNode.values()].some(x => x.length)) return null;
    const root = c.product(name, [], 'CAD:ROOT');
    for (const [node, items] of byNode) {
        if (!items.length) continue;
        const n = built.nodes[node];
        c.occurrence(root, c.product(n.name, items, n.key), n.name);
    }
    const stats = { ...c.stats, wire: built.satBodies.length - list.length };
    return { bytes: c.finish(), stats };
}
