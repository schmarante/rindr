// Library presets: fabric & carpet (category 'fabric') and textured / special plastics (category 'plastic').
// Woven cloth and carpet pile come from the weave node, ribs and stripes from waves, leather grain and foam from
// cellular, studs and netting from dots. Plain gloss / matte plastic colours live in material-presets.js.
// Sizes are real-world: one baked tile = `size` mm on the model (see presets/graph.js).
import { graph } from './graph.js';

// --- woven fabric (weave node: warp a along v, weft b along u) ---

/** a plain weave preset: weave colour + height, optional roughness spread from the height */
function woven({ size, relief, weave, rough }) {
    const g = graph({ size, relief });
    const w = g.node('weave', weave);
    g.out(w, 'color', 'color').out(w, 'value', 'height');
    if (rough) {
        const r = g.node('remap', { from: rough[0], to: rough[1] });
        g.link(w, 'value', r, 'value').out(r, 'value', 'roughness');
    }
    return g.done();
}

const linen = woven({
    size: 40, relief: 0.45, rough: [0.95, 0.85],
    weave: { pattern: 'plain', count: 48, gap: 0.12, fuzz: 0.55, variation: 0.6, a: '#cdbf9f', b: '#c2b391' },
});

// heavy cotton canvas: dense plain weave of even yarn
const canvas = woven({
    size: 40, relief: 0.4, rough: [0.95, 0.85],
    weave: { pattern: 'plain', count: 40, gap: 0.05, fuzz: 0.35, variation: 0.2, a: '#a9a8a2', b: '#9a9993' },
});

const denim = woven({
    size: 30, relief: 0.45, rough: [0.95, 0.8],
    weave: { pattern: 'denim', count: 96, gap: 0.03, fuzz: 0.5, variation: 0.5, a: '#27406e', b: '#aab4c4' },
});

const woolTwill = woven({
    size: 40, relief: 0.4, rough: [1, 0.9],
    weave: { pattern: 'twill', count: 64, gap: 0.05, fuzz: 0.8, variation: 0.35, a: '#5e5e5e', b: '#8e8e8b' },
});

const herringbone = woven({
    size: 50, relief: 0.5, rough: [1, 0.9],
    weave: { pattern: 'herringbone', count: 48, gap: 0.05, fuzz: 0.7, variation: 0.3, a: '#3e3a36', b: '#a39e94' },
});

const satin = woven({
    size: 20, relief: 0.1, rough: [0.3, 0.22],
    weave: { pattern: 'satin', count: 100, gap: 0.02, fuzz: 0.05, variation: 0.1, a: '#7a1a2a', b: '#701626' },
});

// chenille: thick, very fuzzy yarn
const chenille = woven({
    size: 40, relief: 0.35, rough: [1, 0.9],
    weave: { pattern: 'plain', count: 20, gap: 0.04, fuzz: 1, variation: 0.5, a: '#123f6e', b: '#0d335c' },
});

// burlap / hessian: coarse jute, open plain weave, irregular yarn
const burlap = woven({
    size: 60, relief: 0.4, rough: [1, 0.92],
    weave: { pattern: 'plain', count: 24, gap: 0.25, fuzz: 0.9, variation: 0.8, a: '#8a7048', b: '#7d6440' },
});

// sisal floor covering: coarse natural fibre in 2×2 basket weave
const sisal = woven({
    size: 100, relief: 0.7, rough: [1, 0.9],
    weave: { pattern: 'basket', count: 32, gap: 0.1, fuzz: 0.7, variation: 0.6, a: '#b39869', b: '#aa8f60' },
});

// tweed: twill with coloured flecks in the warp (speckle → warp colour)
const tweed = (() => {
    const g = graph({ size: 40, relief: 0.4 });
    const fleck = g.node('speckle', {
        scale: 20, size: 0.6, density: 0.4, variation: 0.6, layers: 1, roundness: 0.8, elongation: 0.8, softness: 0.3,
        tone: 0.5, a: '#5b5048', b: '#c9823a',
    });
    const fleck2 = g.node('speckle', {
        scale: 26, size: 0.5, density: 0.3, variation: 0.6, layers: 1, roundness: 0.8, elongation: 0.8, softness: 0.3,
        tone: 0.5, b: '#4f8a86',
    });
    const w = g.node('weave', { pattern: 'twill', count: 56, gap: 0.05, fuzz: 0.85, variation: 0.45, b: '#4a453f' });
    g.link(fleck, 'color', fleck2, 'a').link(fleck2, 'color', w, 'a');
    g.out(w, 'color', 'color').out(w, 'value', 'height');
    return g.done();
})();

// stripes: warp in two colours (waves along u), plain weft – like woven ticking
const stripes = (() => {
    const g = graph({ size: 80, relief: 0.3 });
    const s = g.node('waves', { profile: 'square', count: 5, axis: 'u', width: 0.35, slope: 0, softness: 0.1, a: '#e8e3d6', b: '#102f68' });
    const w = g.node('weave', { pattern: 'plain', count: 140, gap: 0.04, fuzz: 0.4, variation: 0.25, b: '#e4dfd2' });
    g.link(s, 'color', w, 'a');
    g.out(w, 'color', 'color').out(w, 'value', 'height');
    return g.done();
})();

// plaid / check: the same stripe sequence in warp (u) and weft (v) – broad blocks, a red line in the dark blocks
// and a thin yellow line at the block edges; twill weave
const plaid = (() => {
    const g = graph({ size: 120, relief: 0.3 });
    const set = axis => {
        const blocks = g.node('waves', { profile: 'square', count: 4, axis, width: 0.5, slope: 0, softness: 0.1, a: '#1d3b2c', b: '#1f2c4c' });
        const line = g.node('waves', { profile: 'square', count: 4, axis, width: 0.1, slope: 0, softness: 0.1, b: '#a8232b' });
        const fine = g.node('waves', { profile: 'square', count: 8, axis, width: 0.04, slope: 0, softness: 0.1, b: '#d8b84a' });
        g.link(blocks, 'color', line, 'a').link(line, 'color', fine, 'a');
        return fine;
    };
    const warp = set('u'), weft = set('v');
    const w = g.node('weave', { pattern: 'twill', count: 160, gap: 0.04, fuzz: 0.6, variation: 0.25 });
    g.link(warp, 'color', w, 'a').link(weft, 'color', w, 'b');
    g.out(w, 'color', 'color').out(w, 'value', 'height');
    return g.done();
})();

// corduroy: rounded wales (waves) covered with fine cut pile, dark in the grooves
const corduroy = (() => {
    const g = graph({ size: 40, relief: 0.6 });
    const wale = g.node('waves', { profile: 'square', count: 12, axis: 'u', width: 0.8, slope: 0, softness: 0.9 });
    const pile = g.node('weave', { pattern: 'cut', count: 96, gap: 0.1, fuzz: 0.8, variation: 0.3, a: '#6b4a2e', b: '#5e3f26' });
    const shade = g.node('mix', { a: '#24180e' });
    g.link(pile, 'color', shade, 'b').link(wale, 'value', shade, 'factor');
    const hw = g.node('math', { op: 'mul', b: 0.75 });
    const hp = g.node('math', { op: 'mul', b: 0.25 });
    const h = g.node('math', { op: 'add' });
    g.link(wale, 'value', hw, 'a').link(pile, 'value', hp, 'a').link(hw, 'value', h, 'a').link(hp, 'value', h, 'b');
    g.out(shade, 'color', 'color').out(h, 'value', 'height');
    return g.done();
})();

// velvet: dense, short cut pile; the look comes from the sheen
const velvet = woven({
    size: 30, relief: 0.15,
    weave: { pattern: 'cut', count: 120, gap: 0.05, fuzz: 0.9, variation: 0.2, a: '#5a0f18', b: '#4c0b13' },
});

// --- leather ---

/** leather grain: cellular cells → height, colour mottled by noise and darker in the creases */
function leather({ size, relief, cells, mottle, crease, rough }) {
    const g = graph({ size, relief });
    const c = g.node('cellular', { mode: 'cells', ...cells });
    const n = g.node('noise', { noiseType: 'fractal', scale: 4, detail: 4, ...mottle });
    const col = g.node('mix', { a: crease });
    g.link(n, 'color', col, 'b').link(c, 'value', col, 'factor');
    const r = g.node('remap', { from: rough[0], to: rough[1] });
    g.link(c, 'value', r, 'value');
    g.out(col, 'color', 'color').out(c, 'value', 'height').out(r, 'value', 'roughness');
    return g.done();
}

const leatherSmooth = leather({
    size: 60, relief: 0.08, crease: '#3a2214', rough: [0.6, 0.42],
    cells: { scale: 70, spread: 0.97, smoothing: 0.9, roughness: 0.6, fractal: 1, variation: 0.1, a: '#ffffff', b: '#bbbbbb' },
    mottle: { a: '#5a3520', b: '#7a4a2c' },
});

const leatherPebbled = leather({
    size: 60, relief: 0.6, crease: '#0b0b0b', rough: [0.75, 0.5],
    cells: { scale: 26, spread: 0.85, smoothing: 0.55, roughness: 0.55, fractal: 2, variation: 0.3, a: '#ffffff', b: '#888888' },
    mottle: { a: '#1b1a19', b: '#2a2826' },
});

// patent leather: mirror lacquer over a gently undulating surface
const leatherPatent = (() => {
    const g = graph({ size: 200, relief: 0.08 });
    const n = g.node('noise', { noiseType: 'fractal', scale: 3, detail: 3 });
    g.out(n, 'value', 'height');
    return g.done();
})();

// --- openwork: alpha cutouts ---

// tulle / netting: staggered round holes → thin hexagonal net
const netting = (() => {
    const g = graph({ size: 25, relief: 0.3 });
    const d = g.node('dots', { pattern: 'perforated', shape: 'circle', stagger: 'half', count: 10, size: 0.84, bevel: 0.6, a: '#202020', b: '#e9e6df' });
    g.out(d, 'color', 'color').out(d, 'value', 'alpha').out(d, 'value', 'height');
    return g.done();
})();

// cane webbing: flat glossy strands in an open plain weave; the square openings between the strands are cut out
// (two square waves on the thread centres, max = strand)
const cane = (() => {
    const g = graph({ size: 80, relief: 0.5 });
    const n = 10, width = 0.55;
    const w = g.node('weave', { pattern: 'plain', count: n, gap: 0.4, fuzz: 0.05, variation: 0.25, a: '#d8bf86', b: '#cdb27a' });
    const su = g.node('waves', { profile: 'square', count: n, axis: 'u', width, slope: 0, softness: 0 });
    const sv = g.node('waves', { profile: 'square', count: n, axis: 'v', width, slope: 0, softness: 0 });
    const a = g.node('math', { op: 'max' });
    g.link(su, 'value', a, 'a').link(sv, 'value', a, 'b');
    g.out(w, 'color', 'color').out(w, 'value', 'height').out(a, 'value', 'alpha');
    return g.done();
})();

// --- carpet ---

const berber = woven({
    size: 100, relief: 1, rough: [1, 0.9],
    weave: { pattern: 'loop', count: 24, gap: 0.05, fuzz: 0.5, variation: 0.4, a: '#d2c4a6', b: '#b3a27e' },
});

const velour = woven({
    size: 100, relief: 0.7,
    weave: { pattern: 'cut', count: 64, gap: 0.1, fuzz: 0.7, variation: 0.4, a: '#3b4f78', b: '#33456a' },
});

// needle punch (needle felt): matted fibres, no structure but fine turbulence
const needlePunch = (() => {
    const g = graph({ size: 100, relief: 0.3 });
    const n = g.node('noise', { noiseType: 'turbulence', scale: 90, detail: 4, a: '#3a3937', b: '#5d5b57' });
    const f = g.node('speckle', { scale: 120, size: 0.3, density: 0.5, variation: 0.6, layers: 2, roundness: 0.3, elongation: 0.9, softness: 0.2, tone: 0.4, b: '#7a776f' });
    g.link(n, 'color', f, 'a');
    g.out(f, 'color', 'color').out(n, 'value', 'height');
    return g.done();
})();

// --- plastics ---

// carbon fibre: 2/2 twill of flat tows under clear lacquer; warp and weft catch the light differently
const carbon = (() => {
    const g = graph({ size: 50, relief: 0.25 });
    const w = g.node('weave', { pattern: 'twill', count: 24, gap: 0.02, fuzz: 0.12, variation: 0.05, a: '#121213', b: '#323236' });
    const r = g.node('remap', { from: 0.55, to: 0.18 });
    g.link(w, 'mask', r, 'value');
    g.out(w, 'color', 'color').out(w, 'value', 'height').out(r, 'value', 'roughness');
    return g.done();
})();

// grained plastic (dashboard, housings): fine leather-like stipple
const grained = (() => {
    const g = graph({ size: 40, relief: 0.3 });
    const c = g.node('cellular', { mode: 'cells', scale: 40, spread: 0.9, smoothing: 0.7, roughness: 0.5, fractal: 2, variation: 0.2, a: '#ffffff', b: '#999999' });
    const r = g.node('remap', { from: 0.75, to: 0.55 });
    g.link(c, 'value', r, 'value');
    g.out(c, 'value', 'height').out(r, 'value', 'roughness');
    return g.done();
})();

// high-pressure laminate: two-tone fine speckle, faint orange-peel surface
const laminate = (() => {
    const g = graph({ size: 100, relief: 0.08 });
    const s = g.node('speckle', { scale: 80, size: 0.45, density: 0.55, variation: 0.7, layers: 2, roundness: 0.6, elongation: 0.2, softness: 0.3, tone: 0.3, a: '#c9c6bf', b: '#77736c' });
    const n = g.node('noise', { noiseType: 'fractal', scale: 40, detail: 3 });
    g.out(s, 'color', 'color').out(n, 'value', 'height');
    return g.done();
})();

// neoprene / textured rubber: matte with fine pores
const neoprene = (() => {
    const g = graph({ size: 30, relief: 0.3 });
    const d = g.node('dent', { scale: 40, size: 0.45, density: 0.5, strength: 0.6, detail: 2, distort: 0.5, a: '#151515', b: '#2b2b2b' });
    g.out(d, 'color', 'color').out(d, 'value', 'height');
    return g.done();
})();

// studded rubber floor: round studs on a square grid
const studded = (() => {
    const g = graph({ size: 400, relief: 1 });
    const d = g.node('dots', { pattern: 'dots', shape: 'circle', stagger: 'none', count: 8, size: 0.55, bevel: 0.5, a: '#242424', b: '#2a2a2a' });
    g.out(d, 'color', 'color').out(d, 'value', 'height');
    return g.done();
})();

// expanded polystyrene: fused beads
const polystyrene = (() => {
    const g = graph({ size: 100, relief: 0.6 });
    const c = g.node('cellular', { mode: 'cells', scale: 24, spread: 0.94, smoothing: 0.6, roughness: 0.3, fractal: 1, variation: 0.15, a: '#f3f3ef', b: '#d6d6d0' });
    g.out(c, 'color', 'color').out(c, 'value', 'height');
    return g.done();
})();

// foam rubber (open-cell sponge): dense pores
const foam = (() => {
    const g = graph({ size: 40, relief: 0.6 });
    const d = g.node('dent', { scale: 30, size: 0.75, density: 0.95, strength: 1, detail: 2, distort: 0.6, a: '#8f7a3e', b: '#e0c87e' });
    g.out(d, 'color', 'color').out(d, 'value', 'height');
    return g.done();
})();

const cloth = { metalness: 0, specularIntensity: 0.5 };

export default [
    // --- fabric ---
    { libraryId: 'fabric-linen', category: 'fabric', params: { color: '#c8ba9a', ...cloth, roughness: 0.9 }, graph: linen },
    { libraryId: 'fabric-canvas', category: 'fabric', params: { color: '#a3a29c', ...cloth, roughness: 0.9 }, graph: canvas },
    { libraryId: 'fabric-denim', category: 'fabric', params: { color: '#3a5078', ...cloth, roughness: 0.9 }, graph: denim },
    { libraryId: 'fabric-wool-twill', category: 'fabric', params: { color: '#727270', ...cloth, roughness: 0.95, sheen: 0.4, sheenColor: '#bdbdb8', sheenRoughness: 0.7 }, graph: woolTwill },
    { libraryId: 'fabric-herringbone', category: 'fabric', params: { color: '#6d6862', ...cloth, roughness: 0.95, sheen: 0.4, sheenColor: '#b5afa5', sheenRoughness: 0.7 }, graph: herringbone },
    { libraryId: 'fabric-tweed', category: 'fabric', params: { color: '#55493f', ...cloth, roughness: 0.95, sheen: 0.4, sheenColor: '#a89a88', sheenRoughness: 0.7 }, graph: tweed },
    { libraryId: 'fabric-satin', category: 'fabric', params: { color: '#761828', metalness: 0, roughness: 0.26 }, graph: satin },
    { libraryId: 'fabric-velvet', category: 'fabric', params: { color: '#550e17', metalness: 0, roughness: 0.9, specularIntensity: 0.3, sheen: 1, sheenColor: '#e0606f', sheenRoughness: 0.35 }, graph: velvet },
    { libraryId: 'fabric-corduroy', category: 'fabric', params: { color: '#5e4128', ...cloth, roughness: 0.9, sheen: 0.8, sheenColor: '#c49a72', sheenRoughness: 0.4 }, graph: corduroy },
    { libraryId: 'fabric-chenille', category: 'fabric', params: { color: '#103a66', ...cloth, roughness: 0.95, sheen: 0.7, sheenColor: '#6f9fd8', sheenRoughness: 0.45 }, graph: chenille },
    { libraryId: 'fabric-burlap', category: 'fabric', params: { color: '#836a44', ...cloth, roughness: 0.95 }, graph: burlap },
    { libraryId: 'fabric-plaid', category: 'fabric', params: { color: '#24334a', ...cloth, roughness: 0.92, sheen: 0.3, sheenColor: '#9aa6b8', sheenRoughness: 0.7 }, graph: plaid },
    { libraryId: 'fabric-stripes', category: 'fabric', params: { color: '#a9b4c4', ...cloth, roughness: 0.9 }, graph: stripes },
    { libraryId: 'fabric-netting', category: 'fabric', params: { color: '#e9e6df', ...cloth, roughness: 0.85 }, graph: netting },
    { libraryId: 'fabric-cane', category: 'fabric', params: { color: '#d4ba80', metalness: 0, roughness: 0.45 }, graph: cane },
    { libraryId: 'leather-smooth', category: 'fabric', params: { color: '#6a3f25', metalness: 0, roughness: 0.5, sheen: 0.3, sheenColor: '#b08060', sheenRoughness: 0.5 }, graph: leatherSmooth },
    { libraryId: 'leather-pebbled', category: 'fabric', params: { color: '#222120', metalness: 0, roughness: 0.6, sheen: 0.25, sheenColor: '#606060', sheenRoughness: 0.5 }, graph: leatherPebbled },
    { libraryId: 'leather-patent', category: 'fabric', params: { color: '#0c0c0d', metalness: 0, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03 }, graph: leatherPatent },
    { libraryId: 'carpet-berber', category: 'fabric', params: { color: '#c6b791', ...cloth, roughness: 0.95 }, graph: berber },
    { libraryId: 'carpet-velour', category: 'fabric', params: { color: '#374a70', ...cloth, roughness: 0.95, sheen: 0.6, sheenColor: '#8ea4d0', sheenRoughness: 0.5 }, graph: velour },
    { libraryId: 'carpet-needle-punch', category: 'fabric', params: { color: '#4a4946', ...cloth, roughness: 1 }, graph: needlePunch },
    { libraryId: 'carpet-sisal', category: 'fabric', params: { color: '#b09466', ...cloth, roughness: 0.95 }, graph: sisal },

    // --- plastic ---
    { libraryId: 'plastic-carbon', category: 'plastic', params: { color: '#222224', metalness: 0, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.02 }, graph: carbon },
    { libraryId: 'plastic-grained', category: 'plastic', params: { color: '#2c2d2f', metalness: 0, roughness: 0.65 }, graph: grained },
    { libraryId: 'plastic-laminate', category: 'plastic', params: { color: '#bcb8b0', metalness: 0, roughness: 0.38 }, graph: laminate },
    { libraryId: 'rubber-neoprene', category: 'plastic', params: { color: '#232323', metalness: 0, roughness: 0.85, sheen: 0.3, sheenColor: '#3d3d3d', sheenRoughness: 0.8 }, graph: neoprene },
    { libraryId: 'rubber-studded', category: 'plastic', params: { color: '#262626', metalness: 0, roughness: 0.75 }, graph: studded },
    { libraryId: 'foam-polystyrene', category: 'plastic', params: { color: '#ebebe6', metalness: 0, roughness: 0.85 }, graph: polystyrene },
    { libraryId: 'foam-rubber', category: 'plastic', params: { color: '#d4bc72', metalness: 0, roughness: 1 }, graph: foam },
];
