// Render client (distributed rendering, docs/distributed.md): RINDR opened with ?render-client. Announces itself
// every second, takes the scene of the first master that sends one, renders the buckets it is given and sends the
// accumulated linear pixels back. One bucket at a time; a new job or cancel aborts the running one.
import { HEARTBEAT_MS, gpuName } from './protocol.js';

export class RenderClient {
    /**
     * @param {{ send, onmessage, close }} transport
     * @param {{ id: string, name: string, renderer, loadScene: (state, files) => Promise<void>,
     *   renderRegion: (region, samples, options) => Promise<Float32Array>, onStatus: (status) => void }} hooks
     */
    constructor(transport, hooks) {
        this.transport = transport;
        this.hooks = hooks;
        this.id = hooks.id;
        this.master = null;        // the master this client works for
        this.sceneId = null;       // scene ready for buckets
        this.sceneFrom = null;     // the master it came from (stays after a release – the next job may reuse it)
        this.loading = null;       // scene being loaded
        this.job = null;           // { jobId, bucketId, abort }
        this.done = 0;
        transport.onmessage = msg => this._message(msg);
        this._hello();
        this._timer = setInterval(() => this._hello(), HEARTBEAT_MS);
        this._status('waiting');
    }

    _send(msg) {
        this.transport.send({ ...msg, from: this.id, to: this.master });
    }

    _hello() {
        this.transport.send({ type: 'hello', from: this.id, name: this.hooks.name, gpu: gpuName(this.hooks.renderer),
            sceneId: this.sceneId, sceneFrom: this.sceneFrom, master: this.master, busy: !!this.job });
    }

    _status(state, extra = {}) {
        this.hooks.onStatus?.({ state, master: this.master, done: this.done, ...extra });
    }

    async _message(msg) {
        if (!msg || msg.from === this.id) return;
        if (msg.type === 'release' && msg.from === this.master) {
            this.job?.abort.abort();
            this.master = null;
            this._status('waiting');
            return;
        }
        if (msg.to !== this.id) return;
        if (msg.type === 'scene') {
            if (this.master && this.master !== msg.from && this.job) return;   // busy for another master
            this.master = msg.from;
            this.job?.abort.abort();
            this.sceneId = null;
            this.sceneFrom = null;
            this.loading = msg.sceneId;
            this._status('loading');
            try {
                await this.hooks.loadScene(msg.state, msg.files || []);
                if (this.loading !== msg.sceneId) return;   // a newer scene came meanwhile
                this.sceneId = msg.sceneId;
                this.sceneFrom = msg.from;
                this.loading = null;
                // to the scene's sender (a release meanwhile – its job cancelled or done – cleared this.master)
                this.transport.send({ type: 'scene-ready', from: this.id, to: msg.from, sceneId: msg.sceneId });
                this._status('ready');
            } catch (err) {
                console.error('[Render client] scene:', err);
                this.transport.send({ type: 'scene-error', from: this.id, to: msg.from, sceneId: msg.sceneId, message: err?.message || String(err) });
                this._status('error', { message: err?.message });
            }
            this._hello();
            return;
        }
        if (msg.type === 'cancel') {
            if (!msg.jobId || this.job?.jobId === msg.jobId) this.job?.abort.abort();
            return;
        }
        if (msg.type === 'job') this._render(msg);
    }

    async _render(msg) {
        // a job on the scene this client holds binds it to that master again (after the release of the previous job)
        if (!this.master && msg.from === this.sceneFrom) this.master = msg.from;
        if (msg.from !== this.master || msg.sceneId !== this.sceneId) {
            this.transport.send({ type: 'job-error', from: this.id, to: msg.from, jobId: msg.jobId, bucketId: msg.bucket.id, message: 'scene not loaded' });
            return;
        }
        this.job?.abort.abort();
        const abort = new AbortController();
        const job = this.job = { jobId: msg.jobId, bucketId: msg.bucket.id, abort };
        const { x, y, w, h, id } = msg.bucket;
        // one bucket at a time on the path tracer: an aborted one (cancel, a new job sent right away) must have left
        // renderRegion first – two at once hung the client
        const previous = this._running;
        let finished;
        this._running = new Promise(resolve => { finished = resolve; });
        this._status('rendering', { bucket: msg.bucket });
        let last = 0;
        try {
            await previous;
            if (abort.signal.aborted) return;   // replaced while waiting
            const out = await this.hooks.renderRegion({ x, y, w, h, fullW: msg.fullW, fullH: msg.fullH }, msg.samples, {
                signal: abort.signal,
                matte: msg.matte ?? null,
                passes: msg.passes || false,
                onPartial: (data, done) => this._send({ type: 'partial', jobId: msg.jobId, bucketId: id, data, samples: done }),
                onProgress: p => {
                    this._status('rendering', { bucket: msg.bucket, progress: p });
                    const now = performance.now();
                    if (now - last < 150) return;   // a few progress messages per second are enough
                    last = now;
                    this._send({ type: 'progress', jobId: msg.jobId, bucketId: id, p });
                },
            });
            if (abort.signal.aborted) return;
            this.done++;
            // with light passes: { data, passes } (light-passes.js)
            this._send({ type: 'result', jobId: msg.jobId, bucketId: id, data: out.data ?? out, passes: out.passes });
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.error('[Render client] bucket:', err);
                this._send({ type: 'job-error', jobId: msg.jobId, bucketId: id, message: err?.message || String(err) });
            }
        } finally {
            finished();
            if (this.job === job) {
                this.job = null;
                this._status(this.sceneId ? 'ready' : 'waiting');
            }
        }
    }

    dispose() {
        clearInterval(this._timer);
        this.job?.abort.abort();
        this.transport.close();
    }
}
