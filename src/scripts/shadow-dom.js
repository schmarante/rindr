// Helpers so the interface works the same in the page (the app) and inside a shadow root (<rindr-player>,
// docs/player.md). In the page they give exactly what the plain DOM calls gave.
//  - Listeners on window/document see `e.target` retargeted to the shadow host – eventTarget(e) is the real element.
//  - `document.activeElement` / `document.elementFromPoint` stop at the host – ask the node's own root instead.
//  - Windows, menus and notices belong into the player's layer (layerFor), positions relative to it (layerRect).

/** The element the event really started on (inside shadow roots too). Read it before the first `await`. */
export function eventTarget(e) {
    return e.composedPath?.()[0] ?? e.target;
}

/** The focused element of the tree `node` lives in (document or shadow root). */
export function focusedIn(node) {
    return node?.getRootNode?.().activeElement ?? document.activeElement;
}

/** The element at a viewport point, seen from the tree `node` lives in. */
export function elementFromPointIn(node, x, y) {
    const root = node?.getRootNode?.();
    return (root?.elementFromPoint ? root : document).elementFromPoint(x, y);
}

// the layer windows and notices go into when nothing tells otherwise (a player inside a shadow root sets its own)
let defaultLayer = null;
export function setDefaultLayer(el) { defaultLayer = el; }

/**
 * Where a window, menu or notice belongs: the layer of the player `node` lives in, otherwise the default layer of the
 * page (document.body for the app).
 */
export function layerFor(node = null) {
    const root = node?.getRootNode?.();
    if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) return root.querySelector('[data-rindr-layer]') ?? root;
    return defaultLayer ?? document.body;
}

/** Rectangle of a layer in viewport coordinates – fixed elements in it are placed relative to it (the window for the page). */
export function layerRect(layer = layerFor()) {
    if (!layer || layer === document.body || layer === document.documentElement) {
        return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    // a player's layer has no box of its own (display: contents): its player element is the size container
    const root = layer.getRootNode();
    const box = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : layer;
    const r = box.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}
