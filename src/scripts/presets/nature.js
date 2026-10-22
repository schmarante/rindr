// Library presets: natural surfaces (fruit, vegetables …). All procedural – texture nodes baked into tileable maps;
// `size` = mm per tile.
import { graph } from './graph.js';

const P = (libraryId, params, g) => ({ libraryId, category: 'nature', params: { metalness: 0, ...params }, graph: g.done() });

// --- pumpkin skin: deep orange with broad, faint streaks along the ribs (v – upright on the box UVs' sides), soft
// mottling towards yellow, sparse pale pores; waxy half gloss. The ribs themselves are the model's geometry.
const pumpkin = graph({ size: 300, relief: 0 });
{
    const g = pumpkin;
    // broad streaks: noise stretched across u, turned 90° → runs along v; little contrast (box UV seams stay calm)
    const streaks = g.node('noise', { noiseType: 'fractal', scale: 2, detail: 3, stretch: 6, low: 0.2, high: 0.8, seed: 7, angle: 90,
        a: '#a33d04', b: '#c25207' });
    // mottling: soft blotches of a slightly lighter, yellower orange
    const mottle = g.node('noise', { noiseType: 'fractal', scale: 6, detail: 4, stretch: 1, low: 0.4, high: 0.95, seed: 21 });
    const amount = g.node('remap', { from: 0, to: 0.3 });
    g.link(mottle, 'value', amount, 'value');
    const tinted = g.node('mix', { b: '#d26b12' });
    g.link(streaks, 'color', tinted, 'a').link(amount, 'value', tinted, 'factor');
    // pores (lenticels): sparse, small, pale and flat
    const pores = g.node('speckle', { scale: 60, size: 0.15, density: 0.12, variation: 0.6, layers: 1, roundness: 0.6, elongation: 0.5,
        softness: 0.5, tone: 0.4, b: '#dd9445' });
    g.link(tinted, 'color', pores, 'a');
    g.out(pores, 'color', 'color');
    // no height: the skin is smooth, and a normal map showed the box UVs' seams as steps on the round body
    // waxy half gloss: slightly duller in the lighter blotches and on the pores
    const dull = g.node('math', { op: 'max' });
    g.link(amount, 'value', dull, 'a').link(pores, 'value', dull, 'b');
    const rough = g.node('remap', { from: 0.4, to: 0.62 });
    g.link(dull, 'value', rough, 'value');
    g.out(rough, 'value', 'roughness');
}

export default [
    P('nature-pumpkin', { color: '#b84a06', roughness: 0.45, clearcoat: 0.2, clearcoatRoughness: 0.35 }, pumpkin),
];
