// Groups of helper meshes that only belong in the normal colour image (cloud volume boxes, wool fibre shells): passes
// that draw the scene with an override material (contour, contact shadow, depth of field lines, section caps,
// selection outline, light shafts, UV/wireframe …) would draw them as solid shapes. renderer.render is wrapped
// once; a registered group is hidden for a call with an override material unless keep() returns that material or a
// list with it (grass: the light shafts' depth – real geometry that blocks the sun) or active() says it draws itself
// (cloud: the light shafts' depth). The Basic view (no override, basic-view.js) hides the groups without keepPlain
// (wool fibres: the slimmed-down look shows the base colour only; clouds and grass blades stay).

const entries = [];
let wrapped = null;
let plain = () => false;   // (scene) => the Basic view draws this scene

/** Basic view: groups without keepPlain are hidden in renders of the scenes for which plainView(scene) is true */
export function setPlainView(plainView) {
    plain = plainView;
}

/**
 * @param {THREE.Renderer} renderer
 * @param {THREE.Object3D} group
 * @param {{ keep?: () => THREE.Material | THREE.Material[] | null, active?: () => boolean }} [options]
 */
export function hideInOverridePasses(renderer, group, { keep = () => null, active = () => false, keepPlain = false } = {}) {
    entries.push({ group, keep, active, keepPlain });
    if (wrapped === renderer) return;
    wrapped = renderer;
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
        const override = scene.overrideMaterial;
        const hidden = override ? entries.filter(e => e.group.visible && ![].concat(e.keep()).includes(override) && !e.active())
            : plain(scene) ? entries.filter(e => e.group.visible && !e.keepPlain) : [];
        for (const e of hidden) e.group.visible = false;
        try {
            return render(scene, camera);
        } finally {
            for (const e of hidden) e.group.visible = true;
        }
    };
}
