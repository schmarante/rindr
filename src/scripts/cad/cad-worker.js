// Worker: drawing files (DXF, DWG – cad/dwg/) → scene data. Two steps, the drawing stays here between them:
//   { type: 'read', bytes, format }  → { type: 'spaces', spaces }   (model space + layouts with content – the viewer may ask)
//   { type: 'build', space, limits } → { type: 'done', extras, step } (extras: drawing-build.js; step: STEP text of the
//                                                                     SAT bodies or null)
// Progress messages { type: 'progress', phase, fraction } in between.
import { readDxf } from './dxf-reader.js';
import { buildDrawing, listSpaces } from './drawing-build.js';
import { solidsToStep } from './drawing-solids.js';

let drawing = null, name = '';

const progress = phase => fraction => self.postMessage({ type: 'progress', phase, fraction });

self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'read') {
            // TextDecoder refuses views of shared memory: an own copy (the shared file is released by the caller)
            const bytes = typeof SharedArrayBuffer !== 'undefined' && data.bytes instanceof SharedArrayBuffer ? new Uint8Array(data.bytes).slice() : new Uint8Array(data.bytes);
            drawing = data.format === 'dwg' ? (await import('./dwg/dwg-reader.js')).readDwg(bytes, progress('read')) : readDxf(bytes, progress('read'));
            name = data.name || '';
            self.postMessage({ type: 'spaces', spaces: listSpaces(drawing), version: drawing.header.version });
            return;
        }
        if (data.type === 'build') {
            const r = buildDrawing(drawing, { space: data.space, ...data.limits, onProgress: progress('build') });
            const transfer = [];
            for (const l of r.lines) transfer.push(l.positions.buffer, l.colors.buffer);
            for (const f of r.fills) transfer.push(f.positions.buffer, f.colors.buffer, f.index.buffer);
            for (const t of r.texts) transfer.push(t.positions.buffer, t.uvs.buffer, t.colors.buffer, t.index.buffer);
            for (const g of r.geometries) transfer.push(g.positions.buffer, g.normals.buffer, g.uvs.buffer, g.index.buffer);
            if (r.atlas) transfer.push(r.atlas.data.buffer);
            // SAT bodies → STEP text (the viewer imports it the STEP way, the extras hang on the same nodes)
            progress('solids')(0);
            const solids = solidsToStep(drawing, r, name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Drawing');
            delete r.satBodies;
            r.counts.solids = 0;
            r.counts.solidStats = solids?.stats || null;
            if (solids) r.is2D = false;
            drawing = null;
            let step = null;
            if (solids) {
                if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
                    const shared = new Uint8Array(new SharedArrayBuffer(solids.bytes.length));
                    shared.set(solids.bytes);
                    step = shared.buffer;
                } else {
                    step = solids.bytes.slice().buffer;
                    transfer.push(step);
                }
            }
            self.postMessage({ type: 'done', extras: r, step }, transfer);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err?.message || String(err) });
    }
};
