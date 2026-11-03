// The groups of a material's values – one list for the material panel and the node editor's material output (same
// groups in the same order, user: "die Gruppierungen immer gleich"). From the parameters' groups (material-manager
// PARAMS, in their order), every row a parameter (a value) and/or an input of the node graph (a port), plus the rows
// that are no parameter: the graph's settings and its inputs without a value of their own. Filtered by the material
// type – what a type does not use drops out (also its ports).
import * as THREE from 'three/webgpu';
import { PARAMS } from './material-manager.js';
import { INPUT_PARAMS, FACTOR_INPUTS } from './material-graph.js';
import { typeShows, typeTakesInput, typeAllowsGraph } from './material-types.js';

// parameter → the graph input that drives it
const PARAM_INPUT = Object.fromEntries(Object.entries(INPUT_PARAMS).map(([input, param]) => [param, input]));
// rows of a group that are no parameter (only with a node graph): its settings and the inputs without a value
const TEXTURES = [{ setting: 'size' }, { setting: 'resolution' }];
// a setting goes with its input (`with`): relief strength with the relief, displacement with its height
const SURFACE = [{ input: 'normal' }, { input: 'height' }, { setting: 'reliefStrength', with: 'height' }, { input: 'ao' },
    { input: 'displacementHeight' }, { setting: 'displacement', with: 'displacementHeight' }, { setting: 'displacementMid', with: 'displacementHeight' }];
const APPENDED = { clearcoat: [{ input: 'coatNormal' }, { input: 'coatHeight' }], effects: [{ input: 'alpha' }] };

/**
 * @param {string} type  material type (material-types.js)
 * @param {boolean} graph  the material has a node graph (rows with ports and the graph's settings)
 * @returns {{ key: string, rows: { param?: object, input?: string, factor?: boolean, setting?: string }[] }[]}  key →
 *   materials.paramGroups.*; factor: a linked map multiplies the value (it stays editable)
 */
export function materialGroups(type, graph) {
    graph = graph && typeAllowsGraph(type);
    const usable = row => (!row.input || typeTakesInput(type, row.input)) && (!row.with || typeTakesInput(type, row.with));
    const groups = [];
    if (graph) groups.push({ key: 'textures', rows: TEXTURES });
    for (const p of PARAMS) {
        if (!typeShows(type, p.key)) continue;
        let g = groups[groups.length - 1];
        if (!g || g.key !== p.group) {
            g = groups.find(x => x.key === p.group);
            if (!g) {
                g = { key: p.group, rows: [] };
                groups.push(g);
                if (graph && p.group === 'base') groups.push({ key: 'surface', rows: SURFACE.filter(usable) });
            }
        }
        const input = graph ? PARAM_INPUT[p.key] : undefined;
        g.rows.push({ param: p, input, factor: FACTOR_INPUTS.has(input) });
    }
    if (graph) {
        if (!groups.some(g => g.key === 'surface')) groups.splice(1, 0, { key: 'surface', rows: SURFACE.filter(usable) });
        // the extra inputs into their group – a type without it (Toon: no effects) takes them into the surface group
        const surface = groups.find(g => g.key === 'surface');
        for (const [key, rows] of Object.entries(APPENDED)) (groups.find(g => g.key === key) ?? surface).rows.push(...rows.filter(usable));
    }
    // surface group right after base (base may not be the first group of a type)
    const base = groups.findIndex(g => g.key === 'base'), surface = groups.findIndex(g => g.key === 'surface');
    if (base >= 0 && surface >= 0 && surface !== base + 1) groups.splice(base + 1, 0, ...groups.splice(surface, 1));
    return groups.filter(g => g.rows.length);
}

// graph value → the parameter's unit (coat IOR coded 0..1 = 1.0..3.0, directions 0..1 = 0..180°)
const UNIT = { coatIor: v => 1 + 2 * v, anisotropyDirection: v => v * 180, coatAnisotropyDirection: v => v * 180 };

/**
 * The value the graph gives an input, in the form of its parameter (shown in the locked field): a constant as it is,
 * a baked map its mean; undefined while unknown (not baked yet, a picture from the file). Colours as hex (sRGB).
 * @param entry  { def, material } (material-manager.js)
 */
export function graphValue(entry, input, param) {
    const ud = entry?.material?.userData;
    let v = ud?.graphValues?.[input] ?? ud?.graphMeans?.[input]?.value;
    if (v === undefined || v === null) return undefined;
    if (input === 'transmissionDepth') return typeof v === 'number' ? v * (entry.def.params.attenuationDistance ?? param.default) : undefined;
    if (UNIT[input] && typeof v === 'number') v = UNIT[input](v);
    if (param.type === 'color') return v.isColor ? '#' + v.getHexString() : '#' + new THREE.Color(v, v, v).getHexString();
    return v.isColor ? (v.r + v.g + v.b) / 3 : v;
}

