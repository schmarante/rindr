// Master of distributed rendering (docs/distributed.md): the user's browser. Knows the render clients from their
// heartbeat, sends them the scene, hands out buckets one at a time from a queue (fast clients simply take more –
// no imbalance from expensive regions such as glass), collects the results, puts a lost client's bucket back
// into the queue. The own computer can render along as a worker of its own (in process, no transport).
//
// Buckets: square tiles of the full image, ordered from the centre outwards (the subject shows first).
import { HEARTBEAT_MS, LOST_MS, newId } from './protocol.js';

// client colours (labels of the buckets) – the own computer takes the first
export const CLIENT_COLORS = ['#38bdf8', '#f59e0b', '#a3e635', '#f472b6', '#c084fc', '#2dd4bf', '#fb7185', '#facc15'];
export const LOCAL_ID = 'local';

/** buckets of a w × h image, size s, ordered by distance of their centre from the image centre */
export function makeBuckets(w, h, s) {
    const list = [];
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) list.push({ id: list.length, x, y, w: Math.min(s, w - x), h: Math.min(s, h - y) });
    const d = b => Math.hypot(b.x + b.w / 2 - w / 2, (b.y + b.h / 2 - h / 2) * 1.2);
    return list.sort((a, b) => d(a) - d(b));
}

export class RenderMaster {
    /**
     * @param {{ send, onmessage, close }} transport
     * @param {{ captureScene: () => Promise<{ state, files }>, local: { name: string,
     *   renderRegion: (region, samples, options) => Promise<Float32Array> }, onBucket: (bucket, data) => void,
     *   onChange: () => void, onDone: (stats) => void }} hooks
     */
    constructor(transport, hooks) {
        this.transport = transport;
        this.hooks = hooks;
        this.id = newId();
        // id → { id, name, gpu, lastSeen, sceneId, lost, color, bucket, done, busyOther, transfer }; transfer while the scene
        // goes to the client: { sent, total } bytes – sent = total (or nothing to follow, tabs): the client loads it
        this.clients = new Map();
        this.renderLocal = true;
        this.job = null;            // { jobId, sceneId, fullW, fullH, samples, queue, pending: Map(bucketId → info), done, total, t0 }
        this._colorSeq = 1;
        transport.onmessage = msg => this._message(msg);
        transport.onpeerclosed = id => this.drop(id);
        this._timer = setInterval(() => this._watch(), HEARTBEAT_MS);
    }

    /** a client whose connection closed (computer in the network): its bucket goes back into the queue, it leaves the list */
    drop(id) {
        const c = this.clients.get(id);
        if (!c) return;
        this._requeue(c);
        this.clients.delete(id);
        this._dispatch();
        this.hooks.onChange?.();
    }

    /** clients for the settings list (own computer first while it renders along) */
    list() {
        const now = performance.now();
        return [...this.clients.values()].map(c => ({ ...c, online: !c.lost && now - c.lastSeen < LOST_MS }));
    }

    get running() {
        return !!this.job && !this.job.finished;
    }

    _send(to, msg, options) {
        this.transport.send({ ...msg, from: this.id, to }, options);
    }

    _client(id) {
        return this.clients.get(id);
    }

    _message(msg) {
        if (!msg || msg.from === this.id) return;
        if (msg.type === 'hello') {
            let c = this.clients.get(msg.from);
            if (!c) {
                c = { id: msg.from, color: CLIENT_COLORS[this._colorSeq++ % CLIENT_COLORS.length], done: 0, bucket: null, sceneId: null };
                this.clients.set(msg.from, c);
            }
            const wasLost = c.lost;
            Object.assign(c, { name: msg.name, gpu: msg.gpu, lastSeen: performance.now(), lost: false, busyOther: !!msg.master && msg.master !== this.id });
            c.sceneId = msg.master === this.id || msg.sceneFrom === this.id ? msg.sceneId : null;
            // a running job: a new (or returning) free client gets the scene
            if (this.running && !c.busyOther && c.sceneId !== this.job.sceneId && !c.sending) this._sendScene(c);
            if (wasLost || this.running) this._dispatch();
            this.hooks.onChange?.();
            return;
        }
        if (msg.to !== this.id) return;
        const c = this._client(msg.from);
        if (!c) return;
        const job = this.job;
        if (msg.type === 'scene-ready') {
            c.sending = false;
            c.transfer = null;
            c.sceneId = msg.sceneId;
            this._dispatch();
        } else if (msg.type === 'scene-error') {
            c.sending = false;
            c.transfer = null;
            c.error = msg.message;
            this.hooks.onChange?.();
        } else if (!job || msg.jobId !== job.jobId) {
            return;
        } else if (msg.type === 'progress') {
            const p = job.pending.get(msg.bucketId);
            if (p && p.client === c.id) { p.progress = msg.p; this.hooks.onChange?.(); }
        } else if (msg.type === 'partial') {
            const p = job.pending.get(msg.bucketId);
            if (p && p.client === c.id) this.hooks.onBucket(p.bucket, msg.data, false);   // preview, the final one follows
        } else if (msg.type === 'result') {
            this._result(c, msg.bucketId, msg.data);
        } else if (msg.type === 'job-error') {
            console.warn(`[Distributed] ${c.name}: bucket ${msg.bucketId} failed – ${msg.message}`);
            this._requeue(c);
            this._dispatch();
        }
    }

    /** heartbeat check: lost clients give their bucket back */
    _watch() {
        const now = performance.now();
        let changed = false;
        for (const c of this.clients.values()) {
            if (c.lost || now - c.lastSeen < LOST_MS) continue;
            c.lost = true;
            c.sceneId = null;
            c.transfer = null;
            changed = true;
            this._requeue(c);
        }
        if (changed) { this._dispatch(); this.hooks.onChange?.(); }
    }

    async _sendScene(c) {
        c.sending = true;
        const transfer = c.transfer = { sent: 0, total: 0 };
        this.hooks.onChange?.();
        try {
            const { state, files } = await this.job.scene;
            this._send(c.id, { type: 'scene', sceneId: this.job.sceneId, state, files }, {
                onProgress: (sent, total) => {
                    if (c.transfer !== transfer) return;   // done, cancelled or sent anew
                    transfer.sent = sent;
                    transfer.total = total;
                    this.hooks.onChange?.();
                },
            });
        } catch (err) {
            c.sending = false;
            c.transfer = null;
            console.error('[Distributed] scene:', err);
        }
    }

    /**
     * Start a job: full image fullW × fullH, samples per pixel, bucket size; matte: grey value of a plain background
     * (passes of a transparent image) or null. The scene goes to every free client – keepScene: the scene of the job
     * before (unchanged – e.g. the second pass of a transparent image), clients holding it start at once. The own
     * computer starts at once when it renders along.
     */
    start({ fullW, fullH, samples, bucketSize, matte = null, keepScene = false }) {
        const previous = keepScene ? this.job : null;
        this.cancel();
        const queue = makeBuckets(fullW, fullH, bucketSize);
        this.job = { jobId: newId(), sceneId: previous?.sceneId ?? newId(), fullW, fullH, samples, matte, queue, pending: new Map(), done: 0,
            total: queue.length, t0: performance.now(), finished: false, scene: previous?.scene ?? this.hooks.captureScene(), perClient: new Map() };
        for (const c of this.clients.values()) {
            c.bucket = null;
            c.done = 0;
            if (!c.lost && !c.busyOther && c.sceneId !== this.job.sceneId) this._sendScene(c);
        }
        this.hooks.onChange?.();
        this._dispatch();
    }

    cancel() {
        const job = this.job;
        if (!job) return;
        job.finished = true;
        this._localAbort?.abort();
        for (const c of this.clients.values()) {
            if (c.bucket) this._send(c.id, { type: 'cancel', jobId: job.jobId });
            c.bucket = null;
            c.transfer = null;
        }
        this.transport.send({ type: 'release', from: this.id });
        this.job = null;
        this.hooks.onChange?.();
    }

    /** hand out buckets to every idle worker (clients with the scene; the own computer) */
    _dispatch() {
        const job = this.job;
        if (!job || job.finished) return;
        if (this.renderLocal && !this._localBusy && job.queue.length) this._renderLocal();
        for (const c of this.clients.values()) {
            if (!job.queue.length) break;
            if (c.lost || c.busyOther || c.bucket || c.sceneId !== job.sceneId) continue;
            const bucket = job.queue.shift();
            c.bucket = bucket;
            job.pending.set(bucket.id, { bucket, client: c.id, progress: 0, color: c.color, name: c.name });
            this._send(c.id, { type: 'job', jobId: job.jobId, sceneId: job.sceneId, bucket, fullW: job.fullW, fullH: job.fullH, samples: job.samples, matte: job.matte });
        }
        this.hooks.onChange?.();
    }

    _requeue(c) {
        const job = this.job;
        if (!c.bucket) return;
        if (job && !job.finished && job.pending.get(c.bucket.id)?.client === c.id) {
            job.pending.delete(c.bucket.id);
            job.queue.unshift(c.bucket);   // first in line again
        }
        c.bucket = null;
    }

    _result(c, bucketId, data) {
        const job = this.job;
        const p = job.pending.get(bucketId);
        if (!p || p.client !== c.id) return;   // late result of a bucket that went to someone else
        job.pending.delete(bucketId);
        c.bucket = null;
        c.done++;
        job.done++;
        job.perClient.set(c.id, (job.perClient.get(c.id) || 0) + 1);
        this.hooks.onBucket(p.bucket, data);
        if (job.done === job.total) this._finish();
        else this._dispatch();
    }

    async _renderLocal() {
        const job = this.job;
        this._localBusy = true;
        const abort = this._localAbort = new AbortController();
        const self = { id: LOCAL_ID, name: this.hooks.local.name, color: CLIENT_COLORS[0] };
        try {
            while (this.renderLocal && !job.finished && job.queue.length && !abort.signal.aborted) {
                const bucket = job.queue.shift();
                const info = { bucket, client: LOCAL_ID, progress: 0, color: self.color, name: self.name };
                job.pending.set(bucket.id, info);
                this.hooks.onChange?.();
                let data;
                try {
                    data = await this.hooks.local.renderRegion({ x: bucket.x, y: bucket.y, w: bucket.w, h: bucket.h, fullW: job.fullW, fullH: job.fullH },
                        job.samples, { signal: abort.signal, matte: job.matte, onProgress: p => { info.progress = p; this.hooks.onChange?.(); },
                            onPartial: partial => { if (!job.finished) this.hooks.onBucket(bucket, partial, false); } });
                } catch (err) {
                    job.pending.delete(bucket.id);
                    if (!job.finished) job.queue.unshift(bucket);
                    if (err?.name !== 'AbortError') {
                        console.error('[Distributed] own bucket:', err?.message || err);
                        this.renderLocal = false;   // do not retry endlessly – the clients carry on
                        this.hooks.onLocalError?.(err);
                    }
                    break;
                }
                if (job.finished) break;
                job.pending.delete(bucket.id);
                job.done++;
                job.perClient.set(LOCAL_ID, (job.perClient.get(LOCAL_ID) || 0) + 1);
                this.localDone = (this.localDone || 0) + 1;
                this.hooks.onBucket(bucket, data);
                if (job.done === job.total) { this._finish(); break; }
                this._dispatch();
            }
        } finally {
            this._localBusy = false;
        }
    }

    _finish() {
        const job = this.job;
        job.finished = true;
        job.ms = performance.now() - job.t0;
        this.transport.send({ type: 'release', from: this.id });
        for (const c of this.clients.values()) c.bucket = null;
        this.hooks.onDone?.({ ms: job.ms, buckets: job.total, perClient: job.perClient });
        this.hooks.onChange?.();
    }

    /** own computer renders along (switch in the settings) – takes effect for the next bucket */
    setRenderLocal(on) {
        this.renderLocal = on;
        if (!on) this._localAbort?.abort();
        else this._dispatch();
    }

    dispose() {
        this.cancel();
        clearInterval(this._timer);
        this.transport.close();
    }
}
