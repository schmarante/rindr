// Library presets: car paint (category 'paint') – a clear coat over the base; docs/materials.md (speckle flake normal,
// scratches node) and docs/material-library.md (the recipes from the old library's paints).
import { graph } from './graph.js';

// swirl marks ("holograms"): fine straight micro scratches in the clear coat, smooth along and rough across
// (coat anisotropy 1 on every scratch, its direction across them) – only the tiny spot of each scratch that lies
// across the line to a light reflects it; thousands form the round rings around every highlight. Real size:
// 32 mm tile, 50 cells → scratches of ~3 mm; baked at 4096 so they stay finer than the reflections around them.
const swirl = (() => {
    const g = graph({ size: 32, relief: 0 });
    const s = g.node('scratches', { scale: 50, density: 1, layers: 8, length: 5, thickness: 0.002, variation: 0.4 });
    const strength = g.node('math', { op: 'mul', a: 0, b: 4 });          // full strength on every scratch
    const rough = g.node('remap', { from: 0.03, to: 0.5 });              // the coat across a scratch
    g.link(s, 'value', strength, 'a').out(strength, 'value', 'coatAnisotropy')
        .out(s, 'direction', 'coatAnisotropyDirection')
        .link(s, 'value', rough, 'value').out(rough, 'value', 'clearcoatRoughness');
    const done = g.done();
    done.nodes[0].params.resolution = '4096';
    return done;
})();

// metallic flakes: glitter under the clear coat – dense fine flakes (~0.19 mm), each a slightly glossy tilted mirror
// of varying brightness (speckle flake normal); together they make the metallic sheen, only the ones facing a light
// sparkle (single bright flakes on a rough base looked like snow)
const flakes = (() => {
    const g = graph({ size: 51, relief: 0 });
    const f = g.node('speckle', { scale: 200, size: 0.75, density: 0.8, variation: 0.3, layers: 1, roundness: 0, elongation: 0.2,
        softness: 0, tone: 0.7, tilt: 0.35, a: '#0a1a5a', b: '#2a4ab8' });
    const metal = g.node('remap', { from: 0.6, to: 1 });
    const rough = g.node('remap', { from: 0.4, to: 0.12 });
    g.out(f, 'color', 'color').out(f, 'normal', 'normal')
        .link(f, 'value', metal, 'value').out(metal, 'value', 'metalness')
        .link(f, 'value', rough, 'value').out(rough, 'value', 'roughness');
    const done = g.done();
    done.nodes[0].params.resolution = '2048';
    return done;
})();

export default [
    { libraryId: 'paint-car-swirl-black', category: 'paint', params: { color: '#060606', metalness: 0, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 }, graph: swirl },
    { libraryId: 'paint-car-flakes-blue', category: 'paint', params: { color: '#0a1a5a', metalness: 0.6, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 }, graph: flakes },
];
