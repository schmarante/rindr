// Material node graph: node types, evaluation and baking.
//
// A graph feeds the inputs of a physical material (output node). For every connected input:
//  - If only constant nodes precede it (value, color, mix, math …), the value is computed
//    directly and set as a material parameter.
//  - Otherwise (image, noise, checker …) the subgraph is built as a TSL expression over the UVs
//    and baked on the GPU into a tileable texture covering one UV tile; the output node's `size` says how many mm
//    that tile is on the model (map repeat = UV_TILE / size). The texture is set as a map -> raster view and path
//    tracer see exactly the same.
// "Relief" (height) is additionally converted into a normal map, "alpha" cuts the surface (alpha test).
//
// Coordinates (like the coordinate settings of texture maps in MAX): every texture node has offset U/V, tiling U/V
// and an angle (MAPPING_PARAMS); the image node also a wrap mode per axis (repeat / mirror / off). An image that does
// not repeat on an axis is a single picture – a decal. Such a graph cannot be baked into a repeating tile: it is baked
// once over the UV range of the meshes that use the material ("UV mode", isUvMode – graph-apply.js passes the range).
//
// Procedural texture nodes live in their own modules in nodes/ (one per type, default export = node type with an
// `evaluate` function; see node-lib.js for the result format and the tileable helpers) and register themselves here.
//
// Imported materials (glTF/FBX) get a graph on import with one "import texture" node per texture
// of the file. If such a node is attached unchanged to the matching input (channel as three.js
// reads it, e.g. metalness = B, roughness = G), the original texture is set directly as a map
// (kind 'map', full resolution, material parameters act as a factor). Only when something sits
// in between is it baked – with the model's UVs, at the resolution of the source texture.
import { t, has } from './i18n.js';
import * as THREE from 'three/webgpu';
import { float, vec2, vec3, vec4, uv, uniform, texture, mat3, fract, floor, dot, mix, mod, clamp, max, min, pow, abs, step, dFdx, dFdy, sRGBTransferOETF, cos, sin } from 'three/tsl';
import { LUMA, linear, C, T, tsl, convert, input } from './node-lib.js';

export const BAKE_SIZE = 1024;
// auto resolution in UV mode: one texture spans the whole UV range of the parts, a decal covers only a part of it
const UV_BAKE_SIZE = 2048;
export const BAKE_RESOLUTIONS = ['auto', '512', '1024', '2048', '4096'];
/** bake edge length of a resolution setting ('auto' or a number as string); null = auto */
export const bakeResolution = res => (res && res !== 'auto' ? Math.min(MAX_BAKE_SIZE, Math.max(64, Number(res) || BAKE_SIZE)) : null);
const MAX_BAKE_SIZE = 4096;

// --- Node types ---
// inputs/outputs: { key, type: 'float'|'color'|'vector', default? }  ('vector' = texture coordinate, see node-lib.js)
// params: { key, kind: 'number'|'color'|'select'|'image'|'importMap', min?, max?, step?, options? (keys), default }
// Labels come from the language file (see nodeLabel/portLabel/paramLabel/optionLabel); type ids
// and port/param keys are persisted in the material JSON.
export const NODE_TYPES = {
    output: {
        category: null, color: 'bg-emerald-700',
        inputs: [
            { key: 'color', type: 'color' },
            { key: 'metalness', type: 'float' },
            { key: 'roughness', type: 'float' },
            // OpenPBR specular_roughness_anisotropy + direction (0..1 = 0..180°, along the UVs' u) – one anisotropy map
            { key: 'anisotropy', type: 'float' },
            { key: 'anisotropyDirection', type: 'float' },
            // OpenPBR specular_weight / specular_color (dielectric tint; on metals the edge tint, F82)
            { key: 'specularIntensity', type: 'float' },
            { key: 'specularColor', type: 'color' },
            { key: 'clearcoat', type: 'float' },
            { key: 'clearcoatRoughness', type: 'float' },
            // OpenPBR coat_roughness_anisotropy + geometry_coat_tangent (0..1 = 0..180°) – one coat anisotropy map
            // (swirl marks: micro scratches in the clear coat)
            { key: 'coatAnisotropy', type: 'float' },
            { key: 'coatAnisotropyDirection', type: 'float' },
            { key: 'transmission', type: 'float' },
            { key: 'sheen', type: 'float' },
            { key: 'sheenRoughness', type: 'float' },
            { key: 'iridescence', type: 'float' },
            { key: 'emissive', type: 'color' },
            { key: 'normal', type: 'color' },
            { key: 'ao', type: 'float' },
            { key: 'height', type: 'float' },
            // OpenPBR geometry_coat_normal: the coat's own normal (normal map or relief, e.g. orange peel over a smooth base)
            { key: 'coatNormal', type: 'color' },
            { key: 'coatHeight', type: 'float' },
            { key: 'alpha', type: 'float' },
        ],
        outputs: [],
        params: [
            { key: 'reliefStrength', kind: 'number', min: 0, max: 5, step: 0.05, default: 1 },
            // edge length of the baked tile on the model in mm (UV_TILE = one UV unit of the box UVs)
            { key: 'size', kind: 'number', min: 10, max: 10000, step: 10, default: 100 },
            // resolution of the baked maps of this material (wish of the user: per material); auto = BAKE_SIZE, imported
            // textures at their own size
            { key: 'resolution', kind: 'select', options: BAKE_RESOLUTIONS, default: 'auto' },
        ],
    },
    value: {
        category: 'input', color: 'bg-slate-600',
        inputs: [], outputs: [{ key: 'value', type: 'float' }],
        params: [{ key: 'value', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }],
    },
    color: {
        category: 'input', color: 'bg-slate-600',
        inputs: [], outputs: [{ key: 'color', type: 'color' }],
        params: [{ key: 'color', kind: 'color', default: '#cc3333' }],
    },
    image: {
        category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [], outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }, { key: 'alpha', type: 'float' }],
        params: [
            { key: 'image', kind: 'image', default: null },
            { key: 'scale', kind: 'number', min: 1, max: 50, step: 1, default: 4 },
            // per axis: repeat, mirror every other copy, or off (a single picture – decal; alpha 0 outside)
            { key: 'wrapU', kind: 'select', options: ['repeat', 'mirror', 'off'], default: 'repeat' },
            { key: 'wrapV', kind: 'select', options: ['repeat', 'mirror', 'off'], default: 'repeat' },
        ],
    },
    importMap: {
        category: 'texture', color: 'bg-orange-800', texture: true, importOnly: true,
        inputs: [],
        outputs: [
            { key: 'color', type: 'color' },
            { key: 'r', type: 'float' }, { key: 'g', type: 'float' },
            { key: 'b', type: 'float' }, { key: 'a', type: 'float' },
        ],
        params: [{ key: 'map', kind: 'importMap', default: 'map' }],
    },
    // extent 'object': once over the UVs of every mesh with the material (UV mode, like an image with tiling off) –
    // e.g. a band at the top of a model (beer foam); from / to: where the ramp starts and ends (0 below, 1 above)
    gradient: {
        category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [], outputs: [{ key: 'value', type: 'float' }],
        params: [
            { key: 'axis', kind: 'select', options: ['u', 'v'], default: 'u' },
            { key: 'extent', kind: 'select', options: ['tile', 'object'], default: 'tile' },
            { key: 'scale', kind: 'number', min: 1, max: 50, step: 1, default: 1 },
            { key: 'from', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
            { key: 'to', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
        ],
    },
    checker: {
        category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [{ key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
        outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }],
        params: [
            { key: 'scale', kind: 'number', min: 1, max: 100, step: 1, default: 10 },
            { key: 'a', kind: 'color', default: '#ffffff' },
            { key: 'b', kind: 'color', default: '#202020' },
        ],
    },
    mix: {
        category: 'color', color: 'bg-sky-700',
        inputs: [
            { key: 'a', type: 'color' }, { key: 'b', type: 'color' }, { key: 'factor', type: 'float' },
        ],
        outputs: [{ key: 'color', type: 'color' }],
        params: [
            { key: 'a', kind: 'color', default: '#000000' },
            { key: 'b', kind: 'color', default: '#ffffff' },
            { key: 'factor', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
        ],
    },
    ramp: {
        category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 't', type: 'float' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [
            { key: 'a', kind: 'color', default: '#000000' },
            { key: 'b', kind: 'color', default: '#ffffff' },
            { key: 't', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
        ],
    },
    math: {
        category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'a', type: 'float' }, { key: 'b', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [
            { key: 'op', kind: 'select', options: ['add', 'sub', 'mul', 'pow', 'min', 'max'], default: 'mul' },
            { key: 'a', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
            { key: 'b', kind: 'number', min: 0, max: 4, step: 0.01, default: 1 },
        ],
    },
    remap: {
        category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'value', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [
            { key: 'value', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
            { key: 'from', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
            { key: 'to', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
        ],
    },
    invert: {
        category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'value', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [{ key: 'value', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }],
    },
};

// procedural texture nodes: one module per type in nodes/ (Vite glob – new files register themselves)
for (const mod of Object.values(import.meta.glob('./nodes/*.js', { eager: true }))) {
    const def = mod.default;
    if (def?.type) NODE_TYPES[def.type] = def;
}

// Coordinates of every texture node (not the imported textures – they follow the model's UVs): offset (in tile units
// – for a decal the position of its lower left corner), tiling per axis (copies per tile; for a decal 1 / its size)
// and an angle around the picture's centre. Defaults = the coordinate unchanged (older graphs look the same).
// Integer tiling, mirroring and 90° steps keep a repeating texture seamless; other values break the tile edges.
export const MAPPING_PARAMS = [
    // offsets in tile units – a decal sits at the model's UV of its spot (large on big models); the slider spans one
    // tile either way around the current value (sliderRange – a repeating texture is periodic, a decal moves finely
    // instead of jumping; user: "-1 to +1 instead of -1000 to +1000"), the field takes the whole range
    { key: 'offsetU', kind: 'number', min: -10000, max: 10000, step: 0.01, default: 0, mapping: true, slider: 'tile' },
    { key: 'offsetV', kind: 'number', min: -10000, max: 10000, step: 0.01, default: 0, mapping: true, slider: 'tile' },
    // negative tiling mirrors the axis (decals on faces whose UVs run mirrored)
    { key: 'tilingU', kind: 'number', min: -100, max: 100, step: 0.01, default: 1, mapping: true },
    { key: 'tilingV', kind: 'number', min: -100, max: 100, step: 0.01, default: 1, mapping: true },
    { key: 'angle', kind: 'number', min: -180, max: 180, step: 1, default: 0, mapping: true },
];
for (const def of Object.values(NODE_TYPES)) {
    if (def.texture && !def.importOnly) def.params = [...(def.params || []), ...MAPPING_PARAMS];
}

/** range of a number parameter's slider: { min, max } – 'tile': one tile either way around the whole tile nearest the value */
export function sliderRange(p, value) {
    if (p.slider !== 'tile') return { min: p.min, max: p.max };
    const c = Math.round(Number(value) || 0);
    return { min: Math.max(p.min, c - 1), max: Math.min(p.max, c + 1) };
}

/** graph with a picture that does not repeat (decal): baked over the UV range of its meshes instead of a tile */
export const isUvMode = graph => !!graph?.nodes?.some(n => (n.type === 'image' && (n.params?.wrapU === 'off' || n.params?.wrapV === 'off'))
    || (n.type === 'gradient' && n.params?.extent === 'object'));

export const NODE_CATEGORIES = ['input', 'texture', 'color', 'value'];

/** Display label of a node type */
export const nodeLabel = type => t(`nodes.types.${type}.label`);
/** Display label of a node category */
export const categoryLabel = category => t(`nodes.categories.${category}`);
/** Display label of an input ('inputs') or output ('outputs') port */
export const portLabel = (type, side, key) => t(`nodes.types.${type}.${side}.${key}`);
/** Display label of a node parameter */
export const paramLabel = (type, key) => (has(`nodes.types.${type}.params.${key}`) ? t(`nodes.types.${type}.params.${key}`) : t(`nodes.mapping.${key}`));
/** Display label of an option of a select parameter */
export const optionLabel = (type, param, option) => (has(`nodes.types.${type}.options.${param}.${option}`)
    ? t(`nodes.types.${type}.options.${param}.${option}`) : t(`nodes.mapping.options.${param}.${option}`));

/** Empty graph with output */
export function createGraph() {
    return { nodes: [{ id: 'out', type: 'output', x: 520, y: 40, params: { reliefStrength: 1 } }], links: [] };
}

// Import map -> input/channel that three.js reads for this map (can be passed through directly)
export const IMPORT_SLOTS = {
    map: ['color', 'color'],
    metalnessMap: ['metalness', 'b'],
    roughnessMap: ['roughness', 'g'],
    emissiveMap: ['emissive', 'color'],
    normalMap: ['normal', 'color'],
    aoMap: ['ao', 'r'],
    clearcoatMap: ['clearcoat', 'r'],
    clearcoatRoughnessMap: ['clearcoatRoughness', 'g'],
    transmissionMap: ['transmission', 'r'],
    sheenColorMap: ['sheen', 'color'],
    clearcoatNormalMap: ['coatNormal', 'color'],
    specularColorMap: ['specularColor', 'color'],
    iridescenceMap: ['iridescence', 'r'],
};
// input -> channel that can be passed through
const PASS_PORT = Object.fromEntries(Object.values(IMPORT_SLOTS));

/**
 * Graph for an imported material: one image node from the file per texture, connected to its inputs
 * (one texture for several maps, e.g. glTF metallicRoughness -> one node, B -> metalness, G -> roughness). Images the
 * file names but that are missing (render.missing) get their node too – shown with a warning and the way to load
 * them; until they are there the material's own values apply (evaluateGraph skips them).
 * @param {{ [mapKey]: THREE.Texture }} maps
 * @param {{ [mapKey]: { url: string } }} [missing]
 */
export function createImportGraph(maps, missing = null) {
    const graph = createGraph();
    const byTexture = new Map();   // texture (or address of a missing image) -> node
    let row = 0;
    for (const [key, [input, port]] of Object.entries(IMPORT_SLOTS)) {
        const tex = maps?.[key] || (missing?.[key] ? 'missing:' + missing[key].url : null);
        if (!tex) continue;
        let node = byTexture.get(tex);
        if (!node) {
            node = { id: 'import-' + key, type: 'importMap', x: 40, y: 20 + row++ * 190, params: { map: key } };
            byTexture.set(tex, node);
            graph.nodes.push(node);
        }
        graph.links.push({ from: { node: node.id, port }, to: { node: 'out', port: input } });
    }
    return graph;
}

export function defaultParams(type) {
    return Object.fromEntries((NODE_TYPES[type].params || []).map(p => [p.key, p.default]));
}

// --- Evaluation ---

/**
 * Evaluate the graph for the output node.
 * @param {Map<string, THREE.Texture>} textures  image nodes (node ID -> texture)
 * @param {{ [mapKey]: THREE.Texture }} [importMaps]  textures from the imported file
 * @returns {{ [input]: { kind: 'const', value: number|THREE.Color } | { kind: 'map', texture }
 *           | { kind: 'tsl', node, type, sig, size } }}
 */
export function evaluateGraph(graph, textures, importMaps = {}, { domain = null } = {}) {
    // bakeSize: texels across the tile – nodes that smooth edges over about one texel need it
    const fixed = bakeResolution(graph.nodes.find(n => n.type === 'output')?.params?.resolution) || (domain ? UV_BAKE_SIZE : null);
    // coordinate of a bake texel: tile mode – the tile's UV (0..1 = one tile); UV mode (domain = { min, max, scale }) –
    // the model's UV range across the texture, in tile units (× scale = UV_TILE / size)
    const modelUv = domain ? mix(vec2(...domain.min), vec2(...domain.max), uv()) : uv();
    const base = domain ? modelUv.mul(domain.scale) : uv();
    // span: 0..1 across the bake – the material's UV range in UV mode (gradient over the object), the tile otherwise
    const ctx = { textures, importMaps, bakeSize: fixed || BAKE_SIZE, base, modelUv, span: uv() };
    const { nodes, linkTo, outputOf, signature } = evaluator(graph, ctx);

    // Bake size: largest import texture in the subgraph (at least BAKE_SIZE)
    const bakeSize = (nodeId, seen = new Set()) => {
        const n = nodes.get(nodeId);
        if (!n || seen.has(nodeId)) return BAKE_SIZE;
        seen.add(nodeId);
        let size = BAKE_SIZE;
        if (n.type === 'importMap') {
            const img = importMaps[n.params?.map]?.image;
            size = Math.max(size, Math.min(MAX_BAKE_SIZE, img?.width || 0, img?.height || 0));
        }
        for (const i of NODE_TYPES[n.type].inputs) {
            const from = linkTo.get(nodeId + ':' + i.key);
            if (from) size = Math.max(size, bakeSize(from.node, seen));
        }
        return size;
    };

    const out = graph.nodes.find(n => n.type === 'output');
    const result = {};
    if (!out) return result;
    for (const input of NODE_TYPES.output.inputs) {
        const from = linkTo.get(out.id + ':' + input.key);
        if (!from || !nodes.has(from.node)) continue;
        // import texture directly at the matching input -> pass the original texture through
        const src = nodes.get(from.node);
        // image from the file still missing: the material's own value (not a grey stand-in)
        if (src.type === 'importMap' && !importMaps[src.params?.map]) continue;
        const tex = src.type === 'importMap' && importMaps[src.params?.map];
        if (tex && PASS_PORT[input.key] === from.port) {
            result[input.key] = { kind: 'map', texture: tex };
            continue;
        }
        const r = convert(outputOf(from.node, from.port), input.type);
        result[input.key] = r.isConst
            ? { kind: 'const', value: r.value }
            : { kind: 'tsl', node: r.node, type: input.type, sig: signature(from.node, from.port), size: fixed || bakeSize(from.node) };
    }
    // anisotropy (base and coat): strength and direction share one map (three.js / the path tracer: RG = direction as
    // a vector in the tangent frame, B = strength – both multiply the material's values, so an unlinked one stays the
    // material's)
    const anisotropy = (aStr, aDir, name) => {
        if (aStr?.kind === 'tsl' || aDir?.kind === 'tsl') {
            const strength = aStr?.kind === 'tsl' ? aStr.node : float(aStr?.kind === 'const' ? aStr.value : 1);
            const angle = (aDir?.kind === 'tsl' ? aDir.node : float(aDir?.kind === 'const' ? aDir.value : 0)).mul(Math.PI);
            result[name + 'Map'] = { kind: 'tsl', type: 'color', node: vec3(cos(angle).mul(0.5).add(0.5), sin(angle).mul(0.5).add(0.5), strength),
                sig: `${name}|${aStr?.sig ?? aStr?.value}|${aDir?.sig ?? aDir?.value}`, size: Math.max(aStr?.size || 0, aDir?.size || 0) || BAKE_SIZE,
                strength: aStr?.kind === 'tsl' || aStr?.kind === 'const', direction: aDir?.kind === 'tsl' || aDir?.kind === 'const' };
        } else if (aStr || aDir) {
            result[name + 'Const'] = { strength: aStr?.kind === 'const' ? aStr.value : null, direction: aDir?.kind === 'const' ? aDir.value : null };
        }
    };
    anisotropy(result.anisotropy, result.anisotropyDirection, 'anisotropy');
    anisotropy(result.coatAnisotropy, result.coatAnisotropyDirection, 'coatAnisotropy');
    result.reliefStrength = out.params?.reliefStrength ?? 1;
    result.size = out.params?.size ?? 100;
    result.domain = domain;
    return result;
}

/**
 * Evaluate one output of any node (node editor preview): one tile, coordinate = the tile's UV.
 * @returns {{ isConst: true, type, value } | { isConst: false, type, node } | null}  as color/float, null if missing
 */
export function evaluateNode(graph, nodeId, port, textures, importMaps = {}, { bakeSize = BAKE_SIZE } = {}) {
    const { nodes, outputOf } = evaluator(graph, { textures, importMaps, bakeSize, base: uv(), modelUv: uv() });
    const n = nodes.get(nodeId), out = n && NODE_TYPES[n.type]?.outputs.find(o => o.key === port);
    if (!out) return null;
    return convert(outputOf(nodeId, port), out.type === 'float' ? 'float' : 'color');
}

/** Signature of the subgraph before an output of a node – same signature = same preview; importMaps: the material's
 * textures from the file (an image from the file counts by its picture, not only by its slot name) */
export function nodeSignature(graph, nodeId, port, importMaps = null) {
    return evaluator(graph, null, importMaps).signature(nodeId, port);
}

// shared by evaluateGraph/evaluateNode: node lookup, links (input -> source output), cached output evaluation
// (ctx = evalNode context; null when only the signature is needed) and the signature of a subgraph
function evaluator(graph, ctx, importMaps = ctx?.importMaps) {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    const linkTo = new Map(graph.links.map(l => [l.to.node + ':' + l.to.port, l.from]));
    const cache = new Map();

    // result of an output: { isConst, value (number|Color), node (TSL), type }
    const outputOf = (nodeId, port, stack = new Set()) => {
        const key = nodeId + ':' + port;
        if (cache.has(key)) return cache.get(key);
        if (stack.has(nodeId)) throw new Error('Cycle in node graph');
        stack.add(nodeId);
        const n = nodes.get(nodeId);
        const res = evalNode(n, port, inp => {
            const from = linkTo.get(nodeId + ':' + inp);
            return from && nodes.has(from.node) ? outputOf(from.node, from.port, stack) : null;
        }, ctx);
        stack.delete(nodeId);
        cache.set(key, res);
        return res;
    };

    // Signature of the subgraph before an output (type, parameters, links) – same
    // signature = same texture, does not need to be baked again
    const signature = (nodeId, port, seen = new Set()) => {
        const n = nodes.get(nodeId);
        if (!n || seen.has(nodeId)) return '';
        seen.add(nodeId);
        const ins = NODE_TYPES[n.type].inputs.map(i => {
            const from = linkTo.get(nodeId + ':' + i.key);
            return i.key + '=' + (from ? signature(from.node, from.port, seen) : '');
        });
        // image from the file: its picture (two import materials with the same slot shared previews and baked maps;
        // a picture linked later had the old preview)
        const tex = n.type === 'importMap' ? importMaps?.[n.params?.map] : null;
        const picture = n.type === 'importMap' ? '#' + (tex ? (tex.source?.uuid ?? tex.uuid) : 'missing') : '';
        return `${n.type}:${port}(${JSON.stringify(n.params || {})}${picture};${ins.join(',')})`;
    };
    return { nodes, linkTo, outputOf, signature };
}

function evalNode(n, port, get, ctx) {
    const { textures, importMaps } = ctx;
    const p = { ...defaultParams(n.type), ...n.params };
    const def = NODE_TYPES[n.type];
    // texture nodes: coordinate = connected `uv` input or the bake texel's, then the node's coordinate settings;
    // the node reads it through its `uv` input
    let at = null;
    if (def?.texture && !def.importOnly) {
        const connected = get('uv');
        at = mapCoord(connected?.type === 'vector' ? connected.node : ctx.base, p);
        const inner = get;
        get = k => (k === 'uv' ? T(at, 'vector') : inner(k));
    }
    switch (n.type) {
        case 'value': return C(p.value);
        case 'color': return C(linear(p.color));
        case 'mix': {
            const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b), f = input(get, 'factor', 'float', p.factor);
            if (a.isConst && b.isConst && f.isConst) return C(a.value.clone().lerp(b.value, f.value));
            return T(mix(tsl(a), tsl(b), tsl(f)), 'color');
        }
        case 'ramp': {
            const t = input(get, 't', 'float', p.t);
            const a = linear(p.a), b = linear(p.b);
            if (t.isConst) return C(a.clone().lerp(b, clamp01(t.value)));
            return T(mix(vec3(a.r, a.g, a.b), vec3(b.r, b.g, b.b), clamp(tsl(t), 0, 1)), 'color');
        }
        case 'math': {
            const a = input(get, 'a', 'float', p.a), b = input(get, 'b', 'float', p.b);
            const ops = {
                add: [(x, y) => x + y, (x, y) => x.add(y)],
                sub: [(x, y) => x - y, (x, y) => x.sub(y)],
                mul: [(x, y) => x * y, (x, y) => x.mul(y)],
                pow: [(x, y) => Math.pow(Math.max(x, 0), y), (x, y) => pow(max(x, 0), y)],
                min: [Math.min, (x, y) => min(x, y)],
                max: [Math.max, (x, y) => max(x, y)],
            };
            const [js, gpu] = ops[p.op] || ops.mul;
            if (a.isConst && b.isConst) return C(js(a.value, b.value));
            return T(gpu(tsl(a), tsl(b)), 'float');
        }
        case 'remap': {
            const v = input(get, 'value', 'float', p.value);
            if (v.isConst) return C(p.from + (p.to - p.from) * v.value);
            return T(mix(float(p.from), float(p.to), tsl(v)), 'float');
        }
        case 'invert': {
            const v = input(get, 'value', 'float', p.value);
            if (v.isConst) return C(1 - v.value);
            return T(float(1).sub(tsl(v)), 'float');
        }
        case 'gradient': {
            const s = Math.max(1, Math.round(p.scale));
            // object: the bake texel across the UV range of the material's meshes (0 … 1 once, mapping params unused)
            const span = p.extent === 'object' ? ctx.span : null;
            const c = span ? (p.axis === 'v' ? span.y : span.x) : (p.axis === 'v' ? at.y : at.x);
            let v = span ? clamp(c, 0, 1) : fract(c.mul(s));
            const from = p.from ?? 0, to = p.to ?? 1;
            if (from !== 0 || to !== 1) v = clamp(v.sub(from).div(Math.max(to - from, 1e-3)), 0, 1);
            return T(v, 'float');
        }
        case 'checker': {
            const s = Math.max(1, Math.round(p.scale));
            const cell = floor(at.mul(s));
            const m = mod(cell.x.add(cell.y), 2);
            const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b);
            return port === 'value' ? T(m, 'float') : T(mix(tsl(a), tsl(b), m), 'color');
        }
        case 'image': {
            const tex = textures?.get(n.id);
            if (!tex) return port === 'value' ? C(0.5) : port === 'alpha' ? C(0) : C(new THREE.Color(0.5, 0.5, 0.5));
            const s = at.mul(Math.max(1, Math.round(p.scale)));
            // wrap per axis ourselves; mip level from the unwrapped coordinate (no seam line at the wrap)
            const u = wrapAxis(s.x, p.wrapU), v = wrapAxis(s.y, p.wrapV);
            const c = texture(tex, vec2(u.t, v.t)).grad(dFdx(s), dFdy(s));
            if (port === 'alpha') return T(c.a.mul(u.inside).mul(v.inside), 'float');
            return port === 'value' ? T(dot(c.rgb, vec3(...LUMA)), 'float') : T(c.rgb, 'color');
        }
        case 'importMap': {
            const tex = importMaps?.[p.map];
            if (!tex) return port === 'color' ? C(new THREE.Color(0.5, 0.5, 0.5)) : C(0.5);
            // model UVs incl. texture transform (e.g. KHR_texture_transform)
            if (tex.matrixAutoUpdate) tex.updateMatrix();
            const c = texture(tex, mat3(tex.matrix.clone()).mul(vec3(ctx.modelUv, 1)).xy);
            return port === 'color' ? T(c.rgb, 'color') : T(c[port], 'float');
        }
    }
    if (def?.evaluate) return def.evaluate(port, p, get, ctx);
    return C(0);
}

const clamp01 = v => Math.min(Math.max(v, 0), 1);

// coordinate settings of a texture node: (c − offset) × tiling, turned by `angle` around the centre of the copy.
// The values are uniforms: moving a decal changes only them, the bake shader stays the same (no new compile per step)
function mapCoord(c, p) {
    const off = [p.offsetU || 0, p.offsetV || 0], til = [p.tilingU ?? 1, p.tilingV ?? 1], a = (p.angle || 0) * Math.PI / 180;
    if (!off[0] && !off[1] && til[0] === 1 && til[1] === 1 && !a) return c;   // unchanged (older graphs: same shader)
    const d = c.sub(uniform(new THREE.Vector2(...off))).mul(uniform(new THREE.Vector2(...til))).sub(0.5);
    const co = uniform(Math.cos(-a)), si = uniform(Math.sin(-a));
    return vec2(d.x.mul(co).sub(d.y.mul(si)), d.x.mul(si).add(d.y.mul(co))).add(0.5);
}

// one axis of an image coordinate: { t: 0..1 to sample, inside: 1 where the picture is (0 outside a non-repeating one) }
function wrapAxis(x, mode) {
    if (mode === 'mirror') return { t: float(1).sub(abs(fract(x.mul(0.5)).mul(2).sub(1))), inside: float(1) };
    if (mode === 'off') return { t: clamp(x, 0, 1), inside: step(0, x).mul(step(x, 1)) };
    return { t: fract(x), inside: float(1) };
}

// --- Baking ---

export class GraphBaker {
    constructor(renderer) {
        this.renderer = renderer;
        this.target = new THREE.RenderTarget(BAKE_SIZE, BAKE_SIZE, { depthBuffer: false, type: THREE.UnsignedByteType });
        this.material = new THREE.NodeMaterial();
        this.material.toneMapped = false;
        this.quad = new THREE.QuadMesh(this.material);
    }

    /**
     * Bake a TSL expression (function of the UVs) into a texture.
     * @param {'color'|'float'} type
     * @param {boolean} srgb  store the color sRGB-encoded (color maps)
     * @param {number} size  edge length (import textures: resolution of the source)
     */
    async bake(node, type, { srgb = false, size = BAKE_SIZE } = {}) {
        return makeTexture(await this.bakePixels(node, type, { srgb, size }), srgb, size);
    }

    /** Like bake(), but only the RGBA pixels (size², 8 bit); small sizes (node previews) use their own target, the
     *  maps' target keeps its size */
    async bakePixels(node, type, { srgb = false, size = BAKE_SIZE } = {}) {
        const { renderer } = this;
        const target = size < BAKE_SIZE ? (this.smallTarget ??= new THREE.RenderTarget(size, size, { depthBuffer: false, type: THREE.UnsignedByteType })) : this.target;
        if (target.width !== size) target.setSize(size, size);
        // 'floatA': the value also in alpha (three reads specularIntensityMap / sheenRoughnessMap from A)
        let out = type === 'float' || type === 'floatA' ? vec3(node) : node;
        if (srgb) out = sRGBTransferOETF(out);
        this.material.fragmentNode = uniformConstants(vec4(out, type === 'floatA' ? float(node) : 1));
        this.material.needsUpdate = true;
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        this.quad.render(renderer);
        renderer.setRenderTarget(prev);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        const src = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), row = size * 4;
        if (src.length === row * size) return src.slice();
        // WebGPU pads each row to 256 bytes (sizes that are no multiple of 64, e.g. 200 px previews): drop the padding
        const stride = src.length / size, packed = new Uint8Array(row * size);
        for (let y = 0; y < size; y++) packed.set(src.subarray(y * stride, y * stride + row), y * row);
        return packed;
    }

    /** Height (TSL) -> normal map (tangent space). The height is baked as float – in 8 bit gentle slopes showed
     *  steps in the normals */
    async bakeNormal(heightNode, strength, size = BAKE_SIZE) {
        const { renderer } = this;
        const target = this.heightTarget ??= new THREE.RenderTarget(size, size, { depthBuffer: false, type: THREE.FloatType });
        if (target.width !== size) target.setSize(size, size);
        this.material.fragmentNode = uniformConstants(vec4(vec3(heightNode), 1));
        this.material.needsUpdate = true;
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        this.quad.render(renderer);
        renderer.setRenderTarget(prev);
        const src = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        const n = size;
        const out = new Uint8Array(n * n * 4);
        const at = (x, y) => src[(((y + n) % n) * n + ((x + n) % n)) * 4];
        const k = strength * 8;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const dx = (at(x + 1, y) - at(x - 1, y)) * k;
                const dy = (at(x, y + 1) - at(x, y - 1)) * k;
                const l = Math.hypot(dx, dy, 1);
                const i = (y * n + x) * 4;
                out[i] = (-dx / l * 0.5 + 0.5) * 255;
                out[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
                out[i + 2] = (1 / l * 0.5 + 0.5) * 255;
                out[i + 3] = 255;
            }
        }
        return makeTexture(out, false, n);
    }
}

// Every number in a bake shader becomes a uniform of the same value, so a changed node value leaves the shader code
// as it was – three then takes the compiled pipeline from its cache instead of compiling anew, which took ~200 ms per
// node preview and map and held the GPU process (the window stood still; user: "node editor very slow"; measured
// with a checker: 230 ms → 6 ms). Only a change of structure (a link, a select, the number of octaves) compiles –
// that first compile costs ~7 % more than with constants (measured 440 vs. 410 ms). Compiling it in the background
// (compileAsync) was tried and dropped: twice as slow, and the GPU process stood still just the same.
// The nodes build their expressions from plain JS numbers; turning those into uniforms in every node by hand would
// be a lot of places to keep right, so the finished tree is rewritten here: each float / vector constant (no
// int/uint – bit operations and indices stay constants) is replaced in its parent by a uniform. Constants written
// inside inline Fn(() => …)() bodies are not in the tree – such bodies take their values as arguments instead
// (waves.js ripples, marble-noise.js voronoiRegions).
const UNIFORM_TYPES = new Set([null, 'float', 'vec2', 'vec3', 'vec4', 'color']);
export function uniformConstants(root) {
    // one uniform per use: three shares constant nodes of equal value, so merging them would let the uniform count –
    // and the code – depend on whether two values happen to be equal (a noise threshold of 0.25 next to a fixed 0.25
    // compiled anew)
    const seen = new Set();
    const stack = [root];
    const swap = c => uniform(typeof c.value === 'number' ? c.value : c.value.clone(), c.nodeType || undefined);
    while (stack.length) {
        const node = stack.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        for (const { property, index, childNode } of node._getChildren()) {
            const v = childNode.value;
            if (childNode.isConstNode && UNIFORM_TYPES.has(childNode.nodeType ?? null)
                && (typeof v === 'number' || v?.isVector2 || v?.isVector3 || v?.isVector4 || v?.isColor)) {
                if (index === undefined) node[property] = swap(childNode); else node[property][index] = swap(childNode);
            } else stack.push(childNode);
        }
    }
    return root;
}

function makeTexture(data, srgb, size) {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
}

// Image node: data URL -> texture (for baking)
export async function loadImageTexture(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}
