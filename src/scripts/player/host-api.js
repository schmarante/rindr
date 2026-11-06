// The player's interface for the host page (docs/player.md, stage 4): what <rindr-player> offers as methods – load a model
// or scene, list and address parts by name (part-paths.js), assign materials, show/hide, select, views, view mode, render
// an image, the scene as data. viewer.js hands in its internals (ctx); everything here works on them only. Every
// method returns a promise (the element awaits the player's start first). Errors are thrown as Error with a `code`.
import { partPaths, pathMatcher, splitSurface } from './part-paths.js';
import { normalizeBackdrop } from '../scene-state.js';
import { splitBackground } from './backdrop-css.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * A background as the host page writes it (attribute `background`, setBackground): 'hdri' (the HDRI), 'default' (the
 * built-in dark gradient), a CSS colour, 'linear(top, bottom)', 'radial(centre, edge)' – or { type, colors } / { type:
 * 'hdri' }. → { hdri: boolean, backdrop: { type, colors } | null }, or null when not understood
 */
export function parseBackground(spec) {
    const bg = splitBackground(spec);
    if (bg === 'hdri') return { hdri: true, backdrop: null };
    if (bg === 'default') return { hdri: false, backdrop: null };
    const backdrop = bg && normalizeBackdrop(bg);
    return backdrop ? { hdri: false, backdrop } : null;
}

/**
 * @param {object} ctx  internals of one player (viewer.js, `hostContext`)
 */
export function createHostApi(ctx) {
    const absolute = url => new URL(url, document.baseURI).href;

    // every node of every loaded model with its path (deleted ones and nodes without any mesh below left out); meshes =
    // its own surfaces (meshes whose nearest node it is, in file order – 'Path#k', as in the scene format)
    function allParts() {
        const out = [];
        for (const rm of ctx.runtimeModels()) {
            const nodes = ctx.importNodesOf(rm);
            if (!nodes?.length) continue;
            const index = new Map(rm.nodeGroups.map((g, i) => [g, i]));
            const own = new Map();
            for (const m of rm.meshes) {
                let i;
                for (let o = m.parent; o && i === undefined; o = o.parent) i = index.get(o);
                if (i !== undefined) { if (!own.has(i)) own.set(i, []); own.get(i).push(m); }
            }
            partPaths(nodes).forEach((p, i) => {
                const group = rm.nodeGroups[i];
                if (p.root || !group || ctx.isDeleted(rm.prefix + 'n' + i)) return;   // (the file's unnamed root: the whole model)
                let meshes = 0;
                group.traverse(o => { if (o.isMesh) meshes++; });
                if (meshes) out.push({ ...p, group, rm, key: rm.prefix + 'n' + i, meshes: own.get(i) || [] });
            });
        }
        return out;
    }
    // what a pattern (or a list of them) names: parts – outermost only (a part inside a matched one is covered by it) – or,
    // with #k, the k-th surface of each matched part → [{ part, object (group or mesh), surface }]; nothing: an error
    function resolve(target, { surfaces = true } = {}) {
        if (target == null) throw fail('no-part', 'No part given');
        const all = allParts();
        const out = [];
        for (const t of Array.isArray(target) ? target : [target]) {
            const { pattern, surface } = splitSurface(t && typeof t === 'object' ? t.path : t);
            const hits = all.filter(pathMatcher(pattern));
            if (surface !== null) {
                if (!surfaces) throw fail('bad-argument', 'Surfaces (#k) are not possible here – whole parts only');
                for (const p of hits) if (p.meshes[surface]) out.push({ part: p, object: p.meshes[surface], surface });
                continue;
            }
            const groups = new Set(hits.map(p => p.group));
            for (const p of hits) {
                let inside = false;
                for (let o = p.group.parent; o && !inside; o = o.parent) inside = groups.has(o);
                if (!inside) out.push({ part: p, object: p.group, surface: null });
            }
        }
        const unique = [...new Map(out.map(x => [x.object, x])).values()];
        if (!unique.length) throw fail('no-part', `No part matches ${JSON.stringify(Array.isArray(target) ? target : target?.path ?? target)}`);
        return unique;
    }
    function describePart(p) {
        const materials = new Set();
        p.group.traverse(o => { const id = o.isMesh && o.material?.userData?.materialId; if (id) materials.add(id); });
        const out = { path: p.path, name: p.name, model: p.rm.file?.name ?? null, visible: isShown(p.group), materials: [...materials] };
        // several surfaces of its own (e.g. the colour groups of a STEP part): each with its path and material
        if (p.meshes.length > 1) out.surfaces = p.meshes.map((m, k) => ({ path: `${p.path}#${k}`, name: m.name || null, material: m.material?.userData?.materialId ?? null }));
        return out;
    }
    const isShown = object => { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; };

    // a material by id (scene), library id or name; an object: { id } | { library } | { name } | a new definition.
    // Checked (and the library loaded) first; returns a function that gets or creates it – called inside the undo step
    const need = (value, message) => { if (value == null) throw fail('no-material', message); return value; };
    const byName = name => ctx.materialManager.list.find(e => e.def.name === name) ?? null;
    async function inLibrary(libraryId) {
        if (!ctx.presets().some(p => p.libraryId === libraryId)) await ctx.loadLibraryPresets();
        return ctx.presets().some(p => p.libraryId === libraryId);
    }
    async function materialMaker(spec) {
        const mm = ctx.materialManager;
        if (spec && typeof spec === 'object') {
            if (spec.id) { const e = need(mm.get(spec.id), `No material with id ${spec.id}`); return () => e; }
            if (spec.library) { need((await inLibrary(spec.library)) || null, `No library material ${spec.library}`); return () => mm.fromLibrary(spec.library); }
            if (spec.params || spec.graph || spec.type) return () => mm.create({ name: spec.name || 'Material', source: 'user', ...spec, id: undefined });
            if (spec.name) { const e = need(byName(spec.name), `No material named ${spec.name}`); return () => e; }
            throw fail('no-material', 'Unknown material');
        }
        const text = String(spec ?? '');
        const own = mm.get(text);
        if (own) return () => own;
        if (await inLibrary(text)) return () => mm.fromLibrary(text);
        const named = need(byName(text), `No material ${JSON.stringify(text)}`);
        return () => named;
    }

    // the Scene Graph row of a part: its own, or (rows of single-child chains are folded together) the outermost row inside it
    function entriesOf(p) {
        const own = ctx.sceneGraph.byKey.get(p.key);
        if (own) return [own];
        const inside = [...ctx.sceneGraph.byKey.values()].filter(e => e.object && e.kind === 'node' && isInside(e.object, p.group));
        return inside.filter(e => !inside.some(o => o !== e && isInside(e.object, o.object)));
    }
    const isInside = (object, ancestor) => { for (let o = object.parent; o; o = o.parent) if (o === ancestor) return true; return false; };

    // renders one after another (one export at a time per player)
    let renderQueue = Promise.resolve();

    const api = {
        /**
         * load a model (URL) or { src | scene | package, files, hdr } – scene: URL or the scene as data (getScene(), 'rindr-save'),
         * files: { name: URL | Blob } for the files the scene names (otherwise element.resolveAsset, then next to a scene URL),
         * package: a zip from getPackage(). Resolves when it is shown ({ models, missing, parts }), rejects with the load error
         */
        async load(spec) {
            if (typeof spec === 'string') spec = { src: spec };
            if (!spec || (!spec.src && !spec.scene && !spec.package && !spec.hdr)) throw fail('bad-argument', 'load() needs src, scene, package or hdr');
            ctx.touch();
            const mark = ctx.errorMark();
            if (spec.package) {
                const { state, files } = await ctx.unpackScene(spec.package).catch(err => { throw fail('load-failed', err.message); });
                await ctx.openScene(state, files);
            } else if (spec.scene && typeof spec.scene === 'object') {
                const files = await Promise.all(Object.entries(spec.files || {}).map(async ([name, value]) => {
                    if (value instanceof Blob) return { path: name, file: value instanceof File ? value : new File([value], name) };
                    const res = await fetch(absolute(String(value)));
                    if (!res.ok) throw fail('load-failed', `${name}: HTTP ${res.status}`);
                    return { path: name, file: new File([await res.blob()], name) };
                }));
                await ctx.openScene(spec.scene, files);
            } else if (spec.scene) await ctx.openSceneUrl(absolute(spec.scene));
            else if (spec.src) await ctx.openUrl(absolute(spec.src));
            const err = ctx.errorSince(mark);
            if (err) throw fail('load-failed', err.message);
            if (spec.hdr) await ctx.selectHdrUrl(absolute(spec.hdr));
            return { models: ctx.runtimeModels().map(rm => rm.file?.name ?? null), missing: ctx.missing(), parts: allParts().length };
        },
        /** save as the save button does: 'rindr-save' (the page may take the scene), otherwise the file dialog / download;
         *  event: false = straight to the file (the iframe fallback after the page left it) */
        async save({ event = true } = {}) {
            await ctx.idle();
            ctx.touch();
            await ctx.saveScene({ event });
        },
        /** the scene with its files as one zip (Blob) – load({ package }) opens it again */
        async getPackage() {
            await ctx.idle();
            ctx.touch();
            return ctx.scenePackage();
        },
        /** the visible models with their materials as one GLB file (glTF 2.0 binary, metres) → { file: File, warnings:
         *  [{ code, names }] } – what glTF could not hold (special materials, subsurface, hair fibres, splats …);
         *  camera: true adds the current camera */
        async exportGlb({ camera = false } = {}) {
            await ctx.idle();
            ctx.touch();
            return ctx.exportGlb({ camera: !!camera });
        },
        /** every part (node) of the loaded models: { path, name, model, visible, materials } */
        async getParts(pattern = '**') {
            await ctx.idle();
            ctx.touch();
            const all = allParts();
            return (pattern === '**' ? all : all.filter(pathMatcher(pattern))).map(describePart);
        },
        /** the scene's materials: { id, name, library, source } */
        async getMaterials() {
            await ctx.idle();
            ctx.touch();
            return ctx.materialManager.list.map(e => ({ id: e.def.id, name: e.def.name, library: e.def.libraryId ?? null, source: e.def.source ?? null }));
        },
        /** the material library (all categories): { library, name, category } */
        async getLibrary() {
            await ctx.loadLibraryPresets();
            return ctx.presets().filter(p => p.libraryId).map(p => ({ library: p.libraryId, name: ctx.presetName(p.libraryId), category: p.category ?? null }));
        },
        /** assign a material to parts (one undo step); returns the material's id */
        async setMaterial(target, material) {
            await ctx.idle();
            ctx.touch();
            const parts = resolve(target);
            const make = await materialMaker(material);
            let id = null;
            ctx.history.transaction(ctx.labels.assignMaterial, () => {   // a library material created + assigned = one step
                id = make().def.id;
                for (const p of parts) ctx.assignMaterial(p.object, id, { quiet: true });
            });
            ctx.afterMaterialChange();
            return id;
        },
        /** change parameters of a scene material (id or name) – every part with it follows (one undo step) */
        async updateMaterial(material, params) {
            await ctx.idle();
            ctx.touch();
            const mm = ctx.materialManager;
            const entry = (typeof material === 'object' && material ? mm.get(material.id) ?? byName(material.name) : mm.get(String(material)) ?? byName(String(material)));
            if (!entry) throw fail('no-material', `No scene material ${JSON.stringify(material)}`);
            if (!params || typeof params !== 'object') throw fail('bad-argument', 'updateMaterial() needs parameters');
            mm.setParams(entry.def.id, params);
            return entry.def.id;
        },
        /** show or hide parts (one undo step) */
        async setVisible(target, visible = true) {
            await ctx.idle();
            ctx.touch();
            const entries = resolve(target, { surfaces: false }).map(x => x.part).flatMap(entriesOf);
            if (entries.length) ctx.sceneGraph.setVisible(entries, !!visible);
        },
        /** select parts (null: nothing) – as a click in the Scene Graph */
        async select(target) {
            await ctx.idle();
            ctx.touch();
            if (target == null) { ctx.sceneGraph.select(null); return; }
            const targets = resolve(target);
            const own = targets.length === 1 ? ctx.sceneGraph.entryForObject(targets[0].object, { surfaces: true }) : null;
            if (own?.object === targets[0].object) ctx.sceneGraph.select(own);
            else ctx.sceneGraph.selectObjects(targets.map(x => x.object));
        },
        /** fly the camera so that the parts (or everything) fill the view */
        async frame(target) {
            await ctx.idle();
            ctx.touch();
            ctx.frame(target == null ? null : resolve(target).map(x => x.object));
        },
        /** the saved views (cameras of the scene and of the file) */
        async getViews() {
            await ctx.idle();
            ctx.touch();
            return ctx.views().map(v => v.name);
        },
        /** a saved view by name, or { position, target, fov } (camera flies there) */
        async setView(view) {
            ctx.touch();
            if (typeof view === 'string') {
                const v = ctx.views().find(x => x.name === view);
                if (!v) throw fail('no-view', `No view named ${JSON.stringify(view)}`);
                ctx.activateView(v);
                return;
            }
            if (!Array.isArray(view?.position) || !Array.isArray(view?.target)) throw fail('bad-argument', 'setView() needs a name or { position, target }');
            ctx.flyTo({ position: view.position, target: view.target, ...(view.fov ? { fov: view.fov } : {}) });
        },
        /** view mode: 'default', 'hq' (path tracing), 'basic', 'uv', 'wire' */
        /** the background: 'hdri', 'default', a colour, 'linear(top, bottom)', 'radial(centre, edge)' or { type, colors } */
        async setBackground(spec) {
            const parsed = parseBackground(spec);
            if (!parsed) throw fail('bad-argument', `Unknown background ${JSON.stringify(spec)}`);
            ctx.touch();
            ctx.setBackground(parsed);
        },
        async setMode(mode) {
            if (!ctx.viewModes.includes(mode)) throw fail('bad-argument', `mode is one of ${ctx.viewModes.join(', ')}`);
            ctx.touch();
            ctx.setViewMode(mode);
        },
        async getMode() { return ctx.getViewMode(); },
        /**
         * an image of the view as a Blob: path traced (hq, default) or the raster view as it is (hq: false);
         * width (pixels) or scale (× the view's pixels), transparent background, samples, type/quality (canvas.toBlob)
         */
        render({ width = null, scale = null, transparent = false, samples = 0, hq = true, type = 'image/png', quality } = {}) {
            const run = async () => {
                await ctx.idle();
                ctx.touch();
                let canvas;
                if (hq) {
                    const base = ctx.bufferWidth();
                    let s = width ? width / base : (scale ?? 1);
                    s = Math.max(0.1, Math.min(s, ctx.maxExportSize() / base));
                    canvas = await ctx.exportImage(!!transparent, null, null, s, samples);
                } else canvas = await ctx.exportFrame();
                if (canvas instanceof Blob) return canvas;
                return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(fail('render-failed', 'Image could not be encoded'))), type, quality));
            };
            const job = renderQueue.then(run, run);
            renderQueue = job.catch(() => {});
            return job;
        },
        /** the scene as data (RINDR scene format – the same JSON as "Save scene") */
        async getScene() {
            await ctx.idle();
            ctx.touch();
            return ctx.captureState();
        },

        // --- for events (viewer.js) ---
        /** what a Scene Graph selection is, for the host: { kind, name, path(s) } */
        describeSelection(entry) {
            if (!entry) return null;
            const all = allParts();
            const byGroup = new Map(all.map(p => [p.group, p]));
            const pathOf = object => {
                for (let o = object; o; o = o.parent) {
                    const p = byGroup.get(o);
                    if (!p) continue;
                    const k = object.isMesh ? p.meshes.indexOf(object) : -1;   // a surface of its own: Path#k
                    return k >= 0 && p.meshes.length > 1 ? `${p.path}#${k}` : p.path;
                }
                return null;
            };
            if (entry.kind === 'selection') return { kind: 'parts', name: entry.name, paths: (entry.object.members || []).map(pathOf).filter(Boolean) };
            if (entry.kind === 'node' || entry.kind === 'surface') return { kind: entry.kind === 'node' ? 'part' : 'surface', name: entry.name, path: pathOf(entry.object) };
            return { kind: entry.kind, name: entry.name ?? null, path: null };
        },
        partCount: () => allParts().length,
    };
    return api;
}
