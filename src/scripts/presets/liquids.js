// Library presets: liquids and food (docs/material-library.md). Clear and cloudy ones are glass with an OpenPBR medium
// (transmission colour over its depth, haze = transmission_scatter – a random walk in HQ, materials/medium.js); opaque
// ones (milk, yoghurt, creamy honey) subsurface scattering, chocolate and ketchup plain glossy. Pieces (fruit pulp, jam chunks, seeds) as speckles in the colour
// map – it tints the light passing the surface; the medium itself is even. Distances in mm, `size` = mm per tile.
import { graph } from './graph.js';

const P = (libraryId, params, g) => ({ libraryId, category: 'liquid', params: { metalness: 0, ...params }, ...(g ? { graph: g.done() } : {}) });
// smooth liquid surface, a volume (not a thin wall)
const LIQUID = { color: '#ffffff', roughness: 0.02, transmission: 1, ior: 1.34, thickness: 2 };

// --- orange juice with pulp: elongated light pulp sacs over the juice
const pulp = graph({ size: 40, relief: 0 });
{
    const g = pulp;
    const sacs = g.node('speckle', { scale: 14, size: 0.45, density: 0.45, variation: 0.7, layers: 2, roundness: 0.5, elongation: 0.75,
        softness: 0.55, tone: 0.5, a: '#ffffff', b: '#ffd37e' });
    g.out(sacs, 'color', 'color');
}

// --- jam: soft chunks of fruit, small seeds (strawberry)
function jam({ chunk, seed }) {
    const g = graph({ size: 50, relief: 0 });
    const chunks = g.node('speckle', { scale: 6, size: 0.6, density: 0.4, variation: 0.8, layers: 2, roundness: 0.35, elongation: 0.3,
        softness: 0.6, tone: 0.6, a: '#ffffff', b: chunk });
    let top = chunks;
    if (seed) {
        top = g.node('speckle', { scale: 40, size: 0.12, density: 0.12, variation: 0.4, layers: 1, roundness: 0.7, elongation: 0.4,
            softness: 0.2, tone: 0.3, b: seed });
        g.link(chunks, 'color', top, 'a');
    }
    g.out(top, 'color', 'color');
    return g;
}

// --- wheat beer with a head of foam (user's reference photo: deep golden orange, translucent, a white head of very fine
// bubbles with a hard edge): a band at the top of the model – gradient once over the object along V (V must run upwards
// on the model, e.g. mapping per object "cylinder"); the foam takes the light at the surface (transmission 0), fine
// cells as relief. Below it the beer: the colour from absorption over the thickness (yellow at thin edges, orange in the
// middle), a light haze of yeast – a strong haze looked opaque, a clear lager watery
const head = graph({ size: 30, relief: 0.3 });
{
    const g = head;
    const foam = g.node('gradient', { axis: 'v', extent: 'object', from: 0.785, to: 0.79 });
    const color = g.node('ramp', { a: '#ffffff', b: '#f8f4ea' });
    g.link(foam, 'value', color, 't');
    g.out(color, 'color', 'color');
    const through = g.node('invert');
    g.link(foam, 'value', through, 'value');
    g.out(through, 'value', 'transmission');
    const rough = g.node('remap', { from: 0.02, to: 0.6 });
    g.link(foam, 'value', rough, 'value');
    g.out(rough, 'value', 'roughness');
    // relief: very fine foam cells, only in the foam
    const cells = g.node('speckle', { scale: 60, size: 0.95, density: 1, variation: 0.5, layers: 2, roundness: 1, elongation: 0,
        softness: 0.6, tone: 0 });
    const relief = g.node('math', { op: 'mul' });
    g.link(cells, 'value', relief, 'a').link(foam, 'value', relief, 'b');
    g.out(relief, 'value', 'height');
}

export default [
    // water: a faint blue-green over long distances
    P('liquid-water', { ...LIQUID, ior: 1.333, attenuationColor: '#e3f2f5', attenuationDistance: 100 }),
    // orange juice: cloudy orange – the colour from the haze alone (white tint: OpenPBR absorbs what the haze colour
    // lacks; scatter albedo from the observed colour by the van de Hulst relation). A strong tint instead turned the
    // juice red over a few centimetres. Cloudy apple juice and quince jam likewise
    P('liquid-orange-juice', { ...LIQUID, ior: 1.35, attenuationDistance: 3, transmissionScatter: '#ffe646' }),
    P('liquid-orange-juice-pulp', { ...LIQUID, ior: 1.35, attenuationDistance: 2, transmissionScatter: '#ffe646' }, pulp),
    P('liquid-apple-juice', { ...LIQUID, ior: 1.35, attenuationColor: '#e8b04a', attenuationDistance: 60 }),
    P('liquid-apple-juice-cloudy', { ...LIQUID, ior: 1.35, attenuationDistance: 12, transmissionScatter: '#fee065' }),
    P('liquid-milk', { color: '#f5f3ec', roughness: 0.05, ior: 1.35, thickness: 1, subsurface: 1, subsurfaceColor: '#f4f1e6', subsurfaceRadius: 2 }),
    P('liquid-yoghurt', { color: '#f6f4ec', roughness: 0.35, ior: 1.35, thickness: 1, subsurface: 1, subsurfaceColor: '#f5f2e8', subsurfaceRadius: 1.5 }),
    // honey: clear, deep amber; rapeseed honey: set (crystallised) – pale, creamy, opaque
    P('liquid-honey', { ...LIQUID, ior: 1.49, attenuationColor: '#e8941c', attenuationDistance: 25, transmissionScatter: '#1e1408' }),
    P('liquid-honey-rapeseed', { color: '#f3e2b0', roughness: 0.3, ior: 1.49, thickness: 1, subsurface: 1, subsurfaceColor: '#f0d890', subsurfaceRadius: 3 }),
    P('liquid-maple-syrup', { ...LIQUID, ior: 1.48, attenuationColor: '#d07a24', attenuationDistance: 25 }),
    // jams: dense, slightly hazy, half gloss; chunks of fruit (strawberry with seeds)
    P('liquid-jam-strawberry', { ...LIQUID, roughness: 0.12, ior: 1.45, attenuationColor: '#d02232', attenuationDistance: 5, transmissionScatter: '#902030' },
        jam({ chunk: '#b02434', seed: '#e0bc6a' })),
    P('liquid-jam-cherry', { ...LIQUID, roughness: 0.12, ior: 1.45, attenuationColor: '#741020', attenuationDistance: 3, transmissionScatter: '#3c060e' },
        jam({ chunk: '#5c0c1c' })),
    P('liquid-jam-quince', { ...LIQUID, roughness: 0.1, ior: 1.45, attenuationDistance: 6, transmissionScatter: '#feca5e' }),
    P('liquid-red-wine', { ...LIQUID, ior: 1.34, attenuationColor: '#7a1424', attenuationDistance: 15 }),
    P('liquid-white-wine', { ...LIQUID, ior: 1.34, attenuationColor: '#efe2a0', attenuationDistance: 120 }),
    P('liquid-beer', { ...LIQUID, ior: 1.34, attenuationColor: '#f2bc40', attenuationDistance: 90 }),
    P('liquid-wheat-beer', { ...LIQUID, ior: 1.34, attenuationColor: '#a39508', attenuationDistance: 5, transmissionScatter: '#ffffff' }, head),
    P('liquid-coffee', { ...LIQUID, ior: 1.34, attenuationColor: '#3c1e0a', attenuationDistance: 3 }),
    P('liquid-tea', { ...LIQUID, ior: 1.34, attenuationColor: '#bc5e22', attenuationDistance: 30 }),
    P('liquid-olive-oil', { ...LIQUID, ior: 1.47, attenuationColor: '#cfc24a', attenuationDistance: 60 }),
    // melted chocolate, ketchup: opaque, wet gloss (as subsurface the raster's approximation turned them beige / pink)
    P('liquid-chocolate', { color: '#3e1c0e', roughness: 0.1, ior: 1.5 }),
    P('liquid-ketchup', { color: '#a8160e', roughness: 0.08, ior: 1.4 }),
];
