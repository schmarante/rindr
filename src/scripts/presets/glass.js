// Library presets: glass with dispersion (Nov. 2026, user: rainbow fringes inside the glass like in a reference
// render). Dispersion = OpenPBR scale × 20 / Abbe number (material-manager.js); HQ traces one wavelength per path,
// so the fringes need many samples – and thick glass with several reflections inside (pathtracer.js raises the
// refraction bounces for dispersive glass). Lead crystal is real (Abbe ~32); the fringed glass exaggerates (Abbe 4 ≈
// five times a dense flint glass – what the reference shows); the flake glass breaks the light at every flake like a
// small prism.
import { graph } from './graph.js';

const GLASS = { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, thickness: 2 };
const P = (libraryId, params, g) => ({ libraryId, category: 'glass', params: { ...GLASS, ...params }, ...(g ? { graph: g } : {}) });

// --- glass with flakes: the flake normal (flake2d) on the glass – fine flakes need the finer bake
const flakes = graph({ size: 50, relief: 1 });
flakes.out(flakes.node('flakes', { size: 0.02, roughness: 0.35, coverage: 0.6 }), 'normal', 'normal');
const flakeGraph = flakes.done();
flakeGraph.nodes.find(n => n.type === 'output').params.resolution = '2048';

export default [
    P('glass-crystal', { ior: 1.56, dispersion: 1, dispersionAbbe: 32 }),
    P('glass-rainbow', { ior: 1.5, dispersion: 1, dispersionAbbe: 4 }),
    P('glass-flakes', { ior: 1.5, dispersion: 1, dispersionAbbe: 6 }, flakeGraph),
];
