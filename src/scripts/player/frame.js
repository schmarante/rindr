// The player inside an iframe (README.md "Embedding the RINDR player" → iframe): player/<version>/frame.html runs one <rindr-player> over the
// whole frame, set up from the URL's hash (src, scene, hdr, mode, features, activate, poster, background – URLs absolute;
// theme-accent/-panel/-background/-font: the page's whitelabel values, RINDR.configure), and
// speaks with the embedding page by postMessage – the fallback for pages whose CSP or framework does not let the player
// in (`<rindr-player frame>` uses it with the same interface; a page can also talk to it directly).
//
// Protocol (every message has `rindr: 1`):
//   page → frame  { rindr, id, call, args }          a method of the element (load, setMaterial, render …); answer:
//   frame → page  { rindr, id, result } | { rindr, id, error: { message, code } }
//   frame → page  { rindr, event, detail }           the element's events (ready, progress, load, select, change, mode,
//                                                    error, save – save: { scene, json, name }, see below)
//   frame → page  { rindr, ask: 'resolveAsset', id, name, kind } → page answers { rindr, id, result: URL | Blob | null }
//   page → frame  { rindr, call: 'hello', args: [{ saves: true }] }  first message (the frame answers to its origin from
//                                                    then on); saves: the page takes every save – otherwise the frame's
//                                                    own default (a download) runs
// Only the embedding window may call; Blobs (render, getPackage, packages for load) travel as they are.

const params = new URLSearchParams(location.hash.slice(1));
const player = document.createElement('rindr-player');
for (const name of ['src', 'scene', 'hdr', 'mode', 'features', 'activate', 'poster', 'background']) {
    const value = params.get(name);
    if (value != null) player.setAttribute(name, value);
}
const theme = Object.fromEntries(['accent', 'panel', 'background', 'font'].map(k => [k, params.get(`theme-${k}`)]).filter(([, v]) => v));
if (Object.keys(theme).length) customElements.whenDefined('rindr-player').then(() => globalThis.RINDR?.configure?.({ theme }));
let pageOrigin = null;   // set by the page's first message
let takesSaves = false;
const pending = new Map();
let askId = 0;
const post = message => { if (window.parent !== window) window.parent.postMessage({ rindr: 1, ...message }, pageOrigin ?? '*'); };

// files a scene names: asked from the page
player.resolveAsset = (name, kind) => {
    if (!pageOrigin) return null;
    const id = `a${++askId}`;
    post({ ask: 'resolveAsset', id, name, kind });
    return new Promise(resolve => { pending.set(id, resolve); setTimeout(() => { if (pending.delete(id)) resolve(null); }, 10000); });
};

// the element's events to the page (structured-cloneable parts of the detail)
for (const type of ['ready', 'progress', 'load', 'select', 'change', 'mode', 'error', 'save']) {
    player.addEventListener(`rindr-${type}`, e => {
        if (type === 'save') {
            if (!takesSaves) return;   // the frame's own download
            e.preventDefault();
            post({ event: 'save', detail: { scene: e.detail.scene, json: e.detail.json, name: e.detail.name } });
            return;
        }
        post({ event: type, detail: e.detail });
    });
}

const ALLOWED = new Set(['start', 'load', 'getParts', 'getMaterials', 'getLibrary', 'setMaterial', 'updateMaterial', 'setVisible', 'select', 'frame', 'getViews', 'setView',
    'setMode', 'getMode', 'setBackground', 'render', 'getScene', 'getPackage', 'save']);
window.addEventListener('message', async e => {
    const m = e.data;
    if (e.source !== window.parent || !m || m.rindr !== 1) return;
    if (!m.call) {   // the page's answer to an ask
        const resolve = pending.get(m.id);
        if (resolve) { pending.delete(m.id); resolve(m.result ?? null); }
        return;
    }
    if (m.call === 'hello') {
        pageOrigin = e.origin === 'null' ? '*' : e.origin;
        takesSaves = !!m.args?.[0]?.saves;
        post({ id: m.id, result: true });
        return;
    }
    if (!ALLOWED.has(m.call)) { post({ id: m.id, error: { message: `Unknown method ${m.call}`, code: 'bad-argument' } }); return; }
    try {
        await customElements.whenDefined('rindr-player');
        const result = m.call === 'start' ? (await player.start(), true) : await player[m.call](...(m.args || []));
        post({ id: m.id, result: result ?? null });
    } catch (err) {
        post({ id: m.id, error: { message: err?.message || String(err), code: err?.code ?? null } });
    }
});

document.body.append(player);
post({ event: 'frame-ready' });   // listening: the page may say hello
