// What other modules need from the STEP importer without loading it (step-importer.js comes with the first STEP file –
// docs/player.md "schlank"): the tessellation levels and the import limit error.

// Tessellation quality levels:
//   rel = chord error relative to the solid diagonal, ang = max. angle between normals (rad)
export const TESS_PRESETS = {
    coarse:   { rel: 0.004,   ang: 0.6 },
    medium:   { rel: 0.0015,  ang: 0.4 },
    fine:     { rel: 0.0005,  ang: 0.25 },
    veryFine: { rel: 0.0002,  ang: 0.15 },
};
// Quality levels used to be stored with their German names (scene states before the i18n refactoring)
const LEGACY_QUALITY = { 'Grob': 'coarse', 'Mittel': 'medium', 'Fein': 'fine', 'Sehr fein': 'veryFine' };
/** Valid TESS_PRESETS key for a stored value (also legacy German names), otherwise null */
export const normalizeQuality = q => (q in TESS_PRESETS ? q : LEGACY_QUALITY[q] || null);

/**
 * Tessellation would exceed the triangle limit (memory protection, IMPORT in config.js).
 * during = false: refused beforehand (estimate), true: aborted while tessellating (counted).
 */
export class ImportLimitError extends Error {
    constructor(triangles, limit, quality, during) {
        super(`Triangle limit exceeded: ${Math.round(triangles)} > ${limit} (${quality})`);
        this.name = 'ImportLimitError';
        Object.assign(this, { triangles: Math.round(triangles), limit, quality, during });
    }
}
