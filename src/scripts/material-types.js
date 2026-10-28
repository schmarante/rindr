// Material types (docs/materials.md): a material is Standard or one special kind – Toon, cloud, wool, grass, soap
// film, glowing marble. The type decides which parameters the panel shows and whether the node editor is offered;
// the special effects exclude each other (one path tracer slot, ptVolume – mixed, the raster showed a blend while
// HQ took one). Stored as params.type; older materials get it from their values (first special effect found wins,
// the others are switched off).
import { MATERIAL_PRESETS } from './material-presets.js';

// switch of each special type (> 0 = on); order = precedence when an older material had several on
const SWITCHES = { cloud: ['cloud'], grass: ['grass'], wool: ['wool'], soap: ['soap'], marble: ['marble'], toon: ['toon', 'flat', 'contour'] };

export const MATERIAL_TYPES = {
    // everything except the special effects (contour lines only with Toon – user's choice)
    standard: { graph: true },
    toon: { keys: ['color', 'toon', 'flat', 'contour', 'contourColor', 'contourWidth'], graph: true, template: 'toon-orange' },
    cloud: { keys: ['cloud', 'cloudColor', 'cloudPuff'], graph: false, template: 'cloud-white' },
    // wool, grass, soap film: their switch itself is not shown – the type is the switch (user: "wool as a material type is enough")
    wool: { keys: ['color', 'sheen', 'sheenColor', 'sheenRoughness', 'woolLength'], graph: false, template: 'wool-cream', on: { wool: 1 } },
    grass: { keys: ['color', 'roughness', 'grassHeight', 'grassDensity', 'grassDry'], graph: false, template: 'grass-lawn', on: { grass: 1 } },
    soap: { keys: ['soapFilm', 'soapSwirl', 'soapScale'], graph: false, template: 'soap-bubble', on: { soap: 1 } },
    marble: { keys: ['color', 'roughness', 'clearcoat', 'clearcoatRoughness', 'marble', 'marbleColor', 'marbleScale'], graph: true, template: 'marble-glow-green' },
};

// parameters only a special type has (hidden for Standard)
const SPECIAL_KEYS = new Set(['toon', 'flat', 'contour', 'contourColor', 'contourWidth', 'cloud', 'cloudColor', 'cloudPuff', 'wool', 'woolLength', 'grass', 'grassHeight',
    'grassDensity', 'grassDry', 'soap', 'soapFilm', 'soapSwirl', 'soapScale', 'marble', 'marbleColor', 'marbleScale']);

/** Type of a material's params: stored, else from the values */
export function materialType(params = {}) {
    if (MATERIAL_TYPES[params.type]) return params.type;
    for (const [type, keys] of Object.entries(SWITCHES)) if (keys.some(k => params[k] > 0)) return type;
    return 'standard';
}

/** Parameter shown for this type? */
export function typeShows(type, key) {
    const keys = MATERIAL_TYPES[type]?.keys;
    return keys ? keys.includes(key) : !SPECIAL_KEYS.has(key);
}

/** Node editor offered for this type? */
export const typeAllowsGraph = type => MATERIAL_TYPES[type]?.graph !== false;

/** params with their type fixed: params.type set, the other types' effects off (in place; returns params) */
export function normalizeType(params) {
    const type = materialType(params);
    params.type = type;
    for (const [other, keys] of Object.entries(SWITCHES)) if (other !== type) for (const k of keys) if (params[k] > 0) params[k] = 0;
    // a type whose switch the panel does not show is always on
    for (const [k, v] of Object.entries(MATERIAL_TYPES[type]?.on ?? {})) if (!(params[k] > 0)) params[k] = v;
    return params;
}

/**
 * params after switching to `type`: values the new type does not show back to their defaults (an old contour,
 * effect or glass setting must not stay invisible on the material), then the new type's values from its library
 * template; the colour stays where the new type shows it.
 * @param {object} defaults  { key: default } of all parameters (material-manager.js)
 */
export function paramsForType(params, type, defaults) {
    const next = { ...params };
    for (const [k, v] of Object.entries(defaults)) if (!typeShows(type, k)) next[k] = v;
    for (const keys of Object.values(SWITCHES)) for (const k of keys) next[k] = 0;
    const template = MATERIAL_PRESETS.find(p => p.libraryId === MATERIAL_TYPES[type]?.template)?.params || {};
    for (const [k, v] of Object.entries(template)) {
        const keep = k === 'color' && typeShows(type, k) && params.color !== undefined;
        if (!keep) next[k] = v;
    }
    next.type = type;
    return next;
}
