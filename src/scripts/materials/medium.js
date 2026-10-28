// Scattering media after OpenPBR (docs/material-format.md): the homogeneous medium inside a mesh, as coefficients per
// world unit (mm) for the path tracer's random walk (medium-walk.patch.wgsl, Vite plugin rindr-medium):
// - transmission_scatter: μ_t = −ln(transmission colour) / depth, μ_s = scatter / depth, μ_a = μ_t − μ_s, lifted so
//   that no channel goes negative – depth = the glass's absorption distance (RINDR attenuationDistance)
// - subsurface: μ_t = 1 / (radius × radius scale) per channel, single-scattering albedo from the observed colour by
//   the inverted van de Hulst approximation (both as in the OpenPBR specification)
// Returned as the path tracer's material fields: mediumScatter (μ_s), the absorption as attenuationColor over
// attenuationDistance (the library's own absorption fields). Colours linear (THREE.Color or { r, g, b }).

const CHANNELS = ['r', 'g', 'b'];

// OpenPBR subsurface_radius_scale default: red light travels farthest (skin, wax)
export const SUBSURFACE_RADIUS_SCALE = [1, 0.5, 0.25];

/** single-scattering albedo for an observed multiple-scattering colour c (0..1) and anisotropy g (OpenPBR) */
export function albedoFromColor(c, g = 0) {
    const C = Math.min(Math.max(c, 0), 1);
    const s = 4.09712 + 4.20863 * C - Math.sqrt(9.59217 + 41.6808 * C + 17.7126 * C * C);
    return Math.min(Math.max((1 - s * s) / (1 - g * s * s), 0), 1);
}

/** observed multiple-scattering colour of single-scattering albedo a (OpenPBR's forward van de Hulst relation) */
export function colorFromAlbedo(a, g = 0) {
    const s = Math.sqrt(Math.max(1 - a, 0) / Math.max(1 - a * g, 1e-6));
    return (1 - s) * (1 - 0.139 * s) / (1 + 1.17 * s);
}

function fields(scatter, absorption, distance) {
    return {
        mediumScatter: { r: scatter[0], g: scatter[1], b: scatter[2] },
        attenuationColor: { r: Math.exp(-absorption[0] * distance), g: Math.exp(-absorption[1] * distance), b: Math.exp(-absorption[2] * distance) },
        attenuationDistance: distance,
    };
}

/** OpenPBR transmission medium: transmission colour over depth (mm), scatter colour – null without a medium */
export function transmissionMedium(color, depth, scatter) {
    if (!(depth > 0) || !Number.isFinite(depth)) return null;
    const ms = CHANNELS.map(c => Math.max(scatter[c], 0) / depth);
    if (ms[0] + ms[1] + ms[2] <= 0) return null;
    const mt = CHANNELS.map(c => -Math.log(Math.max(color[c], 1e-6)) / depth);
    let ma = mt.map((v, i) => v - ms[i]);
    const low = Math.min(...ma);
    if (low < 0) ma = ma.map(v => v - low);
    return fields(ms, ma, depth);
}

/** OpenPBR subsurface medium: observed colour, radius = mean free path of red (mm), anisotropy g */
export function subsurfaceMedium(color, radius, g = 0) {
    const r = Math.max(radius, 1e-3);
    const mt = SUBSURFACE_RADIUS_SCALE.map(s => 1 / (r * s));
    const albedo = CHANNELS.map(c => albedoFromColor(color[c], g));
    return fields(mt.map((v, i) => v * albedo[i]), mt.map((v, i) => v * (1 - albedo[i])), r);
}
