// Dropped VDB files (.vdb OpenVDB, .nvdb NanoVDB) → the import structure of mesh-importer.js: one Scene Graph node (the
// volume as an object), no meshes, one grid volume (grid-volumes.js) – smoke, clouds, fire as a model of their own.
// Reading and resampling in a worker (vdb-worker.js → vdb-import.js); here: units and the default medium
// (volume-look.js – the Properties panel edits it). Details: docs/mesh-import.md "VDB".
//
// Units: VDB files carry no unit; simulation and 3D programs work in metres → × 1000 (mm). Density: σt = 1 per metre at
// density 1 (the usual convention of volume shaders), the panel's density scales it. Colour: smoke grey, a fire's soot
// darker; flame from a temperature grid: values above 500 taken as kelvin, otherwise (normalised grids) the maximum as
// 1800 K.
import { t } from '../i18n.js';
import { debugLog } from '../log.js';
import { gridVoxelBudget } from './grid-volumes.js';
import { withLook } from './volume-look.js';

const UNIT_MM = 1000;                       // file units (metres) → mm
const SIGMA_PER_UNIT = 1;                   // σt per file unit at density 1
const SMOKE_ALBEDO = 0.8, SOOT_ALBEDO = 0.3, SOLID_ALBEDO = 0.9;   // linear grey: smoke/cloud, with flames, level set
const KELVIN_ABOVE = 500, FLAME_K = 1800;
const FLAME_STRENGTH = 8;                   // radiance of the hottest part (the panel's emission scales it)

function runWorker(source, onStatus) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./vdb-worker.js', import.meta.url), { type: 'module', name: 'vdb' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') {
                if (data.phase === 'volume') onStatus(t('import.vdb.volume'), data.fraction);
                else onStatus(t('import.vdb.volume'), 0);
                return;
            }
            worker.terminate();
            if (data.type === 'error') reject(new Error(t('import.vdb.failed', { message: data.message })));
            else resolve(data);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'VDB worker failed')); };
        worker.postMessage({ main: source.main, maxVoxels: gridVoxelBudget() });
    });
}

/**
 * @param {{ name, main: Blob }} source
 * @returns {Promise<{ result, missing: string[] }>}
 */
export async function importVdb(source, { onStatus = () => {} } = {}) {
    const { volume: v, grids } = await runWorker(source, onStatus);
    const stem = source.name.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    // unit box → file world (row-major) → mm, column-major for three
    const matrix = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) matrix[4 * c + r] = v.boxToWorld[4 * r + c] * (r < 3 ? UNIT_MM : 1);
    const flame = !!v.temperature && v.temperatureMax > 0;
    const grey = v.levelSet ? SOLID_ALBEDO : flame ? SOOT_ALBEDO : SMOKE_ALBEDO;
    const volume = withLook({ ...v, name: v.densityGrid || stem, matrix, unitScale: UNIT_MM }, {
        sigma: SIGMA_PER_UNIT * v.densityMax / UNIT_MM, albedo: [grey, grey, grey], g: 0,
        blackbody: flame, temperature: flame ? (v.temperatureMax > KELVIN_ABOVE ? Math.round(v.temperatureMax) : FLAME_K) : null,
        strength: FLAME_STRENGTH,
    });
    debugLog('[VDB] volume', { grids, density: v.densityGrid, temperature: v.temperatureGrid, dims: v.dims, factor: v.factor, densityMax: +v.densityMax.toFixed(3), temperatureMax: +v.temperatureMax.toFixed(2), levelSet: v.levelSet });
    // Scene Graph: the volume as an object of its own (grid-volumes.js places it on that node)
    volume.node = 0;
    const nodes = [{ name: t('import.volume.node', { name: stem }), parent: -1 }];
    const result = { nodes, geometries: [], meshes: [], cameras: [], lights: [], animation: null, volumes: [volume] };
    return { result, missing: new Set() };
}
