// Library presets: natural stone (category 'stone') and walls of bricks, blocks and stones (category 'masonry').
// All looks are procedural (node graphs baked into tileable maps); sizes follow real stones and units
// (size = mm per baked tile, 1 UV = 100 mm on CAD models).
// Polished stone: flat (no relief), clearcoat for the polish; honed and split surfaces: rough, with relief.
import { graph } from './graph.js';

/** roughness driven by a 0..1 value of node `from` (port), remapped to lo..hi */
function roughBy(g, from, port, lo, hi) {
    const r = g.node('remap', { from: lo, to: hi });
    g.link(from, port, r, 'value').out(r, 'value', 'roughness');
    return r;
}

// polished stone: clearcoat on a slightly rough base
const POLISHED = { metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 };

// ---------------------------------------------------------------------------------------------------------------
// stone
// ---------------------------------------------------------------------------------------------------------------

/** marble with veins or layers (marble node), polished or honed */
function marble(params, { size = 600, rough = [0.12, 0.22], relief = 0 } = {}) {
    const g = graph({ size, relief });
    const m = g.node('marble', params);
    g.out(m, 'color', 'color');
    roughBy(g, m, 'value', ...rough);
    if (relief) g.out(m, 'value', 'height');
    return g.done();
}

// white marble, grey veins on a cool white ground
const marbleWhite = marble({ mode: 'veins', scale: 1, stretch: 2, veins: 2, width: 0.3, turbulence: 0.8, detail: 5, softness: 0.7, grain: 0.15, seed: 7, a: '#efede8', b: '#55595e', c: '#b4b6b9' });
// black marble, bold white veins
const marbleBlack = marble({ mode: 'veins', scale: 2, veins: 2, width: 0.3, turbulence: 0.8, detail: 5, softness: 0.3, grain: 0.1, seed: 3, a: '#141416', b: '#e6e3dc', c: '#4a4a4e' });
// deep green marble with a white vein network
const marbleGreen = marble({ mode: 'veins', scale: 2, veins: 3, width: 0.25, turbulence: 1.1, detail: 5, softness: 0.6, grain: 0.15, seed: 12, a: '#1d3a2b', b: '#d9e3d5', c: '#3f7056' });
// warm beige marble: soft, cloudy veining, few crisp veins (honed look under a satin polish)
const marbleBeige = marble({ mode: 'veins', scale: 1, stretch: 2, veins: 2, width: 0.25, turbulence: 0.9, detail: 5, softness: 0.9, grain: 0.25, seed: 21, a: '#d8c098', b: '#9c7b52', c: '#c4a77c' });

/** granite: two chained speckle layers (dark mica + light quartz / feldspar on the ground colour) */
function granite(n1, n2, { size = 200, rough = [0.15, 0.3], relief = 0 } = {}) {
    const g = graph({ size, relief });
    const s1 = g.node('speckle', n1);
    const s2 = g.node('speckle', n2);
    g.link(s1, 'color', s2, 'a').out(s2, 'color', 'color');
    roughBy(g, s1, 'value', ...rough);
    if (relief) g.out(s1, 'value', 'height');
    return g.done();
}

const graniteGrey = granite(
    { scale: 40, size: 0.8, density: 0.55, variation: 0.7, layers: 3, roundness: 0.2, elongation: 0.4, softness: 0.05, tone: 0.4, a: '#8c8a86', b: '#232325' },
    { scale: 28, size: 1.0, density: 0.28, variation: 0.6, layers: 2, roundness: 0.15, elongation: 0.5, softness: 0.1, tone: 0.3, b: '#cfcdc8' });
// nearly black: faint grey crystals in a black ground
const graniteBlack = granite(
    { scale: 48, size: 0.7, density: 0.5, variation: 0.8, layers: 3, roundness: 0.2, elongation: 0.4, softness: 0.1, tone: 0.5, a: '#18191b', b: '#3c3d40' },
    { scale: 36, size: 0.6, density: 0.12, variation: 0.8, layers: 2, roundness: 0.2, elongation: 0.4, softness: 0.1, tone: 0.4, b: '#8a8b8e' });
// red granite: red feldspar, black mica, grey quartz
const graniteRed = granite(
    { scale: 36, size: 0.85, density: 0.65, variation: 0.7, layers: 3, roundness: 0.15, elongation: 0.4, softness: 0.05, tone: 0.4, a: '#7f3329', b: '#151211' },
    { scale: 24, size: 0.9, density: 0.3, variation: 0.6, layers: 2, roundness: 0.15, elongation: 0.5, softness: 0.1, tone: 0.3, b: '#6e6b69' });

// travertine: banded cream layers with pores; honed (matte), pores rougher and deeper
const travertine = (() => {
    const g = graph({ size: 600, relief: 0.5 });
    const m = g.node('marble', { mode: 'banded', scale: 2, veins: 6, width: 0.3, turbulence: 0.8, detail: 5, softness: 0.5, grain: 0.4, pores: 0.5, seed: 4, a: '#e2d3b5', b: '#c3a77c', c: '#8a6b45' });
    g.out(m, 'color', 'color');
    const h = g.node('invert', {});
    g.link(m, 'pores', h, 'value').out(h, 'value', 'height');
    roughBy(g, m, 'pores', 0.45, 0.85);
    return g.done();
})();

// sandstone: fine sandy layers, matte, grainy relief
const sandstone = (() => {
    const g = graph({ size: 800, relief: 0.4 });
    const m = g.node('marble', { mode: 'banded', scale: 2, veins: 10, width: 0.1, turbulence: 0.5, detail: 4, softness: 0.8, grain: 0.8, seed: 9, a: '#d9bc8c', b: '#b88a5c', c: '#a07048' });
    const n = g.node('noise', { noiseType: 'fractal', scale: 96, detail: 3, seed: 5 });
    g.out(m, 'color', 'color').out(n, 'value', 'height');
    roughBy(g, n, 'value', 0.75, 0.95);
    return g.done();
})();

// onyx: translucent-looking banded layers, polished
const onyx = marble({ mode: 'banded', scale: 2, veins: 8, width: 0.15, turbulence: 1.6, detail: 5, softness: 0.6, grain: 0.05, seed: 2, a: '#e9cf98', b: '#b9772f', c: '#f6ecd2' }, { size: 500, rough: [0.06, 0.12] });

// slate: dark blue-grey cleft surface – flat plates with a slight tilt, fine layering streaks
const slate = (() => {
    const g = graph({ size: 600, relief: 0.5 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 3, stretch: 16, detail: 5, seed: 3, a: '#33373e', b: '#4f545c' });
    const c = g.node('cellular', { mode: 'chips', scale: 4, spread: 0.99, smoothing: 0.1, roughness: 0.6, fractal: 2, variation: 0.35, a: '#4b4f56', b: '#3f434a' });
    const mix = g.node('mix', { factor: 0.6 });
    g.link(n, 'color', mix, 'a').link(c, 'color', mix, 'b').out(mix, 'color', 'color');
    const h = g.node('math', { op: 'add' });
    g.link(c, 'value', h, 'a').link(n, 'value', h, 'b');
    const hs = g.node('math', { op: 'mul', b: 0.5 });
    g.link(h, 'value', hs, 'a').out(hs, 'value', 'height');
    roughBy(g, n, 'value', 0.55, 0.8);
    return g.done();
})();

// soapstone: dark grey-green, soft light veins, waxy satin
const soapstone = marble({ mode: 'veins', scale: 2, stretch: 1, veins: 3, width: 0.12, turbulence: 1.2, detail: 5, softness: 0.8, grain: 0.2, seed: 15, a: '#4e5855', b: '#9aa7a1', c: '#66726e' }, { size: 500, rough: [0.4, 0.5] });

// limestone: honed, warm grey-beige with fine shell fragments and soft mottling
const limestone = (() => {
    const g = graph({ size: 400, relief: 0.2 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 4, detail: 6, seed: 8, a: '#bfb196', b: '#ddd3bf' });
    const s = g.node('speckle', { scale: 20, size: 0.6, density: 0.2, variation: 0.85, layers: 3, roundness: 0.3, elongation: 1, softness: 0.5, tone: 0.6, b: '#ad9e83' });
    g.link(n, 'color', s, 'a').out(s, 'color', 'color');
    const inv = g.node('invert', {});
    g.link(s, 'value', inv, 'value').out(inv, 'value', 'height');
    roughBy(g, s, 'value', 0.55, 0.7);
    return g.done();
})();

// ---------------------------------------------------------------------------------------------------------------
// masonry
// ---------------------------------------------------------------------------------------------------------------

/**
 * bricks/blocks: tiles node (colour, joint, bevel); per-unit noise darkens the faces (tiles uv → noise), joints
 * rougher than the faces
 */
function units(tile, { size, relief = 1, noise = null, rough = [0.95, 0.75] } = {}) {
    const g = graph({ size, relief });
    const t = g.node('tiles', tile);
    let col = t;
    if (noise) {
        const n = g.node('noise', { noiseType: 'fractal', detail: 4, ...noise.params });
        g.link(t, 'uv', n, 'uv');
        const f = g.node('math', { op: 'mul', b: noise.amount });
        g.link(n, 'value', f, 'a').link(t, 'mask', f, 'b');
        const m = g.node('mix', { b: noise.color });
        g.link(t, 'color', m, 'a').link(f, 'value', m, 'factor');
        col = m;
    }
    g.out(col, 'color', 'color').out(t, 'value', 'height');
    roughBy(g, t, 'mask', ...rough);
    return { g, t, done: () => g.done() };
}

// NF bricks 240 × 71 mm, 10 mm joints: 4 × 12 units per 1 m tile
const BRICK = { countU: 4, countV: 12, gap: 0.12, bevel: 0.05 };

const brickRed = units({ pattern: 'running', ...BRICK, edgeNoise: 0.25, surface: 0.4, variation: 0.35, colorMix: 0.5, seed: 1, a: '#8e3f2a', b: '#b4aea3', c: '#5e2c22' },
    { size: 1000, noise: { params: { scale: 3, seed: 2 }, amount: 0.5, color: '#4a2016' } }).done();
const brickClinker = units({ pattern: 'running', ...BRICK, gap: 0.14, bevel: 0.03, edgeNoise: 0.15, surface: 0.25, variation: 0.4, colorMix: 0.6, seed: 2, a: '#5a2a20', b: '#6f6a64', c: '#2e2420' },
    { size: 1000, rough: [0.9, 0.55] }).done();
const brickYellow = units({ pattern: 'flemish', ...BRICK, edgeNoise: 0.25, surface: 0.45, variation: 0.3, colorMix: 0.4, seed: 3, a: '#d0ad6e', b: '#c9c3b6', c: '#b08646' },
    { size: 1000, noise: { params: { scale: 3, seed: 4 }, amount: 0.4, color: '#8f6a38' } }).done();
const brickEnglish = units({ pattern: 'english', ...BRICK, edgeNoise: 0.25, surface: 0.4, variation: 0.35, colorMix: 0.5, seed: 4, a: '#a24e30', b: '#a9a296', c: '#7c3a26' },
    { size: 1000, noise: { params: { scale: 3, seed: 6 }, amount: 0.45, color: '#5a2a1a' } }).done();
// white glazed bricks, stack bond: glossy glaze on the faces only (clearcoat by the tile mask)
const brickGlazed = (() => {
    const u = units({ pattern: 'stack', ...BRICK, gap: 0.1, bevel: 0.08, edgeNoise: 0.05, surface: 0.05, variation: 0.06, colorMix: 0.2, seed: 5, a: '#f0efea', b: '#8d8a84', c: '#e2e3e0' },
        { size: 1000, relief: 0.6, rough: [0.9, 0.12] });
    u.g.out(u.t, 'mask', 'clearcoat');
    return u.done();
})();
// herringbone paving bricks 200 × 100 mm (sand joints)
const brickHerringbone = units({ pattern: 'herringbone', countU: 4, ratio: 2, gap: 0.08, bevel: 0.08, edgeNoise: 0.2, surface: 0.45, variation: 0.35, colorMix: 0.5, seed: 6, a: '#94452e', b: '#a59a86', c: '#6a3324' },
    { size: 1200, noise: { params: { scale: 2, seed: 7 }, amount: 0.4, color: '#4a2418' } }).done();
// basket weave: pairs of 200 × 100 mm bricks
const brickBasket = units({ pattern: 'basket', countU: 3, ratio: 2, gap: 0.08, bevel: 0.08, edgeNoise: 0.2, surface: 0.45, variation: 0.3, colorMix: 0.5, seed: 7, a: '#9b6a4a', b: '#aaa293', c: '#7a4c34' },
    { size: 1200, noise: { params: { scale: 2, seed: 8 }, amount: 0.35, color: '#5a3a26' } }).done();

// concrete blocks 390 × 190 mm, 10 mm joints: 3 × 6 per 1.2 m tile, fine aggregate on the face
function cmu(tile, speck, { size = 1200, relief = 1 } = {}) {
    const g = graph({ size, relief });
    const t = g.node('tiles', { countU: 3, countV: 6, gap: 0.05, bevel: 0.02, ...tile });
    const s = g.node('speckle', { scale: 160, size: 0.6, density: 0.35, variation: 0.8, layers: 2, roundness: 0.3, elongation: 0.3, softness: 0.2, tone: 0.5, ...speck });
    g.link(t, 'color', s, 'a').out(s, 'color', 'color');
    return { g, t, s };
}
const blockStretcher = (() => {
    const { g, t } = cmu({ pattern: 'running', edgeNoise: 0.15, surface: 0.7, variation: 0.12, colorMix: 0.3, seed: 8, a: '#7e7d78', b: '#a19d94', c: '#6f6e69' }, { b: '#5d5c58' });
    g.out(t, 'value', 'height');
    roughBy(g, t, 'mask', 0.95, 0.85);
    return g.done();
})();
// split-face blocks: rough broken face (fractal noise relief on the faces), warm tan
const blockSplitFace = (() => {
    const { g, t } = cmu({ pattern: 'running', gap: 0.07, bevel: 0.01, edgeNoise: 0.6, surface: 0.9, variation: 0.2, colorMix: 0.4, seed: 9, a: '#b2a58a', b: '#8a8478', c: '#998a6e' }, { b: '#6e6352', density: 0.45 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 16, detail: 5, seed: 11 });
    const nm = g.node('math', { op: 'mul' });
    g.link(n, 'value', nm, 'a').link(t, 'mask', nm, 'b');
    const h = g.node('math', { op: 'add' });
    const hs = g.node('math', { op: 'mul', b: 0.6 });
    g.link(t, 'value', h, 'a').link(nm, 'value', h, 'b').link(h, 'value', hs, 'a').out(hs, 'value', 'height');
    roughBy(g, t, 'mask', 0.95, 0.9);
    return g.done();
})();
// ribbed blocks, stack bond: vertical ribs on every face
const blockRibbed = (() => {
    const { g, t } = cmu({ pattern: 'stack', edgeNoise: 0.15, surface: 0.6, variation: 0.1, colorMix: 0.3, seed: 10, a: '#858072', b: '#a39e92', c: '#787366' }, { b: '#5f5a50' }, { relief: 2.2 });
    const w = g.node('waves', { profile: 'trapezoid', count: 9, axis: 'u', width: 0.5, slope: 0.15, softness: 0.3 });
    const r = g.node('math', { op: 'mul' });
    g.link(t, 'value', r, 'a').link(w, 'value', r, 'b');
    const h = g.node('math', { op: 'add' });
    const hs = g.node('math', { op: 'mul', b: 0.7 });
    g.link(t, 'value', h, 'a').link(r, 'value', h, 'b').link(h, 'value', hs, 'a').out(hs, 'value', 'height');
    roughBy(g, t, 'mask', 0.95, 0.85);
    return g.done();
})();

// coursed ashlar: large dressed sandstone blocks, rows of random offset, per-stone cloudiness
const ashlar = units({ pattern: 'running', countU: 3, countV: 6, gap: 0.04, bevel: 0.04, edgeNoise: 0.3, surface: 0.6, variation: 0.25, colorMix: 0.6, jitter: 0.8, seed: 11, a: '#c4b598', b: '#bdb4a3', c: '#a8987a' },
    { size: 2000, noise: { params: { scale: 4, seed: 12 }, amount: 0.3, color: '#8a7c62' } }).done();
// limestone rustication: big blocks with deep chamfered (V) joints
const rustication = units({ pattern: 'running', countU: 2, countV: 4, gap: 0.02, bevel: 0.12, profile: 'chamfer', edgeNoise: 0.2, surface: 0.5, variation: 0.12, colorMix: 0.3, seed: 12, a: '#d3cbb8', b: '#bfb6a2', c: '#c4b89e' },
    { size: 2400, relief: 1.5, noise: { params: { scale: 5, seed: 13 }, amount: 0.15, color: '#a39678' } }).done();
// dry-stacked wall of flat limestone slabs: courses of thin stones of random lengths
const dryStone = units({ pattern: 'planks', countU: 4, countV: 16, gap: 0.12, bevel: 0.2, edgeNoise: 0.7, surface: 0.7, variation: 0.5, colorMix: 0.7, jitter: 1, seed: 13, a: '#b3a98f', b: '#3c3830', c: '#8c8068' },
    { size: 1500, noise: { params: { scale: 4, seed: 14 }, amount: 0.4, color: '#6f6550' } }).done();
// random rubble / fieldstone: irregular stones in mortar
const rubble = (() => {
    const g = graph({ size: 1500, relief: 1 });
    const c = g.node('cellular', { mode: 'cells', scale: 5, spread: 0.85, smoothing: 0.25, roughness: 0.45, fractal: 2, variation: 0.6, a: '#8f877b', b: '#a8a194' });
    g.out(c, 'color', 'color').out(c, 'value', 'height');
    roughBy(g, c, 'value', 0.95, 0.8);
    return g.done();
})();
// river stone wall: rounded pebbles set in mortar
const riverStone = (() => {
    const g = graph({ size: 1200, relief: 1 });
    const c = g.node('cellular', { mode: 'circular', scale: 6, spread: 0.75, smoothing: 0.3, roughness: 0.6, fractal: 2, variation: 0.8, a: '#9a958c', b: '#b0a998' });
    g.out(c, 'color', 'color').out(c, 'value', 'height');
    roughBy(g, c, 'value', 0.95, 0.6);
    return g.done();
})();

export default [
    // --- stone ---
    { libraryId: 'stone-marble-white', category: 'stone', params: { color: '#e8e6e1', ...POLISHED, roughness: 0.15 }, graph: marbleWhite },
    { libraryId: 'stone-marble-black', category: 'stone', params: { color: '#1c1c1f', ...POLISHED, roughness: 0.15 }, graph: marbleBlack },
    { libraryId: 'stone-marble-green', category: 'stone', params: { color: '#2a4a38', ...POLISHED, roughness: 0.15 }, graph: marbleGreen },
    { libraryId: 'stone-marble-beige', category: 'stone', params: { color: '#dccdb0', ...POLISHED, roughness: 0.15 }, graph: marbleBeige },
    { libraryId: 'stone-granite-grey', category: 'stone', params: { color: '#8f8d8a', ...POLISHED, roughness: 0.2 }, graph: graniteGrey },
    { libraryId: 'stone-granite-black', category: 'stone', params: { color: '#1e1f21', ...POLISHED, roughness: 0.2 }, graph: graniteBlack },
    { libraryId: 'stone-granite-red', category: 'stone', params: { color: '#7e3a2c', ...POLISHED, roughness: 0.2 }, graph: graniteRed },
    { libraryId: 'stone-onyx-honey', category: 'stone', params: { color: '#e0b878', ...POLISHED, roughness: 0.08 }, graph: onyx },
    { libraryId: 'stone-travertine', category: 'stone', params: { color: '#d8c6a2', metalness: 0, roughness: 0.5 }, graph: travertine },
    { libraryId: 'stone-limestone', category: 'stone', params: { color: '#d4cab4', metalness: 0, roughness: 0.6 }, graph: limestone },
    { libraryId: 'stone-sandstone', category: 'stone', params: { color: '#c9a678', metalness: 0, roughness: 0.85 }, graph: sandstone },
    { libraryId: 'stone-slate', category: 'stone', params: { color: '#44484f', metalness: 0, roughness: 0.65 }, graph: slate },
    { libraryId: 'stone-soapstone', category: 'stone', params: { color: '#59625f', metalness: 0, roughness: 0.45 }, graph: soapstone },

    // --- masonry ---
    { libraryId: 'brick-running-red', category: 'masonry', params: { color: '#8e3f2a', metalness: 0, roughness: 0.85 }, graph: brickRed },
    { libraryId: 'brick-clinker-dark', category: 'masonry', params: { color: '#4a2820', metalness: 0, roughness: 0.6 }, graph: brickClinker },
    { libraryId: 'brick-english-red', category: 'masonry', params: { color: '#a24e30', metalness: 0, roughness: 0.85 }, graph: brickEnglish },
    { libraryId: 'brick-flemish-yellow', category: 'masonry', params: { color: '#d0ad6e', metalness: 0, roughness: 0.85 }, graph: brickYellow },
    { libraryId: 'brick-glazed-white', category: 'masonry', params: { color: '#eeede8', metalness: 0, roughness: 0.15, clearcoatRoughness: 0.05 }, graph: brickGlazed },
    { libraryId: 'brick-herringbone', category: 'masonry', params: { color: '#8f4530', metalness: 0, roughness: 0.85 }, graph: brickHerringbone },
    { libraryId: 'brick-basket-weave', category: 'masonry', params: { color: '#9b6a4a', metalness: 0, roughness: 0.85 }, graph: brickBasket },
    { libraryId: 'masonry-block-grey', category: 'masonry', params: { color: '#8b8a84', metalness: 0, roughness: 0.9 }, graph: blockStretcher },
    { libraryId: 'masonry-block-split-face', category: 'masonry', params: { color: '#b2a58a', metalness: 0, roughness: 0.92 }, graph: blockSplitFace },
    { libraryId: 'masonry-block-ribbed', category: 'masonry', params: { color: '#8f8a7c', metalness: 0, roughness: 0.9 }, graph: blockRibbed },
    { libraryId: 'masonry-ashlar', category: 'masonry', params: { color: '#c9b693', metalness: 0, roughness: 0.85 }, graph: ashlar },
    { libraryId: 'masonry-rustication', category: 'masonry', params: { color: '#d6cdb9', metalness: 0, roughness: 0.8 }, graph: rustication },
    { libraryId: 'masonry-dry-stone', category: 'masonry', params: { color: '#a89e85', metalness: 0, roughness: 0.9 }, graph: dryStone },
    { libraryId: 'masonry-rubble', category: 'masonry', params: { color: '#8f877b', metalness: 0, roughness: 0.9 }, graph: rubble },
    { libraryId: 'masonry-river-stone', category: 'masonry', params: { color: '#9a958c', metalness: 0, roughness: 0.85 }, graph: riverStone },
];
