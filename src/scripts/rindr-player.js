// <rindr-player> – RINDR as an element for other pages (PIM systems, shops – docs/player.md): the viewer in its own
// shadow root with its own styles. The app (index.astro → app.js) is one of these with every feature.
//
//   <rindr-player src="models/chair.glb" mode="hq"></rindr-player>
//
// Attributes (read once at the start): src = model URL (relative to the page), scene = scene file URL (RINDR scene,
// its models next to it), hdr = HDRI URL (.hdr/.exr), mode = 'default' (raster, the default)
// or 'hq' (path tracing when standing still), features = the interface parts (player/features.js; none = the 3D view
// only, 'all' = everything), activate = when the player starts: 'auto' (at once, the default), 'visible' (once it
// comes near the visible part of the page) or 'click' (a start button), poster = picture shown until the player shows
// its model. Options of the app (whole page, its preloader …) come in as the property `rindrOptions` before the element
// is put into the page.
import { createPlayer } from './viewer.js';
import css from '../styles/player.css?inline';
import { playerTemplate } from './player/template.js';
import { setDefaultLayer } from './shadow-dom.js';
import { debugLog } from './log.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

// players starting at the same time (GPU set-up, model download, tessellation): a page full of players starts them a few
// at a time (docs/player.md, stage 3) – a start ends once the player shows its model (or fails)
const MAX_STARTING = 2;
let starting = 0;
const waiting = [];
function startTurn() {
    return new Promise(resolve => {
        if (starting < MAX_STARTING) { starting++; resolve(); } else waiting.push(resolve);
    });
}
function startDone() {
    const next = waiting.shift();
    if (next) next(); else starting--;
}
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
// the player shows its model: interface up, nothing loading, the model there (src/scene), two frames drawn
async function shown(api, wantsModel) {
    for (let i = 0; i < 1200 && (api.isLoading() || (wantsModel && !api.getModel())); i++) await new Promise(resolve => setTimeout(resolve, 100));
    await frame(); await frame();
}

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

// The element's methods for the host page (docs/player.md, stage 4 – player/host-api.js; load() has its own below): each
// returns a promise; a player still waiting for its activation (activate="click" / "visible") starts on the first call
const HOST_METHODS = ['getParts', 'getMaterials', 'getLibrary', 'setMaterial', 'setVisible', 'select', 'frame', 'getViews', 'setView',
    'setMode', 'getMode', 'render', 'getScene', 'getPackage'];
// attributes the player follows when the page changes them after the start (the others count once, at the start)
const LIVE_ATTRIBUTES = ['src', 'scene', 'hdr', 'mode'];

export class RindrPlayer extends HTMLElement {
    static get observedAttributes() { return LIVE_ATTRIBUTES; }

    connectedCallback() {
        // moved or put back into the page (frameworks do that): the running player stays (out of the page it draws nothing)
        if (this.ready) return;
        const options = this.rindrOptions || {};
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [playerSheet()];
        root.innerHTML = playerTemplate();
        const layer = root.querySelector('[data-rindr-layer]');
        setDefaultLayer(layer);   // windows and notices without an anchor go here (the player's own get their layer)
        // an embedded player takes keys while it has the focus (click into the view, or Tab)
        if (!options.appMode && !this.hasAttribute('tabindex')) this.tabIndex = 0;
        const create = () => {
            // the attributes as they are when the player starts (the page may change them while it waits for activation)
            const attrs = this._startAttributes = Object.fromEntries(LIVE_ATTRIBUTES.map(name => [name, this.getAttribute(name)]));
            this._shows = { src: attrs.src, scene: attrs.scene, hdr: attrs.hdr };   // what the player shows (attribute or load())
            const url = value => new URL(value, document.baseURI).href;
            return createPlayer({
                ...options,
                element: this,
                dom: root,
                host: layer,
                uiRoot: root.querySelector('[data-rindr-root]'),
                fullscreenElement: options.appMode ? document.documentElement : this,
                ...(attrs.src ? { modelUrl: url(attrs.src) } : {}),
                ...(attrs.scene ? { sceneUrl: url(attrs.scene) } : {}),
                ...(attrs.hdr ? { hdrUrl: url(attrs.hdr) } : {}),
                ...(attrs.mode ? { mode: attrs.mode } : {}),
                features: options.features ?? this.getAttribute('features') ?? '',
                emit: (type, detail, { cancelable = false } = {}) => this._emit(type, detail, cancelable),
                // files a scene names, from the host page: element.resolveAsset = (name, kind) => URL | Blob | null
                resolveAsset: (name, kind) => this.resolveAsset?.(name, kind),
            });
        };
        const started = options.appMode ? create() : this._deferredStart(root, create, () => !!(this.getAttribute('src') || this.getAttribute('scene')));
        /** Promise of the player's (internal) interface once it runs – rejects when the browser has no usable renderer */
        this.ready = started.then(api => {
            this._api = api;
            this._emit('ready', {});
            // attributes changed between the start and now
            for (const name of LIVE_ATTRIBUTES) if (this.getAttribute(name) !== this._startAttributes?.[name]) this.attributeChangedCallback(name, this._startAttributes?.[name], this.getAttribute(name));
            return api;
        }, err => {
            this._emit('error', { message: err?.message || String(err), name: null, title: null, start: true });
            throw err;
        });
        // a player that cannot start says so in its box (no renderer, without WebGPU only the first player) – the page may
        // still await `ready`; no unhandled rejection in the console otherwise
        this.ready.catch(() => {});
    }

    attributeChangedCallback(name, previous, value) {
        if (!this._api) return;   // before the start: read when it starts
        const done = p => p.catch(err => { if (err?.code !== 'load-failed') console.warn(`[rindr-player] ${name}: ${err.message}`); });   // load errors: 'rindr-error'
        // src / scene / hdr: load when it is not what the player shows already (frameworks set unchanged attributes again)
        if (name === 'mode') { if (previous !== value) done(this.setMode(value || 'default')); }
        else if (value && value !== this._shows?.[name]) done(this.load({ [name]: value }));
    }

    /** load a model (URL) or { src | scene, hdr } – resolves when it is shown (see player/host-api.js) */
    async load(spec) {
        const api = await this.start();
        const s = typeof spec === 'string' ? { src: spec } : spec ?? {};
        if (s.src || s.scene || s.package) this._shows = { ...this._shows, src: s.src ?? null, scene: typeof s.scene === 'string' && !s.src ? s.scene : null };
        if (s.hdr) this._shows = { ...this._shows, hdr: s.hdr };
        return api.host.load(spec);
    }

    /** start a player that waits for its activation (activate="click" / "visible"); resolves like `ready` */
    start() {
        if (!this.ready) return Promise.reject(new Error('rindr-player: not in the page yet'));
        this._startNow?.();
        return this.ready;
    }

    // 'rindr-<type>' on the element (bubbles, crosses shadow roots); returns false when a cancelable one was cancelled
    _emit(type, detail, cancelable = false) {
        return this.dispatchEvent(new CustomEvent(`rindr-${type}`, { detail, bubbles: true, composed: true, cancelable }));
    }

    /**
     * Start by `activate` (auto | visible | click), the poster until the player shows its model, a few starts at a time.
     * Returns the promise of the player's interface.
     */
    _deferredStart(root, create, wantsModel) {
        const activate = (this.getAttribute('activate') || 'auto').toLowerCase();
        const posterUrl = this.getAttribute('poster');
        let poster = null, button = null, observer = null;
        if (posterUrl) {
            poster = document.createElement('img');
            poster.alt = '';
            poster.className = 'pointer-events-none absolute inset-0 z-[70] size-full object-cover transition-opacity duration-500';
            poster.src = new URL(posterUrl, document.baseURI).href;
            root.append(poster);
        }
        return new Promise((resolve, reject) => {
            const start = this._startNow = () => {
                this._startNow = null;
                button?.remove();
                observer?.disconnect();
                startTurn().then(create).then(api => {
                    resolve(api);
                    return shown(api, wantsModel());
                }, err => { reject(err); }).finally(() => {
                    startDone();
                    if (poster) { poster.style.opacity = '0'; setTimeout(() => poster.remove(), 600); }
                });
            };
            if (activate === 'click') {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'absolute top-1/2 left-1/2 z-[71] grid size-16 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 shadow-2xl backdrop-blur-sm transition-colors outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-sky-400';
                button.title = t('player.start');
                button.setAttribute('aria-label', t('player.start'));
                button.innerHTML = icon('play', 'ml-1 size-7 fill-white');
                button.onclick = e => { e.stopPropagation(); start(); };
                root.append(button);
            } else if (activate === 'visible' && typeof IntersectionObserver !== 'undefined') {
                observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) start(); }, { rootMargin: '200px' });
                observer.observe(this);
            } else start();
        });
    }
}
for (const name of HOST_METHODS) {
    Object.defineProperty(RindrPlayer.prototype, name, {
        async value(...args) { const api = await this.start(); return api.host[name](...args); },
        writable: true, configurable: true,
    });
}

if (!customElements.get('rindr-player')) customElements.define('rindr-player', RindrPlayer);
