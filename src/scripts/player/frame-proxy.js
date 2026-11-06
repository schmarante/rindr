// <rindr-player frame> (README.md "Embedding the RINDR player" → iframe): the player runs in an iframe (player/<version>/frame.html, protocol
// in player/frame.js) and the element keeps its interface – methods go to the frame by postMessage, the frame's events
// become the element's events, element.resolveAsset is asked across. The fallback for pages whose CSP or framework does
// not let the player itself in (the frame needs its own GPU device and compiles its own path tracing kernel).

/**
 * @param {HTMLElement} element  the <rindr-player>
 * @param {ShadowRoot} root      its shadow root (takes the iframe)
 * @param {string} frameUrl      frame.html of the player build
 * @param {(type: string, detail: object, cancelable?: boolean) => boolean} emit  the element's events
 * @returns {{ started: Promise<{ host: object }>, start: () => Promise }}  like the player's start (createPlayer)
 */
export function startFrame(element, root, frameUrl, emit) {
    const url = new URL(frameUrl, document.baseURI);
    // the attributes for the frame (URLs absolute: the frame lies elsewhere)
    const values = {};
    for (const name of ['src', 'scene', 'hdr', 'poster']) { const v = element.getAttribute(name); if (v) values[name] = new URL(v, document.baseURI).href; }
    for (const name of ['mode', 'features', 'activate']) { const v = element.getAttribute(name); if (v != null) values[name] = v; }
    // the page's whitelabel values on the element (--rindr-*) – inside the frame through RINDR.configure
    const style = getComputedStyle(element);
    for (const key of ['accent', 'panel', 'background', 'font']) { const v = style.getPropertyValue(`--rindr-${key}`).trim(); if (v) values[`theme-${key}`] = v; }
    url.hash = new URLSearchParams(values).toString();

    const iframe = document.createElement('iframe');
    iframe.title = element.getAttribute('title') || 'RINDR';
    iframe.allow = 'fullscreen; clipboard-write';
    if ((element.getAttribute('activate') || '').toLowerCase() === 'visible') iframe.loading = 'lazy';   // offscreen: not even loaded
    iframe.style.cssText = 'border:0;display:block;width:100%;height:100%;color-scheme:normal';
    const origin = url.origin;
    const toFrame = message => iframe.contentWindow?.postMessage({ rindr: 1, ...message }, origin);

    let n = 0;
    const calls = new Map();
    const send = (name, args = []) => new Promise((resolve, reject) => {
        const id = `c${++n}`;
        calls.set(id, { resolve, reject });
        toFrame({ id, call: name, args });
    });
    // calls wait until the frame listens and has heard hello
    let greeted;
    const hello = new Promise(resolve => { greeted = resolve; });
    const call = (name, args) => hello.then(() => send(name, args));
    let resolveStarted, rejectStarted;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const host = new Proxy({}, { get: (target, name) => (typeof name === 'string' ? (...args) => call(name, args) : undefined) });

    window.addEventListener('message', async e => {
        const m = e.data;
        if (e.source !== iframe.contentWindow || !m || m.rindr !== 1) return;
        if (m.event === 'frame-ready') {
            // the page takes every save (handed on below); answers go to this page's origin from now on
            send('hello', [{ saves: true }]).then(greeted, greeted);
            return;
        }
        if (m.event === 'ready') { resolveStarted({ host }); return; }
        if (m.event === 'error' && m.detail?.start) { rejectStarted(new Error(m.detail.message)); return; }
        if (m.event === 'save') {
            // as without a frame: cancelled = the page keeps the scene; not cancelled = the frame's own download
            if (emit('save', { ...m.detail, package: () => call('getPackage') }, true)) call('save', [{ event: false }]).catch(() => {});
            return;
        }
        if (m.event) { emit(m.event, m.detail); return; }
        if (m.ask === 'resolveAsset') {
            let result = null;
            try { result = (await element.resolveAsset?.(m.name, m.kind)) ?? null; } catch (err) { console.warn(`[rindr-player] resolveAsset(${m.name}): ${err.message}`); }
            if (result && !(result instanceof Blob)) result = new URL(String(result), document.baseURI).href;
            toFrame({ id: m.id, result });
            return;
        }
        const c = calls.get(m.id);
        if (!c) return;
        calls.delete(m.id);
        if (m.error) c.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else c.resolve(m.result);
    });
    iframe.src = url.href;
    root.append(iframe);
    return { started, start: () => call('start') };
}
