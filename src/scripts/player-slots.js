// Values the players of a page share in one place (docs/player.md, stage 3): module uniforms the shaders read (one shader
// for every player – fisheye, background dome, ground, shadow catcher, the materials' ambient occlusion …) and texture
// slots of shared nodes. Each player keeps its own values: when another player becomes the current one (runtime.js
// usePlayer) the leaving player's values are captured and the coming player's put back – a player that never had a
// turn starts from the values the slots had when they were registered (the modules' defaults). A single player (the
// app) never switches: nothing is captured or restored.
const slots = [];

/**
 * A shared value: get() reads it, set(v) writes it; init = its value for a player that never set it (default: get() now).
 * Values are copied (objects with copy()/clone(): vectors, matrices, colours).
 */
export function playerSlot(get, set, init = get()) {
    slots.push({ get, set, init: copyOf(init) });
}

/** Every uniform of a module's set (object or array of uniform nodes, nested arrays too) as a slot */
export function playerUniforms(group) {
    for (const u of Array.isArray(group) ? group : Object.values(group)) {
        if (Array.isArray(u)) playerUniforms(u);
        else if (u?.isNode && 'value' in u && !u.isTextureNode) {   // (texture nodes: playerSlot with their own get/set)
            playerSlot(() => u.value, v => {
                if (v?.copy && u.value?.copy) u.value.copy(v);
                else u.value = v;
            });
        }
    }
}

/** The current values of every slot (the leaving player's) */
export function captureSlots() {
    return slots.map(s => copyOf(s.get()));
}

/** Put a player's values back (null: the defaults – a player's first turn); slots registered after the capture keep
 *  their defaults too */
export function restoreSlots(values) {
    slots.forEach((s, i) => s.set(copyOf(values && i < values.length ? values[i] : s.init)));
}

// copy-on-capture: vectors, matrices and colours are objects the next player would otherwise write into
function copyOf(v) {
    return v && typeof v === 'object' && typeof v.clone === 'function' && !v.isTexture ? v.clone() : v;
}
