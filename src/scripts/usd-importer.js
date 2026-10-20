// USD import (.usd, .usda, .usdc, .usdz) – three.js' USD parsers and composer (MIT, loaded on demand) with what a
// multi-file scene needs around them:
//  - layers: the root layer and every layer it references (references, payloads, sublayers – recursively) from the
//    dropped files / the zip package / the server next to the model; only referenced layers are parsed. The composer
//    looks them up in its asset map by path – a proxy normalises "a/../b" and falls back to the file name.
//  - instancing: three.js composes a referenced layer anew for every reference; here each (layer, prim, variants) is
//    composed once and further references get a clone that shares geometry and materials – an asset placed a
//    thousand times stays one geometry (mesh-importer.js dedups by geometry).
//  - references / payloads: the text parser only knew "prepend references" and "payload", the crate parser no
//    reference or payload list ops at all (subclasses below read them, string vectors – the crate's subLayers – and
//    inlined double vectors);
//    every arc of a prim ends up as one string of "@layer@<prim>" items in fields.references – the composer resolves
//    each; an arc without a prim path takes the target layer's defaultPrim (USD rule; three took the whole layer).
//  - sublayers: the composer ignores them; the layer stack is flattened into the root layer before composing –
//    specs of weaker layers fill in what the stronger ones leave open ("over" prims in the text format are read as
//    "def" so they can carry overrides). Arcs of a sublayer in another folder are rewritten relative to the root.
//  - pruned after flattening (the strongest opinion counts): prims with purpose proxy/guide (many assets carry a
//    proxy next to the render mesh – both were drawn), prims authored invisible or inactive (active = false) and class
//    prims (templates, inherits are not composed).
//  - overrides of referenced content: the composer composes a referenced layer without the referencing stack's "over"
//    prims below it – visibility and transforms authored there (directly or in a selected variant: hidden rim
//    variants, a steering variant) are applied to the composed tree afterwards, by prim path.
//  - transform ops by type, also suffixed ones ("xformOp:rotateX:unitsResolve") and every rotation order.
//  - reference cycles are cut; missing layers count only when the composition needed them.
//  - corners welded: the composer emits no index (three corners per triangle) – see weldAll.
//  - units: the composer scales by an authored metersPerUnit; without one USD means centimetres (spec default 0.01).
//    Z up: the composer turns the root.
// Materials: UsdPreviewSurface as far as the composer reads it; MDL shaders mapped onto physical materials with their
// textures (usd-mdl.js); bindings the stack authors over referenced parts applied afterwards (overrideComposed).
import * as THREE from 'three/webgpu';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { USDComposer } from 'three/addons/loaders/usd/USDComposer.js';
import { t } from './i18n.js';
import { debugLog } from './log.js';
import { mdlShader, applyMdl, UsdTextures, finishMaterials } from './usd-mdl.js';

export const USD_EXTENSIONS = ['usd', 'usda', 'usdc', 'usdz'];
const LAYER_EXTENSIONS = ['usd', 'usda', 'usdc'];
const CRATE = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43];   // "PXR-USDC"

const extOf = name => name.split('.').pop().toLowerCase();
const isCrate = bytes => bytes.length >= 8 && CRATE.every((b, i) => bytes[i] === b);

// "a/./b/../c" → "a/c" (no leading slash, forward slashes)
function normalize(path) {
    const out = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
}
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir, rel) => normalize(rel.startsWith('/') ? rel : (dir ? dir + '/' : '') + rel);

// --- parsers: what three's readers leave out ---
const ARC_KEY = /^(?:(prepend|append|add|delete|reorder)\s+)?(references|payload)$/;
class UsdaReader extends USDAParser {
    parseText(text) {
        // "over" prims: overrides of prims defined in a weaker layer (sublayers) – read as def, flattened later
        const root = super.parseText(text.replace(/^([ \t]*)over\b/gm, '$1def'));
        this.header = root['#usda 1.0'] || {};
        return root;
    }
    parseData(text) {
        const parsed = super.parseData(text);
        const subLayers = [...String(this.header.subLayers || '').matchAll(/@([^@]+)@/g)].map(m => m[1]);
        if (subLayers.length) (parsed.specsByPath['/'] ||= { specType: 6, fields: {} }).fields.subLayers = subLayers;
        return parsed;
    }
    // every form of the references / payload metadata (plain, prepend, append, add); delete/reorder dropped
    _extractPrimData(data, path, primFields, ...rest) {
        if (!data || typeof data !== 'object') return super._extractPrimData(data, path, primFields, ...rest);
        const arcs = [], rest0 = { ...data };
        for (const key in data) {
            const m = key.match(ARC_KEY);
            if (!m) continue;
            delete rest0[key];
            if (m[1] !== 'delete' && m[1] !== 'reorder' && typeof data[key] === 'string') arcs.push(data[key]);
        }
        super._extractPrimData(rest0, path, primFields, ...rest);
        if (arcs.length) primFields.references = arcs;
    }
}

// crate types (crateDataTypes.h)
const T_REFERENCE_LIST = 35, T_PAYLOAD = 47, T_LAYER_OFFSETS = 49, T_STRINGS = 50, T_PAYLOAD_LIST = 55;
// vectors of doubles / halves with integral components are inlined as signed bytes – three only decodes the float and
// int ones (a translate of (−40, −40, 0) came back as the number 55512): type → component count
const INLINED_BYTE_VECTORS = { 19: 2, 23: 3, 27: 4, 25: 3, 29: 4 };   // Vec2d, Vec3d, Vec4d, Vec3h, Vec4h
const inlineView = new DataView(new ArrayBuffer(4));
class UsdcReader extends USDCParser {
    _readInlinedValue(valueRep) {
        const n = INLINED_BYTE_VECTORS[valueRep.typeEnum];
        if (!n) return super._readInlinedValue(valueRep);
        inlineView.setUint32(0, valueRep.getInlinedValue(), true);
        return Array.from({ length: n }, (_, i) => inlineView.getInt8(i));
    }
    _readScalarValue(type) {
        const r = this.reader;
        const string = () => this.tokens[this.strings[r.readUint32()]] ?? '';
        const arc = withCustomData => {
            const asset = string(), prim = this.paths[r.readUint32()];
            // layer offsets: references always, payloads from crate 0.8
            if (withCustomData || this.version.major > 0 || this.version.minor >= 8) { r.readFloat64(); r.readFloat64(); }
            if (withCustomData) super._readScalarValue(31);   // customData (dictionary)
            return asset ? `@${asset}@${prim && prim !== '/' ? `<${prim}>` : ''}` : null;   // internal arcs (no layer): not composed
        };
        switch (type) {
            case T_REFERENCE_LIST:
            case T_PAYLOAD_LIST: {
                // header bits: explicit, has explicit/added/deleted/ordered/prepended/appended; lists in the order
                // explicit, added, prepended, appended, deleted, ordered (crateFile.cpp)
                const bits = r.readUint8(), out = [];
                for (const [bit, keep] of [[0x02, true], [0x04, true], [0x20, true], [0x40, true], [0x08, false], [0x10, false]]) {
                    if (!(bits & bit)) continue;
                    for (let i = 0, n = r.readUint64(); i < n; i++) {
                        const item = arc(type === T_REFERENCE_LIST);
                        if (keep && item) out.push(item);
                    }
                }
                return out.join(' ');
            }
            case T_PAYLOAD: return arc(false) || '';
            case T_STRINGS: {
                const out = [];
                for (let i = 0, n = r.readUint64(); i < n; i++) out.push(string());
                return out;
            }
            case T_LAYER_OFFSETS: return null;
            default: return super._readScalarValue(type);
        }
    }
}

// --- shared composition of referenced layers (instancing) ---
// The composer creates a new composer per reference (inside _resolveReference) – patched once on its prototype
// (also: applyTransform and _findSingleMesh below);
// the state is only active during loadUsd (one load at a time: runLoad in viewer.js serialises loading).
let active = null;   // { cache: Map, composers: USDComposer[] }
const originalResolve = USDComposer.prototype._resolveReference;
const originalCompose = USDComposer.prototype.compose;
USDComposer.prototype.compose = function (...args) {
    active?.composers.push(this);   // texture promises of nested composers too
    return originalCompose.apply(this, args);
};
// transform ops: three only knows the plain op names – suffixed ones ("xformOp:rotateX:unitsResolve",
// "xformOp:translate:pivot2", common in exports of DCC tools) and rotations other than XYZ were skipped. The op stack
// in xformOpOrder, each op by its type, "!invert!" inverted, composed like three does (column vectors: forward).
const opMatrix = new THREE.Matrix4(), opEuler = new THREE.Euler(), opQuat = new THREE.Quaternion();
const DEG = Math.PI / 180;
const originalApplyTransform = USDComposer.prototype.applyTransform;
USDComposer.prototype.applyTransform = function (obj, fields, attrs = {}) {
    const data = { ...fields, ...attrs };
    const order = data.xformOpOrder;
    if (!Array.isArray(order) || !order.length) return originalApplyTransform.call(this, obj, fields, attrs);
    const matrix = new THREE.Matrix4();
    for (const op of order) {
        if (op === '!resetXformStack!') continue;
        const inverse = op.startsWith('!invert!');
        const name = inverse ? op.slice(8) : op;
        const v = data[name];
        if (v === undefined || v === null) continue;
        const type = name.split(':')[1] || '';
        if (type === 'translate') opMatrix.makeTranslation(v[0], v[1], v[2]);
        else if (type === 'scale') (Array.isArray(v) ? opMatrix.makeScale(v[0], v[1], v[2]) : opMatrix.makeScale(v, v, v));
        else if (type === 'rotateX') opMatrix.makeRotationX(v * DEG);
        else if (type === 'rotateY') opMatrix.makeRotationY(v * DEG);
        else if (type === 'rotateZ') opMatrix.makeRotationZ(v * DEG);
        else if (/^rotate[XYZ]{3}$/.test(type)) {
            // rotateXZY: first about X, then Z, then Y – three's Euler order names the axes the other way round
            opEuler.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, type.slice(6).split('').reverse().join(''));
            opMatrix.makeRotationFromEuler(opEuler);
        } else if (type === 'orient' && v.length === 4) opMatrix.makeRotationFromQuaternion(opQuat.set(v[0], v[1], v[2], v[3]));
        else if (type === 'transform' && v.length === 16) opMatrix.set(v[0], v[4], v[8], v[12], v[1], v[5], v[9], v[13], v[2], v[6], v[10], v[14], v[3], v[7], v[11], v[15]);
        else continue;
        if (inverse) opMatrix.invert();
        matrix.multiply(opMatrix);
    }
    obj.matrix.copy(matrix);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    // kept until overrides of referenced content are applied (overrideComposed), then removed
    if (active) obj.userData.usdXform = Object.fromEntries(Object.entries(data).filter(([k]) => k === 'xformOpOrder' || k.startsWith('xformOp:')));
};

// materials: named after their prim, MDL shaders mapped (usd-mdl.js), keyed per (layer, material path) – the composer
// builds a new material for every mesh (hundreds of copies of "Material 12"), merged after composing (shareMaterials)
const layerIds = new WeakMap();
const originalApplyMaterial = USDComposer.prototype._applyMaterial;
USDComposer.prototype._applyMaterial = function (material, materialPath) {
    originalApplyMaterial.call(this, material, materialPath);
    if (!active) return;
    const path = String(materialPath).replace(/^<|>$/g, '');
    if (!layerIds.has(this.specsByPath)) layerIds.set(this.specsByPath, layerIds.size + 1);
    material.name = path.split('/').pop();
    material.userData.usdKey = `${layerIds.get(this.specsByPath)}|${path}`;
    material.userData.usdBound = true;
    const mdl = mdlShader(this, path);
    if (mdl) applyMdl(material, mdl, active.textures, this.basePath || '');
};

// textures of UsdPreviewSurface through the same loading (usd-mdl.js UsdTextures: files, package, server, size limit,
// missing ones listed) – the composer loaded them by a path relative to the page for scenes opened by URL
const originalLoadTexture = USDComposer.prototype._loadTexture;
USDComposer.prototype._loadTexture = function (filePath, textureAttrs, transformAttrs) {
    if (!active) return originalLoadTexture.call(this, filePath, textureAttrs, transformAttrs);
    const texture = active.textures.request(String(filePath).replace(/^@|@$/g, ''), this.basePath || '');
    if (!texture) return null;
    if (textureAttrs) {
        texture.wrapS = this._getWrapMode(textureAttrs['inputs:wrapS']);
        texture.wrapT = this._getWrapMode(textureAttrs['inputs:wrapT']);
    }
    this._applyTextureTransforms(texture, transformAttrs);
    return texture;
};

// subset names on the geometry (material index = position in this list) – the stack may bind materials to subsets
// of a referenced mesh (overrideComposed)
const originalSubsetGeometry = USDComposer.prototype._buildGeometryWithSubsets;
USDComposer.prototype._buildGeometryWithSubsets = function (attrs, subsets, ...rest) {
    const geometry = originalSubsetGeometry.call(this, attrs, subsets, ...rest);
    if (active && geometry) geometry.userData.usdSubsets = subsets.map(x => x.name);
    return geometry;
};

// a reference resolving to one mesh is merged into the referencing prim – three took the first mesh of the group even
// when it had siblings, and dropped those (a car body of 180 parts became one mesh)
const originalSingleMesh = USDComposer.prototype._findSingleMesh;
USDComposer.prototype._findSingleMesh = function (group) {
    return group.children.length === 1 ? originalSingleMesh.call(this, group) : null;
};
USDComposer.prototype._resolveReference = function (refValue, localVariants = {}) {
    if (!active) return originalResolve.call(this, refValue, localVariants);
    const m = refValue.match(/@([^@]+)@(?:<([^>]+)>)?/);
    if (!m) return null;
    const resolved = this._resolveFilePath(m[1]);
    if (!this.assets[resolved]) { active.missing.add(resolved); return null; }
    // no prim path: the target layer's defaultPrim
    if (!m[2]) {
        const prim = this.assets[resolved]?.specsByPath?.['/']?.fields?.defaultPrim;
        if (prim) refValue = `@${m[1]}@</${prim}>`;
    }
    const key = `${resolved}|${refValue}|${JSON.stringify({ ...localVariants, ...this.externalVariantSelections })}`;
    const cached = active.cache.get(key);
    if (cached !== undefined) return cached ? cached.clone() : null;
    // a cycle of references (a layer referencing itself, directly or further down): not followed again
    if (active.resolving.has(key) || active.resolving.size > 64) return null;
    active.resolving.add(key);
    let group;
    try {
        group = originalResolve.call(this, refValue, localVariants);
    } finally {
        active.resolving.delete(key);
    }
    // the referenced prim stands for the referencing one (USD): its children directly under it, unless it carries a
    // transform of its own (kept as a level then)
    const only = group?.children.length === 1 && refValue.includes('<') ? group.children[0] : null;
    if (only && !only.isMesh && only.position.lengthSq() === 0 && only.quaternion.w === 1 && only.scale.x === 1 && only.scale.y === 1 && only.scale.z === 1) {
        group = new THREE.Group();
        while (only.children.length) group.add(only.children[0]);
    }
    active.cache.set(key, group ? group.clone() : null);   // pristine copy – the caller re-parents and renames the result
    return group;
};

/**
 * Read a USD scene into a three.js group.
 * @param {{ name: string, main: Blob|null, url?: string, baseUrl?: string, files: { path: string, file: Blob }[] }} source
 * @param {ArrayBuffer} buffer  the main file
 * @param {THREE.LoadingManager} manager  resolves textures (dropped files / server)
 * @returns {Promise<{ object: THREE.Group, scale: number, stats: object }>}  scale: scene units → mm
 */
export async function loadUsd(source, buffer, manager, onStatus = () => {}) {
    const bytes = new Uint8Array(buffer);
    // files by normalised path and by name: dropped files, or the contents of a .usdz
    const byPath = new Map(), byName = new Map();
    const add = (path, data) => {
        const p = normalize(path).toLowerCase();
        byPath.set(p, data);
        const name = p.split('/').pop();
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ path: p, data });
    };
    let rootPath = source.name;
    const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (zipped) {
        // .usdz: the first entry is the root layer (AOUSD core spec 16.4.1.2)
        const zip = unzipSync(bytes);
        const names = Object.keys(zip);
        if (!names.length) throw new Error(t('import.usd.noLayer'));
        rootPath = names[0];
        for (const n of names) add(n, zip[n]);
    } else {
        for (const { path, file } of source.files || []) add(path, file);
        add(rootPath, bytes);
    }
    const fetchBase = !zipped && source.baseUrl ? new URL(source.baseUrl, location.href) : null;
    const read = async path => {
        const key = normalize(path).toLowerCase();
        // by name as a fallback (loose files dropped without their folders) – never the root layer itself: a sublayer
        // named like the root made the root include itself, endlessly
        let data = byPath.get(key) ?? byName.get(key.split('/').pop())?.find(e => e.path !== normalize(rootPath).toLowerCase())?.data;
        if (!data && fetchBase) {
            // the base URL is the root layer's folder (the root's name may carry folders of its own)
            const rel = relative(dirOf(normalize(rootPath)), normalize(path));
            const res = await fetch(new URL(rel.split('/').map(p => (p === '..' ? p : encodeURIComponent(p))).join('/'), fetchBase)).catch(() => null);
            if (res?.ok) data = new Uint8Array(await res.arrayBuffer());
        }
        if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
        return data ?? null;
    };

    // all layers: the root and what it references, recursively
    const usda = new UsdaReader(), usdc = new UsdcReader(), text = new TextDecoder();
    const layers = new Map();   // normalised path → parsed layer
    const unread = new Set();   // referenced layers not found (also arcs of unselected variants / pruned prims)
    const queue = [normalize(rootPath)];
    const queued = new Set(queue);
    while (queue.length) {
        const path = queue.shift();
        onStatus(t('import.usd.layers', { count: layers.size + 1 }));
        const isRoot = path === normalize(rootPath);
        const layerBytes = isRoot && !zipped ? bytes : await read(path);
        if (!layerBytes) { unread.add(path); continue; }
        let parsed;
        try {
            parsed = isCrate(layerBytes) ? usdc.parseData(layerBytes.buffer.slice(layerBytes.byteOffset, layerBytes.byteOffset + layerBytes.byteLength))
                : usda.parseData(text.decode(layerBytes));
        } catch (err) {
            if (isRoot) throw new Error(t('import.usd.parseError', { message: err.message }));
            console.warn('[USD] layer not readable:', path, err.message);
            continue;
        }
        normalizeArcs(parsed);
        layers.set(path, parsed);
        for (const ref of layerReferences(parsed)) {
            if (!LAYER_EXTENSIONS.includes(extOf(ref)) || /^[a-z][\w+.-]*:/i.test(ref)) continue;   // URLs of other servers: not fetched
            const target = join(dirOf(path), ref);
            if (!queued.has(target)) { queued.add(target); queue.push(target); }
        }
        // yield now and then (large scenes: hundreds of layers)
        if (layers.size % 16 === 0) await new Promise(r => setTimeout(r));
    }
    const root = layers.get(normalize(rootPath));
    if (!root) throw new Error(t('import.usd.noLayer'));

    // asset map for the composer: parsed layers by normalised path (+ raw images of a .usdz for its textures)
    const assets = new Proxy({}, {
        get: (_, key) => (typeof key === 'string' ? (layers.get(normalize(key)) ?? (zipped ? byPath.get(normalize(key).toLowerCase()) : undefined)) : undefined),
        has: (_, key) => typeof key === 'string' && (layers.has(normalize(key)) || (zipped && byPath.has(normalize(key).toLowerCase()))),
        ownKeys: () => [...layers.keys(), ...(zipped ? [...byPath.keys()].filter(k => !LAYER_EXTENSIONS.includes(extOf(k))) : [])],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });

    // the layer stack: sublayers (recursively, strongest first) flattened into the root layer
    const rootKey = normalize(rootPath);
    flatten(root, rootKey, layers, new Set([rootKey]));
    // after flattening: a stronger layer's opinion counts (an "over … active = false" on a sublayer's prim)
    let hiddenPaths = [];
    for (const layer of layers.values()) {
        // variant selections of prims removed by the pruning stay readable for the root's hidden paths
        if (layer === root) layer.unprunedOwners = new Map(Object.entries(layer.specsByPath).filter(([, sp]) => sp.fields?.variantSelection));
        const hidden = prune(layer);
        if (layer === root) hiddenPaths = hidden;
    }
    delete root.unprunedOwners;

    onStatus(t('import.usd.composing'));
    await new Promise(r => setTimeout(r));
    // textures of MDL materials: dropped files / package entries by path, then by name (also images downloaded from a
    // server the scene points to – matched by file name), else the server next to the model; other servers: missing
    const textures = new UsdTextures((path, layerDir) => {
        const remote = /^[a-z][\w+.-]*:/i.test(path);
        const full = remote ? path.split('/').pop().toLowerCase() : join(layerDir, path).toLowerCase();
        const local = (remote ? undefined : byPath.get(full)) ?? byName.get(full.split('/').pop())?.[0]?.data;
        if (local) return { key: full, read: async () => (local instanceof Blob ? local : new Blob([local])) };
        if (remote || !fetchBase) return null;
        const url = new URL(relative(dirOf(normalize(rootPath)), join(layerDir, path)).split('/').map(p => (p === '..' ? p : encodeURIComponent(p))).join('/'), fetchBase);
        return { key: full, read: async () => { const res = await fetch(url).catch(() => null); return res?.ok ? res.blob() : null; } };
    });
    active = { cache: new Map(), composers: [], missing: new Set(), resolving: new Set(), textures };
    const { composers, missing: missingSet } = active;
    let object, hidden, overridden;
    try {
        const composer = new USDComposer(manager);
        object = composer.compose(root, assets, {}, dirOf(rootKey));
        hidden = hideComposed(object, hiddenPaths);
        overridden = overrideComposed(object, root, composer);
    } finally {
        active = null;
    }
    await Promise.all(composers.flatMap(c => c.texturePromises || [])).catch(err => console.warn('[USD] texture:', err?.message || err));
    const materials = shareMaterials(object);
    const texStats = await textures.load((done, total) => onStatus(t('import.usd.textures', { done, total })));
    finishMaterials(materials);
    dropEmpty(object);
    const welded = await weldAll(object, onStatus);

    // units: an authored metersPerUnit is applied by the composer (root group scaled), otherwise centimetres
    const authored = root.specsByPath['/']?.fields?.metersPerUnit;
    const scale = authored !== undefined ? 1000 : 10;
    // missing = layers the composition actually needed (USD itself only warns about the others)
    const missingLayers = [...missingSet].map(normalize).filter(p => unread.has(p));
    // nothing to draw because the layers with the geometry are missing (main file dropped without its folder): say so
    // instead of "no faces"
    let meshCount = 0;
    object.traverse(o => { if (o.isMesh) meshCount++; });
    if (!meshCount && missingLayers.length) {
        const names = missingLayers.map(p => p.split('/').pop());
        throw new Error(t('import.usd.layersMissing', { files: names.slice(0, 4).join(', ') + (names.length > 4 ? ` (+${names.length - 4})` : '') }));
    }
    const missingTextures = textures.missingFor(new Set(materials));
    const missing = [...missingLayers, ...missingTextures];
    const stats = { layers: layers.size, missing: missing.length, hiddenByOverrides: hidden, movedByOverrides: overridden, welded, materials: materials.length, textures: { ...texStats, missing: missingTextures.length }, metersPerUnit: authored ?? 0.01, upAxis: root.specsByPath['/']?.fields?.upAxis || 'Y' };
    if (unread.size) console.warn('[USD] referenced layers not found:', [...unread].slice(0, 10), missingLayers.length ? '(needed)' : '(not needed by the composed stage)');
    debugLog('[USD]', stats);
    object.name ||= source.name.replace(/\.[^.]+$/, '');
    return { object, scale, stats, missing };
}

// asset paths of the layers a parsed layer refers to: references (payloads merged in) of all prims, sublayers
function layerReferences(parsed) {
    const out = [];
    for (const path in parsed.specsByPath) {
        const fields = parsed.specsByPath[path].fields;
        if (!fields) continue;
        for (const m of String(fields.references?.[0] || '').matchAll(/@([^@]+)@/g)) out.push(m[1]);
        if (path === '/') out.push(...(fields.subLayers || []));
    }
    return out;
}

// all arcs of a prim (references and payloads, however the parser stored them) as one string of "@layer@<prim>" items
// in references[0] – the form the composer reads
function normalizeArcs(parsed) {
    const items = v => {
        if (!v) return [];
        if (Array.isArray(v)) return v.flatMap(items);
        if (typeof v === 'string') return [...v.matchAll(/@[^@]+@(?:<[^>]+>)?/g)].map(m => m[0]);
        if (typeof v === 'object' && v.assetPath) return [`@${v.assetPath}@`];
        return [];
    };
    for (const path in parsed.specsByPath) {
        const fields = parsed.specsByPath[path].fields;
        if (!fields || (!fields.references && !fields.payload)) continue;
        const arcs = [...items(fields.references), ...items(fields.payload)];
        delete fields.payload;
        if (arcs.length) fields.references = [arcs.join(' ')]; else delete fields.references;
    }
}

// path from folder `from` to `to` (both normalised, relative to the same root)
function relative(from, to) {
    const a = from ? from.split('/') : [], b = to.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

// sublayers of `layer` (strongest first, each with its own sublayers) merged into it: specs it lacks are taken over,
// fields it leaves open filled in; layer metadata (units, up axis) stays the root's. Arcs of a layer in another folder
// are rewritten relative to the root layer's folder (the composer resolves them from there).
function flatten(target, targetKey, layers, seen, layer = target, layerKey = targetKey) {
    for (const sub of layer.specsByPath['/']?.fields?.subLayers || []) {
        const key = join(dirOf(layerKey), sub);
        const subLayer = layers.get(key);
        if (!subLayer || seen.has(key)) continue;
        seen.add(key);
        const moved = dirOf(key) !== dirOf(targetKey);
        for (const path in subLayer.specsByPath) {
            if (path === '/') continue;
            const spec = subLayer.specsByPath[path];
            if (moved && spec.fields?.references) {
                spec.fields.references = [spec.fields.references[0].replace(/@([^@]+)@/g, (all, ref) => (/^[a-z][\w+.-]*:/i.test(ref) || ref.startsWith('/') ? all : `@${relative(dirOf(targetKey), join(dirOf(key), ref))}@`))];
            }
            const own = target.specsByPath[path];
            if (!own) { target.specsByPath[path] = spec; continue; }
            for (const k in spec.fields) {
                if (own.fields[k] === undefined || own.fields[k] === '') own.fields[k] = spec.fields[k];
                // variant selections compose per variant set
                else if (k === 'variantSelection') own.fields[k] = { ...spec.fields[k], ...own.fields[k] };
            }
        }
        flatten(target, targetKey, layers, seen, subLayer, key);
    }
}

// prims that a renderer does not show: purpose proxy/guide, visibility invisible, inactive, classes – removed with
// their subtree
function prune(parsed) {
    const specs = parsed.specsByPath;
    const hidden = new Set();
    for (const path in specs) {
        const dot = path.lastIndexOf('.');
        if (dot < 0) continue;
        const attr = path.slice(dot + 1), value = specs[path].fields?.default;
        if ((attr === 'purpose' && (value === 'proxy' || value === 'guide')) || (attr === 'visibility' && value === 'invisible')) hidden.add(path.slice(0, dot));
    }
    // class prims (crate; templates) and deactivated prims (active = false: not part of the stage at all)
    for (const path in specs) if (specs[path].fields?.specifier === 2 || specs[path].fields?.active === false) hidden.add(path);
    if (!hidden.size) return [];
    // a spec goes when its prim or an ancestor is hidden (walk up the path)
    for (const path in specs) {
        let prim = path.includes('.') ? path.slice(0, path.indexOf('.')) : path;
        while (prim && prim !== '/') {
            if (hidden.has(prim)) { delete specs[path]; break; }
            prim = prim.slice(0, prim.lastIndexOf('/'));
        }
    }
    // the hidden prims as plain paths (a prim inside a variant only for the selected variant) – an over can hide a part
    // that comes from a referenced layer, removed from the composed tree then (hideComposed)
    const out = [];
    for (const path of hidden) {
        const plain = plainPath(path, p => specs[p] || parsed.unprunedOwners?.get(p));
        if (plain) out.push(plain);
    }
    return out;
}

// a spec path inside variants ("/A/{set=name}/B" in the crate, "/A{set=name}B" in text) as the plain prim path, or
// null when one of its variants is not the selected one
function plainPath(path, specOf) {
    if (!path.includes('{')) return path;
    for (const m of path.matchAll(/\{([^=}]+)=([^}]*)\}/g)) {
        if (specOf(path.slice(0, m.index).replace(/\/$/, ''))?.fields?.variantSelection?.[m[1]] !== m[2]) return null;
    }
    return path.replace(/\/?\{[^}]*\}\/?/g, '/');
}

// object of the composed tree at a prim path (object names = prim names; a reference may have left one extra level –
// the referenced prim – so a missing name is looked for one level further down)
function findComposed(root, path) {
    const find = (obj, names) => {
        if (!names.length) return obj;
        const direct = obj.children.filter(c => c.name === names[0]);
        for (const c of direct) { const hit = find(c, names.slice(1)); if (hit) return hit; }
        if (direct.length) return null;
        for (const c of obj.children) for (const cc of c.children) if (cc.name === names[0]) { const hit = find(cc, names.slice(1)); if (hit) return hit; }
        return null;
    };
    const hit = find(root, path.split('/').filter(Boolean));
    return hit === root ? null : hit;
}

// transforms the root layer stack authors over prims (directly or in a selected variant) – also over prims that came
// from a referenced layer, which the composer composed without them (a steering variant turning the front wheels).
// Strength: direct opinion > variant > the referenced layer's own.
function overrideComposed(root, parsed, composer) {
    const specs = parsed.specsByPath;
    const byPrim = new Map();
    const entryOf = prim => byPrim.get(prim) || byPrim.set(prim, { direct: {}, variant: {}, binding: null, bindingFromVariant: true }).get(prim);
    for (const path in specs) {
        const dot = path.lastIndexOf('.');
        if (dot < 0) continue;
        const attr = path.slice(dot + 1);
        const fromVariant = path.includes('{');
        if (attr === 'material:binding') {
            // material bound by the stack to a prim (often a part of referenced content: a variant's paint colour)
            const target = specs[path].fields?.targetPaths?.[0];
            const prim = target && plainPath(path.slice(0, dot), p => specs[p]);
            if (!prim) continue;
            const entry = entryOf(prim);
            if (!entry.binding || (entry.bindingFromVariant && !fromVariant)) { entry.binding = String(target).replace(/^<|>$/g, ''); entry.bindingFromVariant = fromVariant; }
            continue;
        }
        if (attr !== 'xformOpOrder' && !attr.startsWith('xformOp:')) continue;
        const value = specs[path].fields?.default;
        if (value === undefined || value === null) continue;
        const prim = plainPath(path.slice(0, dot), p => specs[p]);
        if (!prim) continue;
        entryOf(prim)[fromVariant ? 'variant' : 'direct'][attr] = value;
    }
    let changed = 0;
    const bindings = [];
    const subsetBindings = [];
    for (const [prim, { direct, variant, binding }] of byPrim) {
        // a subset of a mesh: its material slot (the composer may have built an empty group for the override – dropped
        // later as empty)
        const mesh = binding && findComposed(root, prim.slice(0, prim.lastIndexOf('/')));
        const slot = mesh?.isMesh && Array.isArray(mesh.material) ? (mesh.geometry.userData.usdSubsets || []).indexOf(prim.split('/').pop()) : -1;
        if (slot >= 0) { subsetBindings.push({ mesh, slot, binding }); continue; }
        const obj = findComposed(root, prim);
        if (!obj) continue;
        if (binding) bindings.push({ prim, obj, binding });
        const base = obj.userData.usdXform || {};
        const merged = { ...base, ...variant, ...direct };
        if (!merged.xformOpOrder || Object.keys(merged).every(k => JSON.stringify(merged[k]) === JSON.stringify(base[k]))) continue;
        USDComposer.prototype.applyTransform.call(null, obj, merged);
        changed++;
    }
    root.traverse(o => { delete o.userData.usdXform; });
    // bindings from the top down: a binding reaches the meshes below that have none of their own (a part of the
    // referenced layer bound there wins, as in USD); a deeper binding of the stack replaces one from above
    bindings.sort((a, b) => a.prim.split('/').length - b.prim.split('/').length);
    const fromStack = new Set(), built = new Map();
    const materialFor = binding => {
        if (!built.has(binding)) built.set(binding, composer.specsByPath[binding] ? composer._buildMaterialForPath(binding) : null);
        return built.get(binding);
    };
    for (const { mesh, slot, binding } of subsetBindings) {
        const material = materialFor(binding);
        if (material) mesh.material[slot] = material;   // per mesh array (clones copy it)
    }
    for (const { obj, binding } of bindings) {
        const material = materialFor(binding);
        if (!material) continue;
        obj.traverse(o => {
            if (!o.isMesh || Array.isArray(o.material)) return;
            if (o !== obj && o.material?.userData.usdBound && !fromStack.has(o)) return;
            o.material = material;
            fromStack.add(o);
        });
    }
    return changed;
}

// one material per (layer, material path) – the composer made a copy for every mesh
function shareMaterials(root) {
    const byKey = new Map(), all = new Set();
    const share = m => {
        const key = m?.userData?.usdKey;
        if (!key) { if (m) all.add(m); return m; }
        if (!byKey.has(key)) { byKey.set(key, m); all.add(m); }
        return byKey.get(key);
    };
    root.traverse(o => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material) ? o.material.map(share) : share(o.material);
    });
    root.traverse(o => { if (o.isMesh) delete o.geometry.userData.usdSubsets; });
    for (const m of all) { delete m.userData.usdKey; delete m.userData.usdBound; }
    return [...all];
}

// objects of the composed tree at the given prim paths removed
function hideComposed(root, paths) {
    let removed = 0;
    for (const path of paths) {
        const hit = findComposed(root, path);
        if (hit) { hit.removeFromParent(); removed++; }
    }
    return removed;
}

// The composer emits every mesh without an index – three corners of their own per triangle (35 M vertices for a
// 12 M triangle model): the path tracer packs all vertex data into one buffer and failed with "Array buffer
// allocation failed", the raster held three times the geometry. Corners equal in every attribute (bit for bit) become
// one vertex + index; groups (materials per subset) keep their ranges – they count index entries now. Geometries
// shared by instances are welded once. Skipped: morph targets, attributes other than 32 bit, interleaved data.
async function weldAll(root, onStatus) {
    const seen = new Set();
    let before = 0, after = 0, last = performance.now();
    const meshes = [];
    root.traverse(o => { if (o.isMesh && !seen.has(o.geometry)) { seen.add(o.geometry); meshes.push(o.geometry); } });
    for (let i = 0; i < meshes.length; i++) {
        const g = meshes[i];
        const count = g.attributes.position?.count || 0;
        if (weldGeometry(g)) { before += count; after += g.attributes.position.count; }
        if (performance.now() - last > 50) {   // keep the page responsive on large scenes
            onStatus(t('import.usd.welding', { done: i + 1, total: meshes.length }));
            await new Promise(r => setTimeout(r));
            last = performance.now();
        }
    }
    return { vertices: before, weldedTo: after };
}

function weldGeometry(geometry) {
    if (geometry.index || !geometry.attributes.position || Object.keys(geometry.morphAttributes).length) return false;
    const attrs = Object.entries(geometry.attributes);
    if (attrs.some(([, a]) => a.isInterleavedBufferAttribute || a.array.BYTES_PER_ELEMENT !== 4)) return false;
    const n = geometry.attributes.position.count;
    // every attribute as its raw 32-bit words
    const words = attrs.map(([, a]) => ({ u: new Uint32Array(a.array.buffer, a.array.byteOffset, a.count * a.itemSize), size: a.itemSize }));
    let tableSize = 1;
    while (tableSize < n * 2) tableSize <<= 1;
    const mask = tableSize - 1;
    const table = new Int32Array(tableSize);   // first vertex of the slot + 1, 0 = empty
    const remap = new Uint32Array(n), first = new Uint32Array(n);
    let unique = 0;
    for (let v = 0; v < n; v++) {
        let h = 2166136261;
        for (const { u, size } of words) for (let k = v * size, e = k + size; k < e; k++) h = Math.imul(h ^ u[k], 16777619);
        let slot = (h ^ (h >>> 15)) & mask;
        for (;;) {
            const e = table[slot];
            if (e === 0) { table[slot] = v + 1; remap[v] = unique; first[unique++] = v; break; }
            const w = e - 1;
            let same = true;
            for (const { u, size } of words) {
                for (let k = 0; k < size; k++) if (u[w * size + k] !== u[v * size + k]) { same = false; break; }
                if (!same) break;
            }
            if (same) { remap[v] = remap[w]; break; }
            slot = (slot + 1) & mask;
        }
    }
    if (unique > n * 0.9) return false;   // hardly anything shared: not worth an index
    for (const [name, a] of attrs) {
        const out = new a.array.constructor(unique * a.itemSize);
        for (let i = 0; i < unique; i++) for (let k = 0, src = first[i] * a.itemSize, dst = i * a.itemSize; k < a.itemSize; k++) out[dst + k] = a.array[src + k];
        geometry.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
    }
    geometry.setIndex(new THREE.BufferAttribute(unique < 65536 ? new Uint16Array(remap) : remap, 1));
    return true;
}

// groups without anything drawable below them (material scopes, overrides of removed parts): out of the scene graph
function dropEmpty(obj) {
    for (const c of [...obj.children]) if (!dropEmpty(c)) c.removeFromParent();
    return obj.isMesh || obj.isLight || obj.isCamera || obj.children.length > 0;
}
