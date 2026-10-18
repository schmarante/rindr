// Library presets: concrete & plaster ('concrete') and tiles & floors ('tiles').
// All looks procedural (node graphs baked on the GPU); sizes = mm per baked tile on the model.
import { graph } from './graph.js';

// cloudy concrete mottling (large soft patches), returns the noise node
const cloud = (g, scale, a, b, seed = 0) => g.node('noise', { scale, detail: 8, low: 0.25, high: 0.75, seed, a, b });
// value → roughness between `from` (value 0) and `to` (value 1)
const roughBy = (g, node, port, from, to) => {
    const r = g.node('remap', { from, to });
    g.link(node, port, r, 'value').out(r, 'value', 'roughness');
    return r;
};
// weighted sum of two height values: a·wa + b·wb
const blend = (g, [na, pa, wa], [nb, pb, wb]) => {
    const ra = g.node('remap', { from: 0, to: wa }), rb = g.node('remap', { from: 0, to: wb });
    const s = g.node('math', { op: 'add' });
    g.link(na, pa, ra, 'value').link(nb, pb, rb, 'value').link(ra, 'value', s, 'a').link(rb, 'value', s, 'b');
    return s;
};
// colour a → darker `dark` where `node.port` is low (pores, holes, fissures)
const darkenBy = (g, color, node, port, dark) => {
    const inv = g.node('invert'), m = g.node('mix', { b: dark });
    g.link(node, port, inv, 'value').link(color[0], color[1], m, 'a').link(inv, 'value', m, 'factor');
    return m;
};
// glazed tile: clearcoat only on the tile face, rough joint
const glaze = (g, tiles, face) => {
    roughBy(g, tiles, 'mask', 0.85, face);
    g.out(tiles, 'mask', 'clearcoat');
};

// ===================== concrete & plaster =====================

// fair-faced concrete: cloudy patches, sparse air pores
const smooth = graph({ size: 1000, relief: 0.5 });
{
    const c = cloud(smooth, 3, '#87837b', '#a9a59c');
    const pores = smooth.node('dent', { scale: 60, size: 0.4, density: 0.3, detail: 2, distort: 0.5 });
    const col = darkenBy(smooth, [c, 'color'], pores, 'value', '#5d5a54');
    smooth.out(col, 'color', 'color').out(pores, 'value', 'height');
    roughBy(smooth, c, 'value', 0.9, 0.8);
}

// fair-faced concrete with formwork panels (2400 × 1200) and tie holes every 600 mm
const holes = graph({ size: 2400, relief: 1 });
{
    const c = cloud(holes, 6, '#827f78', '#a6a39b', 3);
    const panels = holes.node('tiles', { pattern: 'stack', countU: 1, countV: 2, gap: 0.004, bevel: 0.004, edgeNoise: 0.15, surface: 0, variation: 0.05, colorMix: 0, b: '#66635d' });
    holes.link(c, 'color', panels, 'a');
    const ties = holes.node('dots', { pattern: 'perforated', shape: 'circle', stagger: 'none', count: 4, rows: 0, size: 0.075, bevel: 0.6, a: '#3f3d3a', b: '#ffffff' });
    const col = darkenBy(holes, [panels, 'color'], ties, 'value', '#45433f');
    const h = holes.node('math', { op: 'min' });
    holes.link(panels, 'value', h, 'a').link(ties, 'value', h, 'b');
    holes.out(col, 'color', 'color').out(h, 'value', 'height');
    roughBy(holes, c, 'value', 0.9, 0.8);
}

// board-formed concrete: horizontal boards (~120 mm), wood grain imprinted, each board a little different
const boards = graph({ size: 1200, relief: 0.8 });
{
    const b = boards.node('tiles', { pattern: 'planks', countU: 1, countV: 10, gap: 0.03, bevel: 0.08, edgeNoise: 0.3, surface: 0.2, variation: 0.22, colorMix: 0, jitter: 0.6, a: '#9a968e', b: '#7a766f' });
    const grain = boards.node('noise', { noiseType: 'fractal', scale: 2, stretch: 40, detail: 5, a: '#77736c', b: '#b0aca4' });
    boards.link(b, 'uv', grain, 'uv');
    const col = boards.node('mix', { factor: 0.5 });
    boards.link(b, 'color', col, 'a').link(grain, 'color', col, 'b');
    const h = blend(boards, [b, 'value', 0.55], [grain, 'value', 0.45]);
    boards.out(col, 'color', 'color').out(h, 'value', 'height');
    roughBy(boards, grain, 'value', 0.92, 0.8);
}

// broom finish: fine parallel brush lines on a slab
const broom = graph({ size: 600, relief: 0.35 });
{
    const c = cloud(broom, 2, '#8e8b84', '#aeaba3', 5);
    const lines = broom.node('noise', { noiseType: 'fractal', scale: 3, stretch: 70, detail: 4, a: '#000000', b: '#ffffff' });
    const col = broom.node('mix', { b: '#77746d', factor: 0 });
    const inv = broom.node('remap', { from: 0.35, to: 0 });
    broom.link(c, 'color', col, 'a').link(lines, 'value', inv, 'value').link(inv, 'value', col, 'factor');
    broom.out(col, 'color', 'color').out(lines, 'value', 'height');
    roughBy(broom, lines, 'value', 0.95, 0.85);
}

// polished concrete: ground slab with fine aggregate showing, satin gloss
const polished = graph({ size: 600, relief: 0.05 });
{
    const c = cloud(polished, 3, '#8f8c86', '#b3b0aa', 7);
    const agg = polished.node('speckle', { scale: 48, size: 0.5, density: 0.5, variation: 0.7, layers: 3, roundness: 0.35, elongation: 0.3, softness: 0.1, tone: 0.6, b: '#7b766e' });
    const light = polished.node('speckle', { scale: 40, size: 0.5, density: 0.4, variation: 0.7, layers: 3, roundness: 0.35, elongation: 0.3, softness: 0.1, tone: 0.5, b: '#cdc9c0', seed: 3 });
    polished.link(c, 'color', agg, 'a').link(agg, 'color', light, 'a');
    polished.out(light, 'color', 'color').out(agg, 'value', 'height');
    roughBy(polished, c, 'value', 0.32, 0.18);
}

// exposed aggregate (washed concrete): round pebbles standing out of the cement
const washed = graph({ size: 400, relief: 1.2 });
{
    const w = washed.node('cellular', { mode: 'circular', scale: 26, spread: 0.85, smoothing: 0.3, roughness: 0.3, fractal: 2, variation: 1, a: '#aa9f8c', b: '#6a665e' });
    washed.out(w, 'color', 'color').out(w, 'value', 'height');
    roughBy(washed, w, 'value', 0.95, 0.6);
}

// sandblasted concrete: grainy, small aggregate exposed, pitted
const blasted = graph({ size: 400, relief: 0.4 });
{
    const c = cloud(blasted, 2, '#958e84', '#aaa398', 9);
    const agg = blasted.node('speckle', { scale: 28, size: 0.6, density: 0.6, variation: 0.7, layers: 3, roundness: 0.2, elongation: 0.3, softness: 0.05, tone: 0.5, b: '#80796f' });
    blasted.link(c, 'color', agg, 'a');
    const pits = blasted.node('dent', { scale: 70, size: 0.5, density: 0.7, detail: 2, distort: 0.6 });
    const h = blend(blasted, [pits, 'value', 0.7], [agg, 'value', 0.3]);
    blasted.out(agg, 'color', 'color').out(h, 'value', 'height');
}

// ribbed concrete: vertical trapezoid ribs every 150 mm
const ribbed = graph({ size: 1200, relief: 2 });
{
    const c = cloud(ribbed, 3, '#8a857f', '#a8a39c', 11);
    const ribs = ribbed.node('waves', { profile: 'trapezoid', count: 8, axis: 'u', width: 0.55, slope: 0.12, softness: 0.25, distortion: 0.02 });
    const col = darkenBy(ribbed, [c, 'color'], ribs, 'value', '#8e8982');
    const pores = ribbed.node('dent', { scale: 50, size: 0.4, density: 0.3, detail: 2, distort: 0.5 });
    const h = blend(ribbed, [ribs, 'value', 0.88], [pores, 'value', 0.12]);
    ribbed.out(col, 'color', 'color').out(h, 'value', 'height');
    roughBy(ribbed, c, 'value', 0.9, 0.8);
}

// precast panels 1500 × 750 with 20 mm reveals, light sandy concrete
const precast = graph({ size: 3000, relief: 1 });
{
    const c = cloud(precast, 6, '#a9a597', '#c3bfb1', 13);
    const p = precast.node('tiles', { pattern: 'stack', countU: 2, countV: 4, gap: 0.027, bevel: 0.01, profile: 'chamfer', edgeNoise: 0.05, surface: 0.15, variation: 0.06, colorMix: 0, b: '#55524c' });
    precast.link(c, 'color', p, 'a');
    precast.out(p, 'color', 'color').out(p, 'value', 'height');
    roughBy(precast, p, 'mask', 0.95, 0.8);
}

// fine plaster (float finish)
const plasterFine = graph({ size: 400, relief: 0.5 });
{
    const n = plasterFine.node('noise', { scale: 48, detail: 5, low: 0.42, high: 0.6, a: '#dcd8ce', b: '#f1efe8' });
    plasterFine.out(n, 'color', 'color').out(n, 'value', 'height');
}

// coarse plaster (scratch render): dense grains of aggregate
const plasterCoarse = graph({ size: 300, relief: 0.9 });
{
    const g = plasterCoarse.node('speckle', { scale: 40, size: 0.9, density: 0.85, variation: 0.6, layers: 3, roundness: 0.6, elongation: 0.2, softness: 0.5, tone: 0.3, a: '#c9c4b8', b: '#e2ded4' });
    plasterCoarse.out(g, 'color', 'color').out(g, 'value', 'height');
}

// troweled plaster: flat overlapping trowel strokes
const troweled = graph({ size: 900, relief: 0.35 });
{
    const t = troweled.node('noise', { scale: 6, detail: 5, low: 0.48, high: 0.52, a: '#d9d7d2', b: '#e0ded9' });
    troweled.out(t, 'color', 'color').out(t, 'value', 'height');
}

// wet-dash render: lumpy thrown mortar
const wetDash = graph({ size: 400, relief: 0.8 });
{
    const s = wetDash.node('speckle', { scale: 18, size: 1.3, density: 0.95, variation: 0.8, layers: 3, roundness: 1, elongation: 0.2, softness: 1, tone: 0.2, a: '#a7a6a2', b: '#c2c1bd' });
    wetDash.out(s, 'color', 'color').out(s, 'value', 'height');
    roughBy(wetDash, s, 'value', 0.95, 0.85);
}

// venetian plaster, polished: cloudy, troweled sheen streaks
const venetian = graph({ size: 1200, relief: 0.05 });
{
    const c = venetian.node('noise', { scale: 4, detail: 6, low: 0.2, high: 0.8, a: '#e4dfd5', b: '#f4f1ea' });
    const s = venetian.node('noise', { noiseType: 'turbulence', scale: 4, stretch: 1, detail: 6, low: 0.55, high: 0.95, b: '#d3cdc1' });
    venetian.link(c, 'color', s, 'a');
    venetian.out(s, 'color', 'color').out(c, 'value', 'height');
    roughBy(venetian, s, 'value', 0.12, 0.3);
}

// venetian plaster, mottled terracotta (satin)
const venetianTerra = graph({ size: 1200, relief: 0.1 });
{
    const c = venetianTerra.node('noise', { scale: 3, detail: 7, low: 0.1, high: 0.9, seed: 4, a: '#a4522f', b: '#c06a3c' });
    const s = venetianTerra.node('noise', { noiseType: 'turbulence', scale: 4, stretch: 1, detail: 6, low: 0.5, high: 0.95, seed: 8, b: '#94442a' });
    venetianTerra.link(c, 'color', s, 'a');
    venetianTerra.out(s, 'color', 'color').out(c, 'value', 'height');
    roughBy(venetianTerra, s, 'value', 0.3, 0.55);
}

// painted wall (gypsum board): faint roller texture only, colour from the parameters
const rollerFlat = graph({ size: 300, relief: 0.12 });
{
    const n = rollerFlat.node('noise', { scale: 50, detail: 3 });
    rollerFlat.out(n, 'value', 'height');
}
const rollerEgg = graph({ size: 300, relief: 0.08 });
{
    const n = rollerEgg.node('noise', { scale: 50, detail: 3, seed: 2 });
    rollerEgg.out(n, 'value', 'height');
}

// flaking paint: white paint peeling off grey concrete
const flaking = graph({ size: 600, relief: 0.45 });
{
    const base = flaking.node('noise', { scale: 6, detail: 6, low: 0.3, high: 0.7, a: '#6f6c66', b: '#8c8982' });
    // fine crazing in the remaining paint
    const craze = flaking.node('cellular', { mode: 'chips', scale: 30, spread: 0.97, smoothing: 0.2, roughness: 0.7, fractal: 1, variation: 0.04, a: '#e9e8e3', b: '#b5b3ad' });
    const paint = flaking.node('noise', { scale: 9, detail: 8, low: 0.34, high: 0.36, seed: 6 });
    flaking.link(base, 'color', paint, 'a').link(craze, 'color', paint, 'b');
    const h = flaking.node('math', { op: 'mul' });
    flaking.link(paint, 'value', h, 'a').link(craze, 'value', h, 'b');
    flaking.out(paint, 'color', 'color').out(h, 'value', 'height');
    roughBy(flaking, paint, 'value', 0.92, 0.7);
}

// ===================== tiles & floors =====================

// white glazed wall tile 15 × 15, 3 mm joint
const white15 = graph({ size: 600, relief: 0.6 });
{
    const t = white15.node('tiles', { pattern: 'stack', countU: 4, countV: 4, gap: 0.02, bevel: 0.04, edgeNoise: 0, surface: 0, variation: 0.04, colorMix: 0, a: '#f2f1ec', b: '#c9c5bd' });
    white15.out(t, 'color', 'color').out(t, 'value', 'height');
    glaze(white15, t, 0.12);
}

// large-format porcelain stoneware 60 × 60, grey, matt, slightly clouded
const grey60 = graph({ size: 1200, relief: 0.4 });
{
    const c = cloud(grey60, 3, '#878682', '#95948f', 15);
    const t = grey60.node('tiles', { pattern: 'stack', countU: 2, countV: 2, gap: 0.006, bevel: 0.006, edgeNoise: 0, surface: 0.35, variation: 0.05, colorMix: 0, b: '#9f9c95' });
    grey60.link(c, 'color', t, 'a');
    grey60.out(t, 'color', 'color').out(t, 'value', 'height');
    roughBy(grey60, t, 'mask', 0.9, 0.45);
}

// terracotta floor tile 30 × 30, unglazed, handmade edges
const terracotta = graph({ size: 1200, relief: 0.7 });
{
    const t = terracotta.node('tiles', { pattern: 'stack', countU: 4, countV: 4, gap: 0.03, bevel: 0.05, edgeNoise: 0.2, surface: 0.5, variation: 0.2, colorMix: 0.7, a: '#b9653c', b: '#9d9486', c: '#8a4226' });
    terracotta.out(t, 'color', 'color').out(t, 'value', 'height');
    roughBy(terracotta, t, 'mask', 0.9, 0.7);
}

// blue glazed tile 10 × 10, slightly varying glaze
const blue10 = graph({ size: 400, relief: 0.6 });
{
    const t = blue10.node('tiles', { pattern: 'stack', countU: 4, countV: 4, gap: 0.025, bevel: 0.06, edgeNoise: 0, surface: 0, variation: 0.08, colorMix: 0.4, a: '#1d5584', b: '#d6d4ce', c: '#2f74a6' });
    blue10.out(t, 'color', 'color').out(t, 'value', 'height');
    glaze(blue10, t, 0.15);
}

// diagonal floor tiles 20 × 20 laid at 45°
const diagonal = graph({ size: 600, relief: 0.5 });
{
    const t = diagonal.node('tiles', { pattern: 'diamond', countU: 2, gap: 0.03, bevel: 0.04, edgeNoise: 0.05, surface: 0.2, variation: 0.12, colorMix: 0.5, a: '#a99f91', b: '#d9d4ca', c: '#8b8174' });
    diagonal.out(t, 'color', 'color').out(t, 'value', 'height');
    roughBy(diagonal, t, 'mask', 0.85, 0.35);
}

// glass-like ceramic mosaic 25 × 25 mm, mixed blues
const mosaic = graph({ size: 300, relief: 0.4 });
{
    const t = mosaic.node('tiles', { pattern: 'stack', countU: 12, countV: 12, gap: 0.08, bevel: 0.12, edgeNoise: 0, surface: 0, variation: 0.15, colorMix: 0.9, a: '#3f78ad', b: '#e4e2dc', c: '#9dc0dd' });
    mosaic.out(t, 'color', 'color').out(t, 'value', 'height');
    glaze(mosaic, t, 0.1);
}

// checkerboard black/white 30 × 30
const checker = graph({ size: 1200, relief: 0.3 });
{
    const ch = checker.node('checker', { scale: 4, a: '#efede7', b: '#1d1d1e' });
    const t = checker.node('tiles', { pattern: 'stack', countU: 4, countV: 4, gap: 0.01, bevel: 0.01, edgeNoise: 0, surface: 0, variation: 0.03, colorMix: 0, b: '#8c8a85' });
    checker.link(ch, 'color', t, 'a');
    checker.out(t, 'color', 'color').out(t, 'value', 'height');
    glaze(checker, t, 0.25);
}

// terrazzo: two layers of stone chips in a cement matrix, ground and polished
const terrazzo = (matrix, chip1, chip2, seed = 0) => {
    const g = graph({ size: 400, relief: 0.05 });
    const n1 = g.node('speckle', { scale: 16, size: 0.9, density: 0.75, variation: 0.7, layers: 3, roundness: 0.1, elongation: 0.3, softness: 0, tone: 0.5, a: matrix, b: chip1, seed });
    const n2 = g.node('speckle', { scale: 12, size: 0.9, density: 0.25, variation: 0.6, layers: 2, roundness: 0.1, elongation: 0.3, softness: 0, tone: 0.4, b: chip2, seed: seed + 1 });
    g.link(n1, 'color', n2, 'a');
    g.out(n2, 'color', 'color').out(n1, 'value', 'height');
    return g.done();
};

// vinyl composition tile 30 × 30: streaky chips, waxed
const vct = graph({ size: 1220, relief: 0.25 });
{
    const streak = vct.node('noise', { scale: 5, stretch: 4, detail: 6, low: 0.35, high: 0.65, a: '#c9c2b5', b: '#e2ddd3' });
    const s = vct.node('speckle', { scale: 30, size: 0.5, density: 0.5, variation: 0.7, layers: 2, roundness: 0.2, elongation: 0.8, softness: 0.4, tone: 0.5, b: '#9d968a' });
    vct.link(streak, 'color', s, 'a');
    const t = vct.node('tiles', { pattern: 'stack', countU: 4, countV: 4, gap: 0.008, bevel: 0.008, edgeNoise: 0, surface: 0, variation: 0.06, colorMix: 0, b: '#7e7a72' });
    vct.link(s, 'color', t, 'a');
    vct.out(t, 'color', 'color').out(t, 'value', 'height');
    roughBy(vct, t, 'mask', 0.8, 0.35);
}

// acoustic ceiling tile 600 × 600 in an exposed grid, fissured mineral fibre
const fissured = graph({ size: 1200, relief: 0.6 });
{
    const t = fissured.node('tiles', { pattern: 'stack', countU: 2, countV: 2, gap: 0.025, bevel: 0.015, profile: 'chamfer', edgeNoise: 0, surface: 0.5, variation: 0.03, colorMix: 0, a: '#e9e7e2', b: '#f4f4f4' });
    const f = fissured.node('noise', { noiseType: 'turbulence', scale: 24, detail: 2, low: 0.22, high: 0.36 });
    const col = darkenBy(fissured, [t, 'color'], f, 'value', '#bdb9b0');
    const h = fissured.node('math', { op: 'mul' });
    fissured.link(t, 'value', h, 'a').link(f, 'value', h, 'b');
    fissured.out(col, 'color', 'color').out(h, 'value', 'height');
}

// perforated metal ceiling panel 600 × 600, white, black acoustic fleece behind the holes
const perforated = graph({ size: 1200, relief: 0.5 });
{
    const t = perforated.node('tiles', { pattern: 'stack', countU: 2, countV: 2, gap: 0.02, bevel: 0.01, profile: 'chamfer', edgeNoise: 0, surface: 0, variation: 0.02, colorMix: 0, a: '#eceee9', b: '#d9dbd6' });
    const d = perforated.node('dots', { pattern: 'perforated', shape: 'circle', stagger: 'none', count: 48, rows: 0, size: 0.32, bevel: 0.3, a: '#1e1e1e', b: '#ffffff' });
    const col = darkenBy(perforated, [t, 'color'], d, 'value', '#232323');
    const h = perforated.node('math', { op: 'min' });
    perforated.link(t, 'value', h, 'a').link(d, 'value', h, 'b');
    perforated.out(col, 'color', 'color').out(h, 'value', 'height');
}

const m = (color, roughness, extra = {}) => ({ color, metalness: 0, roughness, ...extra });

export default [
    // --- concrete & plaster ---
    { libraryId: 'concrete-smooth', category: 'concrete', params: m('#99958d', 0.85), graph: smooth.done() },
    { libraryId: 'concrete-tie-holes', category: 'concrete', params: m('#949189', 0.85), graph: holes.done() },
    { libraryId: 'concrete-board-formed', category: 'concrete', params: m('#928e87', 0.88), graph: boards.done() },
    { libraryId: 'concrete-broom', category: 'concrete', params: m('#9e9b94', 0.9), graph: broom.done() },
    { libraryId: 'concrete-polished', category: 'concrete', params: m('#a19e98', 0.25, { clearcoat: 0.5, clearcoatRoughness: 0.12 }), graph: polished.done() },
    { libraryId: 'concrete-exposed-aggregate', category: 'concrete', params: m('#8c8478', 0.85), graph: washed.done() },
    { libraryId: 'concrete-sandblasted', category: 'concrete', params: m('#9a9389', 0.95), graph: blasted.done() },
    { libraryId: 'concrete-ribbed', category: 'concrete', params: m('#99948d', 0.85), graph: ribbed.done() },
    { libraryId: 'concrete-precast-panels', category: 'concrete', params: m('#b6b2a4', 0.85), graph: precast.done() },
    { libraryId: 'plaster-fine', category: 'concrete', params: m('#e6e3db', 0.9), graph: plasterFine.done() },
    { libraryId: 'plaster-coarse', category: 'concrete', params: m('#d4cfc4', 0.95), graph: plasterCoarse.done() },
    { libraryId: 'plaster-troweled', category: 'concrete', params: m('#d4d1cb', 0.8), graph: troweled.done() },
    { libraryId: 'plaster-wet-dash', category: 'concrete', params: m('#b4b3af', 0.9), graph: wetDash.done() },
    { libraryId: 'plaster-venetian', category: 'concrete', params: m('#e8e4db', 0.2, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), graph: venetian.done() },
    { libraryId: 'plaster-venetian-terracotta', category: 'concrete', params: m('#ad5a32', 0.4, { clearcoat: 0.3, clearcoatRoughness: 0.2 }), graph: venetianTerra.done() },
    { libraryId: 'wallpaint-flat', category: 'concrete', params: m('#ecebe7', 0.92, { specularIntensity: 0.6 }), graph: rollerFlat.done() },
    { libraryId: 'wallpaint-eggshell', category: 'concrete', params: m('#efe9da', 0.5), graph: rollerEgg.done() },
    { libraryId: 'paint-flaking', category: 'concrete', params: m('#d4d2cc', 0.8), graph: flaking.done() },

    // --- tiles & floors ---
    { libraryId: 'tiles-white-15', category: 'tiles', params: m('#f2f1ec', 0.12, { clearcoat: 1, clearcoatRoughness: 0.04 }), graph: white15.done() },
    { libraryId: 'tiles-grey-60', category: 'tiles', params: m('#8c8b86', 0.45), graph: grey60.done() },
    { libraryId: 'tiles-terracotta', category: 'tiles', params: m('#a8573a', 0.7), graph: terracotta.done() },
    { libraryId: 'tiles-blue-10', category: 'tiles', params: m('#245f8e', 0.15, { clearcoat: 1, clearcoatRoughness: 0.04 }), graph: blue10.done() },
    { libraryId: 'tiles-diagonal', category: 'tiles', params: m('#a99f91', 0.35), graph: diagonal.done() },
    { libraryId: 'tiles-mosaic-blue', category: 'tiles', params: m('#5f93c2', 0.1, { clearcoat: 1, clearcoatRoughness: 0.03 }), graph: mosaic.done() },
    { libraryId: 'tiles-checker', category: 'tiles', params: m('#858481', 0.25, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), graph: checker.done() },
    { libraryId: 'terrazzo-white', category: 'tiles', params: m('#ddd8cd', 0.25, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), graph: terrazzo('#e6e0d3', '#8b857c', '#3d3b38', 0) },
    { libraryId: 'terrazzo-black', category: 'tiles', params: m('#3a3937', 0.25, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), graph: terrazzo('#2c2b2a', '#d6d2c9', '#8e8a83', 20) },
    { libraryId: 'terrazzo-red', category: 'tiles', params: m('#cfc6b6', 0.25, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), graph: terrazzo('#e6e0d3', '#6b6258', '#a8634e', 40) },
    { libraryId: 'tiles-vinyl', category: 'tiles', params: m('#c4beb2', 0.35, { clearcoat: 0.3, clearcoatRoughness: 0.2 }), graph: vct.done() },
    { libraryId: 'ceiling-acoustic', category: 'tiles', params: m('#e9e7e2', 0.95, { specularIntensity: 0.4 }), graph: fissured.done() },
    { libraryId: 'ceiling-perforated', category: 'tiles', params: m('#eceee9', 0.5), graph: perforated.done() },
];
