// RINDR node graph ↔ MaterialX nodes (docs/material-format.md "Nodegraph").
//
// Export: a node with a MaterialX counterpart of the same meaning becomes that node (mix, math, remap, checkerboard,
// image + place2d …); RINDR's own procedural nodes (noise, tiles, wood …) have none – they are baked into a picture at
// that point of the graph, the MaterialX nodes after it stay editable in the other program. Everything sits in one
// <nodegraph> with an output per OpenPBR input. Coordinates: texcoord is the tile coordinate (one tile of the
// output's `size` = 0..1) like on the baked maps – the other program scales its UVs (materialx.js, "tile = … mm").
//
// Import (graphFromMtlx): the same nodes back – also from other programs; an input whose nodes RINDR does not all
// know returns null, materialx.js then reads it as before (the picture behind it).
import * as THREE from 'three/webgpu';
import { NODE_TYPES, defaultParams } from './material-graph.js';
import { LUMA } from './node-lib.js';

const fmt = v => String(Number(Number(v).toFixed(6)));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ident = s => {
    const id = String(s).replace(/[^A-Za-z0-9_]+/g, '_');
    return /^[A-Za-z_]/.test(id) ? id : 'n_' + id;
};

// RINDR port type → MaterialX type
export const MX_TYPE = { float: 'float', color: 'color3', vector: 'vector2' };

// output node input → OpenPBR input it drives (the material's value there is the unit while the graph drives it –
// materialx.js keeps its factor / remap as for the baked maps). Not here: normal, relief and anisotropy (baked –
// RINDR's relief → normal map and the per-pixel anisotropy conversion have no node of the same meaning), ao
export const GRAPH_TO_OPENPBR = {
    color: 'base_color', metalness: 'base_metalness', roughness: 'specular_roughness', diffuseRoughness: 'base_diffuse_roughness',
    specularIntensity: 'specular_weight', specularColor: 'specular_color', clearcoat: 'coat_weight', clearcoatRoughness: 'coat_roughness',
    coatColor: 'coat_color', coatIor: 'coat_ior', coatDarkening: 'coat_darkening', transmission: 'transmission_weight',
    transmissionColor: 'transmission_color', transmissionDepth: 'transmission_depth', sheen: 'fuzz_color', sheenRoughness: 'fuzz_roughness',
    iridescence: 'thin_film_weight', emissive: 'emission_color', alpha: 'geometry_opacity',
};

// --- values ---
// a reference is { type, node, output? } (a node in the nodegraph) or { type, value, attrs? } (a value in place)
const val = (type, value, attrs = '') => ({ type, value, attrs });
const F = x => val('float', fmt(x));
const I = x => val('integer', String(Math.round(x)));
const S = s => val('string', s);
const B = b => val('boolean', b ? 'true' : 'false');
const V2 = (x, y) => val('vector2', `${fmt(x)}, ${fmt(y)}`);
const V3 = (x, y, z) => val('vector3', `${fmt(x)}, ${fmt(y)}, ${fmt(z)}`);
const C3 = c => val('color3', `${fmt(c.r)}, ${fmt(c.g)}, ${fmt(c.b)}`);
/** RINDR colour parameter (hex, sRGB) → MaterialX colour (linear rec709) */
const hexC3 = hex => C3(new THREE.Color(hex));
/** Rec.709 luma coefficients as MaterialX lumacoeffs (RINDR's working space; MaterialX's default is ACEScg's) */
const LUMA_C3 = val('color3', LUMA.map(fmt).join(', '));
// value helpers for the node modules' writers (x.v)
const VALUES = { F, I, S, B, V2, V3, C3, hexC3, LUMA: LUMA_C3, FILE: (file, colorspace) => val('filename', file, colorspace ? ` colorspace="${colorspace}"` : '') };
/** a constant evaluation result (material-graph.js: number or linear THREE.Color) */
const constRef = r => (r.type === 'float' ? F(r.value) : C3(r.value));

// --- writer ---

class MxNodes {
    constructor() {
        this.lines = [];
        this.names = new Set();
    }

    name(base) {
        const root = ident(base);
        let name = root;
        for (let i = 2; this.names.has(name); i++) name = `${root}_${i}`;
        this.names.add(name);
        return name;
    }

    /** a node; inputs: { name: ref } (null/undefined left out). Returns its reference (multioutput: use out()) */
    add(category, type, inputs = {}, base = category) {
        const name = this.name(base);
        const ins = Object.entries(inputs).filter(([, r]) => r).map(([k, r]) => (r.node
            ? `    <input name="${k}" type="${r.type}" nodename="${r.node}"${r.output ? ` output="${r.output}"` : ''} />`
            : `    <input name="${k}" type="${r.type}" value="${esc(r.value)}"${r.attrs || ''} />`));
        this.lines.push(ins.length ? `    <${category} name="${name}" type="${type}">\n${ins.map(l => '  ' + l).join('\n')}\n    </${category}>`
            : `    <${category} name="${name}" type="${type}" />`);
        return { type, node: name };
    }

    /** one output of a multioutput node */
    out(ref, output, type) {
        return { type, node: ref.node, output };
    }
}

/** reference converted to a MaterialX type (float ↔ color3 like RINDR's ports: grey / Rec.709 luminance); null if not possible */
function as(mx, ref, type) {
    if (!ref || ref.type === type) return ref;
    if (ref.type === 'float' && type === 'color3') {
        return ref.node ? mx.add('convert', 'color3', { in: ref }, 'to_color') : val('color3', `${ref.value}, ${ref.value}, ${ref.value}`);
    }
    if (ref.type === 'color3' && type === 'float') {
        if (!ref.node) {
            const [r, g, b] = ref.value.split(',').map(Number);
            return F(r * LUMA[0] + g * LUMA[1] + b * LUMA[2]);
        }
        const v = mx.add('convert', 'vector3', { in: ref }, 'to_vector');
        return mx.add('dotproduct', 'float', { in1: v, in2: V3(...LUMA) }, 'luminance');
    }
    return null;
}

// --- translators: RINDR node → MaterialX nodes (null = none of the same meaning → baked picture) ---
// x: { n, p, port, mx, input(key, type) → ref, coord() → ref (texture nodes: coordinate + mapping), texcoord() }

// math ops → MaterialX node (one input: `in`, two: in1/in2); pow clamps the base at 0 like RINDR's
const MATH_BINARY = { add: 'add', sub: 'subtract', mul: 'multiply', div: 'divide', min: 'min', max: 'max', mod: 'modulo' };
const MATH_UNARY_MX = { abs: 'absval', floor: 'floor', ceil: 'ceil', round: 'round', fract: 'fract', sqrt: 'sqrt', sin: 'sin', cos: 'cos', sign: 'sign', trianglewave: 'trianglewave' };

const TRANSLATE = {
    mix: async x => x.mx.add('mix', 'color3', { fg: await x.input('b', 'color'), bg: await x.input('a', 'color'), mix: await x.input('factor', 'float') }),
    ramp: async x => {
        const t = x.mx.add('clamp', 'float', { in: await x.input('t', 'float'), low: F(0), high: F(1) });
        return x.mx.add('mix', 'color3', { fg: hexC3(x.p.b), bg: hexC3(x.p.a), mix: t });
    },
    math: async x => {
        const a = await x.input('a', 'float'), b = await x.input('b', 'float');
        if (MATH_BINARY[x.p.op]) return x.mx.add(MATH_BINARY[x.p.op], 'float', { in1: a, in2: b });
        if (MATH_UNARY_MX[x.p.op]) return x.mx.add(MATH_UNARY_MX[x.p.op], 'float', { in: a });
        if (x.p.op === 'pow') return x.mx.add('power', 'float', { in1: x.mx.add('max', 'float', { in1: a, in2: F(0) }), in2: b });
        return null;
    },
    remap: async x => x.mx.add('remap', 'float', { in: await x.input('value', 'float'), inlow: F(0), inhigh: F(1), outlow: F(x.p.from), outhigh: F(x.p.to) }),
    invert: async x => x.mx.add('invert', 'float', { in: await x.input('value', 'float'), amount: F(1) }),
    gradient: async x => {
        if (x.p.extent === 'object') return null;   // once over the object: UV mode, no tile coordinate
        const c = await x.coord();
        if (!c) return null;
        const s = Math.max(1, Math.round(x.p.scale));
        let v = x.mx.add('extract', 'float', { in: c, index: I(x.p.axis === 'v' ? 1 : 0) });
        v = x.mx.add('modulo', 'float', { in1: x.mx.add('multiply', 'float', { in1: v, in2: F(s) }), in2: F(1) });
        const from = x.p.from ?? 0, to = x.p.to ?? 1;
        if (from !== 0 || to !== 1) {
            v = x.mx.add('divide', 'float', { in1: x.mx.add('subtract', 'float', { in1: v, in2: F(from) }), in2: F(Math.max(to - from, 1e-3)) });
            v = x.mx.add('clamp', 'float', { in: v, low: F(0), high: F(1) });
        }
        return v;
    },
    checker: async x => {
        const c = await x.coord();
        if (!c) return null;
        const s = Math.max(1, Math.round(x.p.scale));
        // MaterialX: mix(color2, color1, (⌊u⌋ + ⌊v⌋) mod 2) – RINDR's a on even cells = color2
        const value = x.port === 'value';
        const board = x.mx.add('checkerboard', 'color3', {
            color1: value ? C3({ r: 1, g: 1, b: 1 }) : await x.input('b', 'color'),
            color2: value ? C3({ r: 0, g: 0, b: 0 }) : await x.input('a', 'color'),
            uvtiling: V2(s, s), uvoffset: V2(0, 0), texcoord: c,
        });
        return value ? x.mx.add('extract', 'float', { in: board, index: I(0) }) : board;
    },
    image: async x => {
        if (x.p.wrapU === 'off' || x.p.wrapV === 'off') return null;   // a decal: UV mode
        const file = await x.env.image?.(x.n.id);
        if (!file) return null;
        let c = await x.coord();
        if (!c) return null;
        const k = Math.max(1, Math.round(x.p.scale));
        if (k !== 1) c = x.mx.add('multiply', 'vector2', { in1: c, in2: F(k) }, 'image_scale');
        const mode = w => S(w === 'mirror' ? 'mirror' : 'periodic');
        const alpha = x.port === 'alpha';
        const img = x.mx.add('image', alpha ? 'color4' : 'color3', {
            file: val('filename', file, x.p.colorspace === 'raw' ? '' : ' colorspace="srgb_texture"'), texcoord: c,
            uaddressmode: mode(x.p.wrapU), vaddressmode: mode(x.p.wrapV),
        });
        if (alpha) return x.mx.add('extract', 'float', { in: img, index: I(3) });
        return x.port === 'value' ? as(x.mx, img, 'float') : img;
    },
};

/** mapping of a texture node (material-graph.js mapCoord: (c − offset) × tiling, turned around the copy's centre)
 *  as place2d (SRT: rotate((c − pivot) / scale) − offset + pivot) – the same with scale = 1 / tiling,
 *  pivot = offset + ½ / tiling, offset = pivot − ½; rotate2d turns like RINDR (amount in degrees) */
function place(mx, c, p) {
    const off = [p.offsetU || 0, p.offsetV || 0], til = [p.tilingU ?? 1, p.tilingV ?? 1], angle = p.angle || 0;
    if (!off[0] && !off[1] && til[0] === 1 && til[1] === 1 && !angle) return c;
    if (!til[0] || !til[1]) return null;   // tiling 0: one texel everywhere – baked instead
    const pivot = [off[0] + 0.5 / til[0], off[1] + 0.5 / til[1]];
    return mx.add('place2d', 'vector2', {
        texcoord: c, pivot: V2(...pivot), scale: V2(1 / til[0], 1 / til[1]), rotate: F(angle),
        offset: V2(pivot[0] - 0.5, pivot[1] - 0.5), operationorder: I(0),
    });
}

/**
 * Write the graph's inputs as MaterialX nodes in one nodegraph.
 * @param graph  RINDR node graph (tile mode – not UV mode, no textures from a model file: the caller checks)
 * @param {string[]} keys  output inputs to write (graph input keys)
 * @param env  { evaluate(nodeId, port) → constant result or { isConst: false } (material-graph.js evaluateNode),
 *               bake(nodeId, port, type) → file in the package (picture of that output, tile coordinate) or null,
 *               image(nodeId) → file of an image node's picture or null }
 * @returns {{ xml: string, outputs: { [key]: { nodegraph, output, type } } } | null}  null: nothing written
 */
export async function graphToMtlx(graph, keys, env, name) {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    const linkTo = new Map(graph.links.map(l => [l.to.node + ':' + l.to.port, l.from]));
    const mx = new MxNodes();
    const cache = new Map();
    let tc = null, tt = null;
    const texcoord = () => (tc ??= mx.add('texcoord', 'vector2', { index: I(0) }, 'texcoord'));
    const tiled = () => (tt ??= mx.add('modulo', 'vector2', { in1: texcoord(), in2: F(1) }, 'tile'));

    // a node's output as MaterialX reference: constant → value, translatable → its nodes, else a baked picture
    const emit = async (nodeId, port) => {
        const key = nodeId + ':' + port;
        if (cache.has(key)) return cache.get(key);
        const n = nodes.get(nodeId), def = NODE_TYPES[n?.type];
        const out = def?.outputs.find(o => o.key === port);
        let ref = null;
        if (out) {
            const ev = out.type !== 'vector' ? env.evaluate(nodeId, port) : null;
            if (ev?.isConst) ref = constRef(ev);
            else {
                const write = TRANSLATE[n.type] || def.mtlx?.write;
                ref = write ? await write(ctx(n, port)) : null;
                if (!ref && out.type !== 'vector') {
                    const file = await env.bake(nodeId, port, out.type);
                    if (file) {
                        const color = out.type === 'color';
                        ref = mx.add('image', MX_TYPE[out.type], {
                            file: val('filename', file, color ? ' colorspace="srgb_texture"' : ''), texcoord: texcoord(),
                            uaddressmode: S('periodic'), vaddressmode: S('periodic'),
                        }, `${nodeId}_${port}`);
                    }
                }
            }
        }
        cache.set(key, ref);
        return ref;
    };

    const ctx = (n, port) => {
        const def = NODE_TYPES[n.type];
        const p = { ...defaultParams(n.type), ...n.params };
        const input = async (key, type) => {
            const from = linkTo.get(n.id + ':' + key);
            if (from && nodes.has(from.node)) return as(mx, await emit(from.node, from.port), MX_TYPE[type]);
            if (type === 'vector') return texcoord();
            if (!(key in p)) return null;
            return type === 'color' ? hexC3(p[key]) : F(p[key]);
        };
        return {
            n, p, port, mx, env, input, texcoord, v: VALUES, as: (ref, type) => as(mx, ref, type),
            // the node's coordinate: linked `uv` or texcoord, then its mapping (texture nodes); tile: the tile coordinate
            // wrapped into 0..1 first – RINDR's bake tile, for nodes that are not periodic themselves (ramp4, shapes …)
            coord: async ({ tile = false } = {}) => {
                let c = await input('uv', 'vector');
                if (c && tile && !linkTo.has(n.id + ':uv')) c = tiled();
                return c && def.texture ? place(mx, c, p) : c;
            },
        };
    };

    const out = graph.nodes.find(n => n.type === 'output');
    const outputs = {};
    const lines = [];
    for (const key of keys) {
        const from = out && linkTo.get(out.id + ':' + key);
        if (!from || !nodes.has(from.node)) continue;
        const type = MX_TYPE[NODE_TYPES.output.inputs.find(i => i.key === key)?.type];
        const ref = as(mx, await emit(from.node, from.port), type);
        if (!ref?.node) continue;   // a constant: the material's value
        const output = ident(`out_${key}`);
        lines.push(`    <output name="${output}" type="${type}" nodename="${ref.node}"${ref.output ? ` output="${ref.output}"` : ''} />`);
        outputs[key] = { nodegraph: ident(`NG_${name}`), output, type };
    }
    if (!lines.length) return null;
    return { xml: `  <nodegraph name="${ident(`NG_${name}`)}">\n${mx.lines.join('\n')}\n${lines.join('\n')}\n  </nodegraph>`, outputs };
}

// --- import: MaterialX nodes → RINDR nodes ---

const nums = s => String(s ?? '').split(',').map(Number);
/** MaterialX colour (linear) → RINDR colour parameter (hex, sRGB) */
const linHex = s => {
    const [r, g = r, b = r] = nums(s);
    return '#' + new THREE.Color().setRGB(r || 0, g || 0, b || 0, THREE.LinearSRGBColorSpace).getHexString();
};
const near = (a, b) => Math.abs(a - b) < 1e-4;

/**
 * place2d (SRT: rotate((c − pivot) / scale) − offset + pivot; TRS without turning) → RINDR mapping params
 * ((c − offset) × tiling, turned around the copy's centre – see place() for the way out); null if it has no such form
 */
function mappingOf(get) {
    const piv = nums(get('pivot') ?? '0, 0'), sc = nums(get('scale') ?? '1, 1'), off = nums(get('offset') ?? '0, 0');
    const angle = Number(get('rotate') ?? 0), order = Number(get('operationorder') ?? 0);
    if (!sc[0] || !sc[1]) return null;
    const til = [1 / sc[0], 1 / sc[1]];
    if (order === 1) {
        // TRS: rotate(c − pivot − offset) / scale + pivot – the same form only without turning
        if (angle) return null;
        return { offsetU: piv[0] + off[0] - piv[0] / til[0], offsetV: piv[1] + off[1] - piv[1] / til[1], tilingU: til[0], tilingV: til[1], angle: 0 };
    }
    // R((c − P)·til) + (P − O) = R((c − off)·til − ½) + ½  with  off = P − (R⁻¹(P − O − ½) + ½) / til
    const t = [piv[0] - off[0] - 0.5, piv[1] - off[1] - 0.5];
    const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    // MaterialX rotate2d turns by −angle (R); R⁻¹ turns by +angle
    const w = [c * t[0] - s * t[1], s * t[0] + c * t[1]];
    return { offsetU: piv[0] - (w[0] + 0.5) / til[0], offsetV: piv[1] - (w[1] + 0.5) / til[1], tilingU: til[0], tilingV: til[1], angle };
}

/**
 * The RINDR nodes for one input of a MaterialX surface shader, added to `g` ({ nodes, links }).
 * @param input  the shader's <input> element (nodename, or nodegraph + output)
 * @param doc  { root, children(el), byName(scope, name), image(file) → data URL of a picture or null }
 * @param prefix  node IDs (unique in the material's graph)
 * @returns {Promise<{ node, port } | { value } | null>}  null: a node RINDR does not know – the caller reads it as before
 */
export async function graphFromMtlx(input, doc, g, prefix = 'mx') {
    const { root, children, byName } = doc;
    const memo = new Map();
    let seq = 0;
    const add = (type, params = {}) => {
        const node = { id: `${prefix}_${seq++}`, type, x: 40, y: 20 + g.nodes.length * 60, params };
        g.nodes.push(node);
        return node;
    };
    const childInput = (el, name) => children(el).find(c => c.nodeName === 'input' && c.getAttribute('name') === name);
    // where an input leads: { value, type } | { el, scope, output } | null; interface inputs of a nodegraph: their value
    const follow = (inp, scope) => {
        if (!inp) return undefined;
        if (inp.hasAttribute('nodegraph')) {
            const graph = byName(root, inp.getAttribute('nodegraph'));
            const outName = inp.getAttribute('output');
            const out = graph && children(graph).find(c => c.nodeName === 'output' && (!outName || c.getAttribute('name') === outName));
            const el = out && byName(graph, out.getAttribute('nodename'));
            return el ? { el, scope: graph, output: out.getAttribute('output') } : null;
        }
        if (inp.hasAttribute('nodename')) {
            const el = byName(scope, inp.getAttribute('nodename')) ?? byName(root, inp.getAttribute('nodename'));
            return el ? { el, scope: el.parentElement === root ? root : scope, output: inp.getAttribute('output') } : null;
        }
        if (inp.hasAttribute('interfacename')) {
            const iface = scope !== root && childInput(scope, inp.getAttribute('interfacename'));
            return iface ? follow(iface, root) : null;
        }
        return inp.hasAttribute('value') ? { value: inp.getAttribute('value'), type: inp.getAttribute('type') } : undefined;
    };

    // one MaterialX node (and output) → { node, port } | { value } | null
    const build = async (el, scope, output) => {
        const key = el;
        if (memo.has(key) && memo.get(key).output === output) return memo.get(key).res;
        const cat = el.nodeName, type = el.getAttribute('type');
        const x = {
            el, cat, type, output, add,
            str: name => childInput(el, name)?.getAttribute('value') ?? undefined,
            num: (name, def) => { const v = childInput(el, name)?.getAttribute('value'); return v === undefined || v === null ? def : Number(String(v).split(',')[0]); },
            vec: (name, def) => { const v = childInput(el, name)?.getAttribute('value'); return v === undefined || v === null ? def : nums(v); },
            linked: name => { const i = childInput(el, name); return !!i && (i.hasAttribute('nodename') || i.hasAttribute('nodegraph') || i.hasAttribute('interfacename')); },
            ref: async name => {
                const f = follow(childInput(el, name), scope);
                if (f === undefined || f === null) return f;
                return f.value !== undefined ? f : build(f.el, f.scope, f.output);
            },
            element: name => { const f = follow(childInput(el, name), scope); return f?.el ? f : null; },
            // another followed element (f from element()), or one of its inputs
            buildOther: async (f, name) => {
                const g2 = name ? follow(childInput(f.el, name), f.scope) : f;
                if (g2 === undefined || g2 === null) return g2;
                return g2.value !== undefined ? g2 : build(g2.el, g2.scope, g2.output);
            },
            addLink: (r, node, key) => g.links.push({ from: { node: r.node, port: r.port }, to: { node: node.id, port: key } }),
            image: async () => {
                const file = childInput(el, 'file');
                return file?.getAttribute('value') ? doc.image(file) : null;
            },
            fileColorspace: () => childInput(el, 'file')?.getAttribute('colorspace') || el.getAttribute('colorspace') || '',
        };
        // link an input (or set the parameter): kind 'color' | 'number'; false if it cannot
        x.link = async (name, node, key, kind = 'number') => {
            const r = await x.ref(name);
            if (r === undefined) return true;
            if (!r) return false;
            if (r.value !== undefined) { node.params[key] = kind === 'color' ? linHex(r.value) : Number(String(r.value).split(',')[0]); return true; }
            if (!NODE_TYPES[node.type].inputs.some(i => i.key === key)) return false;
            g.links.push({ from: { node: r.node, port: r.port }, to: { node: node.id, port: key } });
            return true;
        };
        // the coordinate of a texture node: texcoord, wrapped into the tile, place2d (mapping), × number (tiling or the
        // image's copies); false for anything else
        x.coord = async (node, name = 'texcoord') => {
            let f = x.element(name);
            if (f === null && x.linked(name)) return false;
            let scaleK = 1;
            if (f?.el.nodeName === 'multiply' && f.el.getAttribute('type') === 'vector2') {
                const k = Number(String(children(f.el).find(c => c.getAttribute('name') === 'in2')?.getAttribute('value') ?? 'NaN').split(',')[0]);
                if (!(k > 0)) return false;
                scaleK = k;
                f = follow(childInput(f.el, 'in1'), f.scope);
            }
            if (f?.el?.nodeName === 'place2d') {
                const p = f.el;
                const m = mappingOf(n => childInput(p, n)?.getAttribute('value'));
                if (!m || children(p).some(c => c.nodeName === 'input' && c.getAttribute('name') !== 'texcoord' && (c.hasAttribute('nodename') || c.hasAttribute('nodegraph')))) return false;
                Object.assign(node.params, m);
                f = follow(childInput(p, 'texcoord'), f.scope);
            }
            if (f?.el?.nodeName === 'modulo' && f.el.getAttribute('type') === 'vector2') f = follow(childInput(f.el, 'in1'), f.scope);
            if (f && f.el?.nodeName !== 'texcoord') return false;
            if (scaleK !== 1) {
                if (node.type === 'image' && Number.isInteger(scaleK)) node.params.scale = scaleK;
                else if (node.params.angle) return false;
                else { node.params.tilingU = (node.params.tilingU ?? 1) * scaleK; node.params.tilingV = (node.params.tilingV ?? 1) * scaleK; node.params.offsetU = (node.params.offsetU ?? 0) / scaleK; node.params.offsetV = (node.params.offsetV ?? 0) / scaleK; }
            }
            return true;
        };
        const read = READ[cat];
        let res = read ? await read(x) : null;
        if (res === undefined) res = null;
        memo.set(key, { output, res });
        return res;
    };

    const f = follow(input, root);
    if (!f) return null;
    return f.value !== undefined ? f : build(f.el, f.scope, f.output);
}

// MaterialX node → RINDR node(s); x: see graphFromMtlx. Returns { node, port } / { value } / null (unknown here)
const out = (node, port) => ({ node: node.id, port });
const all = list => list.every(Boolean);
const MATH_FROM = { add: 'add', subtract: 'sub', multiply: 'mul', divide: 'div', min: 'min', max: 'max', modulo: 'mod', power: 'pow' };
const UNARY_FROM = Object.fromEntries(Object.entries(MATH_UNARY_MX).map(([k, v]) => [v, k]));
const BLEND_FROM = { screen: 'screen', overlay: 'overlay', difference: 'difference', plus: 'plus', minus: 'minus', dodge: 'dodge', burn: 'burn' };
const isColor = t => t === 'color3' || t === 'color4';

async function readBinary(x) {
    const op = MATH_FROM[x.cat];
    if (x.type === 'float') {
        // RINDR's pow clamps the base: power(max(a, 0), b) → pow with a
        if (op === 'pow') {
            const base = x.element('in1');
            const zero = base && [...base.el.children].find(c => c.getAttribute('name') === 'in2')?.getAttribute('value');
            if (base?.el.nodeName === 'max' && Number(zero) === 0) {
                const n = x.add('math', { op: 'pow' });
                const inner = await x.buildOther(base, 'in1');
                if (!inner) return null;
                if (inner.value !== undefined) n.params.a = Number(inner.value); else x.addLink(inner, n, 'a');
                return (await x.link('in2', n, 'b')) ? out(n, 'value') : null;
            }
        }
        const n = x.add('math', { op });
        return all([await x.link('in1', n, 'a'), await x.link('in2', n, 'b')]) ? out(n, 'value') : null;
    }
    if (isColor(x.type) && ['add', 'sub', 'mul'].includes(op)) {
        // colour arithmetic as a blend (factor 1): a × b, a + b, a − b
        const n = x.add('blend', { op: op === 'mul' ? 'multiply' : op === 'add' ? 'plus' : 'minus', factor: 1 });
        return all([await x.link('in1', n, 'a', 'color'), await x.link('in2', n, 'b', 'color')]) ? out(n, 'color') : null;
    }
    return null;
}

const READ = {
    constant: async x => ({ value: x.str('value') }),
    texcoord: async x => out(x.add('texcoord'), 'uv'),
    convert: async x => x.ref('in'),   // float ↔ colour, vector3 → colour: RINDR's ports convert the same way
    extract: async x => {
        const f = x.element('in');
        const i = x.num('index', 0);
        if (!f) return null;
        const t = f.el.getAttribute('type');
        if (f.el.nodeName === 'texcoord') return out(x.add('texcoord'), i ? 'v' : 'u');
        if (t === 'color4' && i === 3 && f.el.nodeName === 'image') {
            const r = await x.ref('in');
            return r?.node ? { node: r.node, port: 'alpha' } : null;
        }
        if (t === 'color3' || t === 'vector3') {
            const n = x.add('separate');
            return (await x.link('in', n, 'color', 'color')) ? out(n, ['r', 'g', 'b'][i] ?? 'r') : null;
        }
        return null;
    },
    separate2: async x => (x.element('in')?.el.nodeName === 'texcoord' ? out(x.add('texcoord'), x.output === 'outy' ? 'v' : 'u') : null),
    separate3: async x => {
        const n = x.add('separate');
        return (await x.link('in', n, 'color', 'color')) ? out(n, { outr: 'r', outg: 'g', outb: 'b', outx: 'r', outy: 'g', outz: 'b' }[x.output] ?? 'r') : null;
    },
    combine3: async x => {
        const n = x.add('combine');
        return all([await x.link('in1', n, 'r'), await x.link('in2', n, 'g'), await x.link('in3', n, 'b')]) ? out(n, 'color') : null;
    },
    dotproduct: async x => {
        // dot(colour as vector, Rec.709 luma) – RINDR's colour → value conversion: the colour itself
        const v = x.vec('in2');
        const c = x.element('in1');
        if (!v || !c || c.el.nodeName !== 'convert' || !LUMA.every((k, i) => near(k, v[i]))) return null;
        const n = x.add('luminance');
        const inner = await x.buildOther(c, 'in');
        if (!inner) return null;
        if (inner.value !== undefined) n.params.color = linHex(inner.value); else x.addLink(inner, n, 'color');
        return out(n, 'value');
    },
    luminance: async x => {
        const n = x.add('luminance');
        return (await x.link('in', n, 'color', 'color')) ? out(n, 'value') : null;
    },
    mix: async x => {
        const n = x.add('mix');
        return all([await x.link('bg', n, 'a', 'color'), await x.link('fg', n, 'b', 'color'), await x.link('mix', n, 'factor')]) ? out(n, 'color') : null;
    },
    add: readBinary, subtract: readBinary, multiply: readBinary, divide: readBinary, min: readBinary, max: readBinary, modulo: readBinary, power: readBinary,
    clamp: async x => {
        if (x.type !== 'float') return null;
        const n = x.add('clamp');
        return all([await x.link('in', n, 'value'), await x.link('low', n, 'low'), await x.link('high', n, 'high')]) ? out(n, 'value') : null;
    },
    smoothstep: async x => {
        if (x.type !== 'float') return null;
        const n = x.add('smoothstep');
        return all([await x.link('in', n, 'value'), await x.link('low', n, 'low'), await x.link('high', n, 'high')]) ? out(n, 'value') : null;
    },
    remap: async x => {
        if (x.type !== 'float' || ['inlow', 'inhigh', 'outlow', 'outhigh'].some(k => x.linked(k))) return null;
        const inLow = x.num('inlow', 0), inHigh = x.num('inhigh', 1), outLow = x.num('outlow', 0), outHigh = x.num('outhigh', 1);
        const n = inLow === 0 && inHigh === 1 ? x.add('remap', { from: outLow, to: outHigh }) : x.add('range', { inLow, inHigh, outLow, outHigh, gamma: 1, clamp: false });
        return (await x.link('in', n, 'value')) ? out(n, 'value') : null;
    },
    range: async x => {
        if (x.type !== 'float' || ['inlow', 'inhigh', 'gamma', 'outlow', 'outhigh', 'doclamp'].some(k => x.linked(k))) return null;
        const n = x.add('range', { inLow: x.num('inlow', 0), inHigh: x.num('inhigh', 1), gamma: x.num('gamma', 1), outLow: x.num('outlow', 0), outHigh: x.num('outhigh', 1), clamp: x.str('doclamp') === 'true' });
        return (await x.link('in', n, 'value')) ? out(n, 'value') : null;
    },
    invert: async x => {
        if (x.type !== 'float') return null;
        const amount = x.num('amount', 1);
        if (x.linked('amount')) return null;
        const n = amount === 1 ? x.add('invert') : x.add('math', { op: 'sub', a: amount });
        return (await x.link('in', n, amount === 1 ? 'value' : 'b')) ? out(n, 'value') : null;
    },
    checkerboard: async x => {
        const [tu, tv] = x.vec('uvtiling', [8, 8]), [ou, ov] = x.vec('uvoffset', [0, 0]);
        const n = x.add('checker', { scale: 1, tilingU: tu, tilingV: tv, offsetU: ou / tu, offsetV: ov / tv });
        if (x.linked('uvtiling') || x.linked('uvoffset')) return null;
        // a texcoord transform on top: only without RINDR's own tiling from uvtiling (square whole counts → scale)
        const f = x.element('texcoord');
        if (f && f.el.nodeName !== 'texcoord') {
            if (!(near(tu, tv) && Number.isInteger(tu) && !ou && !ov)) return null;
            Object.assign(n.params, { scale: tu, tilingU: 1, tilingV: 1, offsetU: 0, offsetV: 0 });
            if (!(await x.coord(n))) return null;
        }
        return all([await x.link('color1', n, 'b', 'color'), await x.link('color2', n, 'a', 'color')]) ? out(n, 'color') : null;
    },
    image: async x => {
        const url = await x.image();
        if (!url) return null;
        const mode = m => (m === 'mirror' ? 'mirror' : m === 'clamp' || m === 'constant' ? 'off' : 'repeat');
        // raw values: no sRGB colour space on the file (MaterialX: no transform); colour images default to sRGB
        const cs = x.fileColorspace();
        const raw = cs ? !/srgb/i.test(cs) : !isColor(x.type);
        const n = x.add('image', { image: url, scale: 1, wrapU: mode(x.str('uaddressmode')), wrapV: mode(x.str('vaddressmode')), colorspace: raw ? 'raw' : 'srgb' });
        if (!(await x.coord(n))) return null;
        return out(n, x.type === 'float' ? 'value' : 'color');
    },
    hextiledimage: async x => {
        const url = await x.image();
        if (!url) return null;
        const [tu] = x.vec('tiling', [1, 1]);
        const n = x.add('hexImage', {
            image: url, scale: tu, rotation: x.num('rotation', 1), rotationMin: x.vec('rotationrange', [0, 360])[0], rotationMax: x.vec('rotationrange', [0, 360])[1],
            randomScale: x.num('scale', 1), scaleMin: x.vec('scalerange', [0.5, 2])[0], scaleMax: x.vec('scalerange', [0.5, 2])[1],
            offset: x.num('offset', 1), offsetMin: x.vec('offsetrange', [0, 1])[0], offsetMax: x.vec('offsetrange', [0, 1])[1],
            falloff: x.num('falloff', 0.5), falloffContrast: x.num('falloffcontrast', 0.5),
        });
        return (await x.coord(n)) ? out(n, 'color') : null;
    },
    hsvadjust: async x => {
        const [h, s, v] = x.vec('amount', [0, 1, 1]);
        const n = x.add('hsvAdjust', { hue: h, saturation: s, value: v });
        return !x.linked('amount') && (await x.link('in', n, 'color', 'color')) ? out(n, 'color') : null;
    },
    saturate: async x => {
        const n = x.add('saturate', { amount: x.num('amount', 1) });
        return !x.linked('amount') && (await x.link('in', n, 'color', 'color')) ? out(n, 'color') : null;
    },
    contrast: async x => {
        const n = x.add('contrast', { amount: x.num('amount', 1), pivot: x.num('pivot', 0.5) });
        return !x.linked('amount') && !x.linked('pivot') && (await x.link('in', n, 'color', 'color')) ? out(n, 'color') : null;
    },
    colorcorrect: async x => {
        const keys = { hue: 'hue', saturation: 'saturation', gamma: 'gamma', lift: 'lift', gain: 'gain', contrast: 'contrast', contrastpivot: 'contrastPivot', exposure: 'exposure' };
        if (Object.keys(keys).some(k => x.linked(k))) return null;
        const defs = { hue: 0, saturation: 1, gamma: 1, lift: 0, gain: 1, contrast: 1, contrastpivot: 0.5, exposure: 0 };
        const n = x.add('colorCorrect', Object.fromEntries(Object.entries(keys).map(([m, r]) => [r, x.num(m, defs[m])])));
        return (await x.link('in', n, 'color', 'color')) ? out(n, 'color') : null;
    },
    ramp4: async x => {
        const n = x.add('ramp4');
        return all([await x.coord(n), await x.link('valuetl', n, 'tl', 'color'), await x.link('valuetr', n, 'tr', 'color'), await x.link('valuebl', n, 'bl', 'color'), await x.link('valuebr', n, 'br', 'color')]) ? out(n, 'color') : null;
    },
    splitlr: async x => {
        const n = x.add('split', { axis: 'u', center: x.num('center', 0.5) });
        return all([await x.coord(n), await x.link('valuel', n, 'a', 'color'), await x.link('valuer', n, 'b', 'color')]) ? out(n, 'color') : null;
    },
    splittb: async x => {
        const n = x.add('split', { axis: 'v', center: x.num('center', 0.5) });
        return all([await x.coord(n), await x.link('valueb', n, 'a', 'color'), await x.link('valuet', n, 'b', 'color')]) ? out(n, 'color') : null;
    },
    // ramplr / ramptb: mix along the clamped coordinate – a four-corner ramp with equal corners
    ramplr: async x => {
        const n = x.add('ramp4');
        return all([await x.coord(n), await x.link('valuel', n, 'tl', 'color'), await x.link('valuel', n, 'bl', 'color'), await x.link('valuer', n, 'tr', 'color'), await x.link('valuer', n, 'br', 'color')]) ? out(n, 'color') : null;
    },
    ramptb: async x => {
        const n = x.add('ramp4');
        return all([await x.coord(n), await x.link('valuet', n, 'tl', 'color'), await x.link('valuet', n, 'tr', 'color'), await x.link('valueb', n, 'bl', 'color'), await x.link('valueb', n, 'br', 'color')]) ? out(n, 'color') : null;
    },
    ifgreater: async x => readCompare(x, 'greater'),
    ifgreatereq: async x => readCompare(x, 'greaterEqual'),
    ifequal: async x => readCompare(x, 'equal'),
    switch: async x => {
        const n = x.add('switch');
        for (let i = 6; i <= 10; i++) if (x.linked(`in${i}`) || (x.str(`in${i}`) !== undefined && nums(x.str(`in${i}`)).some(v => v))) return null;
        const ok = [await x.link('which', n, 'which')];
        for (let i = 1; i <= 5; i++) ok.push(await x.link(`in${i}`, n, `in${i}`, 'color'));
        if (!all(ok)) return null;
        return out(n, isColor(x.type) ? 'color' : 'value');
    },
    circle: async x => readShape(x, 'circle'),
    hexagon: async x => readShape(x, 'hexagon'),
    cloverleaf: async x => readShape(x, 'cloverleaf'),
    line: async x => {
        const n = await readShape(x, 'line');
        if (!n) return null;
        const node = x.lastNode;
        [node.params.x1, node.params.y1] = x.vec('point1', [0.25, 0.25]);
        [node.params.x2, node.params.y2] = x.vec('point2', [0.75, 0.75]);
        if (!node.params.radius && node.params.radius !== 0) node.params.radius = 0.1;
        return n;
    },
    grid: async x => readPattern(x, 'grid', 'thickness', 0.05),
    crosshatch: async x => readPattern(x, 'crosshatch', 'thickness', 0.05),
    tiledcircles: async x => readPattern(x, 'tiledCircles', 'size', 0.5),
    tiledhexagons: async x => readPattern(x, 'tiledHexagons', 'size', 0.5),
    tiledcloverleafs: async x => readPattern(x, 'tiledCloverleafs', 'size', 0.5),
    unifiednoise2d: async x => {
        const types = ['perlin', 'cell', 'worley', 'fractal'];
        const [fu, fv] = x.vec('freq', [1, 1]), [ou, ov] = x.vec('offset', [0, 0]);
        if (['freq', 'offset', 'jitter', 'outmin', 'outmax', 'octaves', 'lacunarity', 'diminish', 'type', 'style', 'clampoutput'].some(k => x.linked(k))) return null;
        const n = x.add('unifiedNoise', {
            noiseType: types[x.num('type', 0)] ?? 'perlin', freqU: fu, freqV: fv, jitter: x.num('jitter', 1), style: x.num('style', 0) === 1 ? 'solid' : 'distance',
            octaves: x.num('octaves', 3), lacunarity: x.num('lacunarity', 2), diminish: x.num('diminish', 0.5),
            outMin: x.num('outmin', 0), outMax: x.num('outmax', 1), clamp: x.str('clampoutput') !== 'false',
        });
        if (!(await x.coord(n))) return null;
        // MaterialX adds the offset in noise space: (c − o / f) × f
        if (ou || ov) {
            if (n.params.angle) return null;
            n.params.offsetU = (n.params.offsetU ?? 0) - ou / fu / (n.params.tilingU ?? 1);
            n.params.offsetV = (n.params.offsetV ?? 0) - ov / fv / (n.params.tilingV ?? 1);
        }
        return out(n, 'value');
    },
    // the single noises: unified noise of that kind (Perlin: amplitude / pivot as output range, not clamped)
    noise2d: async x => {
        if (x.type !== 'float' || x.linked('amplitude') || x.linked('pivot')) return null;
        const amp = x.num('amplitude', 1), pivot = x.num('pivot', 0);
        const n = x.add('unifiedNoise', { noiseType: 'perlin', freqU: 1, freqV: 1, outMin: pivot - amp, outMax: pivot + amp, clamp: false });
        return (await x.coord(n)) ? out(n, 'value') : null;
    },
    cellnoise2d: async x => {
        if (x.type !== 'float') return null;
        const n = x.add('unifiedNoise', { noiseType: 'cell', freqU: 1, freqV: 1 });
        return (await x.coord(n)) ? out(n, 'value') : null;
    },
    worleynoise2d: async x => {
        if (x.type !== 'float' || x.linked('jitter')) return null;
        const n = x.add('unifiedNoise', { noiseType: 'worley', freqU: 1, freqV: 1, jitter: x.num('jitter', 1), style: x.num('style', 0) === 1 ? 'solid' : 'distance', outMin: 0, outMax: 1, clamp: false });
        return (await x.coord(n)) ? out(n, 'value') : null;
    },
    flake2d: async x => {
        if (['size', 'roughness', 'coverage'].some(k => x.linked(k)) || !['rand', 'presence'].includes(x.output)) return null;
        const n = x.add('flakes', { size: x.num('size', 0.01), roughness: x.num('roughness', 0.1), coverage: x.num('coverage', 0.5) });
        return (await x.coord(n)) ? out(n, x.output) : null;
    },
    randomfloat: async x => {
        if (['min', 'max', 'seed'].some(k => x.linked(k))) return null;
        const n = x.add('randomFloat', { min: x.num('min', 0), max: x.num('max', 1), seed: x.num('seed', 0) });
        return (await x.link('in', n, 'in')) ? out(n, 'value') : null;
    },
    randomcolor: async x => {
        const keys = { huelow: ['hueLow', 0], huehigh: ['hueHigh', 1], saturationlow: ['saturationLow', 0.825], saturationhigh: ['saturationHigh', 1], brightnesslow: ['brightnessLow', 1], brightnesshigh: ['brightnessHigh', 1], seed: ['seed', 0] };
        if (Object.keys(keys).some(k => x.linked(k))) return null;
        const n = x.add('randomColor', Object.fromEntries(Object.entries(keys).map(([m, [r, d]]) => [r, x.num(m, d)])));
        return (await x.link('in', n, 'in')) ? out(n, 'color') : null;
    },
    heighttonormal: async x => {
        if (x.linked('scale')) return null;
        const n = x.add('heightToNormal', { scale: x.num('scale', 1) });
        return (await x.link('in', n, 'height')) ? out(n, 'normal') : null;
    },
    blur: async x => x.ref('in'),   // a pass-through in MaterialX's own shader generators
};
for (const [mx, op] of Object.entries(UNARY_FROM)) {
    READ[mx] = async x => {
        if (x.type !== 'float') return null;
        const n = x.add('math', { op });
        return (await x.link('in', n, 'a')) ? out(n, 'value') : null;
    };
}
for (const [mx, op] of Object.entries(BLEND_FROM)) {
    READ[mx] = async x => {
        const n = x.add('blend', { op });
        return all([await x.link('bg', n, 'a', 'color'), await x.link('fg', n, 'b', 'color'), await x.link('mix', n, 'factor')]) ? out(n, 'color') : null;
    };
}

// logic on masks: RINDR writes mask > 0.5 (ifgreater → boolean) → and / or / xor / not → convert to 0/1
async function readLogic(x, op) {
    if (x.type !== 'boolean') return null;
    const n = x.add('logic', { op });
    for (const [name, key] of op === 'not' ? [['in', 'a']] : [['in1', 'a'], ['in2', 'b']]) {
        const f = x.element(name);
        const half = f && [...f.el.children].find(c => c.getAttribute('name') === 'value2')?.getAttribute('value');
        if (!f || f.el.nodeName !== 'ifgreater' || f.el.getAttribute('type') !== 'boolean' || Number(half) !== 0.5) return null;
        const r = await x.buildOther(f, 'value1');
        if (!r) return null;
        if (r.value !== undefined) n.params[key] = Number(r.value); else x.addLink(r, n, key);
    }
    return out(n, 'value');
}
for (const op of ['and', 'or', 'xor', 'not']) READ[op] = x => readLogic(x, op);

async function readCompare(x, op) {
    if (x.type === 'boolean') return null;   // part of a logic chain (read there)
    const n = x.add('compare', { op });
    const ok = all([await x.link('value1', n, 'value1'), await x.link('value2', n, 'value2'), await x.link('in1', n, 'in1', 'color'), await x.link('in2', n, 'in2', 'color')]);
    return ok ? out(n, isColor(x.type) ? 'color' : 'value') : null;
}
async function readShape(x, type) {
    const [cu, cv] = x.vec('center', [0, 0]);
    if (x.linked('center') || x.linked('radius')) return null;
    const n = x.add(type, { centerU: cu, centerV: cv, radius: x.num('radius', type === 'line' ? 0.1 : 0.5) });
    x.lastNode = n;
    return (await x.coord(n)) ? out(n, 'value') : null;
}
async function readPattern(x, type, sizeKey, sizeDef) {
    if (['uvtiling', 'uvoffset', sizeKey, 'staggered'].some(k => x.linked(k))) return null;
    const [cu, cv] = x.vec('uvtiling', [1, 1]), [ou, ov] = x.vec('uvoffset', [0, 0]);
    const n = x.add(type, { countU: cu, countV: cv, [sizeKey]: x.num(sizeKey, sizeDef), staggered: x.str('staggered') === 'true' });
    if (!(await x.coord(n))) return null;
    if (ou || ov) {
        if (n.params.angle) return null;
        n.params.offsetU = (n.params.offsetU ?? 0) + ou / cu / (n.params.tilingU ?? 1);
        n.params.offsetV = (n.params.offsetV ?? 0) + ov / cv / (n.params.tilingV ?? 1);
    }
    return out(n, 'value');
}
