// The interface parts a player can have (docs/player.md): <rindr-player features="scene-graph materials …">, `all` =
// everything (the app). Without the attribute a minimal player: the 3D view only. The code of a part is only loaded
// when the player has it.
export const FEATURES = ['scene-graph', 'properties', 'materials', 'material-editor', 'explode', 'transform', 'section',
    'views', 'view-cube', 'view-modes', 'open', 'save', 'render', 'ki', 'animation', 'setup', 'fullscreen'];

// a part that needs another one to work
const NEEDS = {
    'material-editor': ['materials'],
    properties: ['transform'],   // the panel shows and edits the transform of the selection (gizmo fields)
};

/** Set of features from an attribute/option value (space or comma separated; 'all'); unknown names are ignored */
export function resolveFeatures(value) {
    const out = new Set();
    for (const token of String(value ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
        if (token === 'all') FEATURES.forEach(f => out.add(f));
        else if (FEATURES.includes(token)) out.add(token);
    }
    for (const f of [...out]) for (const need of NEEDS[f] || []) out.add(need);
    return out;
}
