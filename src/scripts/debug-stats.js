// Debug overlay (only with ?debug): fps, memory, polygons, draw calls – right column, bottom.
//
// - fps / ms: frames of the render loop per second, CPU time per frame (average over 0.1 s)
//   below: split of that time – scene renders (main image, highlight mask, contact shadow, section caps …),
//   shadow maps (renders nested in the main render), sync (render-batcher.js compare), rest (everything else)
// - GPU used: renderer.info.memory (buffers + textures managed by three.js incl. path tracer
//   storage buffers = "PT"). WebGPU does not expose the total VRAM (fingerprinting protection).
// - RAM: preferably measureUserAgentSpecificMemory (see below), otherwise performance.memory (Chromium only,
//   includes ArrayBuffer data; without --enable-precise-memory-info rounded and cached for up to 20 min per
//   renderer process – even across reloads). The limit that matters: all JS heaps of a tab
//   (main thread + all workers) share ONE 4 GB range in Chrome. With cross-origin isolation
//   every 5 s the whole page incl. workers (measureUserAgentSpecificMemory); device = navigator.deviceMemory
//   (rounded by the browser, Chrome at most 8 GB).
// - Polygons: triangles of the model (counted per instance) total / visible, unique geometry;
//   drawn = triangles + draw calls in the last frame (all passes: shadows, highlight, gizmo …).
// - Workers (worker-monitor.js): like a task manager – alive / started so far / CPU cores, per alive worker a tile
//   (four per row) with a half-circle gauge in the preloader's blue filled by its load over the last update (busy
//   time handling messages), name, messages handled, memory (with the page measurement; details as tooltip);
//   workers of three.js' loaders (classic/blob) without load (empty gauge). Ended ones summed up.
// - "Measure duplicates" (button): geometries identical in shape that are still stored separately
//   (duplicate-scan.js) – would a hash-based instancer pay off? Details in the console.

import { t } from './i18n.js';
import { workerRecords, busyTime, attributeWorkerMemory } from './worker-monitor.js';

const MB = 1024 * 1024;
const WORKER_TILES = 16;   // workers shown at most (a STEP import starts one per core)
const UPDATE_MS = 100;     // text and gauges refreshed this often
// half circle of the worker gauges (pathLength 100: dash = load in %)
const GAUGE_ARC = 'M6 30A24 24 0 0 1 54 30';
const fmtMB = b => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(2)} GB` : `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`);
const fmtN = n => (n >= 1e6 ? t('debugStats.millions', { value: (n / 1e6).toFixed(2) }) : n >= 1e4 ? t('debugStats.thousands', { value: (n / 1e3).toFixed(0) }) : String(Math.round(n)));

export class DebugStats {
    /**
     * @param {HTMLElement} root
     * @param {object} ctx  { renderer, adapter, getRoot(), getPhase(), scanUnits() }
     */
    constructor(root, { renderer, adapter, getRoot, getPhase, scanUnits, getTiming }) {
        this.root = root;
        this.renderer = renderer;
        this.getRoot = getRoot;
        this.getTiming = getTiming;
        this.getPhase = getPhase || (() => '');
        this.lastFrame = 0;
        root.hidden = false;
        root.className = 'pointer-events-auto shrink-0 rounded-lg bg-black/60 px-3 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-white/85 backdrop-blur-sm';
        this.text = document.createElement('div');
        // workers: summary, tiles with gauges (four per row), more/ended below
        this.workerBox = document.createElement('div');
        this.workerHead = document.createElement('div');
        this.workerGrid = document.createElement('div');
        this.workerGrid.className = 'mt-1 grid grid-cols-4 gap-x-1 gap-y-1.5 whitespace-nowrap';
        this.workerFoot = document.createElement('div');
        this.workerBox.append(this.workerHead, this.workerGrid, this.workerFoot);
        this.workerTiles = new Map();
        this.scanText = document.createElement('div');
        this.scanText.className = 'mt-1 border-t border-white/15 pt-1';
        this.scanButton = document.createElement('button');
        this.scanButton.type = 'button';
        this.scanButton.className = 'mt-1 cursor-pointer rounded bg-white/10 px-2 py-0.5 hover:bg-white/20 disabled:cursor-default disabled:opacity-50';
        this.scanButton.textContent = t('debugStats.scan.button');
        this.scanButton.addEventListener('click', () => this._scan(scanUnits));
        root.append(this.text, this.workerBox, this.scanText, this.scanButton);
        this.scanText.hidden = true;
        const info = adapter?.info;
        this.gpuName = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU' : t('debugStats.noWebGpu');
        this.maxBuffer = adapter?.limits.maxBufferSize || 0;
        this.frames = 0;
        this.cpu = 0;
        this.t0 = performance.now();
        this.fps = 0;
        this.ms = 0;
        this.poly = null;
        this.polyTime = 0;
        this.pageMemory = null;
        this._measurePage();
    }

    /** call at the end of every frame of the render loop (cpuMs = duration of the pass) */
    frame(cpuMs) {
        this.frames++;
        this.cpu += cpuMs;
        // breakdown of this frame (ctx.getTiming: renders of the scene incl. shadow maps, comparison)
        const tm = this.getTiming?.();
        if (tm) {
            this.split ??= { render: 0, nested: 0, sync: 0, n: 0 };
            this.split.render += tm.render; this.split.nested += tm.nested; this.split.sync += tm.sync; this.split.n++;
        }
        const now = performance.now();
        // Stall reporter: pause between two frames > 250 ms (main thread OR GPU process blocked –
        // then the browser delivers no frames) with the phase before/after in the console
        const gap = this.lastFrame ? now - this.lastFrame : 0;
        const phase = this.getPhase();
        if (gap > 250 && !document.hidden) {
            console.info(`[Stall] ${gap.toFixed(0)} ms without a frame – phase before: ${this.lastPhase || '-'}, now: ${phase || '-'} (CPU in this frame ${cpuMs.toFixed(0)} ms)`);
        }
        this.lastFrame = now;
        this.lastPhase = phase;
        const dt = now - this.t0;
        if (dt < UPDATE_MS) return;
        this.fps = this.frames * 1000 / dt;
        this.ms = this.cpu / this.frames;
        if (this.split?.n) {
            const n = this.split.n;
            this.cpuSplit = { scene: (this.split.render - this.split.sync) / n, shadow: this.split.nested / n, sync: this.split.sync / n };
            this.split = null;
        }
        this.frames = 0;
        this.cpu = 0;
        this.t0 = now;
        // count model triangles at most twice per second (large models: tens of thousands of meshes)
        if (now - this.polyTime > 500) { this.polyTime = now; this.poly = this._countPolygons(); }
        this._render();
    }

    _countPolygons() {
        const root = this.getRoot();
        if (!root) return null;
        let total = 0, visible = 0, unique = 0, meshes = 0;
        const seen = new Set();
        const walk = (o, shown) => {
            shown = shown && o.visible;
            if (o.isMesh && o.geometry) {
                const g = o.geometry;
                const n = (g.index ? g.index.count : g.getAttribute('position')?.count || 0) / 3;
                total += n;
                meshes++;
                if (shown) visible += n;
                if (!seen.has(g)) { seen.add(g); unique += n; }
            }
            for (const c of o.children) walk(c, shown);
        };
        walk(root, true);
        return { total, visible, unique, meshes };
    }

    async _scan(scanUnits) {
        const units = scanUnits?.() || [];
        this.scanText.hidden = false;
        if (!units.length) { this.scanText.textContent = t('debugStats.scan.noModel'); return; }
        this.scanButton.disabled = true;
        try {
            const { scanDuplicates } = await import('./duplicate-scan.js');
            const r = await scanDuplicates(units, {
                onProgress: (done, total) => { this.scanText.textContent = t('debugStats.scan.progress', { done, total }); },
            });
            const pct = n => (r.triangles ? (100 * n / r.triangles).toFixed(1) : '0');
            this.scanText.textContent = [
                t('debugStats.scan.units', { units: fmtN(r.units), instances: fmtN(r.instances), triangles: fmtN(r.triangles) }),
                t('debugStats.scan.duplicates', { count: fmtN(r.duplicates), groups: r.groups, triangles: fmtN(r.savedTriangles), percent: pct(r.savedTriangles) }),
                t('debugStats.scan.mirrored', { count: fmtN(r.mirrored), triangles: fmtN(r.savedMirrored), percent: pct(r.savedMirrored) }),
                t('debugStats.scan.isotropic', { count: fmtN(r.isotropic) }),
                t('debugStats.scan.time', { ms: r.ms.toFixed(0) }),
            ].join('\n');
            console.info('[Duplicates]', r);
            console.table(r.top.slice(0, 30));
        } catch (err) {
            console.error(err);
            this.scanText.textContent = err.message;
        } finally {
            this.scanButton.disabled = false;
        }
    }

    async _measurePage() {
        if (!globalThis.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return;
        try {
            const r = await performance.measureUserAgentSpecificMemory();
            this.pageMemory = r.bytes;
            attributeWorkerMemory(r);
        } catch { return; }
        setTimeout(() => this._measurePage(), 5000);
    }

    _render() {
        const { info } = this.renderer;
        const m = info.memory;
        const lines = [];
        lines.push(t('debugStats.fps', { fps: this.fps.toFixed(0), ms: this.ms.toFixed(1) }));
        if (this.cpuSplit) {
            const c = this.cpuSplit;
            // scene renders include the nested shadow renders – shown separately
            lines.push(t('debugStats.cpuSplit', { scene: (c.scene - c.shadow).toFixed(1), shadow: c.shadow.toFixed(1), sync: c.sync.toFixed(1), rest: Math.max(0, this.ms - c.scene - c.sync).toFixed(1) }));
        }
        lines.push(t('debugStats.gpu', { name: this.gpuName }));
        lines.push(t('debugStats.gpuUsed', { size: fmtMB(m.total) }));
        lines.push(t('debugStats.gpuBreakdown', { geometry: fmtMB(m.attributesSize + m.indexAttributesSize), textures: fmtMB(m.texturesSize), storage: fmtMB(m.storageAttributesSize) }));
        lines.push(this.maxBuffer ? t('debugStats.gpuTotalMaxBuffer', { size: fmtMB(this.maxBuffer) }) : t('debugStats.gpuTotal'));
        const heap = performance.memory;
        // Exact: measureUserAgentSpecificMemory (whole page incl. workers, every 5 s). performance.memory
        // is rounded without --enable-precise-memory-info and cached for up to 20 min – per
        // renderer process, i.e. even across a reload of the tab (then shows old values).
        const device = navigator.deviceMemory ? t('debugStats.device', { gb: navigator.deviceMemory }) : '';
        if (this.pageMemory != null) lines.push(t('debugStats.ramPage', { size: fmtMB(this.pageMemory), device }));
        else lines.push(heap ? t('debugStats.ramHeap', { size: fmtMB(heap.usedJSHeapSize), device }) : t('debugStats.ramNone', { device }));
        const p = this.poly;
        if (p) {
            lines.push(t('debugStats.triangles', { total: fmtN(p.total), visible: fmtN(p.visible) }));
            lines.push(t('debugStats.unique', { unique: fmtN(p.unique), meshes: fmtN(p.meshes) }));
        }
        lines.push(t('debugStats.frame', { triangles: fmtN(info.render.triangles), drawCalls: info.render.drawCalls }));
        this.text.textContent = lines.join('\n');
        this._renderWorkers();
    }

    // task manager of the workers: load = share of the time since the last update spent handling messages
    _renderWorkers() {
        const records = workerRecords(), now = performance.now();
        const prev = this._workerBusy ?? new Map(), prevTime = this._workerTime ?? now;
        const span = Math.max(now - prevTime, 1);
        this._workerBusy = new Map(records.map(r => [r, busyTime(r, now)]));
        this._workerTime = now;
        const alive = records.filter(r => r.ended === null), ended = records.length - alive.length;
        this.workerHead.textContent = t('debugStats.workers.summary', { alive: alive.length, total: records.length, cores: navigator.hardwareConcurrency || '?' });
        // the same name several times (pool): numbered
        const count = new Map(), seen = new Map();
        for (const r of alive) count.set(r.name, (count.get(r.name) || 0) + 1);
        const shown = alive.slice(0, WORKER_TILES);
        for (const r of shown) {
            const n = (seen.get(r.name) || 0) + 1;
            seen.set(r.name, n);
            const load = r.measured ? Math.min(1, Math.max(0, (busyTime(r, now) - (prev.get(r) ?? busyTime(r, prevTime))) / span)) : null;
            this._updateTile(r, count.get(r.name) > 1 ? `${r.name} #${n}` : r.name, load);
        }
        // tiles of ended workers go; re-ordered only when the set changed (moving a node restarts its transition)
        for (const [r, tile] of this.workerTiles) if (!shown.includes(r)) { tile.root.remove(); this.workerTiles.delete(r); }
        const tiles = shown.map(r => this.workerTiles.get(r).root);
        if (tiles.some((el, i) => this.workerGrid.children[i] !== el)) this.workerGrid.replaceChildren(...tiles);
        this.workerGrid.hidden = !tiles.length;
        const foot = [];
        if (alive.length > WORKER_TILES) foot.push(t('debugStats.workers.more', { count: alive.length - WORKER_TILES }));
        if (ended) {
            const busy = records.filter(r => r.ended !== null).reduce((s, r) => s + r.busyMs, 0);
            foot.push(t('debugStats.workers.ended', { count: ended, seconds: (busy / 1000).toFixed(1) }));
        }
        this.workerFoot.textContent = foot.join('\n');
        this.workerFoot.hidden = !foot.length;
    }

    // one worker: half-circle gauge with the load in %, name, tasks (or messages) · memory below
    _updateTile(r, label, load) {
        let tile = this.workerTiles.get(r);
        if (!tile) {
            const root = document.createElement('div');
            root.className = 'min-w-0 text-center';
            root.innerHTML = `<svg viewBox="0 0 60 34" class="mx-auto block w-full max-w-16">`
                + `<path d="${GAUGE_ARC}" pathLength="100" fill="none" stroke-width="7" class="stroke-white/15"/>`
                + `<path d="${GAUGE_ARC}" pathLength="100" fill="none" stroke-width="7" class="stroke-sky-500 transition-[stroke-dasharray] duration-100 ease-linear" style="stroke-dasharray:0 100"/>`
                + `<text x="30" y="31" text-anchor="middle" class="fill-white/90 text-[11px]"></text></svg>`
                + '<div class="truncate"></div><div class="truncate text-[9px] text-white/55"></div>';
            const [, fill] = root.querySelectorAll('path');
            const [name, sub] = root.querySelectorAll('div');
            tile = { root, fill, value: root.querySelector('text'), name, sub };
            this.workerTiles.set(r, tile);
        }
        const memory = r.memory != null ? fmtMB(r.memory) : '–';
        const pct = load === null ? null : Math.round(load * 100);
        tile.fill.style.strokeDasharray = `${pct ?? 0} 100`;
        tile.value.textContent = pct === null ? '–' : `${pct}%`;
        tile.name.textContent = label;
        tile.sub.textContent = pct === null
            ? t('debugStats.workers.messages', { messages: fmtN(r.messagesIn + r.messagesOut), memory })
            : t('debugStats.workers.tasks', { tasks: fmtN(r.tasks), memory });
        tile.root.title = pct === null
            ? t('debugStats.workers.unmeasured', { name: label, messages: fmtN(r.messagesIn + r.messagesOut), memory })
            : t('debugStats.workers.row', { name: label, load: pct, tasks: fmtN(r.tasks), memory });
    }
}
