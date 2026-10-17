// Worker overview for the debug overlay (only with ?debug, debug-stats.js): like a task manager – which workers the
// page started, which are still alive, how busy each one is, how much memory it holds.
//  - `Worker` is replaced by a subclass before anything starts one (first import of viewer.js): every worker is
//    recorded (name, start, end via terminate(), messages each way)
//  - load: module workers of our own origin start through a small bootstrap (blob module: worker-probe.js, then the
//    real module) – the probe reports begin/end of every message it handles; the main side turns that into busy time
//    (live, also while a long computation runs). The probe's messages never reach the page's own handlers. Its URL
//    carries the real module's URL (?base=): relative fetches inside the worker resolve against it, not the blob
//    Classic and blob workers (decoders of three.js' loaders) are not measured – messages only
//  - memory: performance.measureUserAgentSpecificMemory (cross-origin isolated, debug-stats.js) breaks the page down
//    per worker – matched by the worker's URL
// Without ?debug nothing is replaced.
import { DEBUG } from './log.js';
// own file, never a data: URL (Vite inlines small assets – the CSP of the build blocks importing data: modules)
import probeAsset from './worker-probe.js?url&no-inline';

const records = [];
const byWorker = new WeakMap();

/** All workers started so far (also ended ones), oldest first */
export function workerRecords() {
    return records;
}

/** Busy time of a record up to now (ms) */
export function busyTime(rec, now = performance.now()) {
    return rec.busyMs + (rec.busySince !== null ? now - rec.busySince : 0);
}

/** Memory per worker from a measureUserAgentSpecificMemory result (debug-stats.js) */
export function attributeWorkerMemory(result) {
    const bytes = new Map();
    for (const entry of result?.breakdown || []) {
        for (const a of entry.attribution || []) {
            if (a.scope !== 'DedicatedWorkerGlobalScope') continue;
            bytes.set(a.url, (bytes.get(a.url) || 0) + entry.bytes / entry.attribution.length);
        }
    }
    for (const rec of records) {
        const b = bytes.get(rec.blobUrl) ?? bytes.get(rec.url);
        if (b !== undefined) rec.memory = b;
    }
}

// display name: the name option, else the file without the build hash (grass-worker-Ab12cd.js → grass-worker)
function nameOf(url, options) {
    if (options?.name) return options.name;
    const file = url.split(/[?#]/)[0].split('/').pop() || url;
    return file.replace(/\.m?js$/, '').replace(/-[A-Za-z0-9_-]{6,}$/, '');
}

function install() {
    const Native = globalThis.Worker;
    const probeUrl = new URL(probeAsset, location.href).href;
    class MonitoredWorker extends Native {
        constructor(url, options) {
            const href = new URL(url, location.href).href;
            const own = options?.type === 'module' && /^https?:/.test(href) && new URL(href).origin === location.origin;
            const blobUrl = own
                ? URL.createObjectURL(new Blob([`import ${JSON.stringify(`${probeUrl}?base=${encodeURIComponent(href)}`)};\nimport ${JSON.stringify(href)};\n`], { type: 'text/javascript' }))
                : null;
            super(blobUrl ?? url, options);
            const rec = {
                name: nameOf(href, options), url: href, blobUrl, measured: own, created: performance.now(), ended: null,
                busySince: null, busyMs: 0, tasks: 0, messagesIn: 0, messagesOut: 0, memory: null, failed: false,
            };
            records.push(rec);
            byWorker.set(this, rec);
            // registered first: the probe's messages stop here (stopImmediatePropagation) before the page's handlers
            super.addEventListener('message', e => {
                const probe = e.data?.__rindrProbe;
                if (probe === undefined) { rec.messagesIn++; return; }
                e.stopImmediatePropagation();
                const now = performance.now();
                if (probe === 1 && rec.busySince === null) { rec.busySince = now; rec.tasks++; }
                else if (probe === 0 && rec.busySince !== null) { rec.busyMs += now - rec.busySince; rec.busySince = null; }
            });
            super.addEventListener('error', () => { rec.failed = true; });
        }

        postMessage(...args) {
            const rec = byWorker.get(this);
            if (rec) rec.messagesOut++;
            return super.postMessage(...args);
        }

        terminate() {
            const rec = byWorker.get(this);
            if (rec && rec.ended === null) {
                const now = performance.now();
                if (rec.busySince !== null) { rec.busyMs += now - rec.busySince; rec.busySince = null; }
                rec.ended = now;
                if (rec.blobUrl) URL.revokeObjectURL(rec.blobUrl);
            }
            return super.terminate();
        }
    }
    globalThis.Worker = MonitoredWorker;
}

if (DEBUG && typeof Worker !== 'undefined') install();
