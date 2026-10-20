// Node editor for materials (free window like the HDRI editor, float-window.js).
//  - All node types as a list on the left, by category: click = add, drag onto the canvas = add there
//  - Preview in the node (texture, colour and value nodes: one tile of the result; output: the material sphere),
//    eye in the header folds it away
//  - Move nodes by their header, pan the view by dragging the background
//  - Link: drag from an output (right) to an input (left); dragging an input detaches it
//  - Clicking a link deletes it; × deletes a node
//  - Unconnected inputs show their value directly in the node
import {
    NODE_TYPES, NODE_CATEGORIES, IMPORT_SLOTS, createGraph, createImportGraph, defaultParams,
    nodeLabel, portLabel, paramLabel, optionLabel, categoryLabel,
} from './material-graph.js';
import { mapLabel } from './material-panel.js';
import { t } from './i18n.js';
import { colorField } from './ui-controls.js';
import { floatWindow } from './float-window.js';
import { materialType, typeAllowsGraph } from './material-types.js';


const ICON_WARNING = '<svg viewBox="0 0 20 20" class="size-3.5 shrink-0 fill-amber-400"><path d="M10 2.2 1.3 17.3h17.4L10 2.2Zm-.9 5.3h1.8v4.9H9.1V7.5Zm0 6.3h1.8v1.8H9.1v-1.8Z"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 4V12.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H8L6.5 2.5h-4a1 1 0 0 0-1 1z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>';
const PREVIEW_SIZE = 256;   // baked preview edge length (px)
const NO_PREVIEW = new Set(['value', 'color']);   // show their content directly
const NODE_MIME = 'application/x-rindr-node';   // node type dragged from the list
const PORT_COLORS = { float: 'bg-violet-300', color: 'bg-amber-300', vector: 'bg-teal-300' };
const INPUT = 'w-14 flex-none rounded bg-white/10 px-1 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';

export class NodeEditor {
    /**
     * @param {HTMLElement} root
     * @param {import('./material-manager.js').MaterialManager} manager
     * @param {{ preview?: (def, nodeId, port, size) => Promise<{ size, pixels } | { color } | null>,
     *           materialThumb?: (id, size) => string|null, onThumbReady?: (cb) => void,
     *           downloadTexture?: (url) => void, linkFiles?: (files: { path, file }[]) => void }} [hooks]
     *        preview: bake one node output (graph-apply.js); materialThumb: the material's sphere image (output node);
     *        downloadTexture / linkFiles: an image from the file that is missing – load it from its server / link a file
     */
    constructor(root, manager, hooks = {}) {
        this.root = root;
        this.manager = manager;
        this.hooks = hooks;
        this.previews = new Map();       // node ID -> preview element (kept across re-renders)
        this.hiddenPreviews = new Map(); // material ID -> Set of node IDs with folded preview (this session)
        this.previewRun = 0;
        hooks.onThumbReady?.(() => this._updateOutputPreview());
        // material previews wait while a mouse button is held (material-panel.js) – ask again on release
        window.addEventListener('pointerup', () => { if (this.isOpen) this._updateOutputPreview(); });
        this.materialId = null;
        this.graph = null;
        this.pan = { x: 0, y: 0 };
        this.drag = null;

        root.innerHTML = `
            <div data-head class="flex shrink-0 cursor-move items-center gap-2 border-b border-white/10 px-3 py-1.5">
                <span data-title class="font-medium"></span>
                <button data-close class="ml-auto flex items-center rounded px-2 py-1 text-white/80 hover:bg-white/15" title="${t('nodeEditor.closeTitle')}">${ICON_CLOSE}</button>
            </div>
            <div class="flex min-h-0 flex-1">
                <div data-add class="w-40 shrink-0 overflow-y-auto border-r border-white/10 px-1.5 py-1.5"></div>
                <div data-canvas class="relative min-w-0 flex-1 cursor-grab overflow-hidden"
                     style="background-image: radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px); background-size: 20px 20px;">
                    <div data-world class="absolute top-0 left-0 size-0">
                        <svg data-wires class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1"></svg>
                    </div>
                </div>
            </div>
        `;
        this.title = root.querySelector('[data-title]');
        this.canvas = root.querySelector('[data-canvas]');
        this.world = root.querySelector('[data-world]');
        this.wires = root.querySelector('[data-wires]');
        this.window = floatWindow(root, root.querySelector('[data-head]'), { storeKey: 'rindr.nodeEditor.window', width: 1100, height: 580, minWidth: 480, minHeight: 240,
            clearOf: () => document.getElementById('materials') });
        this.window.apply();

        // node list on the left, by category (click = add, drag onto the canvas = add at the drop point)
        const add = root.querySelector('[data-add]');
        for (const cat of NODE_CATEGORIES) {
            const types = Object.entries(NODE_TYPES).filter(([, def]) => def.category === cat);
            if (!types.length) continue;
            const group = document.createElement('div');
            group.className = 'mb-2';
            const head = document.createElement('div');
            head.className = 'px-1.5 pb-0.5 text-white/40';
            head.textContent = categoryLabel(cat);
            group.append(head);
            for (const [type, def] of types) {
                const b = document.createElement('button');
                b.className = 'block w-full truncate rounded px-1.5 py-0.5 text-left text-white/80 hover:bg-white/15';
                // the image from the model file: "Image (from the file)" next to the plain "Image"
                b.textContent = def.importOnly ? t('nodeEditor.imageFromFileNode') : nodeLabel(type);
                b.title = b.textContent;   // the list is narrow
                b.draggable = true;
                b.onclick = () => this.addNode(type);
                b.ondragstart = e => { e.dataTransfer.setData(NODE_MIME, type); e.dataTransfer.effectAllowed = 'copy'; };
                if (def.importOnly) b.dataset.importOnly = '';
                group.append(b);
            }
            add.append(group);
        }
        this.canvas.addEventListener('dragover', e => {
            if (!e.dataTransfer.types.includes(NODE_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        this.canvas.addEventListener('drop', e => {
            const type = e.dataTransfer.getData(NODE_MIME);
            if (!type || !NODE_TYPES[type]) return;
            e.preventDefault();
            const r = this.canvas.getBoundingClientRect();
            this.addNode(type, { x: e.clientX - r.left - this.pan.x - 90, y: e.clientY - r.top - this.pan.y - 14 });
        });
        root.querySelector('[data-close]').onclick = () => this.close();
        this.canvas.addEventListener('pointerdown', e => this._onPointerDown(e));
        window.addEventListener('pointermove', e => this._onPointerMove(e));
        window.addEventListener('pointerup', e => this._onPointerUp(e));
        manager.addEventListener('change', () => {
            if (this.materialId && !manager.get(this.materialId)) this.close();
            else if (this.materialId) this.title.textContent = t('nodeEditor.title', { name: manager.get(this.materialId).def.name });
        });
        // undo/redo: take the graph over from the material again (view stays)
        manager.addEventListener('update', e => {
            if (e.detail?.id !== this.materialId) return;
            // switched to a type without node editor (cloud, wool, ...): nothing to edit here
            if (!typeAllowsGraph(materialType(manager.get(this.materialId)?.def.params))) { this.close(); return; }
            if (!e.detail.restored && !e.detail.linked) return;
            const graph = manager.get(this.materialId).def.graph;
            this.drag = null;
            this.graph = graph ? structuredClone(graph) : createGraph();
            this.render();
        });
    }

    get isOpen() {
        return !this.root.hidden;
    }

    open(materialId) {
        const entry = this.manager.get(materialId);
        if (!entry || !typeAllowsGraph(materialType(entry.def.params))) { if (entry) this.close(); return; }
        if (materialId !== this.materialId) this.previews.clear();
        this.materialId = materialId;
        const hasImport = Object.keys(this._importMaps()).length > 0 || Object.keys(this._missingMaps()).length > 0;
        this.graph = entry.def.graph ? structuredClone(entry.def.graph)
            : hasImport ? createImportGraph(this._importMaps(), this._missingMaps()) : createGraph();
        // offer the image from the file only for materials with textures from the file
        this.root.querySelectorAll('[data-import-only]').forEach(b => { b.hidden = !hasImport; });
        this.title.textContent = t('nodeEditor.title', { name: entry.def.name });
        this.root.hidden = false;
        this.window.apply();
        // output on the right of the visible area
        const out = this.graph.nodes.find(n => n.type === 'output');
        const w = this.canvas.clientWidth || 900;
        this.pan = { x: out ? w - out.x - 240 : 0, y: 0 };
        this.render();
    }

    // textures of the imported file addressable by the graph (map key -> texture)
    _importMaps() {
        const maps = this.manager.get(this.materialId)?.def.render?.maps || {};
        return Object.fromEntries(Object.entries(maps).filter(([k]) => IMPORT_SLOTS[k]));
    }

    // images the file names that are missing (map key -> { url, … })
    _missingMaps() {
        const missing = this.manager.get(this.materialId)?.def.render?.missing || {};
        return Object.fromEntries(Object.entries(missing).filter(([k]) => IMPORT_SLOTS[k]));
    }

    close() {
        this.root.hidden = true;
        this.materialId = null;
        this.graph = null;
        this.previews.clear();
    }

    /** Add a node of `type` – at `at` (world coordinates, e.g. the drop point) or on a free spot of the view */
    addNode(type, at = null) {
        if (!this.graph) return;
        const id = type + '-' + Math.random().toString(36).slice(2, 8);
        // find a free spot in the grid (columns of 210 px, rows of 150 px)
        const taken = this.graph.nodes.map(n => [n.x, n.y]);
        let x = 0, y = 0;
        search: for (let i = 0; !at && i < 40; i++) {
            x = -this.pan.x + 30 + (i % 4) * 210;
            y = -this.pan.y + 20 + Math.floor(i / 4) * 150;
            for (const [tx, ty] of taken) if (Math.abs(tx - x) < 200 && Math.abs(ty - y) < 140) continue search;
            break;
        }
        if (at) { x = Math.round(at.x); y = Math.round(at.y); }
        const params = defaultParams(type);
        if (type === 'importMap') params.map = Object.keys(this._importMaps())[0] ?? Object.keys(this._missingMaps())[0] ?? params.map;
        this.graph.nodes.push({ id, type, x, y, params });
        this.render();
        this.commit();
    }

    removeNode(id) {
        this.graph.nodes = this.graph.nodes.filter(n => n.id !== id);
        this.graph.links = this.graph.links.filter(l => l.from.node !== id && l.to.node !== id);
        this.render();
        this.commit();
    }

    // hand the graph to the material (triggers evaluation/baking)
    commit(mergeKey) {
        if (this.materialId) this.manager.setGraph(this.materialId, structuredClone(this.graph), mergeKey);
        this._schedulePreviews();
    }

    // --- Rendering ---

    render() {
        this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
        this.world.querySelectorAll('[data-node]').forEach(n => n.remove());
        const linked = new Set(this.graph.links.map(l => l.to.node + ':' + l.to.port));
        for (const n of this.graph.nodes) this.world.append(this._nodeEl(n, linked));
        this._renderWires();
        this._schedulePreviews();
    }

    _nodeEl(n, linked) {
        const type = NODE_TYPES[n.type];
        const el = div('absolute w-48 rounded-md bg-neutral-800 shadow-lg ring-1 ring-white/10');
        el.dataset.node = n.id;
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';

        const head = div(`flex cursor-move items-center justify-between rounded-t-md px-2 py-1 font-medium ${type.color}`);
        head.dataset.handle = 'move';
        head.append(span('min-w-0 flex-1 truncate', nodeLabel(n.type)));
        const previewPort = this._previewPort(n);
        const folded = this.hiddenPreviews.get(this.materialId)?.has(n.id);
        if (previewPort) {
            const eye = document.createElement('button');
            eye.className = 'rounded p-0.5 text-white/60 hover:bg-black/30 hover:text-white';
            eye.innerHTML = folded ? ICON_EYE_OFF : ICON_EYE;
            eye.title = t(folded ? 'nodeEditor.showPreview' : 'nodeEditor.hidePreview');
            eye.onclick = () => this._togglePreview(n.id);
            head.append(eye);
        }
        if (n.type !== 'output') {
            const x = document.createElement('button');
            x.className = 'rounded px-1 text-white/70 hover:bg-black/30 hover:text-white';
            x.textContent = '×';
            x.title = t('nodeEditor.deleteNode');
            x.onclick = () => this.removeNode(n.id);
            head.append(x);
        }
        el.append(head);
        if (previewPort && !folded) el.append(this._previewEl(n));

        const body = div('flex flex-col gap-1 py-1.5');
        const params = { ...defaultParams(n.type), ...n.params };
        for (const o of type.outputs) {
            const row = div('relative flex items-center justify-end px-3');
            row.append(span('text-white/70', portLabel(n.type, 'outputs', o.key)), this._port(n.id, o.key, o.type, 'out'));
            body.append(row);
        }
        const inputKeys = new Set(type.inputs.map(i => i.key));
        for (const i of type.inputs) {
            const row = div('relative flex min-h-5 items-center gap-1 px-3');
            row.append(this._port(n.id, i.key, i.type, 'in'));
            const p = (type.params || []).find(p => p.key === i.key);
            const isLinked = linked.has(n.id + ':' + i.key);
            if (n.type === 'output' && !isLinked) {
                row.append(span('text-white/50', portLabel(n.type, 'inputs', i.key)));
            } else if (p && !isLinked) {
                row.append(this._param(n, p, params[p.key]));
            } else {
                row.append(span(isLinked ? 'text-white' : 'text-white/50', portLabel(n.type, 'inputs', i.key)));
            }
            body.append(row);
        }
        for (const p of type.params || []) {
            if (inputKeys.has(p.key)) continue;
            const row = div('flex items-center gap-1 px-3');
            row.append(this._param(n, p, params[p.key]));
            body.append(row);
        }
        el.append(body);
        return el;
    }

    // --- Previews ---

    // output shown in the node's preview: colour if it has one, else its first output; 'material' for the output node
    _previewPort(n) {
        if (NO_PREVIEW.has(n.type)) return null;
        if (n.type === 'output') return this.hooks.materialThumb ? 'material' : null;
        if (!this.hooks.preview) return null;
        const outs = NODE_TYPES[n.type]?.outputs || [];
        return (outs.find(o => o.key === 'color') || outs[0])?.key ?? null;
    }

    _togglePreview(nodeId) {
        let set = this.hiddenPreviews.get(this.materialId);
        if (!set) this.hiddenPreviews.set(this.materialId, set = new Set());
        if (set.has(nodeId)) set.delete(nodeId); else set.add(nodeId);
        this.render();
    }

    // the node's preview box (same element across re-renders, so the last picture stays while a new one is baked)
    _previewEl(n) {
        let box = this.previews.get(n.id);
        if (!box) {
            box = div('mx-2 mt-2 aspect-square overflow-hidden rounded bg-black/40 ring-1 ring-white/10');
            if (n.type === 'output') {
                const img = document.createElement('img');
                img.className = 'size-full object-cover';
                img.draggable = false;
                box.append(img);
            } else {
                const c = document.createElement('canvas');
                c.width = c.height = PREVIEW_SIZE;
                c.className = 'size-full';
                box.append(c);
            }
            this.previews.set(n.id, box);
        }
        return box;
    }

    // bake the previews shortly after a change (one run at a time; a newer run makes older results stale)
    _schedulePreviews() {
        clearTimeout(this._previewTimer);
        this._previewTimer = setTimeout(() => this._renderPreviews(), 120);
    }

    async _renderPreviews() {
        if (!this.graph || !this.materialId) return;
        const run = ++this.previewRun;
        const entry = this.manager.get(this.materialId);
        const def = { graph: structuredClone(this.graph), render: entry?.def.render };
        const folded = this.hiddenPreviews.get(this.materialId);
        for (const id of this.previews.keys()) if (!this.graph.nodes.some(n => n.id === id)) this.previews.delete(id);
        this._updateOutputPreview();
        for (const n of this.graph.nodes) {
            const port = this._previewPort(n);
            if (!port || port === 'material' || folded?.has(n.id)) continue;
            let res = null;
            try { res = await this.hooks.preview(def, n.id, port, PREVIEW_SIZE); } catch (err) { console.warn('[Node editor] Preview failed:', err); }
            if (run !== this.previewRun) return;   // the graph changed meanwhile
            const canvas = this.previews.get(n.id)?.querySelector('canvas');
            if (!canvas || !res) continue;
            const ctx = canvas.getContext('2d');
            if (res.color) {
                ctx.fillStyle = `rgb(${res.color.map(v => Math.round(v * 255)).join(',')})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            } else {
                if (canvas.width !== res.size) canvas.width = canvas.height = res.size;
                ctx.putImageData(new ImageData(new Uint8ClampedArray(res.pixels.buffer), res.size, res.size), 0, 0);
            }
        }
    }

    // output node: the material's sphere (comes from the material previews, updated when a new one is ready)
    _updateOutputPreview() {
        const out = this.graph?.nodes.find(n => n.type === 'output');
        const img = out && this.previews.get(out.id)?.querySelector('img');
        if (!img) return;
        const url = this.hooks.materialThumb?.(this.materialId, PREVIEW_SIZE);
        if (url && img.src !== url) img.src = url;
        img.hidden = !url;
    }

    _port(node, port, type, dir) {
        const dot = div(`absolute size-2.5 rounded-full ring-2 ring-neutral-800 ${PORT_COLORS[type]} ${dir === 'out' ? '-right-1.5' : '-left-1.5'} cursor-crosshair hover:scale-125`);
        dot.dataset.port = port;
        dot.dataset.dir = dir;
        dot.dataset.portNode = node;
        dot.dataset.type = type;
        dot.title = t(`nodeEditor.portTypes.${type}`);
        return dot;
    }

    _param(n, p, value) {
        const wrap = div('flex min-w-0 flex-1 items-center gap-1');
        const label = span('w-16 shrink-0 truncate text-white/60', paramLabel(n.type, p.key));
        const set = v => { n.params = { ...n.params, [p.key]: v }; this.commit(n.id + ':' + p.key); };
        if (p.kind === 'color') {
            wrap.append(label, colorField(value, { onInput: set, className: 'flex-1' }));
        } else if (p.kind === 'select') {
            const s = document.createElement('select');
            s.className = 'min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-white outline-none';
            for (const k of p.options) s.append(new Option(optionLabel(n.type, p.key, k), k, false, k === value));
            s.onchange = () => set(s.value);
            wrap.append(label, s);
        } else if (p.kind === 'importMap') {
            // an image node whose picture comes from the model file (the same texture for several maps – glTF
            // metallicRoughness – only once); missing: warning + load it from its server / link a file
            const maps = this._importMaps(), missing = this._missingMaps();
            const fileName = url => decodeURIComponent(String(url).split(/[\\/]/).pop());
            const s = document.createElement('select');
            s.className = 'min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-white outline-none';
            const seen = new Map();
            for (const [k, tex] of Object.entries(maps)) {
                if (seen.has(tex)) { seen.get(tex).text += ' / ' + mapLabel(k); continue; }
                const o = new Option(mapLabel(k), k, false, k === value);
                seen.set(tex, o);
                s.append(o);
            }
            for (const [k, info] of Object.entries(missing)) {
                if (seen.has(info.url)) { seen.get(info.url).text += ' / ' + mapLabel(k); continue; }
                const o = new Option(`${mapLabel(k)} – ${t('nodeEditor.missingTexture')}`, k, false, k === value);
                seen.set(info.url, o);
                s.append(o);
            }
            if (!maps[value] && !missing[value]) s.append(new Option(t('nodeEditor.missingTexture'), value, false, true));
            // the chosen key can be a second map of the same texture
            for (const [tex, o] of seen) if (maps[value] === tex || missing[value]?.url === tex) o.selected = true;
            s.onchange = () => { set(s.value); this.render(); };
            s.title = t('nodeEditor.importTextureTitle');
            wrap.append(s);
            const thumb = textureThumb(maps[value]);
            if (thumb) wrap.append(thumb);
            // where the picture comes from (a row of its own below)
            const source = missing[value];
            const note = div('mt-1 flex w-full items-center gap-1 text-[11px] ' + (source ? 'text-amber-200' : 'text-white/45'));
            if (source) {
                note.insertAdjacentHTML('beforeend', ICON_WARNING);
                note.append(span('min-w-0 flex-1 truncate', fileName(source.url)));
                note.title = t('nodeEditor.imageMissing', { url: source.url });
                if (/^https:\/\//i.test(source.url) && this.hooks.downloadTexture) {
                    note.append(iconButton(ICON_DOWNLOAD, t('nodeEditor.downloadImage'), () => this.hooks.downloadTexture(source.url)));
                }
                if (this.hooks.linkFiles) {
                    const f = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
                    f.onchange = () => { if (f.files[0]) this.hooks.linkFiles([{ path: fileName(source.url), file: new File([f.files[0]], fileName(source.url), { type: f.files[0].type }) }]); };
                    note.append(f, iconButton(ICON_FOLDER, t('nodeEditor.linkImage'), () => f.click()));
                }
            } else {
                note.append(span('min-w-0 flex-1 truncate', t('nodeEditor.imageFromFile')));
                note.title = t('nodeEditor.importTextureTitle');
            }
            wrap.classList.add('flex-wrap');
            wrap.append(note);
        } else if (p.kind === 'image') {
            const b = document.createElement('button');
            b.className = 'min-w-0 flex-1 truncate rounded bg-white/10 px-1 py-0.5 text-left text-white/80 hover:bg-white/20';
            b.textContent = value ? t('nodeEditor.replaceImage') : t('nodeEditor.chooseImage');
            const f = document.createElement('input');
            f.type = 'file';
            f.accept = 'image/*';
            f.hidden = true;
            b.onclick = () => f.click();
            f.onchange = async () => {
                if (!f.files[0]) return;
                set(await imageToDataUrl(f.files[0]));
                this.render();
            };
            wrap.append(label, b, f);
            if (value) {
                const thumb = document.createElement('img');
                thumb.src = value;
                thumb.className = 'size-5 shrink-0 rounded object-cover';
                wrap.append(thumb);
            }
        } else {
            const r = document.createElement('input');
            r.type = 'range';
            Object.assign(r, { min: p.min, max: p.max, step: p.step, value });
            r.className = 'min-w-0 flex-1 accent-sky-400';
            const num = document.createElement('input');
            num.type = 'number';
            Object.assign(num, { min: p.min, max: p.max, step: p.step, value });
            num.className = INPUT;
            r.oninput = () => { num.value = r.value; set(Number(r.value)); };
            num.onchange = () => { r.value = num.value; set(Number(num.value)); };
            wrap.append(label, r, num);
        }
        return wrap;
    }

    _portPos(node, port, dir) {
        const el = this.world.querySelector(`[data-port-node="${node}"][data-port="${port}"][data-dir="${dir}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect(), w = this.world.getBoundingClientRect();
        return { x: r.left + r.width / 2 - w.left, y: r.top + r.height / 2 - w.top };
    }

    _renderWires(temp) {
        const paths = [];
        for (const [i, l] of this.graph.links.entries()) {
            const a = this._portPos(l.from.node, l.from.port, 'out');
            const b = this._portPos(l.to.node, l.to.port, 'in');
            if (a && b) paths.push(`<path data-link="${i}" d="${curve(a, b)}" class="pointer-events-auto cursor-pointer stroke-white/60 hover:stroke-red-400" stroke-width="2.5" fill="none"/>`);
        }
        if (temp) paths.push(`<path d="${curve(temp.a, temp.b)}" class="stroke-sky-300" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`);
        this.wires.innerHTML = paths.join('');
    }

    // --- Interaktion ---

    _local(e) {
        const w = this.world.getBoundingClientRect();
        return { x: e.clientX - w.left, y: e.clientY - w.top };
    }

    _onPointerDown(e) {
        if (e.button !== 0 || !this.graph) return;
        const link = e.target.closest('[data-link]');
        if (link) {
            this.graph.links.splice(Number(link.dataset.link), 1);
            this.render();
            this.commit();
            return;
        }
        const port = e.target.closest('[data-port]');
        if (port) {
            e.preventDefault();
            const { portNode: node, port: key, dir } = port.dataset;
            if (dir === 'out') {
                this.drag = { kind: 'link', from: { node, port: key } };
            } else {
                // pick up the existing link at the input
                const i = this.graph.links.findIndex(l => l.to.node === node && l.to.port === key);
                if (i < 0) return;
                const [l] = this.graph.links.splice(i, 1);
                this.drag = { kind: 'link', from: l.from, detached: true };
                this.render();
            }
            return;
        }
        const handle = e.target.closest('[data-handle="move"]');
        if (handle && !e.target.closest('button')) {
            const id = handle.closest('[data-node]').dataset.node;
            const n = this.graph.nodes.find(n => n.id === id);
            this.drag = { kind: 'node', node: n, start: { x: e.clientX, y: e.clientY }, origin: { x: n.x, y: n.y } };
            return;
        }
        if (e.target === this.canvas || e.target === this.world) {
            this.drag = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origin: { ...this.pan } };
            this.canvas.classList.replace('cursor-grab', 'cursor-grabbing');
        }
    }

    _onPointerMove(e) {
        const d = this.drag;
        if (!d) return;
        if (d.kind === 'pan') {
            this.pan = { x: d.origin.x + e.clientX - d.start.x, y: d.origin.y + e.clientY - d.start.y };
            this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
        } else if (d.kind === 'node') {
            d.node.x = d.origin.x + e.clientX - d.start.x;
            d.node.y = d.origin.y + e.clientY - d.start.y;
            const el = this.world.querySelector(`[data-node="${d.node.id}"]`);
            el.style.left = d.node.x + 'px';
            el.style.top = d.node.y + 'px';
            this._renderWires();
        } else if (d.kind === 'link') {
            const a = this._portPos(d.from.node, d.from.port, 'out');
            if (a) this._renderWires({ a, b: this._local(e) });
        }
    }

    _onPointerUp(e) {
        const d = this.drag;
        this.drag = null;
        if (!d) return;
        this.canvas.classList.replace('cursor-grabbing', 'cursor-grab');
        if (d.kind === 'node') { this.commit(); return; }
        if (d.kind !== 'link') return;
        const port = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-port][data-dir="in"]');
        if (port && port.dataset.portNode !== d.from.node) {
            const to = { node: port.dataset.portNode, port: port.dataset.port };
            this.graph.links = this.graph.links.filter(l => !(l.to.node === to.node && l.to.port === to.port));
            this.graph.links.push({ from: d.from, to });
            this.render();
            this.commit();
        } else {
            this._renderWires();
            if (d.detached) this.commit();
        }
    }
}

function curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function div(className) {
    const e = document.createElement('div');
    e.className = className;
    return e;
}

function span(className, text) {
    const e = document.createElement('span');
    e.className = className;
    e.textContent = text;
    return e;
}

// Thumbnail of a texture (ImageBitmap/image/canvas; compressed textures without preview)
const thumbs = new WeakMap();
// small icon button in a node (download / link an image)
function iconButton(icon, title, onClick) {
    const b = document.createElement('button');
    b.className = 'shrink-0 rounded p-0.5 text-white/70 hover:bg-white/15 hover:text-white';
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = onClick;
    return b;
}

function textureThumb(tex) {
    const img = tex?.image;
    if (!img || !(img.width > 0) || img.data) return null;
    let url = thumbs.get(tex);
    if (!url) {
        try {
            const c = document.createElement('canvas');
            c.width = c.height = 48;
            const ctx = c.getContext('2d');
            // pictures flipped while decoding (USD): upright again for the eye
            if (tex.userData?.flippedImage) { ctx.translate(0, 48); ctx.scale(1, -1); }
            ctx.drawImage(img, 0, 0, 48, 48);
            url = c.toDataURL();
        } catch {
            return null;
        }
        thumbs.set(tex, url);
    }
    const e = document.createElement('img');
    e.src = url;
    e.className = 'size-8 shrink-0 rounded object-cover ring-1 ring-white/20';
    return e;
}

// Image downscaled (max. 1024 px) as data URL – keeps the material JSON small
async function imageToDataUrl(file) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
}
