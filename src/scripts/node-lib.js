// Shared helpers for material graph nodes (material-graph.js and the node modules in nodes/).
//
// A node result is { isConst, type, value } (constant: number or THREE.Color, linear) or
// { isConst: false, type, node } (TSL expression over the texture coordinate).
// Types: 'float', 'color' (vec3, linear) and 'vector' (vec2 texture coordinate – e.g. the coordinate inside a tile).
//
// Texture nodes are baked into one square texture that covers one UV tile; the output node's `size` says how many
// mm that tile is on the model. Everything a texture node draws must therefore repeat seamlessly at the tile edge:
// integer cell counts per tile and the periodic helpers below (period = cells per tile). A node fed with a
// `vector` input (e.g. the per-tile coordinate of Tiles) does not need to repeat – the input decides.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uvec3, ivec3, uint, uv, fract, floor, dot, mix, min, max, abs, select, sqrt } from 'three/tsl';

export const LUMA = [0.2126, 0.7152, 0.0722];
/** hex (sRGB) -> linear color */
export const linear = hex => new THREE.Color(hex);

/** constant result */
export const C = v => ({ isConst: true, type: typeof v === 'number' ? 'float' : 'color', value: v });
/** TSL result */
export const T = (node, type) => ({ isConst: false, type, node });
/** result -> TSL expression */
export const tsl = r => (r.isConst ? (r.type === 'float' ? float(r.value) : vec3(r.value.r, r.value.g, r.value.b)) : r.node);

/** type conversion float <-> color (vector -> float/color for a quick look at a coordinate) */
export function convert(r, type) {
    if (r.type === type) return r;
    if (r.type === 'vector') {
        if (type === 'float') return T(fract(r.node.x), 'float');
        if (type === 'color') return T(vec3(fract(r.node), 0), 'color');
        return r;
    }
    if (type === 'vector') return null;   // a value is no coordinate
    if (type === 'float') {
        return r.isConst
            ? { isConst: true, type, value: r.value.r * LUMA[0] + r.value.g * LUMA[1] + r.value.b * LUMA[2] }
            : { isConst: false, type, node: dot(r.node, vec3(...LUMA)) };
    }
    return r.isConst
        ? { isConst: true, type, value: new THREE.Color(r.value, r.value, r.value) }
        : { isConst: false, type, node: vec3(r.node) };
}

/**
 * Read an input: connected -> result (type-converted), otherwise the parameter of the same key.
 * Type 'vector': connected coordinate, otherwise the UV of the bake tile (0..1 = one tile).
 */
export function input(get, key, type, paramValue) {
    const r = get(key);
    if (type === 'vector') {
        const v = r && convert(r, 'vector');
        return v || T(uv(), 'vector');
    }
    if (r) return convert(r, type);
    return C(type === 'color' ? linear(paramValue) : paramValue);
}

/** texture coordinate of a node (input 'uv' of type 'vector'): TSL vec2 */
export const coord = get => input(get, 'uv', 'vector').node;

/** constant check over several results */
export const allConst = (...rs) => rs.every(r => r.isConst);

// --- hashes and noise (all periodic: `period` = cells per tile, integer) ---

/** integer cell index wrapped into 0..period−1 (also for negative indices; +½ – GPU division is not exact, 10 / 5
 *  could floor to 1.999… and wrap 10 to 5) */
export const wrap = (i, period) => i.sub(floor(i.add(0.5).div(period)).mul(period));

/** three pseudo random numbers 0..1 from an integer cell index (vec3; pcg3d, Jarzynski & Olano 2020 – as in wool.js) */
export const hash33 = Fn(([c]) => {
    const v = uvec3(ivec3(floor(c.add(0.5)))).toVar();
    v.assign(v.mul(uint(1664525)).add(uint(1013904223)));
    v.x.addAssign(v.y.mul(v.z));
    v.y.addAssign(v.z.mul(v.x));
    v.z.addAssign(v.x.mul(v.y));
    v.assign(v.bitXor(v.shiftRight(uvec3(16))));
    v.x.addAssign(v.y.mul(v.z));
    v.y.addAssign(v.z.mul(v.x));
    v.z.addAssign(v.x.mul(v.y));
    return vec3(v).mul(1 / 4294967296);
}).setLayout({ name: 'rindrHash33', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });   // a real shader function:
// inlined, every call copied the hash into the shader (nodes with many noise calls compiled for seconds)
/** pseudo random 0..1 from a 2D integer cell index; `seed` (number) gives independent streams */
export const hash2 = (p, seed = 0) => hash33(vec3(p, seed)).x;
/** two pseudo random numbers 0..1 from a 2D integer cell index */
export const hash22 = (p, seed = 0) => hash33(vec3(p, seed)).xy;

/** tileable value noise 0..1 (period = grid cells per tile) */
export const periodicNoise = Fn(([p, period]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3).sub(f.mul(2)));
    const a = hash2(wrap(i, period));
    const b = hash2(wrap(i.add(vec2(1, 0)), period));
    const c = hash2(wrap(i.add(vec2(0, 1)), period));
    const d = hash2(wrap(i.add(vec2(1, 1)), period));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}).setLayout({ name: 'rindrPeriodicNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 'period', type: 'vec2' }] });

/** fractal sum of periodic noise 0..1 (octaves each twice as fine, half as strong) */
export function fbm(p, period, octaves) {
    let sum = float(0);
    let amp = 0.5, norm = 0;
    for (let o = 0; o < Math.max(1, octaves); o++) {
        const f = 2 ** o;
        sum = sum.add(periodicNoise(p.mul(f), period.mul(f)).mul(amp));
        norm += amp;
        amp *= 0.5;
    }
    return sum.div(norm);
}

/** turbulence 0..1: fractal sum of |noise − ½| (sharp creases at the zero crossings) */
export function turbulence(p, period, octaves) {
    let sum = float(0);
    let amp = 0.5, norm = 0;
    for (let o = 0; o < Math.max(1, octaves); o++) {
        const f = 2 ** o;
        sum = sum.add(abs(periodicNoise(p.mul(f), period.mul(f)).sub(0.5)).mul(2 * amp));
        norm += amp;
        amp *= 0.5;
    }
    return sum.div(norm);
}

/**
 * Tileable cellular (Worley) noise: random feature points, one per cell (`jitter` 0 = grid, 1 = fully random).
 * p in cells, period = cells per tile. Returns TSL nodes { f1, f2 } (distance to the nearest / second nearest point
 * in cells) and { cell } (vec2 index of the nearest cell, wrapped – feed hash2/hash22 for a per-cell random).
 */
export function worley(p, period, jitter = 1) {
    const i = floor(p);
    const f = fract(p);
    let f1 = float(8), f2 = float(8), cell = vec2(0, 0);
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const o = vec2(x, y);
            const id = wrap(i.add(o), period);
            const pt = o.add(hash22(id).sub(0.5).mul(jitter)).add(0.5);
            const d = sqrt(dot(pt.sub(f), pt.sub(f)));
            f2 = min(f2, max(f1, d));
            cell = select(d.lessThan(f1), id, cell);
            f1 = min(f1, d);
        }
    }
    return { f1, f2, cell };
}

/** vary a colour per element: random r 0..1, amount 0..1 → brightness ± amount/2 and a slight warm/cool shift */
export function vary(color, r, amount) {
    if (!amount) return color;
    const k = r.sub(0.5).mul(amount);
    return color.mul(float(1).add(k)).mul(vec3(float(1).add(k.mul(0.08)), 1, float(1).sub(k.mul(0.08))));
}
