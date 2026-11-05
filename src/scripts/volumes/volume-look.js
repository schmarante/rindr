// The look of a grid volume (grid-volumes.js): what the Properties panel edits on top of what the import delivered.
// volume.base = the medium as imported { sigma (σt per mm at the grid's maximum), albedo (linear RGB), g, emission
// (table over the stored temperature, pbrt) | blackbody + temperature (dropped VDB files: the flame colour from the
// temperature grid) }; volume.look = { density (factor), color (sRGB hex | null = imported), anisotropy (null =
// imported), emission (factor), temperature (K at the grid's maximum | null = imported) }. applyLook() derives the
// values the volume walk reads: sigma, albedo, g, emission. Lazily loaded (import, panel).
import { Color } from 'three/webgpu';
import { blackbodyRgb } from '../pbrt/pbrt-spectrum.js';
import { GRID_EMISSION_STEPS } from './grid-volumes.js';

const luminance = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// the medium emits σa · Le per unit length; σa = σt · (1 − albedo) – divided out so that a smoke colour near white does
// not switch the flame off (kept from 1 / 0 by this floor)
const ABSORPTION_FLOOR = 0.05;
const MIN_GLOW_K = 400;   // below: no visible glow worth a table entry

export const DEFAULT_LOOK = { density: 1, color: null, anisotropy: null, emission: 1, temperature: null };

/** linear RGB → sRGB hex (colour field) */
export const hexOfLinear = c => '#' + new Color().setRGB(c[0], c[1], c[2]).getHexString();
/** sRGB hex → linear RGB */
export const linearOfHex = hex => { const c = new Color(hex); return [c.r, c.g, c.b]; };

/** the values in effect (panel): imported ones where the look keeps them */
export function effectiveLook(volume) {
    const b = volume.base, l = volume.look;
    return {
        density: l.density,
        color: l.color ?? hexOfLinear(b.albedo),
        anisotropy: l.anisotropy ?? b.g,
        emission: l.emission,
        temperature: l.temperature ?? b.temperature ?? null,
        emissive: !!(b.emission || (b.blackbody && volume.temperature)),
        blackbody: !!(b.blackbody && volume.temperature),
    };
}

/** volume.look → volume.sigma / albedo / g / emission (the volume walk's medium) */
export function applyLook(volume) {
    const b = volume.base, l = volume.look;
    volume.sigma = b.sigma * Math.max(l.density, 0);
    volume.albedo = l.color ? linearOfHex(l.color) : b.albedo.slice();
    volume.g = Math.min(Math.max(l.anisotropy ?? b.g, -0.95), 0.95);
    if (b.blackbody && volume.temperature) {
        // flame: blackbody of the stored temperature (0 … maximum → 0 … T K), its brightest = strength
        const T = Math.max(l.temperature ?? b.temperature, MIN_GLOW_K);
        const top = luminance(blackbodyRgb(T)) || 1;
        const table = new Float32Array(3 * GRID_EMISSION_STEPS);
        for (let i = 1; i < GRID_EMISSION_STEPS; i++) {
            const Ti = i / (GRID_EMISSION_STEPS - 1) * T;
            if (Ti < MIN_GLOW_K) continue;
            const c = blackbodyRgb(Ti);
            for (let k = 0; k < 3; k++) table[3 * i + k] = c[k] / top * b.strength * l.emission / Math.max(1 - volume.albedo[k], ABSORPTION_FLOOR);
        }
        volume.emission = table;
    } else if (b.emission) volume.emission = b.emission.map(x => x * l.emission);
    else volume.emission = null;
    return volume;
}

/** a medium as imported → base + default look, values applied */
export function withLook(volume, base, look = null) {
    volume.base = base;
    volume.look = { ...DEFAULT_LOOK, ...(look || {}) };
    return applyLook(volume);
}
