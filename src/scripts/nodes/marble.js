// Marble: natural stone with veins or layers, tileable.
//
// The coordinate is first domain-warped by fractal gradient noise (turbulence).
// Mode "veins" (marble):
//  - crisp veins: a fine Voronoi network whose cells are grouped by the signs of two smooth noises at the cell
//    centres; the veins are the group boundaries (distance field over the 3×3 neighbours) → long winding veins that
//    branch and have cracked, jagged paths. Width, strength and visibility vary along the veins (open ends);
//    a third, finer noise gives faint hairlines the same way.
//  - soft veining: a wide halo along the zero crossings of the same noises, broken up by a fractal "smoke"
//    texture, plus a faint fringe around the crisp veins and large cloudy patches.
// Mode "banded" (travertine, sandstone, onyx): sediment layers along the warped v axis – every layer gets its own
// random tone, soft transitions, fine striations, broken dark layer lines and optional elongated pores.
// a = base, b = vein / dark layer colour, c = soft veining (veins) or layer lines and pores (banded).
// Outputs: color, value (vein / layer mask 0..1 – for roughness or relief), pores (banded: 1 in a pore).
import { Fn, float, vec2, vec3, vec4, abs, mix, clamp, smoothstep, max, min, pow, floor, fract, step } from 'three/tsl';
import { T, C, tsl, coord, input, wrap, hash2, hash22, hash33, periodicNoise } from '../node-lib.js';
import { fbmS, fbm2S, gnoise, gnoise2, worleyS, voronoiRegions } from './marble-noise.js';

// Voronoi cell of the vein network: feature point offset (xy), main vein group (z: signs of two smooth noises at
// the cell centre, 0..3) and hairline group (w: sign of a finer noise). id = wrapped cell index, V = cells per noise
// cell (along one axis), nper = noise period. A WGSL function – it runs 18× per texel.
const veinCell = Fn(([id, V, nper, seed]) => {
    const c = id.add(0.5).div(V);
    const n = gnoise2(c, nper, seed);
    const h = gnoise(c.mul(2).add(vec2(0.77, 0.29)), nper.mul(2), seed.add(2));
    return vec4(hash22(id, seed), step(0, n.x).add(step(0, n.y).mul(2)), step(0, h));
}).setLayout({ name: 'marbleVeinCell', type: 'vec4', inputs: [{ name: 'id', type: 'vec2' }, { name: 'V', type: 'float' }, { name: 'nper', type: 'vec2' }, { name: 'seed', type: 'float' }] });

let BAKE = 1024;   // bake resolution (ctx.bakeSize, set per evaluate) – minimal line width (anti-aliasing) in texels

export default {
    type: 'marble',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }, { key: 'c', type: 'color' }],
    outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }, { key: 'pores', type: 'float' }],
    params: [
        { key: 'mode', kind: 'select', options: ['veins', 'banded'], default: 'veins' },
        // large structure: noise cells per tile (integer)
        { key: 'scale', kind: 'number', min: 1, max: 16, step: 1, default: 2 },
        // veins: density of the vein network; banded: layers per noise cell
        { key: 'veins', kind: 'number', min: 1, max: 12, step: 1, default: 2 },
        // veins: elongate the structure along u (integer, keeps the tile seamless)
        { key: 'stretch', kind: 'number', min: 1, max: 4, step: 1, default: 1 },
        { key: 'width', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
        { key: 'turbulence', kind: 'number', min: 0, max: 2, step: 0.05, default: 1 },
        { key: 'detail', kind: 'number', min: 1, max: 6, step: 1, default: 5 },
        // cloudy secondary veining / haze (veins), softness of the layer transitions (banded)
        { key: 'softness', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
        // fine grain (both modes) and pore amount (banded)
        { key: 'grain', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.15 },
        { key: 'pores', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'seed', kind: 'number', min: 0, max: 99, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#ebe8e2' },
        { key: 'b', kind: 'color', default: '#5f6266' },
        { key: 'c', kind: 'color', default: '#a9abae' },
    ],
    evaluate(port, p, get, ctx) {
        BAKE = ctx?.bakeSize || 1024;
        const banded = p.mode === 'banded';
        if (port === 'pores' && (!banded || !(p.pores > 0))) return C(0);
        const s = Math.max(1, Math.round(p.scale));
        const D = Math.max(1, Math.round(p.veins));
        const oct = Math.max(1, Math.min(6, Math.round(p.detail)));
        const seed = Math.round(p.seed) * 101;
        const uv0 = coord(get);
        // veins stretched along u: more noise cells along v (banded: the layers give the direction)
        const st = banded ? 1 : Math.max(1, Math.round(p.stretch));
        const per = vec2(s, s * st);
        const P = uv0.mul(per);

        // domain warp (periodic: the offset itself repeats per tile)
        const turb = p.turbulence;
        const wo = Math.min(oct, 4);
        const Q = P.add(fbm2S(P, per, wo, seed + 1).mul(banded ? vec2(turb * 0.6, turb * 0.25) : vec2(turb * 0.5, turb * 0.5)));

        const a = tsl(input(get, 'a', 'color', p.a));
        const b = tsl(input(get, 'b', 'color', p.b));
        const c = tsl(input(get, 'c', 'color', p.c));

        // fine grain: two octaves of value noise at texel scale
        const g = p.grain > 0
            ? periodicNoise(uv0.mul(256), vec2(256, 256)).mul(0.6).add(periodicNoise(uv0.mul(512), vec2(512, 512)).mul(0.4)).sub(0.5)
            : float(0);

        let col, value, pores = float(0);
        if (!banded) {
            const r = this._veins(Q, per, s, st, D, oct, seed, p);
            // cloudy base: large soft patches drifting towards the secondary colour
            const cloud = smoothstep(-0.4, 0.6, fbmS(Q, per, 3, seed + 30)).mul(p.softness * 0.3);
            col = mix(a, c, cloud);
            col = mix(col, c, r.haze.mul(0.75));
            col = mix(col, b, r.crisp);
            value = clamp(max(r.crisp, r.haze.mul(0.55)), 0, 1);
        } else {
            const r = this._layers(Q, per, s, D, oct, seed, p);
            col = mix(a, b, r.tone);
            col = mix(col, c, r.line.mul(0.7));
            pores = r.pores;
            col = mix(col, c.mul(float(1).sub(r.depth.mul(0.5))), pores);
            value = clamp(max(r.tone, r.line), 0, 1);
        }
        col = col.mul(float(1).add(g.mul(p.grain * 0.35)));
        if (port === 'value') return T(value, 'float');
        if (port === 'pores') return T(pores, 'float');
        return T(max(col, vec3(0)), 'color');
    },

    // vein masks 0..1: { crisp, haze }
    // Crisp veins follow the zero crossings of two smooth noises, but snapped to the borders of a fine Voronoi
    // network (cells are grouped by the noise signs at their centres, veins are the group boundaries) → long
    // winding veins with cracked, branching, jagged paths instead of smooth contour lines or closed cells.
    _veins(Q, per, s, st, D, oct, seed, p) {
        const width = p.width;
        // width variation along the veins (factor 0.1..1.5), vein strength (some faint, some bold) and visibility
        // (veins fade out → open ends)
        const ws = fbm2S(Q.mul(2), per.mul(2), 3, seed + 10);
        const wvar = clamp(ws.x.mul(2).add(0.9), 0.1, 1.5);
        const strength = smoothstep(-0.45, 0.35, ws.y).mul(0.65).add(0.35);
        const vis = smoothstep(-0.35, 0.2, fbmS(Q.add(vec2(0.5, 0.2)), per, 2, seed + 11));
        const V = D * 8;   // Voronoi cells per noise cell
        // wavy cell borders: re-warp of the network coordinate at about the cell size
        const jf = V / 4;
        const jag = fbm2S(Q.mul(jf), per.mul(jf), 2, seed + 12);
        const px = s * st * V / BAKE * 1.5;   // ~1.5 texels in Voronoi cells (anti-aliasing)
        // vein network: x = f1, z = distance to the main veins, w = distance to the hairlines (in cells)
        const w = voronoiRegions(Q.mul(V).add(jag.mul(1.2)), per.mul(V), id => veinCell(id, float(V / D), per.mul(D), float(seed + 20)));
        // ragged edges: the line width wobbles with a fine noise
        const rag = fbmS(Q.mul(V / 2).add(0.37), per.mul(V / 2), 2, seed + 18).mul(0.8).add(1);
        const lw = max(wvar.mul(rag).mul(width * 0.3), px);
        const line = float(1).sub(smoothstep(lw.mul(0.6), lw.add(px), w.z));
        const fringe = float(1).sub(smoothstep(0, lw.mul(2).add(0.5), w.z)).mul(0.1 + p.softness * 0.3);
        const hair = float(1).sub(smoothstep(lw.mul(0.2), max(lw.mul(0.35), px * 1.3), w.w));
        const crisp = max(line.mul(strength), hair.mul(0.4)).mul(vis);
        // soft veining: wide halo along the same zero crossings, broken up by a contrasty fractal texture
        // (smoky, mottled – a smooth halo alone looks like plastic)
        const QD = Q.mul(D);
        const sAB = abs(gnoise2(QD, per.mul(D), float(seed + 20)));
        const haloW = wvar.mul(0.04 + p.softness * 0.25);
        const sMin = min(sAB.x, sAB.y);
        const halo = float(1).sub(smoothstep(0, haloW, sMin)).mul(0.7).add(float(1).sub(smoothstep(0, haloW.mul(3), sMin)).mul(0.3));
        const smoke = smoothstep(-0.35, 0.45, fbmS(QD.mul(3).add(jag.mul(0.1)), per.mul(D * 3), oct, seed + 23));
        const haze = clamp(halo.mul(smoke.mul(0.8).add(0.2)).mul(vis.mul(0.5).add(0.5)).mul(p.softness * 1.1), 0, 1);
        return { crisp: clamp(crisp, 0, 1), haze: max(haze, fringe.mul(vis)) };
    },

    // layer masks 0..1: { tone (a → b), line (thin layer lines), pores, depth (pore shading) }
    _layers(Q, per, s, D, oct, seed, p) {
        const L = s * D;   // layers per tile
        // layer coordinate: warped v plus a slow thickness variation
        const thick = fbmS(Q.mul(vec2(1, 2)), per.mul(vec2(1, 2)), 3, seed + 20).mul(0.35);
        const t = Q.y.add(thick.div(D)).mul(D);
        const k = floor(t), f = fract(t);
        const h = (i, sd = 21) => hash2(vec2(wrap(i, float(L)), 0), seed + sd);
        const soft = 0.05 + p.softness * 0.45;
        // tone of this layer → next layer, transition at the top of the layer
        const tA = h(k), tB = h(k.add(1));
        const tone0 = mix(tA, tB, smoothstep(float(1).sub(soft), float(1), f));
        // in-layer cloudiness and fine striations: noise stretched along the layers
        const cl = fbmS(Q.mul(vec2(2, 2 * D)), per.mul(vec2(2, 2 * D)), oct, seed + 22);
        const str = fbmS(Q.mul(vec2(1, 8 * D)), per.mul(vec2(1, 8 * D)), 3, seed + 28);
        const tone = clamp(pow(tone0, float(1.3)).add(cl.mul(0.25)).add(str.mul(0.1 + p.softness * 0.1)), 0, 1);
        // thin dark lines at some layer borders (random strength per border, broken along the layer)
        const broken = smoothstep(-0.2, 0.3, gnoise(Q.mul(vec2(4, D)), per.mul(vec2(4, D)), float(seed + 29)));
        const lineStrength = smoothstep(0.45, 0.9, h(k, 26)).mul(broken);
        const fd = min(f, float(1).sub(f));
        const lw = max(float(p.width * 0.12), float(L / BAKE * 1.5));
        const line = float(1).sub(smoothstep(lw.mul(0.3), lw, fd)).mul(lineStrength);
        // pores: Worley cells stretched along the layers (irregular via a small warp), only some cells – more in
        // porous layers –, many small and few large ones; `depth` darkens towards the pore centre
        let pores = float(0), depth = float(0);
        if (p.pores > 0) {
            const pm = vec2(5, 15);   // pore cells per noise cell (more along v → pores elongated along the layers)
            const pq = Q.mul(pm);
            const warp = gnoise2(pq.mul(2), per.mul(pm).mul(2), float(seed + 27)).mul(0.25);
            const w = worleyS(pq.add(warp), per.mul(pm), seed + 23, 1);
            const r = hash33(vec3(w.cell, seed + 24));
            const density = h(k, 27).mul(1.2).add(0.4).mul(p.pores);
            const on = step(r.y, density);
            const rad = r.x.mul(r.x).mul(r.x).mul(0.4).add(0.07);
            pores = float(1).sub(smoothstep(rad.mul(0.8), rad, w.f1)).mul(on);
            depth = float(1).sub(smoothstep(0, rad, w.f1)).mul(on).mul(r.z.mul(0.5).add(0.5));
        }
        return { tone, line, pores, depth };
    },
};
