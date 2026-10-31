// Raster draw calls: meshes with the same geometry + material are drawn as one InstancedMesh.
//
// Large assemblies have one mesh per solid instance and surface group (large assembly: ~7500) and every mesh is
// a draw call – the CPU cost of the raster view. The path tracer is not affected (it draws via its scene BVH).
//
// Draw-only proxy: the individual meshes stay the scene for everything else (selection, picking, highlight,
// gizmo, explosion, materials, scene state, path tracer). A batched mesh only leaves layer 0, so the
// raster camera skips it; the InstancedMesh draws it instead. Picking raycasters enable BATCH_LAYER, the
// highlight mask uses its own layer.
//
// Nothing has to report changes – every frame that rasterizes `scene` compares the batched meshes with
// their InstancedMesh before drawing:
//   - matrix changed (gizmo, explosion, animation) → copied into the instance matrix
//   - hidden / shown (also via a parent) → instances repacked
//   - geometry/material changed, transparent, fading in, morph … → the mesh leaves its batch at once and is
//     drawn individually again; the grouping is rebuilt once nothing has changed for `delay` ms
//   - new or removed meshes → rebuild likewise
// Before a rebuild switches over, the shaders of its new InstancedMeshes are compiled asynchronously (_stage:
// compileAsync in the real draw context, shader-compile.js) – meanwhile the current grouping keeps drawing. Compiled in
// the draw frame, a regrouping blocked the main thread and then the GPU process (large assembly: ~0.7 s + ~0.9 s).
// The InstancedMeshes only hang in the scene during renderer.render(scene) – other traversals (path tracer,
// bounds, material usage) never see them.
//
// Side products of the comparison (one pass per frame anyway):
//   - `changed`: did anything that is drawn change since the last frame (matrix, shown/hidden, geometry,
//     material, new/removed mesh; skinned/morphed meshes always)? The viewer only re-renders the light
//     shadow maps then (onChange) – they were redrawn every frame (two passes over the whole model).
//   - one scene.updateMatrixWorld() per frame: three.js runs it in every renderer.render(scene) (main image,
//     every shadow map, highlight mask …) – a full pass over all objects each time.
//
// Cluster LOD (lod/lod-store.js): for large models the geometries of the batches get a cluster LOD in the
// background. A batch whose LOD is ready draws the coarsest cut of its geometry that is still fine enough for its
// nearest instance: error below `lod.threshold` px at the nearest point of the instance's bounding sphere (outside
// the view LOD.outsideFactor coarser – only its shadow can be seen). The cut shares the source's vertex buffers →
// same shader, only the batch mesh's geometry is swapped. One cut per batch, not per instance: splitting a batch
// by distance added draw calls, and on a fast GPU the draw calls are the limit, not the triangles (huge assembly,
// 118 M triangles: 41 fps without LOD, 32 fps with one InstancedMesh per cut). Single meshes (drawn individually)
// get their cut only while the scene is rasterized: the render wrapper swaps mesh.geometry and restores it right
// after – picking (BVH), path tracer, bounds always see the source. (Putting them into batches of their own cost a
// node build per mesh – three.js builds every InstancedMesh anew – and delayed the first grouping by ~30 s.)
// Shadow maps reuse the camera's choice.
//
// Occlusion culling (occlusion-culling.js, large models): parts hidden behind others or outside the view are left out
// of the instances (and individually drawn ones out of the camera's layer during the main render) – per frame, from
// the culler's last result; a new depth image + test from inside the main render every few frames. Only when nothing
// changed this frame (every change drops the result) and no other view draws the batches (shadow maps due, fisheye,
// section plane – `occlusionAllowed`): those see the whole model.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { compileAsync } from './shader-compile.js';
import { LOD, OCCLUSION } from './config.js';

const TINT_STEPS = 8;   // debug colours: share of triangles kept, one colour per halving (lod-debug.js)

export const BATCH_LAYER = 30;

export class RenderBatcher {
    /**
     * @param {{ renderer, scene, parent: THREE.Object3D, roots: () => THREE.Object3D[], minInstances?: number, delay?: number,
     *   lods?: import('./lod/lod-store.js').ClusterLods, lodCamera?: () => THREE.Camera, lodAllVisible?: () => boolean }} options
     *   parent = where the InstancedMeshes hang while drawing (section ClippingGroup), roots = model roots,
     *   lods = cluster LOD store (null: no LOD), lodCamera = the camera the LOD follows (default: the syncing render's),
     *   lodAllVisible = the image shows more than the camera frustum (fisheye) → no coarser LOD outside it
     */
    constructor({ renderer, scene, parent, roots, minInstances = 2, delay = 500, lods = null, lodCamera = null, lodAllVisible = null,
        occlusion = null, occlusionAllowed = null }) {
        this.renderer = renderer;
        this.scene = scene;
        this.parent = parent;
        this.roots = roots;
        this.minInstances = minInstances;
        this.delay = delay;
        this.enabled = true;
        this.group = new THREE.Group();
        this.group.name = 'RenderBatches';
        this.group.matrixAutoUpdate = false;
        this.batches = [];               // { key, mesh: InstancedMesh, members: Mesh[], slots: Mesh[] }
        this.token = {};                 // state of a mesh: mesh[STATE] with st.token === this.token (cleared = new token)
        this.frame = 0;
        this._synced = -1;
        this._changedAt = null;          // last change of the grouping (null = none pending)
        this._depth = 0;
        this.generation = 0;             // +1 per rebuild that created batches (new shader variants possible)
        this.stats = { batches: 0, instances: 0, rebuilds: 0, rebuildMs: 0 };
        this.changed = true;             // last sync: something drawn changed
        this.onChange = null;            // called by sync when `changed` (before the render draws shadow maps)
        this._visHash = [0, 0];          // shown meshes of the last sync (sum + xor of ids)
        this._matrixFrame = -1;
        this.staging = new THREE.Group();   // new InstancedMeshes of a pending rebuild, compiling (_stage)
        this.staging.name = 'RenderBatchesStaging';
        this.staging.matrixAutoUpdate = false;
        this._staged = null;             // { at, ready, batches: Map key -> batch }
        // cluster LOD: enabled/threshold changeable at runtime (debug panel); model = the models are large enough
        this.lods = lods;
        this.lodCamera = lodCamera;
        this.lodAllVisible = lodAllVisible;
        // tint: debug colours on the real drawing (lod-debug.js) – each mesh by the share of triangles its cut keeps
        this.lod = { enabled: !!lods && LOD.enabled, threshold: LOD.threshold, model: false, eligible: new Set(), selectMs: 0, tint: false };
        this._view = null;               // camera of the LOD choice (this sync): position, scale, frustum, key
        this.singles = [];               // individually drawn meshes with an LOD-eligible geometry: { mesh, source, bucket, cut, viewKey }
        this._lodNew = true;             // the store has new entries – batches without one look again
        if (lods) lods.onReady = () => { this._lodNew = true; };
        // occlusion culling: the culler, whether this frame may cull (no shadow map due …), model large enough
        this.occlusion = occlusion;
        this.occlusionAllowed = occlusionAllowed;
        this.occModel = false;
        this._occOn = false;
        this._shown = [];                // shown meshes of the models in this sync

        const render = renderer.render.bind(renderer);
        // timing (debug display): CPU time of all renders of `scene` per frame, nested ones = shadow maps
        // (three.js renders them via renderer.render from inside the main render), comparison (sync)
        this.timing = { render: 0, nested: 0, sync: 0 };
        this.beforeDraw = null;   // (camera) => void, called inside the next outer render of `scene` (see below)
        this.compilePasses = [];  // (compile) => Promise: sets its renderer/scene state, calls compile(), restores
        renderer.render = (s, camera) => {
            if (s !== this.scene) return render(s, camera);
            const t0 = performance.now();
            const outer = this._depth++ === 0;
            const auto = s.matrixWorldAutoUpdate;
            let swapped = null, tinted = null, culled = null;
            const main = outer && this.enabled && camera === (this.lodCamera?.() ?? camera);
            if (outer && this.enabled) {
                // world matrices once per frame (sync does it), all renders of this frame use them
                if (this._matrixFrame !== this.frame) { this._matrixFrame = this.frame; s.updateMatrixWorld(); }
                this._attach(camera);
                s.matrixWorldAutoUpdate = false;
                swapped = this._swapSingles();
                if (this.lod.tint) tinted = this._tint();
                if (main && this._occOn) culled = this._cullSingles();
            }
            try {
                // pass that must see exactly what this render draws (ambient-occlusion.js pre-pass): batches attached,
                // LOD cuts swapped in; its renders of `scene` count as nested
                if (outer && this.beforeDraw) this.beforeDraw(camera);
                // occlusion culling: a new depth image of what is drawn + test, when due (main view only)
                const occ = this.occlusion;
                if (main && occ?.valid && occ.due(camera, this.frame)) occ.capture({ scene: s, camera, keep: this.parent, frame: this.frame });
                return render(s, camera);
            } finally {
                if (culled) for (const m of culled) m.layers.enable(0);
                if (tinted) for (const [o, m] of tinted) o.material = m;
                if (swapped) this._restoreSingles(swapped);
                if (outer) s.matrixWorldAutoUpdate = auto;
                if (--this._depth === 0) this._detach();
                this.timing[outer ? 'render' : 'nested'] += performance.now() - t0;
            }
        };
    }

    /** compileAsync() (shader-compile.js) with the current batches attached: compiles the shaders of what render()
     *  would draw. three.js collects the objects synchronously in the call, the batches only hang in the scene
     *  meanwhile. No sync here: a due regrouping is staged by the next real draw (its context, not e.g. the
     *  denoiser's albedo/normal pass). */
    compileAsync(s, camera) {
        const hang = s === this.scene && this.enabled && this._depth === 0 && this.batches.length > 0;
        if (hang) this._hang(this.group);
        try {
            return compileAsync(this.renderer, s, camera);
        } finally {
            if (hang) this._detach();
        }
    }

    /** Call once per frame before rendering – the first render of `scene` in a frame syncs */
    newFrame() {
        this.frame++;
        this.lastTiming = this.timing;
        this.timing = { render: 0, nested: 0, sync: 0 };
    }

    /** Grouping change waiting for its rebuild? */
    get pending() {
        return this.enabled && this._changedAt !== null;
    }

    /** Did the current frame already compare the meshes (scene rasterized this frame)? */
    get synced() {
        return this._synced === this.frame;
    }

    get meshes() {
        return this.batches.map(b => b.mesh);
    }

    setEnabled(on) {
        if (this.enabled === on) return;
        this.enabled = on;
        if (!on) this._clear();
        this._changedAt = on ? -Infinity : null;
        this.changed = true;
    }

    _attach(camera) {
        if (this._synced !== this.frame) {
            this._synced = this.frame;
            const t0 = performance.now();
            this.sync(camera);
            this.timing.sync += performance.now() - t0;
        }
        if (!this.batches.length) return;
        this._hang(this.group);
    }

    // instance matrices are world matrices → the group cancels the parent's world matrix
    _hang(group) {
        this.parent.updateWorldMatrix(true, false);
        group.matrix.copy(this.parent.matrixWorld).invert();
        group.matrixWorldNeedsUpdate = true;
        this.parent.add(group);
    }

    _detach() {
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    /** Which meshes may be drawn as instances? Everything special is drawn individually */
    _keyOf(mesh) {
        const { material, geometry } = mesh;
        if (!material || Array.isArray(material) || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.isBatchedMesh
            || mesh.isSplat || mesh.morphTargetInfluences || geometry.morphAttributes?.position) return null;
        if (material.transparent || material.transmission > 0 || mesh.renderOrder !== 0) return null;   // sorted per object
        if (material.userData.noBatch) return null;   // shader needs the object's own matrices (glowing marble, toon.js)
        if (mesh.userData.fade !== undefined && mesh.userData.fade < 1) return null;                      // dither fade-in per object
        if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return null;
        return `${geometry.id}/${material.id}/${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}${mesh.frustumCulled ? 1 : 0}`;
    }

    /** camera: of the render that syncs – a due rebuild is compiled for it first (_stage); without, at once */
    sync(camera = null) {
        if (!this.enabled) return;
        const now = performance.now();
        const frame = this.frame;
        this._changed = false;
        const lodCamera = this.lodCamera?.() || camera;
        if (this.lod.enabled && this.lods && lodCamera) this._view = this._viewOf(lodCamera);
        else if (!this.lod.enabled) this._view = null;
        this.lod.selectMs = 0;
        let sum = 0, xor = 0;
        const shown = this._shown;
        shown.length = 0;

        // 1. visible meshes of the models (three's rule: invisible parent = whole subtree not drawn)
        const visit = o => {
            if (!o.visible) return;
            if (o.isMesh) {
                this._check(o, frame, now);
                shown.push(o);
                sum += o.id;
                xor ^= Math.imul(o.id, 0x9E3779B1);
            }
            const children = o.children;
            for (let i = 0; i < children.length; i++) visit(children[i]);
        };
        for (const root of this.roots()) if (root) visit(root);
        if (sum !== this._visHash[0] || xor !== this._visHash[1]) { this._visHash = [sum, xor]; this._changed = true; }

        // 2. grouping changed and quiet since `delay` ms → compile the new batches (_stage), then rebuild
        //    (before 3., so the batches draw this frame). Changed again during compiling → stage anew.
        if (this._changedAt !== null && now - this._changedAt > this.delay) {
            const staged = this._staged;
            // second compile round of the staging (see _stage), started from inside a real draw
            if (staged?.next && camera) {
                const next = staged.next;
                staged.next = null;
                this._compileStaged(camera, staged.rest).then(next, next);
            }
            if (!camera) this.rebuild();
            else if (!staged) this._stage(camera);
            else if (staged.ready && staged.at >= this._changedAt) this.rebuild();
            else if (staged.ready) { this._dropStaged(); this._stage(camera); }
        }

        // occlusion culling this frame? Any change (matrices, shown/hidden, materials, new meshes) drops the result –
        // everything is drawn until a test of the new state is back; parts collected on the first quiet frame
        this._occOn = false;
        const occ = this.occlusion;
        if (occ) {
            const allowed = occ.usable && this.occModel && !this.lodAllVisible?.() && (this.occlusionAllowed?.() ?? true);
            if (!allowed || this._changed) occ.invalidate();
            else {
                if (!occ.valid) occ.build(shown.filter(occludable));
                this._occOn = !!occ.result;
            }
        }

        // 3. instance data
        for (const batch of this.batches) this._update(batch, frame, now);
        for (const single of this.singles) this._updateSingle(single, frame);
        this._lodNew = false;
        this.lods?.trim(frame);

        this.changed = this._changed;
        if (this.changed) this.onChange?.();
    }

    _check(mesh, frame, now) {
        let st = this._state(mesh);
        const e = mesh.matrixWorld.elements;
        if (!st) {
            st = this._newState(mesh, -1);
            st.seen = frame;
            st.matrix.set(e);
            st.moved = true;
            this._changed = true;
            if (st.key !== null) this._changedAt = now;   // new mesh – might join a batch
            return;
        }
        st.seen = frame;
        // matrix (all shown meshes: shadow maps; batched: instance data)
        const m = st.matrix;
        st.moved = false;
        for (let j = 0; j < 16; j++) {
            if (m[j] !== e[j]) { m.set(e); st.moved = true; this._changed = true; break; }
        }
        // skinning (animation puppet) deforms without a matrix change; morphs: compare the influences
        if (mesh.isSkinnedMesh) this._changed = true;
        else if (mesh.morphTargetInfluences) {
            let h = 0;
            mesh.morphTargetInfluences.forEach((v, i) => { h += v * (i + 1.618); });
            if (h !== st.morph) { st.morph = h; this._changed = true; }
        }
        // key only recomputed when one of its inputs changed (no string per mesh and frame)
        const flags = flagsOf(mesh);
        if (st.geometry === mesh.geometry && st.material === mesh.material && st.flags === flags) return;
        st.geometry = mesh.geometry; st.material = mesh.material; st.flags = flags;
        this._changed = true;
        const key = this._keyOf(mesh);
        if (st.key === key) return;
        if (st.batch) this._leave(mesh, st);
        st.key = key;
        if (key === null) return;
        // back to its batch (e.g. material transparent and opaque again): rejoin at once
        if (st.home?.alive && st.home.key === key) this._join(mesh, st, st.home);
        else this._changedAt = now;
    }

    _leave(mesh, st) {
        st.batch = null;
        mesh.layers.enable(0);
        mesh.layers.disable(BATCH_LAYER);
    }

    _join(mesh, st, batch) {
        st.batch = st.home = batch;
        mesh.layers.disable(0);
        mesh.layers.enable(BATCH_LAYER);
    }

    _update(batch, frame, now) {
        const { mesh: im, members, slots } = batch;
        const array = im.instanceMatrix.array;
        let n = 0, dirty = false;
        for (const m of members) {
            const st = m[STATE];
            if (st.batch !== batch) continue;
            if (st.seen !== frame) {
                // hidden – or removed from the scene (then rebuild to drop it)
                if (!inScene(m, this.scene)) { this._leave(m, st); this._changedAt = now; this._changed = true; }
                continue;
            }
            if (this._occOn && this.occlusion.hidden(m)) continue;   // behind others / outside the view
            if (slots[n] !== m || st.moved) {
                slots[n] = m;
                array.set(st.matrix, n * 16);
                dirty = true;
            }
            n++;
        }
        if (n !== slots.length) { slots.length = n; dirty = true; }
        if (n !== im.count) { im.count = n; dirty = true; }
        im.visible = n > 0;
        const lod = this._lodOf(batch);
        if (lod) {
            this._chooseCut(batch, lod, n, dirty, frame);
        } else if (im.geometry !== batch.source) {
            im.geometry = batch.source;
            batch.bucket = batch.viewKey = undefined;
        }
        if (dirty) {
            im.instanceMatrix.needsUpdate = true;
            im.boundingSphere = null;   // frustum culling recomputes it from the instances
            im.boundingBox = null;
        }
    }

    /** Group all batchable meshes by geometry + material; unchanged batches are kept */
    rebuild() {
        const t0 = performance.now();
        this._changedAt = null;
        const byKey = new Map();
        const visit = o => {
            if (o.isMesh) {
                let st = this._state(o);
                if (!st) st = this._newState(o, -1);
                const key = st.key = this._keyOf(o);
                st.geometry = o.geometry; st.material = o.material; st.flags = flagsOf(o);
                if (key !== null) {
                    if (!byKey.has(key)) byKey.set(key, []);
                    byKey.get(key).push(o);
                }
            }
            for (const c of o.children) visit(c);
        };
        for (const root of this.roots()) if (root) visit(root);
        this._lodPlan(byKey, true);
        // occlusion culling only for large models (triangles counted per instance, like the LOD)
        let total = 0;
        for (const members of byKey.values()) {
            const g = members[0].geometry;
            total += members.length * (g.index ? g.index.count : g.getAttribute('position')?.count || 0) / 3;
        }
        this.occModel = total >= OCCLUSION.minTriangles;

        const old = new Map(this.batches.map(b => [b.key, b]));
        const batches = [];
        let instances = 0, created = 0;
        for (const [key, members] of byKey) {
            if (!this._batchable(members)) {
                for (const m of members) { const st = m[STATE]; if (st.batch) this._leave(m, st); }
                continue;
            }
            let batch = old.get(key);
            if (batch && sameMembers(batch.members, members)) old.delete(key);
            else { batch = this._takeStaged(key, members) || this._create(key, members); created++; }
            for (const m of members) this._join(m, m[STATE], batch);
            batches.push(batch);
            instances += members.length;
        }
        // dropped batches: members that are not in a new batch are drawn individually again
        for (const batch of old.values()) {
            for (const m of batch.members) {
                const st = this._state(m);
                if (st?.batch === batch) this._leave(m, st);
            }
            this._dispose(batch, this.group);
        }
        this.batches = batches;
        this._dropStaged();
        if (created) this.generation++;
        const ms = performance.now() - t0;
        this.stats = { batches: batches.length, instances, rebuilds: this.stats.rebuilds + 1, rebuildMs: ms };
    }

    // Compile the shaders of the next grouping before switching to it: its new InstancedMeshes (filled, not drawn
    // otherwise) hang in `staging` – same parent, camera and render target as the draw – only while compileAsync
    // (shader-compile.js) collects the scene, i.e. the same render objects as later. Called inside the draw
    // (renderer state = this render's). Current batches are detached meanwhile and the model roots hidden during the
    // (synchronous) collection → only the staged meshes are compiled. three.js yields to the main thread after every
    // object, also already compiled ones: with ~7700 individually drawn meshes at 13 fps the first grouping of a
    // huge model took minutes. Two rounds: first one staged mesh per shader variant (material, shadow flags, vertex
    // attributes) – these wait for their GPU pipelines –, then all the others: three.js builds the nodes of every
    // InstancedMesh anew (its uuid is part of the cache key) but finds the pipelines in its cache. Skipping the second
    // round (drawing them uncompiled) blocked the first frame of the new grouping for seconds (large assembly: 4.7 s).
    _stage(camera) {
        const old = new Map(this.batches.map(b => [b.key, b]));
        const staged = this._staged = { at: performance.now(), ready: false, batches: new Map() };
        for (const [key, members] of this._plan()) {
            if (!this._batchable(members)) continue;
            const batch = old.get(key);
            if (batch && sameMembers(batch.members, members)) continue;
            const b = this._create(key, members, this.staging);
            const im = b.mesh, array = im.instanceMatrix.array;
            members.forEach((m, i) => array.set(m.matrixWorld.elements, i * 16));
            im.count = members.length;
            im.frustumCulled = false;   // no bounds yet
            staged.batches.set(key, b);
        }
        if (!staged.batches.size) { staged.ready = true; return; }
        const variants = new Set(), first = [], rest = [];
        for (const b of staged.batches.values()) {
            const m = b.mesh, variant = `${m.material.id}/${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}/${Object.keys(m.geometry.attributes).sort().join()}`;
            if (variants.has(variant)) rest.push(m); else { variants.add(variant); first.push(m); }
        }
        // same render target/camera/parent as this draw – the second round starts from inside the next real draw
        // (renderer state of the call, shader-compile.js)
        staged.rest = rest;
        this._compileStaged(camera, first).then(() => {
            if (this._staged !== staged || !rest.length) return;
            return new Promise(resolve => { staged.next = resolve; });
        }).catch(err => console.warn('[Batches] shader precompile failed:', err)).finally(() => { staged.ready = true; });
    }

    // compileAsync with only `meshes` of the staging group visible (model roots hidden while three collects)
    _compileStaged(camera, meshes) {
        const show = new Set(meshes);
        const hidden = this.staging.children.filter(m => m.visible && !show.has(m));
        for (const m of hidden) m.visible = false;
        const roots = this.roots().filter(r => r?.visible);
        for (const r of roots) r.visible = false;
        this._hang(this.staging);
        try {
            // passes that draw the scene in another state (ambient-occlusion.js pre-pass): their variants of the new
            // batches too – otherwise their first draw builds every InstancedMesh synchronously (large assembly: 4 s)
            const compile = () => compileAsync(this.renderer, this.scene, camera);
            return Promise.all([compile(), ...this.compilePasses.map(pass => pass(compile))]);
        } catch (err) {
            return Promise.reject(err);
        } finally {
            for (const r of roots) r.visible = true;
            for (const m of hidden) m.visible = true;
            this.staging.removeFromParent();
        }
    }

    // grouping as rebuild() would do it – without touching the mesh states
    _plan() {
        const byKey = new Map();
        const visit = o => {
            if (o.isMesh) {
                const key = this._keyOf(o);
                if (key !== null) {
                    if (!byKey.has(key)) byKey.set(key, []);
                    byKey.get(key).push(o);
                }
            }
            for (const c of o.children) visit(c);
        };
        for (const root of this.roots()) if (root) visit(root);
        this._lodPlan(byKey, false);
        return byKey;
    }

    // staged batch with exactly these members → into the drawn group
    _takeStaged(key, members) {
        const batch = this._staged?.batches.get(key);
        if (!batch || !sameMembers(batch.members, members)) return null;
        this._staged.batches.delete(key);
        const im = batch.mesh;
        im.count = 0;   // _update fills the instances
        im.frustumCulled = members[0].frustumCulled;
        this.group.add(im);
        return batch;
    }

    _dropStaged() {
        if (!this._staged) return;
        for (const batch of this._staged.batches.values()) this._dispose(batch, this.staging);
        this._staged = null;
    }

    _create(key, members, parent = this.group) {
        const first = members[0];
        const im = new THREE.InstancedMesh(first.geometry, first.material, 0);
        im.name = `Batch ${first.name || ''}`.trim();
        im.count = 0;
        im.castShadow = first.castShadow;
        im.receiveShadow = first.receiveShadow;
        im.frustumCulled = first.frustumCulled;
        im.matrixAutoUpdate = false;
        im.raycast = () => {};
        im.userData.batch = true;
        // section caps ask whether the body is closed (same geometry = same solid)
        if (first.userData.instance !== undefined) im.userData.instance = first.userData.instance;
        if (first.userData.closedSolid !== undefined) im.userData.closedSolid = first.userData.closedSolid;
        // Instance matrices as a storage buffer: runtime-sized array in the shader → one shader per material.
        // The default (uniform buffer up to maxUniformBufferBindingSize – we request the adapter maximum)
        // writes the instance count into the shader (array<mat4x4f, N>) → every batch size was its own
        // shader, compiled synchronously on first use (freeze after loading and on the first view mode switch).
        // WebGL2 has no storage buffers: capacity rounded up to a power of two → few sizes.
        if (this.renderer.backend?.isWebGPUBackend) {
            im.instanceMatrix = new THREE.StorageInstancedBufferAttribute(new Float32Array(members.length * 16), 16);
        } else {
            im.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(2 ** Math.ceil(Math.log2(members.length)) * 16), 16);
            im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
        parent.add(im);
        return { key, mesh: im, members, slots: [], alive: true, source: first.geometry };
    }

    _clear() {
        for (const batch of this.batches) {
            for (const m of batch.members) {
                const st = this._state(m);
                if (st?.batch === batch) this._leave(m, st);
            }
            this._dispose(batch, this.group);
        }
        this.batches = [];
        this._dropStaged();
        this.token = {};   // all mesh states invalid
    }

    // frees the batch's render objects + instance buffers (geometry/material are shared, cuts belong to the store)
    _dispose(batch, parent) {
        batch.alive = false;
        batch.mesh.dispose();
        parent.remove(batch.mesh);
    }

    _batchable(members) {
        return members.length >= this.minInstances;
    }

    // Large enough for the cluster LOD? (drawn triangles of all batchable meshes ≥ LOD.minTriangles) → eligible =
    // geometries big enough, within the memory share; request = queue their builds (rebuild, not the staging plan)
    _lodPlan(byKey, request) {
        const lod = this.lod;
        lod.eligible = new Set();
        if (!this.lods || !lod.enabled) { lod.model = false; return; }
        let total = 0;
        for (const members of byKey.values()) {
            const g = members[0].geometry;
            total += members.length * (g.index ? g.index.count : g.getAttribute('position')?.count || 0) / 3;
        }
        lod.model = total >= LOD.minTriangles;
        if (!lod.model) return;
        let wanted = 0;
        for (const members of byKey.values()) {
            const g = members[0].geometry;
            if (!g.index || g.index.count / 3 < LOD.minPartTriangles) continue;
            if (!this.lods.get(g) && !this.lods.queued.has(g)) {
                if (!this.lods.fits(wanted + g.index.count / 3)) continue;   // over the memory share: stays full
                wanted += g.index.count / 3;
            }
            lod.eligible.add(g);
        }
        if (!request) return;
        for (const g of lod.eligible) this.lods.want(g);
        this.singles = [];
        for (const members of byKey.values()) {
            if (members.length < this.minInstances && lod.eligible.has(members[0].geometry)) {
                for (const mesh of members) this.singles.push({ mesh, source: mesh.geometry, bucket: undefined, cut: null, viewKey: null });
            }
        }
    }

    // occlusion culling of the individually drawn meshes: out of the camera's layer during the main render (restored
    // after it – picking, path tracer and the scene graph never see it)
    _cullSingles() {
        const occ = this.occlusion;
        let out = null;
        for (const m of occ.list) {
            if (m[STATE]?.batch || !occ.hidden(m) || !m.layers.isEnabled(0)) continue;
            m.layers.disable(0);
            (out ??= []).push(m);
        }
        return out;
    }

    // cut of an individually drawn mesh (camera or its matrix changed)
    _updateSingle(single, frame) {
        const st = this._state(single.mesh);
        const entry = this._view && this.lod.model && st && st.seen === frame && !st.batch && st.geometry === single.source
            && lodAllowed(single.mesh.material) ? this.lods.get(single.source) : null;
        if (!entry) { single.cut = null; single.bucket = single.viewKey = undefined; return; }
        if (!st.moved && single.viewKey === this._view.key) {
            if (single.bucket !== undefined) this.lods.cut(entry, single.bucket, frame);   // still in use (trim)
            return;
        }
        const t0 = performance.now();
        single.viewKey = this._view.key;
        let b = this._bucketOf(entry, st.matrix);
        if (single.bucket !== undefined && b === single.bucket + 1) b = single.bucket;
        single.bucket = b;
        const g = this.lods.cut(entry, b, frame);
        single.cut = g === single.source ? null : g;
        this.lod.selectMs += performance.now() - t0;
    }

    // during the raster render: the chosen cuts in place of the source geometries
    _swapSingles() {
        let out = null;
        for (const single of this.singles) {
            if (!single.cut || single.mesh.geometry !== single.source) continue;
            (out ??= []).push(single);
            single.mesh.geometry = single.cut;
        }
        return out;
    }

    _restoreSingles(list) {
        for (const single of list) single.mesh.geometry = single.source;
    }

    /** Debug colours on/off (lod-debug.js) – switched on once the debug shaders are compiled (no freeze) */
    async setTint(on) {
        const token = this._tintToken = {};
        if (!on) { this.lod.tint = false; return; }
        const camera = this.lodCamera?.();
        if (camera && this.enabled && this._depth === 0) {
            // only the batches: every InstancedMesh needs its own node build; individually drawn meshes share one
            // (same material, no uuid in three's cache key) – collected with the model roots hidden
            this._hang(this.group);
            const tinted = this._tint();
            const roots = this.roots().filter(r => r?.visible);
            for (const r of roots) r.visible = false;
            let job;
            try {
                job = compileAsync(this.renderer, this.scene, camera);
            } catch (err) {
                job = Promise.reject(err);
            } finally {
                for (const r of roots) r.visible = true;
                for (const [o, m] of tinted) o.material = m;
                this._detach();
            }
            await job.catch(err => console.warn('[LOD] debug colours: precompile failed:', err));
        }
        if (this._tintToken === token) this.lod.tint = true;   // not switched off meanwhile
    }

    // Debug colours on what is really drawn (during the raster render, materials restored after): batches and single
    // meshes with an LOD by the share of triangles their current cut keeps – red = all, then yellow, green, cyan,
    // blue = 1/128 or less (one colour per halving) –, everything else grey. One material, the colour per object
    // (userData.lodTint, uniform) – one shader variant; nine materials froze the page ~11 s on first use.
    _tint() {
        if (!this._tintMaterial) {
            const m = this._tintMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
            m.colorNode = uniform(new THREE.Color()).onObjectUpdate(({ object }) => object.userData.lodTint);
            this._tintColors = [...Array(TINT_STEPS).keys()].map(i => new THREE.Color().setHSL(i / (TINT_STEPS - 1) * 2 / 3, 0.85, 0.5))
                .concat(new THREE.Color(0x8a8a8a));
        }
        const mat = this._tintMaterial, colors = this._tintColors, grey = colors[TINT_STEPS];
        const step = (g, source) => {
            const full = source.index?.count || 1, now = g.index?.count || full;
            return colors[Math.min(TINT_STEPS - 1, Math.max(0, Math.floor(-Math.log2(now / full))))];
        };
        const out = [];
        const set = (o, color) => { out.push([o, o.material]); o.userData.lodTint = color; o.material = mat; };
        for (const b of this.batches) set(b.mesh, this._lodOf(b) ? step(b.mesh.geometry, b.source) : grey);
        const single = new Map(this.singles.map(x => [x.mesh, x]));
        const visit = o => {
            if (!o.visible) return;
            if (o.isMesh && !o.isSplat && o.layers.isEnabled(0) && !Array.isArray(o.material)) {
                const x = single.get(o);
                set(o, x && this.lods.get(x.source) && lodAllowed(o.material) ? step(o.geometry, x.source) : grey);
            }
            for (const c of o.children) visit(c);
        };
        for (const root of this.roots()) if (root) visit(root);
        return out;
    }

    // LOD entry of a batch (looked up again when the store has new ones) – null: drawn in full
    _lodOf(batch) {
        if (!this._view || !this.lod.model || !lodAllowed(batch.mesh.material)) return null;
        if (batch.lod === undefined || (!batch.lod && this._lodNew) || (batch.lod && !this.lods.fresh(batch.lod))) batch.lod = this.lods.get(batch.source) || null;
        return batch.lod;
    }

    _viewOf(camera) {
        camera.updateMatrixWorld();
        const height = this.renderer.getDrawingBufferSize(this._size ??= new THREE.Vector2()).y;
        const ortho = !!camera.isOrthographicCamera;
        // px per unit at distance 1 (perspective) / per unit (orthographic)
        const scale = ortho ? height / ((camera.top - camera.bottom) / camera.zoom) : height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 50) / 2));
        const e = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
        const all = !!this.lodAllVisible?.();
        const key = `${e.join()},${p.join()},${height},${this.lod.threshold},${all}`;
        if (this._view?.key === key) return this._view;
        const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        return { key, x: e[12], y: e[13], z: e[14], ortho, scale, tau: this.lod.threshold, all, planes: frustum.planes.map(pl => [pl.normal.x, pl.normal.y, pl.normal.z, pl.constant]) };
    }

    // cut of the batch: the finest one any of its instances needs (camera or instances changed). Hysteresis: finer at
    // once, coarser only by more than one bucket (a new cut costs an index upload + render object update)
    _chooseCut(batch, entry, n, dirty, frame) {
        const view = this._view, im = batch.mesh;
        if (!dirty && batch.viewKey === view.key) {
            if (batch.bucket !== undefined) this.lods.cut(entry, batch.bucket, frame);   // still in use (trim)
            return;
        }
        if (!n) return;
        const t0 = performance.now();
        batch.viewKey = view.key;
        let b = Infinity;
        for (let k = 0; k < n && b > entry.sourceBucket; k++) b = Math.min(b, this._bucketOf(entry, batch.slots[k][STATE].matrix));
        if (batch.bucket !== undefined && b === batch.bucket + 1) b = batch.bucket;
        batch.bucket = b;
        const g = this.lods.cut(entry, b, frame);
        if (im.geometry !== g) im.geometry = g;
        this.lod.selectMs += performance.now() - t0;
    }

    // LOD bucket for one placement (world matrix e): error below the threshold at the nearest point of its bounding
    // sphere; outside the view LOD.outsideFactor coarser
    _bucketOf(entry, e) {
        const { center, radius } = entry.geometry.boundingSphere;
        const { planes, ortho, scale, tau, all } = this._view;
        const s = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
        const x = e[0] * center.x + e[4] * center.y + e[8] * center.z + e[12];
        const y = e[1] * center.x + e[5] * center.y + e[9] * center.z + e[13];
        const z = e[2] * center.x + e[6] * center.y + e[10] * center.z + e[14];
        const r = radius * s;
        let factor = tau;
        if (!all) for (let p = 0; p < 6; p++) if (planes[p][0] * x + planes[p][1] * y + planes[p][2] * z + planes[p][3] < -r) { factor *= LOD.outsideFactor; break; }
        let E;
        if (ortho) E = factor / scale / s;
        else {
            const d = Math.hypot(x - this._view.x, y - this._view.y, z - this._view.z) - r;
            E = d > 0 ? factor * d / scale / s : 0;
        }
        return this.lods.bucket(entry, E);
    }

    _state(mesh) {
        const st = mesh[STATE];
        return st && st.token === this.token ? st : null;
    }

    _newState(mesh, seen) {
        const st = {
            token: this.token, key: this._keyOf(mesh), batch: null, home: null, seen,
            geometry: mesh.geometry, material: mesh.material, flags: flagsOf(mesh),
            matrix: new Float64Array(16), moved: true,
        };
        st.matrix.set(mesh.matrixWorld.elements);
        mesh[STATE] = st;
        return st;
    }
}

const STATE = Symbol('renderBatch');

// special materials keep their full geometry: wool shells and grass blades are made from it, clouds are volumes
// around it (glowing marble and toon contours are never batched – noBatch – and never get here as batches)
// occlusion culling: parts whose look ends at their surface (special materials grow beyond it, splats are no meshes
// here; several materials on one mesh are drawn individually anyway)
function occludable(mesh) {
    return !mesh.isSplat && !Array.isArray(mesh.material) && lodAllowed(mesh.material);
}

function lodAllowed(material) {
    const u = material?.userData;
    return !!u && !u.wool && !u.grass && !u.cloud && !u.noBatch;
}

// inputs of _keyOf besides geometry/material identity – compared per frame instead of building the key
function flagsOf(mesh) {
    const m = mesh.material;
    const fading = mesh.userData.fade !== undefined && mesh.userData.fade < 1;
    const range = mesh.geometry.drawRange;
    return (mesh.castShadow ? 1 : 0) | (mesh.receiveShadow ? 2 : 0) | (mesh.frustumCulled ? 4 : 0)
        | (m?.transparent ? 8 : 0) | (m?.transmission > 0 ? 16 : 0) | (fading ? 32 : 0)
        | (mesh.renderOrder !== 0 ? 64 : 0) | (range.start !== 0 || range.count !== Infinity ? 128 : 0);
}

function sameMembers(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function inScene(o, scene) {
    for (; o; o = o.parent) if (o === scene) return true;
    return false;
}
