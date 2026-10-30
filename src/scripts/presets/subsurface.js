// Library presets: subsurface scattering with a procedural structure (category 'subsurface' – the plain ones without
// a node graph are base presets in material-presets.js).
import { graph } from './graph.js';

// cloudy jade (user's references: a deep green polished jade, light glowing through, darker clouds, fine fibres, a few
// yellow-green patches; then raw emerald-green jade: fine dark cracks through the stone, crystalline chips of slightly
// different green, glossy): a scattering medium (HQ: light wanders a few mm inside, green survives) – the structure
// only tints the surface (the colour map is the glass lobe's tint): a transmission map instead made the cloudy parts
// milky white (the diffuse rest takes the base colour). Clouds (noise), hairlines (marble), coarse cracks (cellular
// chips, thin ragged borders) and fine hairline cells darken the tint, each chip a little lighter or darker (its
// random value); a second noise mixes in yellow-green where it is clear. Polish 0.1–0.2 (satin 0.2–0.32 looked dull
// next to the glossy stones of the references). Cracks drawn as a thick honeycomb read as snake skin – thin and
// ragged (spread 0.99, roughness 0.9) they read as cracks.
const jade = (() => {
    const g = graph({ size: 300, relief: 0 });
    const cloud = g.node('noise', { noiseType: 'fractal', scale: 4, detail: 6, low: 0.3, high: 0.72, seed: 3 });
    const fibres = g.node('marble', { mode: 'veins', scale: 3, veins: 4, width: 0.02, turbulence: 1.5, detail: 6, softness: 0.95, grain: 1, seed: 5, a: '#ffffff', b: '#000000', c: '#ffffff' });
    const clear = g.node('invert');
    g.link(fibres, 'value', clear, 'value');
    const fibreShare = g.node('remap', { from: 0.6, to: 1 });
    g.link(clear, 'value', fibreShare, 'value');
    const cloudShare = g.node('remap', { from: 0.3, to: 1 });
    g.link(cloud, 'value', cloudShare, 'value');
    const veined = g.node('math', { op: 'mul' });
    g.link(fibreShare, 'value', veined, 'a').link(cloudShare, 'value', veined, 'b');
    // cracks: the divisions (value low) keep 45 % / 70 % of the light
    const cracks = g.node('cellular', { mode: 'chips', scale: 2, spread: 0.99, smoothing: 0.01, roughness: 0.9, fractal: 3, variation: 0.3 });
    const crackShare = g.node('remap', { from: 0.45, to: 1 });
    g.link(cracks, 'value', crackShare, 'value');
    const cracked = g.node('math', { op: 'mul' });
    g.link(veined, 'value', cracked, 'a').link(crackShare, 'value', cracked, 'b');
    const hairlines = g.node('cellular', { mode: 'cells', scale: 6, spread: 0.993, smoothing: 0.02, roughness: 0.8, fractal: 2, variation: 0.2 });
    const hairShare = g.node('remap', { from: 0.7, to: 1 });
    g.link(hairlines, 'value', hairShare, 'value');
    const lined = g.node('math', { op: 'mul' });
    g.link(cracked, 'value', lined, 'a').link(hairShare, 'value', lined, 'b');
    const chipShade = g.node('remap', { from: 0.5, to: 1 });
    g.link(cracks, 'random', chipShade, 'value');
    const clarity = g.node('math', { op: 'mul' });
    g.link(lined, 'value', clarity, 'a').link(chipShade, 'value', clarity, 'b');
    const tint = g.node('ramp', { a: '#043a24', b: '#d8ffe8' });
    g.link(clarity, 'value', tint, 't');
    const patches = g.node('noise', { noiseType: 'fractal', scale: 2, detail: 5, low: 0.45, high: 0.9, seed: 11 });
    const yellow = g.node('math', { op: 'mul' });
    g.link(patches, 'value', yellow, 'a').link(clarity, 'value', yellow, 'b');
    const colour = g.node('mix', { b: '#f2f78a' });
    g.link(tint, 'color', colour, 'a').link(yellow, 'value', colour, 'factor');
    g.out(colour, 'color', 'color');
    const rough = g.node('remap', { from: 0.1, to: 0.2 });
    g.link(cloud, 'value', rough, 'value').out(rough, 'value', 'roughness');
    return g.done();
})();

export default [
    { libraryId: 'sss-jade-cloudy', category: 'subsurface', params: { color: '#ffffff', metalness: 0, roughness: 0.15, transmission: 1, ior: 1.62, thickness: 2, attenuationColor: '#14a86e', attenuationDistance: 9, transmissionScatter: '#ffffff' }, graph: jade },
];
