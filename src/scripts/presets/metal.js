// Library presets: structured and textured metals (brushed, patina, rust, hammered, perforated, tread plate,
// profiled sheet). The plain parameter metals (chrome, gold, copper …) live in material-presets.js.
// Rule for metals: keep colour a/b close – the shading has to come from the normal and the roughness, not from
// colour baked into the albedo.
import { graph } from './graph.js';

/** brushed finish: streaks along u (noise stretched across v), streaks a little rougher */
function brushed({ size, relief, a, b, scale = 2, stretch = 200, detail = 1, rough = [0.4, 0.22], seed = 0 }) {
    const g = graph({ size, relief });
    const n = g.node('noise', { noiseType: 'fractal', scale, detail, stretch, seed, a, b });
    g.out(n, 'color', 'color').out(n, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
}

// --- brushed / satin ---
const stainlessBrushed = brushed({ size: 300, relief: 0.1, a: '#a4a6a8', b: '#c2c4c6', scale: 3, stretch: 200, detail: 3, rough: [0.34, 0.2] });
const aluBrushedLines = brushed({ size: 200, relief: 0.15, a: '#a9adb1', b: '#d6d9dc', rough: [0.4, 0.22], seed: 3 });
const brassBrushed = brushed({ size: 250, relief: 0.12, a: '#b8954f', b: '#d6b56e', stretch: 180, detail: 2, rough: [0.42, 0.26], seed: 5 });
const bronzeAnodized = brushed({ size: 300, relief: 0.08, a: '#463c33', b: '#554a40', stretch: 120, detail: 2, rough: [0.42, 0.3], seed: 7 });

// satin bronze: fine random satin grain (no direction), soft cloudy tone
const bronzeSatin = (() => {
    const g = graph({ size: 200, relief: 0.05 });
    const grain = g.node('noise', { noiseType: 'fractal', scale: 120, detail: 2, a: '#7f6143', b: '#93724f' });
    const cloud = g.node('noise', { noiseType: 'fractal', scale: 3, detail: 4, seed: 11, a: '#76593d', b: '#957452' });
    const m = g.node('mix', { factor: 0.5 });
    g.link(cloud, 'color', m, 'a').link(grain, 'color', m, 'b');
    g.out(m, 'color', 'color').out(grain, 'value', 'height');
    const r = g.node('remap', { from: 0.32, to: 0.42 });
    g.link(cloud, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// --- coated / weathered ---
// hot-dip galvanized: crystal spangles (cells with a slightly different tone and roughness each)
const zincSpangled = (() => {
    const g = graph({ size: 300, relief: 0.06 });
    const c = g.node('cellular', { mode: 'chips', scale: 14, spread: 1, smoothing: 0.05, roughness: 0.6, fractal: 1, variation: 0.6,
        a: '#a9adb0', b: '#9a9ea1' });
    g.out(c, 'color', 'color').out(c, 'value', 'height');
    const r = g.node('remap', { from: 0.22, to: 0.5 });
    g.link(c, 'random', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// copper patina: green verdigris over copper; the patina is mineral (not metallic, rough)
const copperPatina = (() => {
    const g = graph({ size: 600, relief: 0.3 });
    const mask = g.node('noise', { noiseType: 'fractal', scale: 4, detail: 6, low: 0.34, high: 0.6 });
    const patina = g.node('noise', { noiseType: 'fractal', scale: 12, detail: 4, seed: 4, a: '#5a917c', b: '#88b6a1' });
    const m = g.node('mix', { a: '#9a5638' });
    g.link(patina, 'color', m, 'b').link(mask, 'value', m, 'factor');
    g.out(m, 'color', 'color').out(mask, 'value', 'height');
    const met = g.node('remap', { from: 1, to: 0 });
    g.link(mask, 'value', met, 'value').out(met, 'value', 'metalness');
    const r = g.node('remap', { from: 0.3, to: 0.85 });
    g.link(mask, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// rusty steel: rust patches (rough, not metallic, pitted) on worn steel
const steelRusty = (() => {
    const g = graph({ size: 500, relief: 0.4 });
    const mask = g.node('noise', { noiseType: 'fractal', scale: 4, detail: 6, low: 0.42, high: 0.6 });
    const rust = g.node('noise', { noiseType: 'turbulence', scale: 24, detail: 4, seed: 9, a: '#5a2a14', b: '#9a4a20' });
    const m = g.node('mix', { a: '#8a8c8e' });
    g.link(rust, 'color', m, 'b').link(mask, 'value', m, 'factor');
    g.out(m, 'color', 'color');
    const pits = g.node('dent', { scale: 30, size: 0.5, density: 0.5, detail: 2, distort: 0.5, seed: 2 });
    const h = g.node('math', { op: 'mul' });
    g.link(pits, 'value', h, 'a').link(mask, 'value', h, 'b');
    g.out(h, 'value', 'height');
    const met = g.node('remap', { from: 1, to: 0 });
    g.link(mask, 'value', met, 'value').out(met, 'value', 'metalness');
    const r = g.node('remap', { from: 0.4, to: 0.9 });
    g.link(mask, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// weathering steel: fully rusted, stable dark orange-brown skin
const steelWeathering = (() => {
    const g = graph({ size: 800, relief: 0.25 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 6, detail: 7, a: '#4e2414', b: '#8a4422' });
    const fine = g.node('noise', { noiseType: 'turbulence', scale: 60, detail: 3, seed: 6 });
    g.out(n, 'color', 'color').out(fine, 'value', 'height');
    const r = g.node('remap', { from: 0.92, to: 0.78 });
    g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// old, greasy metal: smudges of grease (glossier) and dust (duller) on dark steel
const metalGreasy = (() => {
    const g = graph({ size: 500, relief: 0.1 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 3, detail: 6, low: 0.45, high: 0.75, a: '#6e6f70', b: '#5a5b5c' });
    const brush = g.node('noise', { noiseType: 'fractal', scale: 2, detail: 2, stretch: 120, seed: 8 });
    g.out(n, 'color', 'color').out(brush, 'value', 'height');
    const r = g.node('remap', { from: 0.7, to: 0.3 });
    g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

/** hammered: overlapping dents meet in ridges (facets), dents slightly glossier */
function hammered({ size, relief, a, b, rough }) {
    const g = graph({ size, relief });
    const d = g.node('dent', { scale: 8, size: 1, detail: 2, distort: 0.3, a, b });
    g.out(d, 'color', 'color').out(d, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(d, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
}
const metalHammered = hammered({ size: 300, relief: 0.6, a: '#a9acb0', b: '#c4c7cb', rough: [0.2, 0.28] });
const copperHammered = hammered({ size: 300, relief: 0.6, a: '#c47c55', b: '#d99470', rough: [0.18, 0.3] });

// gold leaf: square sheets laid with slight overlaps, every sheet a little different, fine wrinkles
const goldLeaf = (() => {
    const g = graph({ size: 340, relief: 0.25 });
    const t = g.node('tiles', { pattern: 'running', countU: 4, countV: 4, gap: 0.006, bevel: 0.01, edgeNoise: 0.6, surface: 0,
        variation: 0.15, colorMix: 0.3, jitter: 0.4, a: '#e8be62', b: '#c79c48', c: '#f2d27e' });
    const w = g.node('noise', { noiseType: 'turbulence', scale: 16, detail: 4, seed: 12 });
    const h = g.node('math', { op: 'mul' });
    g.link(t, 'value', h, 'a').link(w, 'value', h, 'b');
    g.out(t, 'color', 'color').out(h, 'value', 'height');
    const r = g.node('remap', { from: 0.32, to: 0.16 });
    g.link(w, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

// --- perforated and expanded sheet: dots value = 1 solid, 0 hole -> alpha cutout and height ---
function sheet(size, relief, dots, roughness = null) {
    const g = graph({ size, relief });
    const d = g.node('dots', { a: '#101010', b: '#b8bcc0', ...dots });
    g.out(d, 'color', 'color').out(d, 'value', 'alpha').out(d, 'value', 'height');
    if (roughness) g.out(g.node('value', { value: roughness }), 'value', 'roughness');
    return g.done();
}
const perfRound = sheet(50, 0.4, { pattern: 'perforated', shape: 'circle', stagger: 'half', count: 10, size: 0.6, bevel: 0.25 });
const perfSquare = sheet(100, 0.4, { pattern: 'perforated', shape: 'square', stagger: 'none', count: 10, size: 0.75, rounding: 0.15, bevel: 0.2 });
const perfSlot = sheet(140, 0.4, { pattern: 'perforated', shape: 'slot', stagger: 'half', count: 5, size: 0.5, length: 3.5, bevel: 0.2 });
const expanded = sheet(150, 0.6, { pattern: 'expanded', count: 5, size: 0.7, length: 2.2, rounding: 0.35, bevel: 0.8, b: '#9a9c9e' });

// --- tread plates: raised pattern -> height ---
function tread(size, relief, dots, rough) {
    const g = graph({ size, relief });
    const d = g.node('dots', dots);
    g.out(d, 'color', 'color').out(d, 'value', 'height');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(d, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
}
const treadBars = tread(200, 0.8, { pattern: 'bars', count: 6, size: 0.9, length: 10, bars: 5, rounding: 0, bevel: 1,
    a: '#b4b8bc', b: '#c8ccd0' }, [0.42, 0.3]);
const treadDiamond = tread(240, 0.8, { pattern: 'tread', stagger: 'half', count: 8, size: 0.8, length: 4, rounding: 0.3, bevel: 0.8,
    a: '#7c7f82', b: '#8e9194' }, [0.55, 0.38]);

// --- profiled sheet (roof / wall cladding): waves profile -> height ---
function profiled(size, relief, waves, rough = null, grain = null) {
    const g = graph({ size, relief });
    const w = g.node('waves', waves);
    g.out(w, 'value', 'height');
    if (grain) {
        // weathering / spangle tone varying along the sheets (without: plain params colour)
        const n = g.node('noise', grain);
        g.out(n, 'color', 'color');
        const r = g.node('remap', { from: rough[0], to: rough[1] });
        g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    }
    return g.done();
}
const corrugated = profiled(1000, 1, { profile: 'sine', count: 13 }, [0.3, 0.42],
    { noiseType: 'fractal', scale: 8, detail: 5, stretch: 4, a: '#9fa3a6', b: '#b3b7ba' });
// coil-coated (painted) steel, anthracite: a dielectric paint layer, not bare metal
const trapezoidal = profiled(1000, 1.6, { profile: 'trapezoid', count: 5, width: 0.4, slope: 0.12, softness: 0.3 });
const standingSeamCopper = profiled(1000, 2, { profile: 'seam', count: 2, width: 0.03, slope: 0.1, softness: 0.6 }, [0.25, 0.4],
    { noiseType: 'fractal', scale: 4, detail: 5, stretch: 2, seed: 5, a: '#b06c48', b: '#c9845c' });

// riveted plate: rows of domed rivets on a plate with faint mill scale
const riveted = (() => {
    const g = graph({ size: 400, relief: 1 });
    const d = g.node('dots', { pattern: 'dots', shape: 'circle', stagger: 'none', count: 4, size: 0.2, bevel: 1, a: '#8d9093', b: '#9a9da0' });
    const n = g.node('noise', { noiseType: 'fractal', scale: 5, detail: 5, a: '#878a8d', b: '#9fa2a5' });
    const m = g.node('mix', {});
    g.link(n, 'color', m, 'a').link(d, 'color', m, 'b').link(d, 'value', m, 'factor');
    g.out(m, 'color', 'color').out(d, 'value', 'height');
    const r = g.node('remap', { from: 0.3, to: 0.48 });
    g.link(n, 'value', r, 'value').out(r, 'value', 'roughness');
    return g.done();
})();

const m = (libraryId, params, g) => ({ libraryId, category: 'metal', params: { metalness: 1, ...params }, graph: g });

export default [
    m('metal-stainless-brushed', { color: '#b8babc', roughness: 0.28 }, stainlessBrushed),
    m('metal-alu-brushed-lines', { color: '#c4c7ca', roughness: 0.3 }, aluBrushedLines),
    m('metal-brass-brushed', { color: '#c9a65f', roughness: 0.34 }, brassBrushed),
    m('metal-bronze-satin', { color: '#87684a', roughness: 0.37 }, bronzeSatin),
    m('metal-alu-anodized-bronze', { color: '#4e443a', roughness: 0.36 }, bronzeAnodized),
    m('metal-zinc-spangled', { color: '#a3a7aa', roughness: 0.36 }, zincSpangled),
    m('metal-copper-patina', { color: '#6a9e8a', roughness: 0.65 }, copperPatina),
    m('metal-steel-rusty', { color: '#7a4a30', roughness: 0.65 }, steelRusty),
    m('metal-steel-weathering', { color: '#6e351c', metalness: 0, roughness: 0.85 }, steelWeathering),
    m('metal-old-greasy', { color: '#646566', roughness: 0.5 }, metalGreasy),
    m('metal-hammered', { color: '#b6b9bd', roughness: 0.24 }, metalHammered),
    m('metal-copper-hammered', { color: '#cf8862', roughness: 0.24 }, copperHammered),
    m('metal-gold-leaf', { color: '#dcb35a', roughness: 0.24 }, goldLeaf),
    m('metal-perforated-round', { color: '#b8bcc0', roughness: 0.3 }, perfRound),
    m('metal-perforated-square', { color: '#b8bcc0', roughness: 0.3 }, perfSquare),
    m('metal-perforated-slot', { color: '#b8bcc0', roughness: 0.3 }, perfSlot),
    m('metal-expanded-mesh', { color: '#9a9c9e', roughness: 0.4 }, expanded),
    m('metal-tread-bars', { color: '#c0c4c8', roughness: 0.36 }, treadBars),
    m('metal-tread-diamond', { color: '#86898c', roughness: 0.45 }, treadDiamond),
    m('metal-corrugated-galvanized', { color: '#a9adb0', roughness: 0.36 }, corrugated),
    m('metal-trapezoidal-anthracite', { color: '#3d4145', metalness: 0, roughness: 0.45, clearcoat: 0.2, clearcoatRoughness: 0.35 }, trapezoidal),
    m('metal-standing-seam-copper', { color: '#c07a55', roughness: 0.32 }, standingSeamCopper),
    m('metal-riveted-plate', { color: '#94979a', roughness: 0.4 }, riveted),
];
