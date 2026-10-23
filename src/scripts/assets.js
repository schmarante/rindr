// Asset window (a links panel like in layout programs): which external files the scene uses and whether they
// are there – models, HDRI, missing textures of imported models. Missing ones can be relinked: per row
// via a file dialog, or by dropping files/folders anywhere while it is open (matched by file name).
// Free window in the style of the panels (movable, resizable – float-window.js); opened via the toolbar or
// automatically when a scene with missing files is opened.
import { t } from './i18n.js';
import { floatWindow } from './float-window.js';
import { icon } from './icons.js';

const ICON_CLOSE = icon('close', 'size-3.5');
const KIND_ICON = {
    model: icon('model', 'size-3.5 stroke-[1.4]'),
    hdri: icon('globe', 'size-3.5 stroke-[1.4]'),
    file: icon('file', 'size-3.5'),
    texture: icon('texture', 'size-3.5'),
};
const ICON_FOLDER = icon('folder', 'size-3.5');
const ICON_DOWNLOAD = icon('download', 'size-3.5');
const BUTTON = 'rounded px-2 py-0.5 text-white/80 outline-none transition-colors hover:bg-white/15 hover:text-white';
const ICON_BUTTON = 'shrink-0 rounded p-1 text-white/70 outline-none transition-colors hover:bg-white/15 hover:text-white disabled:pointer-events-none disabled:opacity-40';
const ICON_CHECK = icon('check', 'size-3.5');
const ICON_FAILED = icon('cross', 'size-3.5');
const MB = 1024 * 1024;

/**
 * @param {{ rows(): {kind: 'model'|'hdri'|'texture'|'file', name: string, status: 'ok'|'missing', detail?: string, url?: string}[],
 *           onFiles(files: {path: string, file: File}[]): void,
 *           remote?: { count(): number, start(urls?: string[]): void, cancel(): void } }} handlers
 *   remote: missing textures on another server (rows with `url`) – a bar above the list offers to load all of them,
 *   each row its own (only on that click); while loading the bar shows the current file and a thin progress bar (its
 *   button cancels), each row its own progress (percent + bar), a tick when loaded, a cross when it failed
 */
export function createAssetsWindow({ rows, onFiles, remote = null }) {
    // free window like the editors (float-window.js): move by the header, resize at the edges, place remembered
    const root = document.createElement('div');
    root.hidden = true;
    const panel = root;
    const head = document.createElement('div');
    head.className = 'flex shrink-0 cursor-move items-center gap-2 border-b border-white/10 px-3 py-2';
    const title = document.createElement('span');
    title.className = 'flex-1 font-medium';
    title.textContent = t('assets.title');
    const count = document.createElement('span');
    count.className = 'text-white/50';
    const close = document.createElement('button');
    close.className = 'text-white/50 hover:text-white';
    close.innerHTML = ICON_CLOSE;
    close.title = t('setup.close');
    close.onclick = () => hide();
    head.append(title, count, close);
    // missing textures on another server: load them from the net (only on request)
    const remoteBar = document.createElement('div');
    remoteBar.className = 'flex shrink-0 items-center gap-2 border-b border-white/10 bg-sky-500/10 px-3 py-2';
    remoteBar.hidden = true;
    const remoteText = document.createElement('span');
    remoteText.className = 'min-w-0 flex-1 text-white/70';
    const remoteButton = document.createElement('button');
    remoteButton.className = 'shrink-0 rounded bg-sky-500/80 px-2.5 py-1 text-white outline-none transition-colors hover:bg-sky-500';
    remoteButton.textContent = t('assets.loadRemote');
    remoteButton.title = t('assets.loadRemoteTitle');
    remoteButton.onclick = () => (remoteBusy ? remote?.cancel() : remote?.start());
    // while loading: current file + thin bar (like the progress display bottom left)
    const remoteInfo = document.createElement('div');
    remoteInfo.className = 'min-w-0 flex-1';
    const remoteTrack = document.createElement('div');
    remoteTrack.className = 'mt-1.5 h-1 overflow-hidden rounded bg-white/15';
    const remoteFill = document.createElement('div');
    remoteFill.className = 'h-full w-0 rounded bg-amber-400 transition-[width] duration-200';
    remoteTrack.append(remoteFill);
    remoteInfo.append(remoteText, remoteTrack);
    remoteText.className = 'block truncate text-white/70';
    remoteBar.append(remoteInfo, remoteButton);
    let remoteBusy = null;   // { label, fraction } while loading
    // per file while loading: url → { status: 'queued'|'loading'|'done'|'failed', loaded, total }; rows update in place
    // (at most once per frame – the stream reports every chunk)
    const fileStates = new Map(), rowSlots = new Map(), dirty = new Set();
    let frame = 0;
    const flush = () => {
        frame = 0;
        for (const url of dirty) rowSlots.get(url)?.();
        dirty.clear();
    };
    const list = document.createElement('div');
    list.className = 'min-h-0 flex-1 overflow-auto p-2';
    const foot = document.createElement('div');
    foot.className = 'flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-2 text-white/50';
    const hint = document.createElement('span');
    hint.className = 'flex-1';
    hint.textContent = t('assets.dropHint');
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
    const folderInput = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
    const pick = document.createElement('button');
    pick.className = BUTTON;
    pick.textContent = t('assets.pickFiles');
    pick.onclick = () => input.click();
    const pickFolder = document.createElement('button');
    pickFolder.className = BUTTON;
    pickFolder.textContent = t('assets.pickFolder');
    pickFolder.onclick = () => folderInput.click();
    const take = inp => () => {
        const files = [...inp.files].map(file => ({ path: file.webkitRelativePath || file.name, file }));
        inp.value = '';
        if (files.length) onFiles(files);
    };
    input.onchange = take(input);
    folderInput.onchange = take(folderInput);
    foot.append(hint, pick, pickFolder, input, folderInput);
    panel.append(head, remoteBar, list, foot);
    const placement = floatWindow(root, head, { storeKey: 'rindr.assets.window', width: 544, height: 520, minWidth: 360, minHeight: 220 });
    document.body.append(root);

    // dropping files: the viewer's global drop handler relinks while the window is open (anywhere in the
    // window, the replace/add plane is not shown then)
    const highlight = on => { panel.style.backgroundColor = on ? 'rgb(12 74 110 / 0.7)' : ''; };
    // a file drag anywhere in the window while open (the viewer then shows no drop plane): highlight as target
    const setDragActive = on => { if (!root.hidden || !on) highlight(on); };

    function render() {
        const items = rows();
        const missing = items.filter(r => r.status === 'missing').length;
        count.textContent = missing ? t('assets.missingCount', { count: missing }) : t('assets.allFound');
        count.className = missing ? 'text-amber-300' : 'text-white/50';
        rowSlots.clear();
        list.replaceChildren(...(items.length ? items.map(row) : [Object.assign(document.createElement('div'), { className: 'p-2 text-white/50', textContent: t('assets.empty') })]));
        const remoteCount = remote?.count() || 0;
        remoteBar.hidden = !remoteCount && !remoteBusy;
        showRemoteBusy();
        if (!remoteBusy) { remoteText.textContent = t('assets.remoteCount', { count: remoteCount }); remoteText.title = ''; }
    }
    function showRemoteBusy() {
        remoteTrack.hidden = !remoteBusy;
        // while loading the button cancels
        remoteButton.textContent = remoteBusy ? t('assets.cancelRemote') : t('assets.loadRemote');
        remoteButton.title = remoteBusy ? '' : t('assets.loadRemoteTitle');
        remoteButton.disabled = !!remoteBusy?.linking;   // linking (scene reopens): no longer cancellable
        remoteButton.className = remoteBusy
            ? 'shrink-0 rounded bg-white/10 px-2.5 py-1 text-white/80 outline-none transition-colors hover:bg-white/20 disabled:opacity-50'
            : 'shrink-0 rounded bg-sky-500/80 px-2.5 py-1 text-white outline-none transition-colors hover:bg-sky-500';
        if (!remoteBusy) return;
        remoteText.textContent = remoteBusy.label;
        remoteText.title = remoteBusy.label;
        remoteFill.style.width = `${Math.round(Math.min(Math.max(remoteBusy.fraction || 0, 0), 1) * 100)}%`;
        for (const b of list.querySelectorAll('[data-download]')) b.disabled = true;
    }
    // the remote state of a row: download button / waiting / percent + bar / tick / cross
    function remoteSlot(r, name, badge) {
        const slot = document.createElement('span');
        slot.className = 'flex w-11 shrink-0 items-center justify-end tabular-nums';
        const track = document.createElement('div');
        track.className = 'mt-1 h-0.5 overflow-hidden rounded bg-white/15';
        const fill = document.createElement('div');
        fill.className = 'h-full w-0 rounded bg-amber-400';
        track.append(fill);
        track.hidden = true;
        name.append(track);
        const update = () => {
            const st = fileStates.get(r.url);
            track.hidden = st?.status !== 'loading';
            // loaded (linked when the batch is over): the tick says it – no "missing" badge any more
            badge.hidden = st?.status === 'done';
            if (!st || st.status === 'aborted') {
                const download = document.createElement('button');
                download.className = ICON_BUTTON;
                download.innerHTML = ICON_DOWNLOAD;
                download.title = t('assets.downloadTitle', { name: r.name });
                download.setAttribute('aria-label', download.title);
                download.dataset.download = '';
                download.disabled = !!remoteBusy;
                download.onclick = () => remote.start([r.url]);
                slot.replaceChildren(download);
            } else if (st.status === 'queued') {
                slot.replaceChildren(Object.assign(document.createElement('span'), { className: 'text-white/35', textContent: t('assets.remoteQueued') }));
            } else if (st.status === 'loading') {
                const known = st.total > 0;
                fill.style.width = known ? `${Math.round(st.loaded / st.total * 100)}%` : '100%';
                fill.classList.toggle('animate-pulse', !known);
                slot.replaceChildren(Object.assign(document.createElement('span'), { className: 'text-amber-200',
                    textContent: known ? `${Math.round(st.loaded / st.total * 100)} %` : `${(st.loaded / MB).toFixed(1)} MB` }));
            } else {
                const ok = st.status === 'done';
                const mark = Object.assign(document.createElement('span'), { className: 'p-1 ' + (ok ? 'text-emerald-300' : 'text-red-300'), innerHTML: ok ? ICON_CHECK : ICON_FAILED });
                mark.title = ok ? t('assets.remoteDone') : t('assets.remoteFailed');
                slot.replaceChildren(mark);
            }
        };
        rowSlots.set(r.url, update);
        update();
        return slot;
    }
    function row(r) {
        const el = document.createElement('div');
        el.className = 'flex items-center gap-2 rounded px-2 py-1 hover:bg-white/5';
        const icon = document.createElement('span');
        icon.className = 'shrink-0 text-white/60';
        icon.innerHTML = KIND_ICON[r.kind] || KIND_ICON.model;
        const name = document.createElement('div');
        name.className = 'min-w-0 flex-1';
        const n = document.createElement('div');
        n.className = 'truncate' + (r.status === 'missing' ? ' text-amber-200' : '');
        n.textContent = r.name;
        n.title = r.name;
        name.append(n);
        if (r.detail) {
            const d = document.createElement('div');
            d.className = 'truncate text-white/40';
            d.textContent = r.detail;
            name.append(d);
        }
        if (r.url) {
            // where it would be loaded from (address in the model)
            const a = document.createElement('a');
            a.className = 'block truncate text-sky-300/60 hover:text-sky-300';
            a.href = r.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = r.url;
            a.title = r.url;
            name.append(a);
        }
        const status = document.createElement('span');
        status.className = 'shrink-0 rounded px-1.5 py-0.5 ' + (r.status === 'missing' ? 'bg-amber-500/25 text-amber-200' : 'bg-emerald-500/20 text-emerald-200');
        status.textContent = r.status === 'missing' ? t('assets.missing') : t('assets.found');
        el.append(icon, name, status);
        if (r.status === 'missing') {
            if (r.url && remote) el.append(remoteSlot(r, name, status));
            const relink = document.createElement('button');
            relink.className = ICON_BUTTON;
            relink.innerHTML = ICON_FOLDER;
            relink.title = t('assets.relinkTitle', { name: r.name });
            relink.setAttribute('aria-label', t('assets.relink'));
            relink.onclick = () => input.click();
            el.append(relink);
        }
        return el;
    }
    function show() {
        render();
        const wasHidden = root.hidden;
        root.hidden = false;
        if (wasHidden) placement.apply();   // (re)placed inside the browser window, in front
    }
    function hide() { root.hidden = true; }
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) { e.stopPropagation(); hide(); } }, true);
    return {
        show, hide, render, setDragActive,
        /** progress while remote textures load: { label, fraction, linking? } (null: done) – only the bar is updated */
        setRemoteBusy(state) {
            const changed = !!state !== !!remoteBusy;
            remoteBusy = state;
            if (changed && !root.hidden) render(); else showRemoteBusy();
        },
        /** state of one file (see fileStates); clearRemoteFiles() when the batch is over */
        setRemoteFile(url, state) {
            fileStates.set(url, state);
            dirty.add(url);
            frame ||= requestAnimationFrame(flush);
        },
        clearRemoteFiles() {
            fileStates.clear();
            if (!root.hidden) render();
        },
        get isOpen() { return !root.hidden; },
        refresh() { if (!root.hidden) render(); },
    };
}
