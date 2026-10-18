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
// Procedural texture nodes live in their own modules in nodes/ (one per type, default export = node type with an
// `evaluate` function; see node-lib.js for the result format and the tileable helpers) and register themselves here.
//
// Imported materials (glTF/FBX) get a graph on import with one "import texture" node per texture
// of the file. If such a node is attached unchanged to the matching input (channel as three.js
// reads it, e.g. metalness = B, roughness = G), the original texture is set directly as a map
// (kind 'map', full resolution, material parameters act as a factor). Only when something sits
// in between is it baked – with the model's UVs, at the resolution of the source texture.
import { t } from './i18n.js';
import * as THREE from 'three/webgpu';
import { float, vec3, vec4, uv, texture, mat3, fract, floor, dot, mix, mod, clamp, max, min, pow, sRGBTransferOETF } from 'three/tsl';
import { LUMA, linear, C, T, tsl, convert, input } from './node-lib.js';

export const BAKE_SIZE = 1024;
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
            { key: 'clearcoat', type: 'float' },
            { key: 'clearcoatRoughness', type: 'float' },
            { key: 'transmission', type: 'float' },
            { key: 'sheen', type: 'float' },
            { key: 'emissive', type: 'color' },
            { key: 'normal', type: 'color' },
            { key: 'ao', type: 'float' },
            { key: 'height', type: 'float' },
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
        inputs: [], outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }],
        params: [
            { key: 'image', kind: 'image', default: null },
            { key: 'scale', kind: 'number', min: 1, max: 50, step: 1, default: 4 },
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
    gradient: {
        category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [], outputs: [{ key: 'value', type: 'float' }],
        params: [
            { key: 'axis', kind: 'select', options: ['u', 'v'], default: 'u' },
            { key: 'scale', kind: 'number', min: 1, max: 50, step: 1, default: 1 },
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

export const NODE_CATEGORIES = ['input', 'texture', 'color', 'value'];

/** Display label of a node type */
export const nodeLabel = type => t(`nodes.types.${type}.label`);
/** Display label of a node category */
export const categoryLabel = category => t(`nodes.categories.${category}`);
/** Display label of an input ('inputs') or output ('outputs') port */
export const portLabel = (type, side, key) => t(`nodes.types.${type}.${side}.${key}`);
/** Display label of a node parameter */
export const paramLabel = (type, key) => t(`nodes.types.${type}.params.${key}`);
/** Display label of an option of a select parameter */
export const optionLabel = (type, param, option) => t(`nodes.types.${type}.options.${param}.${option}`);

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
};
// input -> channel that can be passed through
const PASS_PORT = Object.fromEntries(Object.values(IMPORT_SLOTS));

/**
 * Graph for an imported material: one import node per texture, connected to its inputs
 * (one texture for several maps, e.g. glTF metallicRoughness -> one node, B -> metalness, G -> roughness).
 * @param {{ [mapKey]: THREE.Texture }} maps
 */
export function createImportGraph(maps) {
    const graph = createGraph();
    const byTexture = new Map();   // texture -> node
    let row = 0;
    for (const [key, [input, port]] of Object.entries(IMPORT_SLOTS)) {
        const tex = maps?.[key];
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
export function evaluateGraph(graph, textures, importMaps = {}) {
    // bakeSize: texels across the tile – nodes that smooth edges over about one texel need it
    const fixed = bakeResolution(graph.nodes.find(n => n.type === 'output')?.params?.resolution);
    const ctx = { textures, importMaps, bakeSize: fixed || BAKE_SIZE };
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
        return `${n.type}:${port}(${JSON.stringify(n.params || {})};${ins.join(',')})`;
    };

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
    result.reliefStrength = out.params?.reliefStrength ?? 1;
    result.size = out.params?.size ?? 100;
    return result;
}

function evalNode(n, port, get, ctx) {
    const { textures, importMaps } = ctx;
    const p = { ...defaultParams(n.type), ...n.params };
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
            const c = p.axis === 'v' ? uv().y : uv().x;
            return T(fract(c.mul(s)), 'float');
        }
        case 'checker': {
            const s = Math.max(1, Math.round(p.scale));
            const cell = floor(uv().mul(s));
            const m = mod(cell.x.add(cell.y), 2);
            const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b);
            return port === 'value' ? T(m, 'float') : T(mix(tsl(a), tsl(b), m), 'color');
        }
        case 'image': {
            const tex = textures?.get(n.id);
            if (!tex) return port === 'value' ? C(0.5) : C(new THREE.Color(0.5, 0.5, 0.5));
            const s = Math.max(1, Math.round(p.scale));
            const c = texture(tex, fract(uv().mul(s))).rgb;
            return port === 'value' ? T(dot(c, vec3(...LUMA)), 'float') : T(c, 'color');
        }
        case 'importMap': {
            const tex = importMaps?.[p.map];
            if (!tex) return port === 'color' ? C(new THREE.Color(0.5, 0.5, 0.5)) : C(0.5);
            // model UVs incl. texture transform (e.g. KHR_texture_transform)
            if (tex.matrixAutoUpdate) tex.updateMatrix();
            const c = texture(tex, mat3(tex.matrix.clone()).mul(vec3(uv(), 1)).xy);
            return port === 'color' ? T(c.rgb, 'color') : T(c[port], 'float');
        }
    }
    const def = NODE_TYPES[n.type];
    if (def?.evaluate) return def.evaluate(port, p, get, ctx);
    return C(0);
}

const clamp01 = v => Math.min(Math.max(v, 0), 1);

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
        const { renderer, target } = this;
        if (target.width !== size) target.setSize(size, size);
        let out = type === 'float' ? vec3(node) : node;
        if (srgb) out = sRGBTransferOETF(out);
        this.material.fragmentNode = vec4(out, 1);
        this.material.needsUpdate = true;
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        this.quad.render(renderer);
        renderer.setRenderTarget(prev);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        return makeTexture(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice(), srgb, size);
    }

    /** Height (TSL) -> normal map (tangent space). The height is baked as float – in 8 bit gentle slopes showed
     *  steps in the normals */
    async bakeNormal(heightNode, strength, size = BAKE_SIZE) {
        const { renderer } = this;
        const target = this.heightTarget ??= new THREE.RenderTarget(size, size, { depthBuffer: false, type: THREE.FloatType });
        if (target.width !== size) target.setSize(size, size);
        this.material.fragmentNode = vec4(vec3(heightNode), 1);
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
