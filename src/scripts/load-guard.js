// Crash detection for model loads: running out of memory ends the tab without any JS error (Chrome: "Aw, Snap"), so
// the next start has to find out. A marker in sessionStorage (survives the tab's reload, not a new tab) is set while
// a model loads and removed when the load ends or the page is left normally (pagehide – reload, close, navigation).
// Still there at the next start → the tab died while loading. The same file is then opened in safe mode (smaller
// memory budget: coarser tessellation, fewer workers in parallel – memory-budget.js).
// Several players on a page (docs/player.md, stage 3): the marker is read once for the page (when this module loads,
// before any player loads – a player started later would take a neighbour's running load for a crash) and lists every
// load running on the page; a load that ends removes only itself.

const LOADING = 'rindr.loading';
const SAFE = 'rindr.safeLoad';

const read = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
const write = (key, value) => { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* storage blocked */ } };

// the load that ended the tab last time (marker of the previous page life; older versions stored one load, not a list):
// the largest one when several were running
let crashed = (list => list.reduce((a, b) => ((b.size ?? 0) > (a?.size ?? -1) ? b : a), null))([read(LOADING)].flat().filter(Boolean));
write(LOADING, null);
const running = new Set();   // loads of this page (all players)
const store = () => write(LOADING, running.size ? [...running] : null);

/** A load starts: { name, size, url } of the model. Returns the function to call when it ended (finished, failed, aborted) */
export function beginLoad(info) {
    const entry = { name: info.name, size: info.size ?? null, url: info.url ?? null, at: Date.now() };
    running.add(entry);
    store();
    return () => { if (running.delete(entry)) store(); };
}

// leaving the page normally is no crash
globalThis.addEventListener?.('pagehide', () => { running.clear(); store(); });

/** The model whose load ended the tab last time (or null) – once for the page: the first player asking tells */
export function crashedLoad() {
    const info = crashed;
    crashed = null;
    return info;
}

/** Open this model sparingly next time */
export const markSafe = info => write(SAFE, { name: info.name, size: info.size ?? null });

/** Should this model be opened in safe mode? (same name, same size if both are known) */
export function isSafe(info) {
    const s = read(SAFE);
    return !!s && s.name === info.name && (s.size == null || info.size == null || s.size === info.size);
}

/** The model opened fine (in safe mode): normal again */
export const clearSafe = () => write(SAFE, null);
