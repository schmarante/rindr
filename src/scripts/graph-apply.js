// Applies the node graph of a material (hook MaterialManager.onApply):
//  - constant inputs -> material parameters (immediately)
//  - texture inputs -> baked maps (asynchronously, then onBaked -> update the path tracer)
//  - import texture directly at the matching input -> original texture as map (parameter = factor)
// If an imported material has a graph, the graph alone decides about the maps of these slots:
// unconnected inputs have no map (applyRender does not set them then).
// Baked maps repeat UV_TILE / size times per UV unit (output node `size` = mm per baked tile); a preview entry
// (entry.preview, material thumbnails on a sphere with 0..1 UVs) shows one tile across the visible half instead.
// UV mode (a picture that does not repeat – decal, isUvMode): the maps are baked once over the UV range of the meshes
// using the material (uvDomain callback) and placed there (repeat/offset, clamped) – no repetition.
import * as THREE from 'three/webgpu';
import { evaluateGraph, evaluateNode, nodeSignature, GraphBaker, loadImageTexture, isUvMode } from './material-graph.js';
import { PARAMS } from './material-manager.js';
import { UV_TILE } from './step-importer.js';

const defaultParams = () => Object.fromEntries(PARAMS.map(p => [p.key, p.default]));
// wait after a change before baking (changes in quick succession – a dragged value – bake once); baking is cheap
// now that values do not compile anew (material-graph.js uniformConstants) – was 150 ms
const BAKE_DELAY = 40;

// input -> material property (value) / map / value when a map is set / sRGB map
const SLOTS = {
    color: { prop: 'color', map: 'map', unit: '#ffffff', srgb: true },
    metalness: { prop: 'metalness', map: 'metalnessMap', unit: 1 },
    roughness: { prop: 'roughness', map: 'roughnessMap', unit: 1 },
    specularIntensity: { prop: 'specularIntensity', map: 'specularIntensityMap', unit: 1, alpha: true },
    specularColor: { prop: 'specularColor', map: 'specularColorMap', unit: '#ffffff', srgb: true },
    clearcoat: { prop: 'clearcoat', map: 'clearcoatMap', unit: 1 },
    clearcoatRoughness: { prop: 'clearcoatRoughness', map: 'clearcoatRoughnessMap', unit: 1 },
    transmission: { prop: 'transmission', map: 'transmissionMap', unit: 1 },
    sheen: { prop: 'sheen', map: 'sheenColorMap', unit: 1 },
    sheenRoughness: { prop: 'sheenRoughness', map: 'sheenRoughnessMap', unit: 1, alpha: true },
    iridescence: { prop: 'iridescence', map: 'iridescenceMap', unit: 1 },
    emissive: { prop: 'emissive', map: 'emissiveMap', unit: '#ffffff', srgb: true },
    ao: { map: 'aoMap' },
    normal: { map: 'normalMap' },
    height: { map: 'normalMap' },   // after 'normal': relief takes precedence
    alpha: { map: 'alphaMap' },     // cutout: alpha test at 0.5
    coatNormal: { map: 'clearcoatNormalMap' },
    coatHeight: { map: 'clearcoatNormalMap' },   // after 'coatNormal': relief takes precedence
    // strength + direction combined in material-graph.js (evaluateGraph: RG direction, B strength)
    anisotropyMap: { map: 'anisotropyMap' },
    coatAnisotropyMap: { map: 'coatAnisotropyMap' },
};
// relief inputs: baked from a height into a normal map
const RELIEF = new Set(['height', 'coatHeight']);

export class GraphApplier {
    /**
     * @param {{ onBaked?: (entry) => void, uvDomain?: (material) => { min: number[], max: number[] } | null }} opts
     *   uvDomain: UV range of the meshes using a material (UV mode); null → 0..1
     */
    constructor(renderer, { onBaked, uvDomain } = {}) {
        this.baker = new GraphBaker(renderer);
        this.onBaked = onBaked || (() => {});
        this.uvDomain = uvDomain || (() => null);
        this.images = new Map();     // Data-URL -> Promise<Texture>
        this.queue = Promise.resolve();
        this.pending = new Map();    // material ID -> timer
        this.waiting = new Set();    // material IDs with a bake run waiting in the queue
        this.baking = new Set();     // material IDs being baked right now
    }

    /** Synchronous part; schedules the baking */
    apply(entry) {
        const { material, def } = entry;
        const graph = def.graph;
        const maps = material.userData.graphMaps ||= {};
        if (!graph?.nodes?.length) {
            this._clearMaps(material, Object.keys(maps));
            material.alphaTest = def.render?.alphaTest || 0;
            return;
        }
        // images not loaded yet count as constant grey for now -> load, then evaluate again
        if (graph.nodes.some(n => n.type === 'image' && n.params?.image && !this.images.get(n.params.image)?.loaded)) {
            this._imageTextures(graph)
                .then(() => { if (entry.def.graph === graph) this.apply(entry); })
                .catch(err => console.error('[Material graph] Image could not be loaded:', err));
        }
        let result;
        try {
            result = evaluateGraph(graph, this._imageTexturesSync(graph), def.render?.maps, { domain: this._domain(entry) });
        } catch (err) {
            console.warn('[Material graph]', err.message);
            return;
        }
        const textured = [];
        const params = { ...defaultParams(), ...def.params };
        const assigned = new Set();   // map properties occupied by an input (normalMap: normal/height)
        for (const [key, slot] of Object.entries(SLOTS)) {
            const r = result[key];
            if (!r || r.kind !== 'tsl') this._clearMaps(material, [key], null);
            if (!r) {
                if (!assigned.has(slot.map)) setMap(material, slot.map, null);
                continue;
            }
            assigned.add(slot.map);
            if (r.kind === 'const') {
                setMap(material, slot.map, null);
                if (slot.prop) setProp(material, slot.prop, r.value);
            } else if (r.kind === 'map') {
                material[slot.map] = r.texture;
                if (slot.prop) setProp(material, slot.prop, params[slot.prop]);   // parameter as factor
            } else {
                if (slot.prop) setProp(material, slot.prop, slot.unit);
                if (maps[key]) material[slot.map] = maps[key];   // until (re)baked: previous texture
                textured.push(key);
            }
        }
        if (result.height?.kind === 'tsl') material.normalScale.setScalar(1);
        if (result.coatHeight?.kind === 'tsl') material.clearcoatNormalScale.setScalar(1);
        // anisotropy from the graph: a linked map multiplies the material's values (unit where the graph drives them);
        // constants straight into the material (direction 0..1 = 0..180°)
        const aMap = result.anisotropyMap, aConst = result.anisotropyConst;
        if (aMap) {
            if (aMap.strength) material.anisotropy = 1;
            if (aMap.direction) material.anisotropyRotation = 0;
        } else if (aConst) {
            if (aConst.strength !== null) material.anisotropy = aConst.strength;
            if (aConst.direction !== null) material.anisotropyRotation = aConst.direction * Math.PI;
        }
        // the coat's the same way (RindrMaterial: OpenPBR's own coat anisotropy, raster + path tracer)
        const cMap = result.coatAnisotropyMap, cConst = result.coatAnisotropyConst;
        if (material.setCoatAnisotropy && (cMap || cConst)) {
            const strength = cMap ? (cMap.strength ? 1 : null) : cConst.strength;
            const direction = cMap ? (cMap.direction ? 0 : null) : cConst.direction;
            material.setCoatAnisotropy(strength ?? material.coatAnisotropy, direction !== null ? direction * Math.PI : material.coatAnisotropyRotation);
        }
        material.alphaTest = result.alpha?.kind === 'tsl' ? 0.5 : def.render?.alphaTest || 0;
        material.userData.graphUvMode = !!result.domain;
        for (const tex of Object.values(maps)) place(tex, entry, result);
        material.needsUpdate = true;
        if (textured.length) this._schedule(entry);
    }

    /**
     * Apply and bake right away (no delay); resolves when the maps are there – material thumbnails of library
     * presets (entry = { material, def, preview: true }, not registered). Free the maps with release().
     */
    async applyNow(entry) {
        this.apply(entry);
        clearTimeout(this.pending.get(entry.def.id));
        this.pending.delete(entry.def.id);
        const run = this.queue.then(() => this._bake(entry));
        this.queue = run.catch(() => {});
        await run;
    }

    /**
     * Resolves once no bake of this material is scheduled, waiting or running – its sphere thumbnail renders after
     * that. Before, the thumbnail of a changed graph was rendered at once with the previous maps (the bake starts
     * BAKE_DELAY later), kept under the new graph's key, and nothing asked again when the new maps came: the preview of
     * the output node stayed behind (user: a checker into the colour, its fields changed – the sphere kept the old
     * ones). A change during the wait schedules a new run, which is waited for too (at most `timeout` ms).
     */
    async settled(id, timeout = 15000) {
        const end = performance.now() + timeout;
        while (performance.now() < end) {
            if (this.pending.has(id)) await new Promise(r => setTimeout(r, 40));
            else if (this.waiting.has(id) || this.baking.has(id)) await this.queue;
            else return;
        }
    }

    /** dispose the baked maps of a material that is thrown away (thumbnail of a preset) */
    release(material) {
        for (const tex of Object.values(material.userData.graphMaps || {})) tex.dispose();
        material.userData.graphMaps = {};
    }

    _schedule(entry) {
        const id = entry.def.id;
        clearTimeout(this.pending.get(id));
        this.pending.set(id, setTimeout(() => {
            this.pending.delete(id);
            // bake one after another (one bake target); one waiting run per material is enough – it bakes the graph
            // current when it starts
            if (this.waiting.has(id)) return;
            this.waiting.add(id);
            this.queue = this.queue.then(() => { this.waiting.delete(id); return this._bake(entry); })
                .catch(err => console.error('[Material graph] Baking failed:', err));
        }, BAKE_DELAY));
    }

    async _bake(entry) {
        const id = entry.def.id;
        this.baking.add(id);
        try { await this._bakeMaps(entry); } finally { this.baking.delete(id); }
    }

    async _bakeMaps(entry) {
        const { material, def } = entry;
        const graph = def.graph;
        if (!graph) return;
        const images = await this._imageTextures(graph);
        const result = evaluateGraph(graph, images, def.render?.maps, { domain: this._domain(entry) });
        const maps = material.userData.graphMaps ||= {};
        const sigs = material.userData.graphSigs ||= {};
        let changed = false;
        for (const [key, slot] of Object.entries(SLOTS)) {
            const r = result[key];
            if (!r || r.kind !== 'tsl') continue;
            const sig = (RELIEF.has(key) ? r.sig + '|' + result.reliefStrength : r.sig) + '|' + r.size + (result.domain ? '|' + JSON.stringify(result.domain) : '');
            if (maps[key] && sigs[key] === sig) {
                material[slot.map] = maps[key];   // unchanged -> keep the existing texture
                continue;
            }
            if (entry.def.graph !== graph) return;   // changed in the meantime -> a new run follows
            const tex = RELIEF.has(key)
                ? await this.baker.bakeNormal(r.node, result.reliefStrength, r.size)
                : await this.baker.bake(r.node, slot.alpha ? 'floatA' : r.type, { srgb: !!slot.srgb, size: r.size });
            if (entry.def.graph !== graph) { tex.dispose(); return; }   // changed in the meantime
            maps[key]?.dispose();
            place(tex, entry, result);
            maps[key] = tex;
            sigs[key] = sig;
            material[slot.map] = tex;
            if (key === 'sheen') material.sheenColor.set('#ffffff');
            changed = true;
        }
        if (!changed) return;
        material.needsUpdate = true;
        // a preview material (library thumbnail) is not in the scene – the path tracer must not restart for it
        if (!entry.preview) this.onBaked(entry);
    }

    /**
     * Preview of one node output for the node editor (graph of `def`): { size, pixels } (RGBA, sRGB, top row first) or
     * { color: [r, g, b] } (sRGB 0..1) for a constant; null if there is nothing. Baked in the queue with the maps;
     * the last results are kept by signature (unchanged nodes come back at once).
     */
    async previewNode(def, nodeId, port, size = 128) {
        const sig = nodeSignature(def.graph, nodeId, port, def.render?.maps) + '|' + size;
        const cache = this.previews ??= new Map();
        if (cache.has(sig)) return cache.get(sig);
        const run = async () => {
            const images = await this._imageTextures(def.graph);
            const r = evaluateNode(def.graph, nodeId, port, images, def.render?.maps, { bakeSize: size });
            if (!r) return null;
            if (r.isConst) {
                const c = r.type === 'float' ? [r.value, r.value, r.value] : r.value.clone().convertLinearToSRGB().toArray();
                return { color: c.map(v => Math.min(Math.max(v, 0), 1)) };
            }
            // values as plain grey (0.5 = middle grey), colours sRGB-encoded like the colour maps
            // the bake starts at v = 0 (texture order, bottom row first) – flipped for the canvas (top row first),
            // otherwise pictures stood on their head in the node while the material showed them upright
            const pixels = await this.baker.bakePixels(r.node, r.type, { srgb: r.type === 'color', size });
            return { size, pixels: flipRows(pixels, size) };
        };
        const job = this.queue.then(run);
        this.queue = job.catch(() => {});
        const res = await job;
        cache.set(sig, res);
        if (cache.size > 64) cache.delete(cache.keys().next().value);   // oldest first
        return res;
    }

    // UV mode: the bake domain (UV range of the meshes with this material; preview sphere 0..1) + tile scale; else null
    _domain(entry) {
        const graph = entry.def.graph;
        if (!isUvMode(graph)) return null;
        const d = (!entry.preview && this.uvDomain(entry.material)) || { min: [0, 0], max: [1, 1] };
        const size = graph.nodes.find(n => n.type === 'output')?.params?.size ?? 100;
        // a hair of margin so the clamped edge texels are not on the outermost vertices
        const pad = [0, 1].map(i => Math.max(1e-6, (d.max[i] - d.min[i]) * 0.002));
        return { min: [d.min[0] - pad[0], d.min[1] - pad[1]], max: [d.max[0] + pad[0], d.max[1] + pad[1]], scale: UV_TILE / size };
    }

    // Dispose baked maps. fallback undefined: put the imported texture (glTF/FBX) back
    // (material without graph), otherwise this value – apply() sets the map itself afterwards anyway.
    _clearMaps(material, keys, fallback) {
        const maps = material.userData.graphMaps || {};
        for (const key of keys) {
            if (!maps[key]) continue;
            if (material[SLOTS[key].map] === maps[key]) {
                setMap(material, SLOTS[key].map, fallback !== undefined ? fallback : material.userData.importMaps?.[SLOTS[key].map] ?? null);
            }
            maps[key].dispose();
            delete maps[key];
            delete material.userData.graphSigs?.[key];
            material.needsUpdate = true;
        }
    }

    // image textures: for the synchronous evaluation only those already loaded
    _imageTexturesSync(graph) {
        const out = new Map();
        for (const n of graph.nodes) {
            if (n.type === 'image' && n.params?.image && this.images.get(n.params.image)?.loaded) {
                out.set(n.id, this.images.get(n.params.image).loaded);
            }
        }
        return out;
    }

    async _imageTextures(graph) {
        const out = new Map();
        for (const n of graph.nodes) {
            const url = n.type === 'image' && n.params?.image;
            if (!url) continue;
            let entry = this.images.get(url);
            if (!entry) {
                entry = { promise: loadImageTexture(url) };
                entry.promise.then(t => { entry.loaded = t; });
                this.images.set(url, entry);
            }
            out.set(n.id, await entry.promise);
        }
        return out;
    }
}

// Workaround three.js r186 (Renderer._getShadowNodes): if a material had a color map, the shared
// shadow material keeps its color node even after the map was removed
// ("if (colorNode !== null)") -> the shadow pass reads map = null -> "reading 'matrix' of null",
// the render loop aborts. Hence never set the color map to null, but to white (× color = color).
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.colorSpace = THREE.SRGBColorSpace;
WHITE.needsUpdate = true;

// placement of a baked map on the model's UVs. Tile mode: repeat = UV_TILE mm per UV unit (box UVs) / mm per baked
// tile; preview sphere (0..1 UVs around and from pole to pole): one tile across the visible half, square.
// UV mode: the texture spans the bake domain once (clamped at its edges)
function place(tex, entry, result) {
    const d = result.domain;
    const wrap = d ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (tex.wrapS !== wrap || tex.wrapT !== wrap) { tex.wrapS = tex.wrapT = wrap; tex.needsUpdate = true; }
    if (d) {
        const sx = 1 / (d.max[0] - d.min[0]), sy = 1 / (d.max[1] - d.min[1]);
        tex.repeat.set(sx, sy);
        tex.offset.set(-d.min[0] * sx, -d.min[1] * sy);
    } else {
        tex.repeat.copy(entry.preview ? new THREE.Vector2(2, 1) : new THREE.Vector2(UV_TILE / result.size, UV_TILE / result.size));
        tex.offset.set(0, 0);
    }
}

// RGBA pixels (size², bottom row first) -> top row first
function flipRows(pixels, size) {
    const row = size * 4, out = new Uint8Array(pixels.length);
    for (let y = 0; y < size; y++) out.set(pixels.subarray(y * row, (y + 1) * row), (size - 1 - y) * row);
    return out;
}

function setMap(material, key, texture) {
    if (!texture && key === 'map' && material.map) texture = WHITE;
    if (material[key] !== texture) material[key] = texture;
}

function setProp(material, prop, value) {
    const target = material[prop];
    if (target?.isColor) {
        if (value?.isColor) target.copy(value); else target.set(value);
    } else {
        material[prop] = typeof value === 'number' ? value : Number(value);
    }
}
