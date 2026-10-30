// Library presets: subsurface scattering with a procedural structure (category 'subsurface' – the plain ones without
// a node graph are base presets in material-presets.js).
import { graph } from './graph.js';

// cloudy jade (user's reference: a deep green polished jade, light glowing through, darker clouds, fine fibres, a few
// yellow-green patches): a scattering medium (HQ: light wanders a few mm inside, green survives) – the structure only
// tints the surface (the colour map is the glass lobe's tint): a transmission map instead made the cloudy parts milky
// white (the diffuse rest takes the base colour). Clouds (noise) and hairlines (marble, no crisp veins) darken the
// tint, a second noise mixes in yellow-green where it is clear; satin polish (roughness 0.2–0.32: sharper looked like
// green glass).
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
    const clarity = g.node('math', { op: 'mul' });
    g.link(fibreShare, 'value', clarity, 'a').link(cloudShare, 'value', clarity, 'b');
    const tint = g.node('ramp', { a: '#0b3a17', b: '#eefce6' });
    g.link(clarity, 'value', tint, 't');
    const patches = g.node('noise', { noiseType: 'fractal', scale: 2, detail: 5, low: 0.45, high: 0.9, seed: 11 });
    const yellow = g.node('math', { op: 'mul' });
    g.link(patches, 'value', yellow, 'a').link(clarity, 'value', yellow, 'b');
    const colour = g.node('mix', { b: '#f2f78a' });
    g.link(tint, 'color', colour, 'a').link(yellow, 'value', colour, 'factor');
    g.out(colour, 'color', 'color');
    const rough = g.node('remap', { from: 0.2, to: 0.32 });
    g.link(cloud, 'value', rough, 'value').out(rough, 'value', 'roughness');
    return g.done();
})();

export default [
    { libraryId: 'sss-jade-cloudy', category: 'subsurface', params: { color: '#ffffff', metalness: 0, roughness: 0.25, transmission: 1, ior: 1.62, thickness: 2, attenuationColor: '#2e8a48', attenuationDistance: 5, transmissionScatter: '#ffffff' }, graph: jade },
];
