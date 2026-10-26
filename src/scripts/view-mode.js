// View (one choice bottom centre, Oct. 2026 – user: "wire, UV, grey, standard and High Quality in one, the teapot
// next to it"), tools next to it on the right (hide/show UI, fullscreen – addTool):
//  - wire / uv / basic (key 1 – again: the next of them): one material for the whole model (scene.overrideMaterial,
//    materials are kept) – wire (clay with its edges as a wireframe), uv (UV test pattern, uv-checker.js),
//    basic (grey clay)
//  - default (key 2): raster view with all materials and textures
//  - hq (key 3): path tracing while still (raster preview while orbiting)
// The button shows the current mode (ball + name + arrow), a click opens the choice above the bar; addCompanion puts a
// button right next to it (the teapot – rendering).

import { t } from './i18n.js';
import { uvBall, wireBall } from './view-balls.js';
import { icon } from './icons.js';

// labelKey/titleKey: i18n keys, translated when the buttons are created; ball: CSS background (uv/wire: an image of a
// sphere drawn once – view-balls.js)
export const VIEW_MODES = [
    { key: 'wire', labelKey: 'viewMode.wire.label', titleKey: 'viewMode.wire.title', keyHint: '1', ball: () => `url(${wireBall()}) center/cover` },
    { key: 'uv', labelKey: 'viewMode.uv.label', titleKey: 'viewMode.uv.title', keyHint: '1', ball: () => `url(${uvBall()}) center/cover` },
    {
        key: 'basic', labelKey: 'viewMode.basic.label', titleKey: 'viewMode.basic.title', keyHint: '1',
        ball: () => 'radial-gradient(circle at 32% 28%, #f0f0f0 0, #a3a3a3 30%, #6e6e6e 62%, #2b2b2b 100%)',
    },
    {
        key: 'default', labelKey: 'viewMode.default.label', titleKey: 'viewMode.default.title', keyHint: '2',
        ball: () => 'radial-gradient(circle at 32% 28%, #ffffff 0, #e8643f 16%, #b93a1f 55%, #3d1007 100%)',
    },
    {
        key: 'hq', labelKey: 'viewMode.hq.label', titleKey: 'viewMode.hq.title', keyHint: '3',
        ball: () => 'radial-gradient(circle at 32% 24%, #ffffff 0 7%, transparent 20%), '
            + 'linear-gradient(180deg, #e6eef6 0%, #9fb4c9 42%, #1c2631 50%, #4d5b68 66%, #c4ced8 100%)',
    },
];
// the analysis views behind key 1 (in this order)
export const ANALYSIS_KEYS = ['basic', 'uv', 'wire'];

const ball = background => {
    const b = document.createElement('span');
    b.className = 'size-4 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
    b.style.background = background;
    return b;
};

export class ViewModeBar {
    /**
     * @param {HTMLElement} root
     * @param {(mode: string) => void} onSelect
     */
    constructor(root, onSelect) {
        this.root = root;
        this.onSelect = onSelect;
        this.mode = 'default';
        this.unavailable = [];
        // z-10: its menus open upwards over the play bar (animation.js, later in the page – was drawn on top)
        root.className = 'pointer-events-auto absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-full bg-black/60 p-1 text-xs text-white/80 backdrop-blur-sm';
        // the choice and its companions (teapot) together – actions and tool groups go after this box
        this.box = document.createElement('span');
        this.box.className = 'flex items-center gap-1';
        const b = this.button = document.createElement('button');
        b.className = 'relative flex items-center gap-1.5 rounded-full py-1 pr-2 pl-1 outline-none transition-colors hover:bg-white/10';
        b._ball = ball('');
        b._label = document.createElement('span');
        const arrow = document.createElement('span');
        arrow.className = 'flex size-4 items-center justify-center text-white/60';
        arrow.innerHTML = icon('caret-up', 'size-3');
        b.append(b._ball, b._label, arrow);
        b.onclick = () => this._toggleMenu(b);
        this.box.append(b);
        root.append(this.box);
    }

    /** a button right next to the choice (no separator), e.g. the teapot */
    addCompanion({ icon, title, onClick }) {
        const b = document.createElement('button');
        b.className = 'flex size-7 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 hover:text-white';
        b.title = title;
        b.innerHTML = icon;
        b.onclick = () => { b.blur(); onClick(); };
        this.box.append(b);
        return b;
    }

    // the choice above the button (panel style): ball, name, key
    _toggleMenu(anchor) {
        if (this._menu) { this._closeMenu(); return; }
        const menu = document.createElement('div');
        menu.className = 'absolute bottom-full left-0 mb-2 flex min-w-40 flex-col gap-0.5 rounded-lg bg-black/60 p-1 text-xs text-white/85 shadow-xl backdrop-blur-sm';
        for (const m of VIEW_MODES) {
            const item = document.createElement('button');
            const dim = this.unavailable.includes(m.key);
            item.className = 'flex items-center gap-2 rounded-md py-1 pr-2 pl-1 text-left whitespace-nowrap outline-none hover:bg-white/15'
                + (m.key === this.mode ? ' bg-white/10 text-white' : '') + (dim ? ' opacity-40' : '');
            item.title = t(m.titleKey);
            const name = document.createElement('span');
            name.className = 'flex-1';
            name.textContent = t(m.labelKey);
            const key = document.createElement('kbd');
            key.className = 'rounded bg-white/10 px-1 font-sans text-[10px] text-white/50';
            key.textContent = m.keyHint;
            item.append(ball(m.ball()), name, key);
            item.onclick = e => { e.stopPropagation(); this._closeMenu(); this.onSelect(m.key); };
            menu.append(item);
        }
        anchor.append(menu);
        this._menu = menu;
        // close on a click elsewhere or Esc
        this._outside = e => { if (!menu.contains(e.target)) this._closeMenu(); };
        this._esc = e => { if (e.key === 'Escape') this._closeMenu(); };
        setTimeout(() => { document.addEventListener('pointerdown', this._outside); document.addEventListener('keydown', this._esc); });
    }

    _closeMenu() {
        this._menu?.remove();
        this._menu = null;
        document.removeEventListener('pointerdown', this._outside);
        document.removeEventListener('keydown', this._esc);
    }

    _separator() {
        const sep = document.createElement('span');
        sep.className = 'mx-0.5 my-1 w-px self-stretch bg-white/15';
        return sep;
    }

    /** Action button styled like the view modes, right after them (e.g. AI next to HQ), with a separator before it */
    addAction({ label, title, ball, icon, onClick }) {
        const b = document.createElement('button');
        b.title = title;
        b.className = 'flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 outline-none transition-colors hover:bg-white/10';
        const dot = document.createElement('span');
        if (icon) {   // symbol (SVG) instead of a ball
            dot.className = 'flex size-5 shrink-0 items-center justify-center';
            dot.innerHTML = icon;
        } else {
            dot.className = 'size-4 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
            dot.style.background = ball;
        }
        b.append(dot, label);
        b.onclick = () => { b.blur(); onClick(); };
        this._actionSeparator ??= this._separator();
        this.box.after(this._actionSeparator, b);
        return b;
    }

    /**
     * Append an icon button: on the right, or on the left with start: true; group bundles buttons behind a separator.
     * @returns {(active: boolean, title?: string, enabled?: boolean) => void} set state (highlighted, tooltip, enabled); .button = the button
     */
    addTool({ icon, label, title, onClick, start = false, group = start ? 'start' : 'end' }) {
        // Groups with a separator: start = left of the view modes (groups created later go further
        // left), otherwise right (in creation order). Buttons of one group stay together.
        this._groups ??= new Map();
        let box = this._groups.get(group);
        if (!box) {
            box = document.createElement('span');
            box.className = 'flex items-center gap-1';
            const sep = this._separator();
            if (start) this.root.prepend(box, sep);
            else this.root.append(sep, box);
            box.separator = sep;
            this._groups.set(group, box);
        }
        const b = document.createElement('button');
        // label: icon + text (e.g. "Explosion"), otherwise a round icon button
        b.className = (label ? 'flex h-7 items-center gap-1.5 rounded-full pr-3 pl-2' : 'flex size-7 items-center justify-center rounded-full')
            + ' outline-none transition-colors hover:bg-white/10 hover:text-white';
        b.title = title;
        b.innerHTML = icon;
        if (label) b.append(label);
        b.onclick = () => { b.blur(); onClick(); };
        box.append(b);
        const set = (active, tip, enabled = true) => {
            b.classList.toggle('text-sky-300', active);
            b.disabled = !enabled;
            b.classList.toggle('opacity-30', !enabled);
            b.classList.toggle('pointer-events-none', !enabled);
            if (tip) b.title = tip;
        };
        set.button = b;   // e.g. to swap the icon
        return set;
    }

    /** Hide the view mode buttons (and the separator to the actions) and/or tool groups with their separator */
    setHidden({ modes = false, groups = [] } = {}) {
        this.box.hidden = modes;
        if (this._actionSeparator) this._actionSeparator.hidden = modes;
        for (const [key, box] of this._groups ?? []) box.hidden = box.separator.hidden = groups.includes(key);
    }

    /** Show the active mode; unavailable: dimmed but still clickable – the click explains why (e.g. HQ without WebGPU) */
    set(mode, { unavailable = [] } = {}) {
        this.mode = mode;
        this.unavailable = unavailable;
        const m = VIEW_MODES.find(x => x.key === mode) || VIEW_MODES[3];
        const b = this.button;
        b._ball.style.background = m.ball();
        b._label.textContent = t(m.labelKey);
        b.title = `${t(m.titleKey)} – ${t('viewMode.choice')}`;
    }
}
