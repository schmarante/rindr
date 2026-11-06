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
import css from '../styles/player.css?inline';
import { playerTemplate } from './player/template.js';
import { setDefaultLayer } from './shadow-dom.js';
import { splitBackground, backgroundCss, lightBehindText } from './player/backdrop-css.js';
import { debugLog } from './log.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

// What every player of the page starts with unless its options say otherwise: assetBase = where the player's own files
// lie (denoiser weights …) – the player build's entry sets it to its own folder (player-entry.js); the app: its page
export const playerDefaults = { assetBase: null };

// Page-wide settings (RINDR.configure – README.md "Embedding the RINDR player" → Colours): theme = { accent, panel, background, font } as CSS values
// for every player of the page (a rule on an element of the page still wins), base = where the player's own files lie
const themeSheet = new CSSStyleSheet();
const THEME_KEYS = { accent: 'color', panel: 'color', background: 'color', font: 'font-family' };
const theme = {};   // the values so far (a later call changes only what it names; null or '' removes one)
export function configure({ theme: values, base } = {}) {
    if (values) {
        for (const [key, value] of Object.entries(values)) {
            const property = THEME_KEYS[key];
            if (!property) { console.warn(`[rindr-player] configure: unknown theme key ${key}`); continue; }
            if (value == null || value === '') { delete theme[key]; continue; }
            if (!CSS.supports(property, String(value)) || /[;{}]/.test(String(value))) { console.warn(`[rindr-player] configure: invalid ${key}: ${value}`); continue; }
            theme[key] = String(value);
        }
        const rules = Object.entries(theme).map(([key, value]) => `--rindr-${key}:${value}`);
        themeSheet.replaceSync(rules.length ? `:host{${rules.join(';')}}` : '');
    }
    if (base) playerDefaults.assetBase = new URL(base, document.baseURI).href.replace(/\/?$/, '/');
}
// the viewer (three.js, importers …) loads with the first player that starts (the app has it already – app.js); one promise
// for all: players awaiting it go on in the order they started – createPlayer in page order (without WebGPU the first one
// gets the picture)
let viewerModule = null;
const loadViewer = () => (viewerModule ??= import('./viewer.js'));

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
// (the stylesheet as a parameter: used once here – the minifier put the 70 KB text into the bundle once per use otherwise)
function playerSheet(source = css) {
    if (sheet) return sheet;
    const text = PROPERTY_FALLBACK.test(source) ? source.replace(PROPERTY_FALLBACK, '@supports (display:block){:host,*,::before,::after,::backdrop{')
        : (debugLog('[Player] Tailwind property fallback not found – shadows/rings may be missing'), source);
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet;
}

// The element's methods for the host page (docs/player.md, stage 4 – player/host-api.js; load() has its own below): each
// returns a promise; a player still waiting for its activation (activate="click" / "visible") starts on the first call
const HOST_METHODS = ['getParts', 'getMaterials', 'getLibrary', 'setMaterial', 'updateMaterial', 'setVisible', 'select', 'frame', 'getViews', 'setView',
    'setMode', 'getMode', 'render', 'getScene', 'getPackage', 'save'];   // (setBackground has its own below)
// attributes the player follows when the page changes them after the start (the others count once, at the start)
const LIVE_ATTRIBUTES = ['src', 'scene', 'hdr', 'mode', 'background'];

export class RindrPlayer extends HTMLElement {
    static get observedAttributes() { return LIVE_ATTRIBUTES; }

    connectedCallback() {
        // moved or put back into the page (frameworks do that): the running player stays (out of the page it draws nothing)
        if (this.ready) return;
        const options = this.rindrOptions || {};
        const root = this.attachShadow({ mode: 'open' });
        // <rindr-player frame>: the player in an iframe of the player build, same interface (player/frame-proxy.js)
        if (this.hasAttribute('frame') && !options.appMode) { this._startFrame(root); return; }
        this._backdropSheet = new CSSStyleSheet();
        root.adoptedStyleSheets = [playerSheet(), themeSheet, this._backdropSheet];
        root.innerHTML = playerTemplate();
        this._showBackdrop(this.getAttribute('background'));
        const layer = root.querySelector('[data-rindr-layer]');
        setDefaultLayer(layer);   // windows and notices without an anchor go here (the player's own get their layer)
        // an embedded player takes keys while it has the focus (click into the view, or Tab)
        if (!options.appMode && !this.hasAttribute('tabindex')) this.tabIndex = 0;
        const create = async () => {
            // (a page full of players waiting for a click or for being scrolled to loads only this small element)
            const { createPlayer } = await loadViewer();
            // the attributes as they are when the player starts (the page may change them while it waits for activation)
            const attrs = this._startAttributes = Object.fromEntries(LIVE_ATTRIBUTES.map(name => [name, this.getAttribute(name)]));
            this._shows = { src: attrs.src, scene: attrs.scene, hdr: attrs.hdr };   // what the player shows (attribute or load())
            const url = value => new URL(value, document.baseURI).href;
            return createPlayer({
                ...(playerDefaults.assetBase ? { assetBase: playerDefaults.assetBase } : {}),
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
                ...(attrs.background ? { background: attrs.background } : {}),
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

    _startFrame(root) {
        this._backdropSheet = new CSSStyleSheet();
        root.adoptedStyleSheets = [playerSheet(), themeSheet, this._backdropSheet];
        this._showBackdrop(this.getAttribute('background'));
        // (the address after the import: elements in the page upgrade while this module runs – before player-entry.js has set
        // the player's folder)
        const started = import('./player/frame-proxy.js').then(({ startFrame }) => {
            const url = this.getAttribute('frame') || (playerDefaults.assetBase && `${playerDefaults.assetBase}frame.html`);
            if (!url) throw new Error('rindr-player frame: needs the player build (or frame="<URL of frame.html>")');
            const frame = startFrame(this, root, url, (type, detail, cancelable) => this._emit(type, detail, cancelable));
            this._startNow = () => { this._startNow = null; frame.start().catch(() => {}); };
            return frame.started;
        });
        this._startAttributes = Object.fromEntries(LIVE_ATTRIBUTES.map(name => [name, this.getAttribute(name)]));
        this._shows = { src: this._startAttributes.src, scene: this._startAttributes.scene, hdr: this._startAttributes.hdr };
        this.ready = started.then(api => {
            this._api = api;
            this._emit('ready', {});
            return api;
        }, err => {
            this._emit('error', { message: err?.message || String(err), name: null, title: null, start: true });
            throw err;
        });
        this.ready.catch(() => {});
    }

    attributeChangedCallback(name, previous, value) {
        if (name === 'background' && this._backdropSheet) this._showBackdrop(value);   // (also while it waits for its start)
        if (!this._api) return;   // before the start: read when it starts
        const done = p => p.catch(err => { if (err?.code !== 'load-failed') console.warn(`[rindr-player] ${name}: ${err.message}`); });   // load errors: 'rindr-error'
        // src / scene / hdr: load when it is not what the player shows already (frameworks set unchanged attributes again)
        if (name === 'mode') { if (previous !== value) done(this.setMode(value || 'default')); }
        else if (name === 'background') { if (previous !== value) done(this.setBackground(value || 'default')); }
        else if (value && value !== this._shows?.[name]) done(this.load({ [name]: value }));
    }

    /** the background ('hdri', 'default', a colour, 'linear(a, b)', 'radial(a, b)', { type, colors }) – see player/host-api.js */
    async setBackground(spec) {
        this._showBackdrop(spec);
        const api = await this.start();
        return api.host.setBackground(spec);
    }

    // the background as CSS of the element until the view draws (player/backdrop-css.js) – and the start text readable on it
    _showBackdrop(spec) {
        const bg = spec == null ? null : splitBackground(spec);
        const css = backgroundCss(bg);
        this._backdropSheet?.replaceSync(css ? `:host{--rindr-backdrop:${css}}${lightBehindText(bg) ? '#loading{color:#262626}' : ''}` : '');
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
