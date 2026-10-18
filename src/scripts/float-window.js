// Free window in the panel style (HDRI editor, node editor): move by the header, resize at every edge and corner,
// position/size remembered per browser (localStorage), centred the first time, kept inside the browser window.
// Hides with "hide UI" (data-ui="float"). Several open windows: a click into one brings it to the front, opening
// one too.

// stacking order of all free windows (last = front); z-index 30 + position, below dialogs and menus
const stack = [];
function toFront(root) {
    const i = stack.indexOf(root);
    if (i >= 0) stack.splice(i, 1);
    stack.push(root);
    stack.forEach((w, k) => { w.style.zIndex = String(30 + k); });
}

// resize handles: edges 6 px, corners 12 px, just inside the window (it clips its content)
const HANDLES = {
    n: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize', s: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize',
    w: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize', e: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
    nw: 'top-0 left-0 size-3 cursor-nwse-resize', se: 'bottom-0 right-0 size-3 cursor-nwse-resize',
    ne: 'top-0 right-0 size-3 cursor-nesw-resize', sw: 'bottom-0 left-0 size-3 cursor-nesw-resize',
};

const WINDOW_CLASS = 'fixed z-30 flex flex-col overflow-hidden rounded-lg bg-black/60 text-xs text-white/90 shadow-2xl ring-1 ring-white/10 backdrop-blur-sm';

/**
 * @param {HTMLElement} root  the window
 * @param {HTMLElement} head  drag handle (inputs, selects and buttons in it keep working)
 * @param {{ storeKey: string, width: number, height: number, minWidth?: number, minHeight?: number,
 *           clearOf?: () => HTMLElement|null }} opts  clearOf: a panel the window must not cover when it opens (the
 *           node editor lay over the material list – clicks on the names hit its header)
 * @returns {{ apply(): void }} apply = place the window again (on open: the browser window may have changed)
 */
export function floatWindow(root, head, { storeKey, width, height, minWidth = 520, minHeight = 300, clearOf = null }) {
    const win = load(storeKey);
    const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(win)); } catch { /* storage blocked */ } };

    head.classList.add('select-none');
    root.addEventListener('pointerdown', () => toFront(root), true);
    head.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('input, select, button, textarea')) return;
        const r = root.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
        head.setPointerCapture(e.pointerId);
        const move = ev => {
            win.left = Math.min(Math.max(r.left + ev.clientX - sx, 0), window.innerWidth - 80);
            win.top = Math.min(Math.max(r.top + ev.clientY - sy, 0), window.innerHeight - 40);
            root.style.left = `${win.left}px`; root.style.top = `${win.top}px`;
        };
        const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); save(); };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
    });
    // size from any edge or corner (the opposite side stays put; minimum size, inside the browser window)
    const handles = Object.entries(HANDLES).map(([dir, cls]) => {
        const h = document.createElement('div');
        h.className = `absolute z-10 touch-none ${cls}`;
        h.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const r = root.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
            h.setPointerCapture(e.pointerId);
            const move = ev => {
                const dx = ev.clientX - sx, dy = ev.clientY - sy;
                let { left, top, right, bottom } = r;
                if (dir.includes('w')) left = Math.min(Math.max(r.left + dx, 0), r.right - minWidth);
                if (dir.includes('e')) right = Math.max(Math.min(r.right + dx, window.innerWidth), r.left + minWidth);
                if (dir.includes('n')) top = Math.min(Math.max(r.top + dy, 0), r.bottom - minHeight);
                if (dir.includes('s')) bottom = Math.max(Math.min(r.bottom + dy, window.innerHeight), r.top + minHeight);
                Object.assign(win, { left, top, width: right - left, height: bottom - top });
                Object.assign(root.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
            };
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); save(); };
            h.addEventListener('pointermove', move);
            h.addEventListener('pointerup', up);
        });
        return h;
    });

    return {
        apply() {
            root.className = WINDOW_CLASS;
            root.dataset.ui = 'float';
            let w = Math.min(win.width || width, window.innerWidth - 20);
            const h = Math.min(win.height || height, window.innerHeight - 20);
            let left = win.left ?? Math.max(10, (window.innerWidth - w) / 2);
            // fully inside the browser window (a stored position from a larger window must not hang out at the bottom)
            const top = Math.max(10, Math.min(win.top ?? (window.innerHeight - h) / 2, window.innerHeight - h - 10));
            // keep clear of the panel: end left of it (moved, narrower if needed – down to the minimum width)
            const panel = clearOf?.(), p = panel && !panel.hidden && panel.getBoundingClientRect();
            if (p?.width && left + w > p.left - 8 && top < p.bottom && top + h > p.top && p.left - 8 - minWidth >= 10) {
                left = Math.max(10, Math.min(left, p.left - 8 - w));
                w = Math.min(w, p.left - 8 - left);
            }
            root.style.cssText = `left:${Math.min(left, window.innerWidth - 80)}px;top:${top}px;width:${w}px;height:${h}px;min-width:${minWidth}px;min-height:${minHeight}px;`;
            root.append(...handles);   // (again) on top of the content
            if (!root.hidden) toFront(root);   // opened: in front of the other windows
        },
    };
}

function load(key) {
    try {
        const s = JSON.parse(localStorage.getItem(key) || 'null');
        if (s && typeof s === 'object') return s;
    } catch { /* storage blocked */ }
    return {};
}
