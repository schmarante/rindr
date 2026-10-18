// Library presets: outdoor surfaces (paving, gravel, soil, roofing, cladding, water). All procedural – texture nodes
// baked into tileable maps; `size` = mm per tile from real-world dimensions.
import { graph } from './graph.js';

const P = (libraryId, params, g) => ({ libraryId, category: 'outdoor', params: { metalness: 0, ...params }, graph: g.done() });

/** a · k (scale a height before adding it) */
function scaled(g, from, port, k) {
    const m = g.node('math', { op: 'mul', b: k });
    g.link(from, port, m, 'a');
    return m;
}
/** a + b of two node outputs */
function add(g, a, ap, b, bp) {
    const m = g.node('math', { op: 'add' });
    g.link(a, ap, m, 'a').link(b, bp, m, 'b');
    return m;
}
/** value → remap(from, to) */
function remap(g, from, port, lo, hi) {
    const r = g.node('remap', { from: lo, to: hi });
    g.link(from, port, r, 'value');
    return r;
}

// --- asphalt: dark binder with light chippings ---
function asphalt({ size, relief, s1, s2 }) {
    const g = graph({ size, relief });
    const n1 = g.node('speckle', s1);
    const n2 = g.node('speckle', s2);
    g.link(n1, 'color', n2, 'a').out(n2, 'color', 'color').out(n1, 'value', 'height');
    g.out(remap(g, n1, 'value', 0.95, 0.75), 'value', 'roughness');
    return g;
}
const asphaltFine = asphalt({
    size: 300, relief: 0.6,
    s1: { scale: 70, size: 1.0, density: 0.85, variation: 0.7, layers: 3, roundness: 0.35, elongation: 0.4, softness: 0.2, tone: 0.8, a: '#2e2d2b', b: '#54524e' },
    s2: { scale: 90, size: 0.35, density: 0.15, variation: 0.5, layers: 1, roundness: 0.4, elongation: 0.2, softness: 0.1, tone: 0.5, b: '#a09d98' },
});
const asphaltCoarse = asphalt({
    size: 400, relief: 0.9,
    s1: { scale: 36, size: 1.1, density: 0.9, variation: 0.7, layers: 3, roundness: 0.2, elongation: 0.4, softness: 0.15, tone: 0.9, a: '#2b2a29', b: '#5a5853' },
    s2: { scale: 50, size: 0.5, density: 0.15, variation: 0.6, layers: 2, roundness: 0.2, elongation: 0.3, softness: 0.1, tone: 0.6, b: '#8a857c' },
});

// --- gravel ---
const gravelRound = graph({ size: 500, relief: 1.2 });
{
    const c = gravelRound.node('cellular', { mode: 'circular', scale: 12, spread: 0.95, smoothing: 0.35, roughness: 0.3, fractal: 3, variation: 0.9, a: '#857c6d', b: '#38322b' });
    gravelRound.out(c, 'color', 'color').out(c, 'value', 'height');
    gravelRound.out(remap(gravelRound, c, 'value', 0.95, 0.7), 'value', 'roughness');
}
const gravelCrushed = graph({ size: 400, relief: 1.0 });
{
    const s = gravelCrushed.node('speckle', { scale: 14, size: 1.5, density: 1, variation: 0.7, layers: 3, roundness: 0.3, elongation: 0.4, softness: 0.3, tone: 1, a: '#1f1e1c', b: '#73706a' });
    gravelCrushed.out(s, 'color', 'color').out(s, 'value', 'height');
}
// water-bound path: compacted fine grit in a sandy matrix
const gravelPath = graph({ size: 400, relief: 0.5 });
{
    const n = gravelPath.node('noise', { noiseType: 'fractal', scale: 6, detail: 5, a: '#8c7859', b: '#a89272' });
    const s = gravelPath.node('speckle', { scale: 60, size: 0.8, density: 0.8, variation: 0.7, layers: 3, roundness: 0.4, elongation: 0.3, softness: 0.15, tone: 0.9, b: '#5e5446' });
    gravelPath.link(n, 'color', s, 'a').out(s, 'color', 'color').out(s, 'value', 'height');
}

// --- sand with faint wind ripples ---
const sand = graph({ size: 600, relief: 0.35 });
{
    const w = sand.node('waves', { profile: 'sine', count: 9, axis: 'v', distortion: 0.5 });
    const s = sand.node('speckle', { scale: 160, size: 0.7, density: 0.8, variation: 0.6, layers: 2, roundness: 0.6, softness: 0.3, tone: 0.6, a: '#bba077', b: '#9e855e' });
    sand.out(s, 'color', 'color');
    sand.out(add(sand, scaled(sand, w, 'value', 0.7), 'value', scaled(sand, s, 'value', 0.3), 'value'), 'value', 'height');
}

// --- soil: crumbly clods ---
const soil = graph({ size: 500, relief: 0.8 });
{
    const d = soil.node('dent', { scale: 14, size: 0.9, density: 1, strength: 1, detail: 3, distort: 0.8, a: '#2e231a', b: '#5a4632' });
    const s = soil.node('speckle', { scale: 60, size: 0.5, density: 0.3, variation: 0.6, layers: 2, roundness: 0.6, softness: 0.2, tone: 0.5, b: '#7a6a58' });
    soil.link(d, 'color', s, 'a').out(s, 'color', 'color').out(d, 'value', 'height');
}

// --- mud: wet, glossy puddles in dark earth ---
const mud = graph({ size: 1000, relief: 0.6 });
{
    const n = mud.node('noise', { noiseType: 'fractal', scale: 8, detail: 6, a: '#33271c', b: '#54412f' });
    const d = mud.node('dent', { scale: 10, size: 0.9, density: 1, strength: 1, detail: 3, distort: 0.7 });
    const puddle = mud.node('noise', { noiseType: 'fractal', scale: 3, detail: 4, low: 0.6, high: 0.66, seed: 7 });
    const col = mud.node('mix', { b: '#1f160f' });
    mud.link(n, 'color', col, 'a').link(puddle, 'value', col, 'factor').out(col, 'color', 'color');
    const dry = mud.node('invert', {});
    mud.link(puddle, 'value', dry, 'value');
    const h = mud.node('math', { op: 'mul' });
    mud.link(d, 'value', h, 'a').link(dry, 'value', h, 'b').out(h, 'value', 'height');
    mud.out(remap(mud, dry, 'value', 0.1, 0.7), 'value', 'roughness');
    mud.out(puddle, 'value', 'clearcoat');
}

// --- forest floor: dry leaves on dark soil ---
const leaves = graph({ size: 600, relief: 0.4 });
{
    const leaf = (scale, density, layers, tone, b, a) =>
        leaves.node('speckle', { scale, size: 1.45, density, variation: 0.5, layers, roundness: 0.5, elongation: 1, softness: 0.05, tone, b, ...(a && { a }) });
    const l1 = leaf(14, 1, 3, 0.8, '#5a3a22', '#1f1711');
    const l2 = leaf(20, 0.7, 2, 0.8, '#6a4a2c');
    const l3 = leaf(18, 0.3, 2, 0.6, '#6e5c34');
    leaves.link(l1, 'color', l2, 'a').link(l2, 'color', l3, 'a').out(l3, 'color', 'color');
    leaves.out(add(leaves, scaled(leaves, l1, 'value', 0.5), 'value', scaled(leaves, l2, 'value', 0.6), 'value'), 'value', 'height');
}

// --- lawn as a flat texture (the geometric grass material is under 'special') ---
const lawn = graph({ size: 300, relief: 0.3 });
{
    const n = lawn.node('noise', { noiseType: 'fractal', scale: 4, detail: 5, a: '#22381a', b: '#35501f' });
    const s = lawn.node('speckle', { scale: 110, size: 0.9, density: 1, variation: 0.6, layers: 3, roundness: 0.3, elongation: 1, softness: 0.2, tone: 0.8, b: '#58783a' });
    lawn.link(n, 'color', s, 'a').out(s, 'color', 'color').out(s, 'value', 'height');
}

// --- concrete pavers ---
function pavers({ size, relief, tiles, grain }) {
    const g = graph({ size, relief });
    const t = g.node('tiles', tiles);
    if (grain) {
        const s = g.node('speckle', grain);
        g.link(s, 'color', t, 'a');
    }
    g.out(t, 'color', 'color').out(t, 'value', 'height');
    g.out(remap(g, t, 'mask', 0.95, 0.8), 'value', 'roughness');
    return g;
}
// 200 × 200 mm, grey
const paversSquare = pavers({
    size: 600, relief: 1.2,
    tiles: { pattern: 'stack', countU: 3, countV: 3, gap: 0.04, bevel: 0.03, profile: 'chamfer', edgeNoise: 0.15, surface: 0.5, variation: 0.15, colorMix: 0.3, a: '#787570', c: '#686560', b: '#4e483f' },
    grain: { scale: 120, size: 0.6, density: 0.5, variation: 0.6, layers: 2, roundness: 0.3, softness: 0.2, tone: 0.6, a: '#787570', b: '#8f8a82' },
});
// 200 × 100 mm, anthracite, running bond
const paversRunning = pavers({
    size: 600, relief: 1.2,
    tiles: { pattern: 'running', countU: 3, countV: 6, gap: 0.06, bevel: 0.05, profile: 'chamfer', edgeNoise: 0.15, surface: 0.5, variation: 0.12, colorMix: 0.3, a: '#4a4a4a', c: '#3c3d3e', b: '#6b665d' },
    grain: { scale: 120, size: 0.6, density: 0.5, variation: 0.6, layers: 2, roundness: 0.3, softness: 0.2, tone: 0.6, a: '#4a4a4a', b: '#666462' },
});
// 200 × 100 mm, red-brown, herringbone (plank width = 1/(4·√2) tile → 100 mm at size 566)
const paversHerringbone = pavers({
    size: 566, relief: 1.2,
    tiles: { pattern: 'herringbone', countU: 2, ratio: 2, gap: 0.06, bevel: 0.05, profile: 'chamfer', edgeNoise: 0.2, surface: 0.5, variation: 0.25, colorMix: 0.5, a: '#8a4a32', c: '#6b3a2a', b: '#7a7266' },
});

// granite setts ~100 mm, random lengths, sand joints
const setts = pavers({
    size: 600, relief: 1.5,
    tiles: { pattern: 'planks', countU: 6, countV: 6, jitter: 0.6, gap: 0.12, bevel: 0.2, profile: 'round', edgeNoise: 0.6, surface: 0.6, variation: 0.35, colorMix: 0.5, c: '#6d6863', b: '#4e4840' },
    grain: { scale: 90, size: 0.7, density: 0.7, variation: 0.6, layers: 2, roundness: 0.1, softness: 0.1, tone: 0.5, a: '#8d8a86', b: '#2e2c2b' },
});

// river stones set in light mortar
const riverstone = graph({ size: 700, relief: 1.2 });
{
    const c = riverstone.node('cellular', { mode: 'circular', scale: 9, spread: 0.8, smoothing: 0.4, roughness: 0.3, fractal: 2, variation: 0.8, a: '#776e62', b: '#9a917f' });
    riverstone.out(c, 'color', 'color').out(c, 'value', 'height');
    riverstone.out(remap(riverstone, c, 'value', 0.9, 0.6), 'value', 'roughness');
}

// crazy paving: polygonal stone slabs
const flagstone = graph({ size: 1500, relief: 1.0 });
{
    const c = flagstone.node('cellular', { mode: 'chips', scale: 5, spread: 0.92, smoothing: 0.25, roughness: 0.45, fractal: 2, variation: 0.8, a: '#857a68', b: '#4f4840' });
    flagstone.out(c, 'color', 'color').out(c, 'value', 'height');
}

// terracotta pavers 300 × 300 mm
const terracotta = pavers({
    size: 900, relief: 1.0,
    tiles: { pattern: 'stack', countU: 3, countV: 3, gap: 0.035, bevel: 0.03, profile: 'round', edgeNoise: 0.35, surface: 0.6, variation: 0.3, colorMix: 0.6, a: '#9c5232', c: '#b0704a', b: '#857c6e' },
});

// --- roofing ---
// barrel tiles: sine across (pans and caps), courses overlap along v
const roofBarrel = graph({ size: 1000, relief: 1.8 });
{
    const g = roofBarrel;
    const t = g.node('tiles', { pattern: 'stack', countU: 5, countV: 3, gap: 0, bevel: 0, edgeNoise: 0, surface: 0.6, variation: 0.45, colorMix: 0.7, a: '#9a4c2c', c: '#7a3e26', b: '#9a4c2c' });
    const wave = g.node('waves', { profile: 'sine', count: 5, axis: 'u' });
    const course = g.node('waves', { profile: 'sawtooth', count: 3, axis: 'v', slope: 0.04, softness: 0.3 });
    g.out(t, 'color', 'color');
    g.out(add(g, scaled(g, wave, 'value', 0.55), 'value', scaled(g, course, 'value', 0.6), 'value'), 'value', 'height');
    const ao = g.node('math', { op: 'mul' });
    g.link(remap(g, wave, 'value', 0.5, 1), 'value', ao, 'a').link(remap(g, course, 'value', 0.55, 1), 'value', ao, 'b');
    g.out(ao, 'value', 'ao');
}
// flat interlocking clay tiles, running bond
const roofFlat = graph({ size: 1000, relief: 1.4 });
{
    const g = roofFlat;
    const t = g.node('tiles', { pattern: 'running', countU: 4, countV: 6, gap: 0.025, bevel: 0.03, edgeNoise: 0.2, surface: 0.4, variation: 0.25, colorMix: 0.4, a: '#9c4a30', c: '#7e3a26', b: '#3a1e14' });
    const course = g.node('waves', { profile: 'sawtooth', count: 6, axis: 'v', slope: 0.06, softness: 0.3 });
    g.out(t, 'color', 'color');
    g.out(add(g, scaled(g, t, 'value', 0.4), 'value', scaled(g, course, 'value', 0.7), 'value'), 'value', 'height');
    g.out(remap(g, course, 'value', 0.55, 1), 'value', 'ao');
}
// 3-tab asphalt shingles: mineral granules on tabs, slots between them
const shingles = graph({ size: 1000, relief: 1.2 });
{
    const g = shingles;
    const s = g.node('speckle', { scale: 150, size: 1.0, density: 1, variation: 0.6, layers: 2, roundness: 0.3, softness: 0.1, tone: 0.8, a: '#2e2f31', b: '#55575a' });
    const t = g.node('tiles', { pattern: 'running', countU: 3, countV: 8, gap: 0.05, bevel: 0.02, edgeNoise: 0.1, surface: 0.3, variation: 0.2, colorMix: 0.3, c: '#3a3836', b: '#111111' });
    g.link(s, 'color', t, 'a');
    const course = g.node('waves', { profile: 'sawtooth', count: 8, axis: 'v', slope: 0.05, softness: 0.2 });
    g.out(t, 'color', 'color');
    g.out(add(g, scaled(g, t, 'value', 0.5), 'value', scaled(g, course, 'value', 0.5), 'value'), 'value', 'height');
}
// weathered wood shakes: random widths per course, split grain along the shake
const shakes = graph({ size: 1000, relief: 1.4 });
{
    const g = shakes;
    const t = g.node('tiles', { pattern: 'planks', countU: 6, countV: 4, jitter: 1, gap: 0.06, bevel: 0.02, edgeNoise: 0.3, surface: 0, variation: 0, colorMix: 0 });
    const grain = g.node('waves', { profile: 'sine', count: 140, axis: 'u', distortion: 0.35, variation: 0.6, a: '#5e5249', b: '#8f8173' });
    g.link(t, 'uv', grain, 'uv');
    const tone = g.node('mix', { b: '#3e352f' });
    g.link(grain, 'color', tone, 'a').link(remap(g, t, 'random', 0, 0.6), 'value', tone, 'factor');
    const col = g.node('mix', { a: '#1a1612' });
    g.link(tone, 'color', col, 'b').link(t, 'mask', col, 'factor').out(col, 'color', 'color');
    const course = g.node('waves', { profile: 'sawtooth', count: 4, axis: 'v', slope: 0.04, softness: 0.2 });
    const h = add(g, scaled(g, t, 'value', 0.5), 'value', scaled(g, course, 'value', 0.4), 'value');
    g.out(add(g, h, 'value', scaled(g, grain, 'value', 0.1), 'value'), 'value', 'height');
}

// --- cladding and decking ---
// bevel / lap siding, natural cedar: boards 167 mm, wood grain per board
const sidingLap = graph({ size: 1000, relief: 1.2 });
{
    const g = sidingLap;
    const w = g.node('waves', { profile: 'sawtooth', count: 6, axis: 'v', slope: 0.06, softness: 0.3 });
    const wood = g.node('wood', { cut: 'flat', rings: 30, arches: 3, stretch: 4, pores: 0, contrast: 0.6, a: '#b98a5e', b: '#8a5e3c' });
    g.link(w, 'uv', wood, 'uv').out(wood, 'color', 'color');
    g.out(add(g, scaled(g, w, 'value', 0.9), 'value', scaled(g, wood, 'value', 0.1), 'value'), 'value', 'height');
    g.out(remap(g, w, 'value', 0.6, 1), 'value', 'ao');
}
// vertical board and batten, painted red, faint vertical grain under the paint
const sidingBatten = graph({ size: 1000, relief: 1.2 });
{
    const g = sidingBatten;
    const w = g.node('waves', { profile: 'square', count: 5, axis: 'u', width: 0.22, softness: 0.25 });
    const grain = g.node('waves', { profile: 'sine', count: 160, axis: 'u', distortion: 0.4, variation: 0.5, a: '#6e1f18', b: '#87281e' });
    g.out(grain, 'color', 'color');
    g.out(add(g, scaled(g, w, 'value', 0.9), 'value', scaled(g, grain, 'value', 0.08), 'value'), 'value', 'height');
    g.out(remap(g, w, 'value', 0.75, 1), 'value', 'ao');
}
// hardwood decking: grooved boards 145 mm, open joints
const decking = graph({ size: 1200, relief: 1.0 });
{
    const g = decking;
    const t = g.node('tiles', { pattern: 'planks', countU: 1, countV: 8, jitter: 0.8, gap: 0.05, bevel: 0.03, edgeNoise: 0.1, surface: 0, variation: 0, colorMix: 0 });
    const wood = g.node('wood', { cut: 'flat', rings: 28, arches: 2, stretch: 6, pores: 0.4, contrast: 0.6, a: '#9a6a44', b: '#6e4529' });
    g.link(t, 'uv', wood, 'uv');
    const col = g.node('mix', { a: '#16110c' });
    g.link(wood, 'color', col, 'b').link(t, 'mask', col, 'factor').out(col, 'color', 'color');
    const grooves = g.node('waves', { profile: 'square', count: 48, axis: 'v', width: 0.6, softness: 0.5 });
    const top = add(g, scaled(g, grooves, 'value', 0.25), 'value', scaled(g, wood, 'value', 0.1), 'value');
    const h = g.node('math', { op: 'mul' });
    g.link(t, 'value', h, 'a').link(top, 'value', h, 'b');
    g.out(add(g, scaled(g, t, 'value', 0.6), 'value', h, 'value'), 'value', 'height');
}

// --- water: rippled surface ---
const water = graph({ size: 1000, relief: 0.6 });
{
    const w = water.node('waves', { profile: 'ripples', count: 3, centres: 2, wavelength: 0.1, a: '#1d3a4a', b: '#2f5f72' });
    water.out(w, 'color', 'color').out(w, 'value', 'height');
}

export default [
    P('outdoor-asphalt-fine', { color: '#333230', roughness: 0.9 }, asphaltFine),
    P('outdoor-asphalt-coarse', { color: '#4a4844', roughness: 0.9 }, asphaltCoarse),
    P('outdoor-gravel-round', { color: '#8a8274', roughness: 0.85 }, gravelRound),
    P('outdoor-gravel-crushed', { color: '#7a7974', roughness: 0.9 }, gravelCrushed),
    P('outdoor-gravel-path', { color: '#ad9a7a', roughness: 0.95 }, gravelPath),
    P('outdoor-sand', { color: '#cdb995', roughness: 0.95 }, sand),
    P('outdoor-soil', { color: '#4e3d2e', roughness: 0.95 }, soil),
    P('outdoor-mud', { color: '#3a2c20', roughness: 0.5, clearcoatRoughness: 0.05 }, mud),
    P('outdoor-leaves', { color: '#7a5030', roughness: 0.85 }, leaves),
    P('outdoor-lawn-texture', { color: '#4a6e2a', roughness: 0.85, sheen: 0.4, sheenColor: '#9ac060', sheenRoughness: 0.6 }, lawn),
    P('outdoor-pavers-square', { color: '#8f8c86', roughness: 0.9 }, paversSquare),
    P('outdoor-pavers-running', { color: '#4a4a4a', roughness: 0.9 }, paversRunning),
    P('outdoor-pavers-herringbone', { color: '#8a4a32', roughness: 0.9 }, paversHerringbone),
    P('outdoor-setts-granite', { color: '#7f7b76', roughness: 0.85 }, setts),
    P('outdoor-riverstone-mortared', { color: '#a49a8a', roughness: 0.8 }, riverstone),
    P('outdoor-flagstone', { color: '#93887a', roughness: 0.85 }, flagstone),
    P('outdoor-terracotta-pavers', { color: '#b0603c', roughness: 0.85 }, terracotta),
    P('outdoor-roof-barrel', { color: '#a4532f', roughness: 0.75 }, roofBarrel),
    P('outdoor-roof-flat-tiles', { color: '#9c4a30', roughness: 0.75 }, roofFlat),
    P('outdoor-shingles-asphalt', { color: '#38393b', roughness: 0.95 }, shingles),
    P('outdoor-shakes-wood', { color: '#7a6d60', roughness: 0.9 }, shakes),
    P('outdoor-siding-lap', { color: '#a87a52', roughness: 0.75 }, sidingLap),
    P('outdoor-siding-board-batten', { color: '#7a231b', roughness: 0.7 }, sidingBatten),
    P('outdoor-decking', { color: '#8a5e3c', roughness: 0.7 }, decking),
    P('outdoor-water', { color: '#1d3a4a', roughness: 0.04, ior: 1.33, clearcoat: 0 }, water),
];
