// Hex-tiled image (Nov. 2026, MaterialX hextiledimage – Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 2022): the
// picture on a hexagonal grid, every hexagon turned / scaled / shifted at random and blended into its neighbours
// (weighted by brightness) – no visible repetition. The hex grid does not repeat with RINDR's square bake tile, so a
// graph with this node is baked once over the object (UV mode, material-graph.js isUvMode) – as in other programs,
// which evaluate it across the whole model too.
import { float, vec2, vec3, fract, floor, dot, mix, step, pow, select, sin, cos, texture, dFdx, dFdy, sRGBTransferOETF, sRGBTransferEOTF } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { C, T, coord, LUMA } from '../node-lib.js';

const SQRT3_2 = Math.sqrt(3) * 2;
// MaterialX's per-hexagon hash (2D → 2D, "hash without sine")
const hash = p => {
    let p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973)));
    p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
    return fract(vec2(p3.x, p3.x).add(vec2(p3.y, p3.z)).mul(vec2(p3.z, p3.y)));
};
// Schlick's gain (falloff of the blend)
const gain = (x, r) => {
    const rr = Math.min(Math.max(r, 0.001), 0.999);
    const a = float(1 / rr - 2).mul(float(1).sub(x.mul(2)));
    return select(x.lessThan(0.5), x.div(a.add(1)), a.sub(x).div(a.sub(1)));
};
const weights = (lum, tile, falloff) => {
    let w = lum.mul(pow(tile, vec3(7)));
    w = w.div(w.x.add(w.y).add(w.z));
    if (falloff !== 0.5) {
        w = vec3(gain(w.x, falloff), gain(w.y, falloff), gain(w.z, falloff));
        w = w.div(w.x.add(w.y).add(w.z));
    }
    return w;
};
// GLSL mat2(a, b, c, d) · v (column-major) / v · mat2 (row vector)
const mul = (m, v) => vec2(v.x.mul(m[0]).add(v.y.mul(m[2])), v.x.mul(m[1]).add(v.y.mul(m[3])));

function hexTile(tex, c, p) {
    const st = c.mul(SQRT3_2);
    const sk = mul([1, 0, -0.57735027, 1.15470054], st);
    const fr = fract(sk);
    const tz = float(1).sub(fr.x).sub(fr.y);
    const s = step(0, tz.negate()), s2 = s.mul(2).sub(1);
    const tw = vec3(tz.negate().mul(s2), s.sub(fr.y.mul(s2)), s.sub(fr.x.mul(s2)));
    const base = floor(sk);
    const ids = [base.add(vec2(s, s)), base.add(vec2(s, float(1).sub(s))), base.add(vec2(float(1).sub(s), s))];
    const inv = [1, 0, 0.5, 1 / 1.15470054];
    const rr = [p.rotationMin * Math.PI / 180, p.rotationMax * Math.PI / 180];
    const ddx = dFdx(c), ddy = dFdy(c);
    const samples = ids.map(id => {
        const ctr = mul(inv, id.div(SQRT3_2));
        const rnd = hash(id.add(0.12345));
        const rot = mix(float(rr[0]), float(rr[1]), rnd.x.mul(p.rotation));
        const sr = sin(rot), cr = cos(rot);
        // v · mat2(cos, −sin, sin, cos): (v.x cos − v.y sin, v.x sin + v.y cos) – the row-vector product of MaterialX
        const turn = v => vec2(v.x.mul(cr).sub(v.y.mul(sr)), v.x.mul(sr).add(v.y.mul(cr)));
        const sc = mix(float(1), mix(float(p.scaleMin), float(p.scaleMax), rnd.y), p.randomScale);
        const off = mix(vec2(p.offsetMin, p.offsetMin), vec2(p.offsetMax, p.offsetMax), rnd.mul(p.offset));
        const uv = turn(c.sub(ctr)).div(sc).add(ctr).add(off);
        // blended sRGB-encoded like MaterialX (its colour space transform follows the node), decoded at the end
        return sRGBTransferOETF(texture(tex, uv).grad(turn(ddx).div(sc), turn(ddy).div(sc)).rgb);
    });
    const lum = vec3(...samples.map(x => dot(x, vec3(...LUMA))));
    const w = weights(mix(vec3(1), lum, p.falloffContrast), tw, p.falloff);
    return sRGBTransferEOTF(samples[0].mul(w.x).add(samples[1].mul(w.y)).add(samples[2].mul(w.z)));
}

const num = (key, def, lo = 0, hi = 1, step = 0.01) => ({ key, kind: 'number', min: lo, max: hi, step, default: def });

export default {
    type: 'hexImage', category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }],
    outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }],
    params: [
        { key: 'image', kind: 'image', default: null },
        num('scale', 4, 0.1, 50, 0.1),
        num('rotation', 1), num('rotationMin', 0, 0, 360, 1), num('rotationMax', 360, 0, 360, 1),
        num('randomScale', 1), num('scaleMin', 0.5, 0.1, 4), num('scaleMax', 2, 0.1, 4),
        num('offset', 1), num('offsetMin', 0), num('offsetMax', 1),
        num('falloff', 0.5), num('falloffContrast', 0.5),
    ],
    evaluate(port, p, get, ctx) {
        const tex = ctx.textures?.get(ctx.nodeId);
        if (!tex) return port === 'value' ? C(0.5) : C(new THREE.Color(0.5, 0.5, 0.5));
        const rgb = hexTile(tex, coord(get).mul(p.scale), p);
        return port === 'value' ? T(dot(rgb, vec3(...LUMA)), 'float') : T(rgb, 'color');
    },
    mtlx: {
        write: async x => {
            const file = await x.env.image?.(x.n.id);
            if (!file) return null;
            const img = x.mx.add('hextiledimage', 'color3', {
                file: x.v.FILE(file, 'srgb_texture'), texcoord: await x.coord(), tiling: x.v.V2(x.p.scale, x.p.scale),
                rotation: x.v.F(x.p.rotation), rotationrange: x.v.V2(x.p.rotationMin, x.p.rotationMax),
                scale: x.v.F(x.p.randomScale), scalerange: x.v.V2(x.p.scaleMin, x.p.scaleMax),
                offset: x.v.F(x.p.offset), offsetrange: x.v.V2(x.p.offsetMin, x.p.offsetMax),
                falloff: x.v.F(x.p.falloff), falloffcontrast: x.v.F(x.p.falloffContrast), lumacoeffs: x.v.LUMA,
            });
            return x.port === 'value' ? x.as(img, 'float') : img;
        },
    },
};
