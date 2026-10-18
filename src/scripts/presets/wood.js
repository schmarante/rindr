// Wood presets: solid woods / veneers, panels (plywood, OSB, chipboard, MDF), cork and wood floors.
// Grain from the wood node (fibre along u); pores drive the roughness (open pores rougher). Finish: oiled = no
// clearcoat, moderate roughness; lacquered = clearcoat over a smoother base. Floors: tiles node (planks, herringbone,
// basket) whose per-plank `uv` feeds the wood node, so every plank shows its own piece of grain; joint by mask.
import { graph } from './graph.js';

/** solid wood / veneer: wood node → colour + relief, `port` (pores or ring) → roughness range */
function solid({ size = 500, relief = 0.35, wood, rough = [0.5, 0.7], port = 'pores' }) {
    const g = graph({ size, relief });
    const w = g.node('wood', wood);
    g.out(w, 'color', 'color').out(w, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(w, port, r, 'value').out(r, 'value', 'roughness');
    return g.done();
}

/**
 * wood floor: tiles layout → per-plank uv into the wood node; per-plank shade (random → towards `shade`, up to
 * `vary`); joint colour via mask; bevel × grain as height
 */
function floor({ size, relief = 0.5, tiles, wood, joint, shade, vary = 0.35, rough = [0.4, 0.6] }) {
    const g = graph({ size, relief });
    const t = g.node('tiles', { edgeNoise: 0.1, surface: 0, variation: 0, colorMix: 0, profile: 'round', ...tiles });
    const w = g.node('wood', wood);
    g.link(t, 'uv', w, 'uv');
    const rv = g.node('remap', { from: 0, to: vary });
    g.link(t, 'random', rv, 'value');
    const sh = g.node('mix', { b: shade });
    g.link(w, 'color', sh, 'a').link(rv, 'value', sh, 'factor');
    const m = g.node('mix', { a: joint, factor: 1 });
    g.link(sh, 'color', m, 'b').link(t, 'mask', m, 'factor').out(m, 'color', 'color');
    const h = g.node('math', { op: 'mul' });
    g.link(t, 'value', h, 'a').link(w, 'value', h, 'b').out(h, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(w, 'pores', r, 'value').out(r, 'value', 'roughness');
    return g.done();
}

/** wood-based panel / cork: one or two chained speckle nodes (second one sprinkles onto the first) */
function chips({ size, relief = 0.3, first, second = null, rough = [0.7, 0.85] }) {
    const g = graph({ size, relief });
    const s1 = g.node('speckle', first);
    let top = s1;
    if (second) {
        top = g.node('speckle', second);
        g.link(s1, 'color', top, 'a');
    }
    g.out(top, 'color', 'color');
    const h = g.node('math', { op: 'max' });
    g.link(s1, 'value', h, 'a').link(top, 'value', h, 'b').out(h, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(h, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
}

// --- solid woods / veneers ---
const oak = solid({ size: 500, relief: 0.4, rough: [0.5, 0.75],
    wood: { cut: 'flat', rings: 40, arches: 4, irregularity: 0.5, stretch: 4, latewood: 0.4, contrast: 0.6, pores: 0.8, seed: 3, a: '#c9a06a', b: '#94683c' } });
const oakSmoked = solid({ size: 500, relief: 0.4, rough: [0.5, 0.75],
    wood: { cut: 'flat', rings: 36, arches: 3, irregularity: 0.55, stretch: 4, latewood: 0.4, contrast: 0.65, pores: 0.85, seed: 11, a: '#8c6243', b: '#4f3320' } });
const walnut = solid({ size: 500, relief: 0.3, rough: [0.45, 0.65],
    wood: { cut: 'flat', rings: 30, arches: 3, irregularity: 0.6, stretch: 4, latewood: 0.35, contrast: 0.6, pores: 0.5, seed: 7, a: '#7a5236', b: '#3e2618' } });
const maple = solid({ size: 400, relief: 0.2, rough: [0.4, 0.5], port: 'ring',
    wood: { cut: 'flat', rings: 30, arches: 3, irregularity: 0.3, stretch: 4, latewood: 0.25, contrast: 0.5, pores: 0.1, seed: 5, a: '#dfc296', b: '#b98f5c' } });
const cherry = solid({ size: 450, relief: 0.2, rough: [0.35, 0.5],
    wood: { cut: 'flat', rings: 32, arches: 3, irregularity: 0.5, stretch: 4, latewood: 0.3, contrast: 0.5, pores: 0.2, seed: 9, a: '#b8714a', b: '#7f4026' } });
const pine = solid({ size: 500, relief: 0.35, rough: [0.55, 0.7], port: 'ring',
    wood: { cut: 'flat', rings: 24, arches: 2, irregularity: 0.5, stretch: 4, latewood: 0.3, contrast: 0.85, pores: 0, seed: 5, a: '#e2bf86', b: '#a86e36' } });
const teak = solid({ size: 550, relief: 0.3, rough: [0.45, 0.65],
    wood: { cut: 'flat', rings: 34, arches: 2, irregularity: 0.5, stretch: 5, latewood: 0.4, contrast: 0.6, pores: 0.6, seed: 4, a: '#a8743f', b: '#6e4520' } });
const ash = solid({ size: 500, relief: 0.4, rough: [0.5, 0.75],
    wood: { cut: 'flat', rings: 26, arches: 4, irregularity: 0.5, stretch: 4, latewood: 0.5, contrast: 0.55, pores: 0.9, seed: 6, a: '#dcc196', b: '#9e7f52' } });
const beech = solid({ size: 400, relief: 0.2, rough: [0.45, 0.55], port: 'ring',
    wood: { cut: 'flat', rings: 28, arches: 3, irregularity: 0.35, stretch: 4, latewood: 0.25, contrast: 0.3, pores: 0.15, seed: 8, a: '#e4b98e', b: '#c9966a' } });
const mahogany = solid({ size: 500, relief: 0.2, rough: [0.35, 0.45],
    wood: { cut: 'quarter', rings: 40, arches: 0, irregularity: 0.6, stretch: 6, latewood: 0.5, contrast: 0.6, pores: 0.5, seed: 12, a: '#a0522e', b: '#5a2412' } });
const wenge = solid({ size: 450, relief: 0.35, rough: [0.45, 0.65],
    wood: { cut: 'quarter', rings: 56, arches: 0, irregularity: 0.5, stretch: 8, latewood: 0.55, contrast: 0.85, pores: 0.7, seed: 14, a: '#6e4c33', b: '#24170e' } });
const weathered = solid({ size: 600, relief: 0.8, rough: [0.8, 0.95],
    wood: { cut: 'flat', rings: 22, arches: 3, irregularity: 0.75, stretch: 5, latewood: 0.35, contrast: 0.8, pores: 0.7, seed: 21, a: '#9a958b', b: '#5f5a52' } });
const plywood = solid({ size: 1200, relief: 0.15, rough: [0.55, 0.65], port: 'ring',
    wood: { cut: 'flat', rings: 12, arches: 2, irregularity: 0.8, stretch: 3, latewood: 0.3, contrast: 0.45, pores: 0.05, seed: 17, a: '#dbbd8e', b: '#b48a52' } });

// bamboo: laminated panel of strips (20 mm wide), each strip cut into staggered segments – the joints read as the
// darker node rings; every segment its own piece of the dense grain
const bamboo = (() => {
    const g = graph({ size: 600, relief: 0.2 });
    const t = g.node('tiles', { pattern: 'planks', countU: 2, countV: 30, jitter: 0.8, gap: 0.05, bevel: 0.04, edgeNoise: 0.2, surface: 0, seed: 4 });
    const w = g.node('wood', { cut: 'quarter', rings: 70, arches: 0, irregularity: 0.15, stretch: 10, latewood: 0.3, contrast: 0.4, pores: 0.4, a: '#d9b47a', b: '#b0864a' });
    g.link(t, 'uv', w, 'uv');
    const m = g.node('mix', { a: '#9a7240', factor: 1 });
    g.link(w, 'color', m, 'b').link(t, 'mask', m, 'factor').out(m, 'color', 'color');
    const h = g.node('math', { op: 'mul' });
    g.link(t, 'value', h, 'a').link(w, 'value', h, 'b').out(h, 'value', 'height');
    const r = g.node('remap', { from: 0.4, to: 0.55 });
    g.link(w, 'pores', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// --- panels and cork ---
// OSB: strands as thresholded noise stretched along u, three layers on top of each other over a dark base
const osb = (() => {
    const g = graph({ size: 600, relief: 0.6 });
    const layers = [
        { scale: 6, seed: 1, low: 0.4, high: 0.42, a: '#5a3e22', b: '#b88b54' },
        { scale: 5, seed: 7, low: 0.5, high: 0.52, b: '#d3ad76' },
        { scale: 6, seed: 13, low: 0.5, high: 0.52, b: '#a87a46' },
        { scale: 7, seed: 23, low: 0.52, high: 0.54, b: '#dfbd88' },
        { scale: 8, seed: 31, low: 0.55, high: 0.57, b: '#c49660' },
    ];
    let prev = null, hPrev = null;
    for (const l of layers) {
        const n = g.node('noise', { noiseType: 'fractal', detail: 2, stretch: 6, ...l });
        if (prev) {
            g.link(prev, 'color', n, 'a');
            const h = g.node('math', { op: 'max' });
            g.link(hPrev, 'value', h, 'a').link(n, 'value', h, 'b');
            hPrev = h;
        } else hPrev = n;
        prev = n;
    }
    g.out(prev, 'color', 'color').out(hPrev, 'value', 'height');
    return g.done();
})();
const chipboard = chips({ size: 300, relief: 0.25, rough: [0.7, 0.85],
    first: { scale: 60, size: 1, density: 1, variation: 0.7, layers: 3, roundness: 0.1, elongation: 0.5, softness: 0.1, tone: 0.5, a: '#a88660', b: '#6f5233' },
    second: { scale: 80, size: 0.7, density: 0.6, variation: 0.7, layers: 2, roundness: 0.1, elongation: 0.4, softness: 0.1, tone: 0.4, b: '#cdb08a' } });
const cork = chips({ size: 300, relief: 0.35, rough: [0.8, 0.9],
    first: { scale: 50, size: 1.1, density: 1, variation: 0.8, layers: 3, roundness: 0.5, elongation: 0.2, softness: 0.2, tone: 0.6, a: '#b48d68', b: '#7d5534' },
    second: { scale: 70, size: 0.6, density: 0.5, variation: 0.8, layers: 2, roundness: 0.6, elongation: 0.2, softness: 0.3, tone: 0.5, b: '#4a2e1a' } });
const mdf = (() => {
    const g = graph({ size: 300, relief: 0.1 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 40, detail: 5, stretch: 1, a: '#8f6c49', b: '#b08b63', seed: 3 });
    g.out(n, 'color', 'color').out(n, 'value', 'height');
    const r = g.node('remap', { from: 0.7, to: 0.85 });
    g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// --- floors ---
// plank floor: boards 200 mm wide, random lengths up to 1200 mm, satin lacquer
const planks = floor({ size: 2400, relief: 0.5, rough: [0.35, 0.55], joint: '#3a2616', shade: '#8a5a30',
    tiles: { pattern: 'planks', countU: 2, countV: 12, jitter: 0.7, gap: 0.03, bevel: 0.05, seed: 3 },
    wood: { cut: 'flat', rings: 150, arches: 10, irregularity: 0.5, stretch: 4, latewood: 0.4, contrast: 0.6, pores: 0.7, a: '#c9a06a', b: '#94683c' } });
const herringbone = floor({ size: 1200, relief: 0.5, rough: [0.4, 0.6], joint: '#3a2616', shade: '#7a5030',
    tiles: { pattern: 'herringbone', countU: 2, ratio: 6, gap: 0.03, bevel: 0.04, seed: 5 },
    wood: { cut: 'flat', rings: 100, arches: 8, irregularity: 0.5, stretch: 4, latewood: 0.4, contrast: 0.55, pores: 0.7, a: '#c39a66', b: '#8d6238' } });
const basket = floor({ size: 960, relief: 0.5, rough: [0.4, 0.6], joint: '#1e120a', shade: '#2e1c10', vary: 0.3,
    tiles: { pattern: 'basket', countU: 2, ratio: 4, gap: 0.03, bevel: 0.04, seed: 8 },
    wood: { cut: 'flat', rings: 90, arches: 6, irregularity: 0.6, stretch: 4, latewood: 0.35, contrast: 0.6, pores: 0.5, a: '#7a5236', b: '#3e2618' } });

const oiled = rough => ({ metalness: 0, roughness: rough });
const lacquered = (rough, cc = 1, ccr = 0.08) => ({ metalness: 0, roughness: rough, clearcoat: cc, clearcoatRoughness: ccr });

export default [
    { libraryId: 'wood-oak', category: 'wood', params: { color: '#b88c58', ...oiled(0.6) }, graph: oak },
    { libraryId: 'wood-oak-smoked', category: 'wood', params: { color: '#6e4a30', ...oiled(0.6) }, graph: oakSmoked },
    { libraryId: 'wood-walnut', category: 'wood', params: { color: '#5e3e28', ...oiled(0.55) }, graph: walnut },
    { libraryId: 'wood-maple', category: 'wood', params: { color: '#dcc29a', ...lacquered(0.45, 0.8, 0.12) }, graph: maple },
    { libraryId: 'wood-cherry', category: 'wood', params: { color: '#a05a38', ...lacquered(0.4, 0.8, 0.1) }, graph: cherry },
    { libraryId: 'wood-pine', category: 'wood', params: { color: '#d8b07a', ...oiled(0.62) }, graph: pine },
    { libraryId: 'wood-teak', category: 'wood', params: { color: '#8f5f32', ...oiled(0.55) }, graph: teak },
    { libraryId: 'wood-ash', category: 'wood', params: { color: '#d0b48a', ...oiled(0.6) }, graph: ash },
    { libraryId: 'wood-beech', category: 'wood', params: { color: '#d9ab7f', ...oiled(0.5) }, graph: beech },
    { libraryId: 'wood-mahogany', category: 'wood', params: { color: '#82391f', ...lacquered(0.4, 1, 0.03) }, graph: mahogany },
    { libraryId: 'wood-wenge', category: 'wood', params: { color: '#3e2a1c', ...oiled(0.55) }, graph: wenge },
    { libraryId: 'wood-bamboo', category: 'wood', params: { color: '#cfb07a', ...lacquered(0.45, 0.7, 0.15) }, graph: bamboo },
    { libraryId: 'wood-weathered', category: 'wood', params: { color: '#837e75', ...oiled(0.9) }, graph: weathered },
    { libraryId: 'wood-plywood', category: 'wood', params: { color: '#dcc497', ...oiled(0.6) }, graph: plywood },
    { libraryId: 'wood-osb', category: 'wood', params: { color: '#b08752', ...oiled(0.75) }, graph: osb },
    { libraryId: 'wood-chipboard', category: 'wood', params: { color: '#9a7a55', ...oiled(0.8) }, graph: chipboard },
    { libraryId: 'wood-mdf', category: 'wood', params: { color: '#a07c56', ...oiled(0.8) }, graph: mdf },
    { libraryId: 'wood-cork', category: 'wood', params: { color: '#a07a56', ...oiled(0.85) }, graph: cork },
    { libraryId: 'wood-floor-planks', category: 'wood', params: { color: '#b88c58', ...lacquered(0.45, 0.8, 0.15) }, graph: planks },
    { libraryId: 'wood-floor-herringbone', category: 'wood', params: { color: '#b08a5a', ...oiled(0.5) }, graph: herringbone },
    { libraryId: 'wood-floor-basket', category: 'wood', params: { color: '#5e3e28', ...lacquered(0.45, 0.8, 0.12) }, graph: basket },
];
