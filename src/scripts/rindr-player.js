// <rindr-player> – RINDR as an element for other pages (PIM systems, shops – docs/player.md): the viewer in its own
// shadow root with its own styles. The app (index.astro → app.js) is one of these with every feature.
//
//   <rindr-player src="models/chair.glb" mode="hq"></rindr-player>
//
// Attributes (read once at the start): src = model URL (relative to the page), mode = 'default' (raster, the default)
// or 'hq' (path tracing when standing still). Options of the app (whole page, its preloader …) come in as the property
// `rindrOptions` before the element is put into the page.
import { createPlayer } from './viewer.js';
import css from '../styles/player.css?inline';
import { playerTemplate } from './player/template.js';
import { setDefaultLayer } from './shadow-dom.js';
import { debugLog } from './log.js';

// one stylesheet for every player. Tailwind registers its custom properties with @property, which is ignored inside
// shadow roots (shadows, rings, transforms, backdrop blur would break); its fallback for browsers without @property –
// the initial values on every element – is used for the shadow root instead (no @property in the page: no side effect
// on the page and no clash with the page's own Tailwind)
let sheet = null;
const PROPERTY_FALLBACK = /@supports([^{]*)\{\s*\*,\s*:?:before,\s*:?:after,\s*::backdrop\s*\{/;
function playerSheet() {
    if (sheet) return sheet;
    const text = PROPERTY_FALLBACK.test(css) ? css.replace(PROPERTY_FALLBACK, '@supports (display:block){:host,*,::before,::after,::backdrop{')
        : (debugLog('[Player] Tailwind property fallback not found – shadows/rings may be missing'), css);
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet;
}

export class RindrPlayer extends HTMLElement {
    connectedCallback() {
        // moved or put back into the page (frameworks do that): the running player stays (stage 3: pause/resume)
        if (this.ready) return;
        const options = this.rindrOptions || {};
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [playerSheet()];
        root.innerHTML = playerTemplate();
        const layer = root.querySelector('[data-rindr-layer]');
        setDefaultLayer(layer);   // windows and notices without an anchor go here (one player per page until stage 3)
        // an embedded player takes keys while it has the focus (click into the view, or Tab)
        if (!options.appMode && !this.hasAttribute('tabindex')) this.tabIndex = 0;
        const src = this.getAttribute('src');
        const mode = this.getAttribute('mode');
        /** Promise of the player's interface (rejects when the browser has no usable renderer) */
        this.ready = createPlayer({
            ...options,
            element: this,
            dom: root,
            host: layer,
            uiRoot: root.querySelector('[data-rindr-root]'),
            fullscreenElement: options.appMode ? document.documentElement : this,
            ...(src ? { modelUrl: new URL(src, document.baseURI).href } : {}),
            ...(mode ? { mode } : {}),
        });
    }
}

if (!customElements.get('rindr-player')) customElements.define('rindr-player', RindrPlayer);
