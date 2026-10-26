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
//  - skeletons across layers (rig, geometry and animation in separate files): bound once the stage is composed, clips
//    of every layer on the root, starting at the stage's first time code – see bindAcrossLayers.
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
        // "over" prims: overrides of prims defined in a weaker layer (sublayers) – read as def, flattened later.
        // Metadata closing on the line of its block ("…\n) {" – variants written by the USD library): three read it as a
        // block named ")" without closing the metadata, the following siblings nested inside – split into ")" and "{".
        const root = super.parseText(text.replace(/^([ \t]*)over\b/gm, '$1def').replace(/^([ \t]*)\)[ \t]*\{[ \t]*$/gm, '$1)\n$1{'));
        this.header = root['#usda 1.0'] || {};
        this.raw = root;
        return root;
    }
    parseData(text) {
        const parsed = super.parseData(text);
        const subLayers = [...String(this.header.subLayers || '').matchAll(/@([^@]+)@/g)].map(m => m[1]);
        if (subLayers.length) (parsed.specsByPath['/'] ||= { specType: 6, fields: {} }).fields.subLayers = subLayers;
        // the stage's first time code (three reads no time range from text): clips start there
        if (this.header.startTimeCode !== undefined) (parsed.specsByPath['/'] ||= { specType: 6, fields: {} }).fields.startTimeCode = parseFloat(this.header.startTimeCode);
        textVariants(this, this.raw, parsed.specsByPath);
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

// variant sets of a text layer – three's text parser has none (`variantSet "x" = { "a" ( … ) { … } }` became an
// attribute): specs like the crate's – the set ("/P/{x=}", its variants), each variant ("/P/{x=a}": its arcs and
// attributes) and the prims inside it ("/P/{x=a}/Child"); the prim lists its sets (variantSetChildren). A skinned
// character example picked its whole geometry by a variant's reference – "the file contains no faces".
const TEXT_SPEC = { Attribute: 1, Prim: 6, Relationship: 8 };
const TEXT_DEF = /^def\s+(?:(\w+)\s+)?"?([^"]+)"?$/;
const TEXT_SET = /^variantSet\s+"([^"]+)"$/;
const TEXT_VARIANT = /^"([^"]+)"$/;
function textVariants(reader, raw, specs) {
    // prims below a variant (create) or already known (the parser defined them) – and their variant sets
    const walk = (data, path, create) => {
        if (!data || typeof data !== 'object') return;
        const children = [];
        for (const key in data) {
            const def = key.match(TEXT_DEF);
            if (def) {
                const child = path === '/' ? '/' + def[2] : `${path}/${def[2]}`;
                if (create) {
                    const fields = { typeName: def[1] || '' };
                    reader._extractPrimData(data[key], child, fields, specs, TEXT_SPEC);
                    specs[child] = { specType: TEXT_SPEC.Prim, fields };
                    children.push(def[2]);
                }
                walk(data[key], child, create);
                continue;
            }
            const set = key.match(TEXT_SET);
            if (!set || path === '/' || typeof data[key] !== 'object') continue;
            const names = [];
            for (const vkey in data[key]) {
                const variant = vkey.match(TEXT_VARIANT);
                if (!variant) continue;
                names.push(variant[1]);
                const vpath = `${path}/{${set[1]}=${variant[1]}}`;
                const fields = {};
                reader._extractPrimData(data[key][vkey], vpath, fields, specs, TEXT_SPEC);
                specs[vpath] = { specType: 10, fields };
                walk(data[key][vkey], vpath, true);
            }
            const prim = specs[path];
            if (prim && names.length) {
                const sets = prim.fields.variantSetChildren ||= [];
                if (!sets.includes(set[1])) sets.push(set[1]);
                specs[`${path}/{${set[1]}=}`] = { specType: 11, fields: { variantChildren: names } };
            }
        }
        if (create && children.length && specs[path]) specs[path].fields.primChildren = children;
    };
    walk(raw, '/', false);
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
// Every object remembers the composers (layers) it was composed in – the one that built it and those whose references
// brought it in: the animation bindings of a layer apply to its objects (two characters referencing different animation
// layers over the same character files); clones of cached references copy the list.
USDComposer.prototype.compose = function (...args) {
    active?.composers.push(this);   // texture promises of nested composers too
    if (active) this.usdLayerName = active.layerNames.get(args[0]);   // file name of the layer (pose names)
    const group = originalCompose.apply(this, args);
    if (active) {
        if (!active.composerIds.has(this)) active.composerIds.set(this, active.composerIds.size + 1);
        const id = active.composerIds.get(this);
        group.traverse(o => { const list = o.userData.usdLayers ??= []; if (!list.includes(id)) list.push(id); });
    }
    return group;
};
// transform ops: three only knows the plain op names – suffixed ones ("xformOp:rotateX:unitsResolve",
// "xformOp:translate:pivot2", common in exports of DCC tools) and rotations other than XYZ were skipped. The op stack
// in xformOpOrder, each op by its type, "!invert!" inverted, composed like three does (column vectors: forward).
const opMatrix = new THREE.Matrix4(), opEuler = new THREE.Euler(), opQuat = new THREE.Quaternion();
const DEG = Math.PI / 180;
const originalApplyTransform = USDComposer.prototype.applyTransform;
USDComposer.prototype.applyTransform = function (obj, fields, attrs = {}) {
    // a SkelRoot with references (its geometry through a variant) became a plain reference container – marked here, the
    // skeletons of two characters are told apart by it (bindAcrossLayers)
    if (fields?.typeName === 'SkelRoot') obj.userData.isSkelRoot = true;
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

// UsdPreviewSurface colours are linear (OpenUSD's convention, what exporters write) – three read diffuse, emissive and
// specular colour as sRGB: the walls of a bedroom scene came out a shade darker and browner than from the other formats
// of the same scene. The conversion undone (white and black stay as they are).
const originalPreviewSurface = USDComposer.prototype._applyPreviewSurface;
USDComposer.prototype._applyPreviewSurface = function (material, shaderPath) {
    const out = originalPreviewSurface.call(this, material, shaderPath);
    if (active) for (const key of ['color', 'emissive', 'specularColor']) material[key]?.convertLinearToSRGB?.();
    return out;
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

// arcs authored on a selected variant (`variantSet "lod" = { "full" ( references = @…@ ) { } }`) belong to the prim –
// three only read the prim's own; the variant's (as selected for this composition) are added
const originalGetReferences = USDComposer.prototype._getReferences;
const specPaths = new WeakMap();   // specsByPath → Map(spec → path)
USDComposer.prototype._getReferences = function (spec) {
    const own = originalGetReferences.call(this, spec);
    if (!active || !this.specsByPath) return own;
    let paths = specPaths.get(this.specsByPath);
    if (!paths) {
        paths = new Map(Object.entries(this.specsByPath).map(([path, sp]) => [sp, path]));
        specPaths.set(this.specsByPath, paths);
    }
    const path = paths.get(spec);
    if (!path || !spec.fields?.variantSetChildren?.length) return own;
    for (const vp of this._getVariantPaths(path)) {
        const variant = this.specsByPath[vp];
        if (variant?.fields?.references) own.push(...originalGetReferences.call(this, variant));
    }
    return own;
};

// Skeletons across layers (a character: rig, geometry and walk cycle in three files): every referenced layer is
// composed on its own, a mesh never met a skeleton of another layer – three warned and left a SkinnedMesh without one
// (the import broke on it), the clip of the animation layer moved nothing. Collected here per load (skeletons, the
// skel:skeleton targets, the clips of every composer) and bound once the stage is composed (bindAcrossLayers).
const originalBuildSkeleton = USDComposer.prototype._buildSkeleton;
USDComposer.prototype._buildSkeleton = function (path) {
    const data = originalBuildSkeleton.call(this, path);
    if (active && data) active.skeletons.push({ data, path: plainSkelPath(path), used: null });
    return data;
};
const originalBindSkeletons = USDComposer.prototype._bindSkeletons;
USDComposer.prototype._bindSkeletons = function () {
    if (active) {
        for (const path in this.specsByPath) {
            if (!/\.(?:rel )?skel:skeleton$/.test(path)) continue;
            const fields = this.specsByPath[path].fields;
            const target = fields?.targetPaths?.[0] ?? fields?.default?.replace?.(/[<>]/g, '');
            if (target) active.skelTargets.add(plainSkelPath(target));
        }
        // skel:animationSource: which animation drives the skeletons bound at or below that prim
        for (const path in this.specsByPath) {
            const m = path.match(/^(.*)\.(?:rel )?skel:animationSource$/);
            if (!m) continue;
            const fields = this.specsByPath[path].fields;
            const target = fields?.targetPaths?.[0] ?? fields?.default?.replace?.(/[<>]/g, '');
            if (target) active.animBindings.push({ composer: this, prim: plainSkelPath(m[1]), anim: plainSkelPath(target) });
        }
        // no skeleton in this layer: bound later – what binding needs goes with the mesh (also into cached clones)
        if (!Object.keys(this.skeletons).length) {
            for (const { mesh, skeletonPath, localJoints, geomBindTransform } of this.skinnedMeshes) {
                mesh.userData.usdSkin = {
                    skeletonPath: skeletonPath ? plainSkelPath(skeletonPath) : null,
                    localJoints: localJoints ? [...localJoints] : null,
                    geomBindTransform: geomBindTransform ? [...geomBindTransform].flat(2) : null,   // nested in text layers
                };
            }
            this.skinnedMeshes.length = 0;
        }
    }
    return originalBindSkeletons.call(this);
};
// SkelAnimation prims: read here instead of by three – also values without time samples (a pose stored as one value per
// joint: three read only time samples, the character stood in its rest pose; a clip with time-sampled rotations and one
// translation value lost the translations). Tracks are made per skeleton once the stage is composed (bindAcrossLayers):
// they name the bones by uuid, each character gets its own animation (skel:animationSource) even with equal joint names.
const ANIM_CHANNELS = [['rotations', 'quaternion', 4], ['translations', 'position', 3], ['scales', 'scale', 3]];
const originalBuildAnimationClip = USDComposer.prototype._buildAnimationClip;
USDComposer.prototype._buildAnimationClip = function (path) {
    if (!active) return originalBuildAnimationClip.call(this, path);
    const attrs = this._getAttributes(path);
    if (!attrs.joints?.length) return null;
    const channels = [];
    for (const [attr, property, size] of ANIM_CHANNELS) {
        const sampled = this._getTimeSampledAttribute(path, attr);
        if (sampled?.times?.length) channels.push({ property, size, times: sampled.times.map(t => t / this.fps), values: sampled.values.map(flatValues) });
        else if (attrs[attr]?.length) channels.push({ property, size, times: null, values: [flatValues(attrs[attr])] });
    }
    if (channels.length) active.anims.push({ composer: this, path: plainSkelPath(path), name: path.split('/').pop(), joints: [...attrs.joints], channels });
    return null;
};
const flatValues = v => (typeof v[0] === 'number' || ArrayBuffer.isView(v) ? v : v.flat(2));

const originalBuildAnimations = USDComposer.prototype._buildAnimations;
USDComposer.prototype._buildAnimations = function () {
    const clips = originalBuildAnimations.call(this);
    if (active) for (const clip of clips) active.clips.push({ clip, fps: this.fps });
    return clips;
};

// rigidly skinned meshes (eyes bound to one joint): joint indices/weights with constant interpolation – one tuple for
// all points; three read it per point, every point but the first had weight 0 and collapsed to the origin when skinned.
// The tuple is repeated per point.
const originalGetAttributes = USDComposer.prototype._getAttributes;
USDComposer.prototype._getAttributes = function (path) {
    const attrs = originalGetAttributes.call(this, path);
    const indices = attrs['primvars:skel:jointIndices'], weights = attrs['primvars:skel:jointWeights'], points = attrs.points;
    if (!indices?.length || !weights?.length || !points?.length) return attrs;
    const count = typeof points[0] === 'number' ? points.length / 3 : points.length;
    const size = attrs['primvars:skel:jointIndices:elementSize'] ?? (indices.length < 4 ? indices.length : 4);
    if (count < 2 || indices.length !== size || weights.length !== size) return attrs;
    const expand = (tuple, Type) => {
        const out = new Type(count * size);
        for (let v = 0; v < count; v++) for (let k = 0; k < size; k++) out[v * size + k] = tuple[k];
        return out;
    };
    attrs['primvars:skel:jointIndices'] = expand(indices, Int32Array);
    attrs['primvars:skel:jointWeights'] = expand(weights, Float32Array);
    attrs['primvars:skel:jointIndices:elementSize'] = size;
    return attrs;
};

// orientation = "leftHanded" (clockwise faces – hair shells of a character): three ignored it, the front faces looked
// inwards and only the backs of the shells showed (thin hair on top of the head) → winding reversed per triangle; the
// normals three computed from the winding flipped with it (authored ones stay). doubleSided: noted for the materials.
const originalBuildMesh = USDComposer.prototype._buildMesh;
USDComposer.prototype._buildMesh = function (path, spec) {
    const mesh = originalBuildMesh.call(this, path, spec);
    if (!active || !mesh?.geometry) return mesh;
    const attrs = this._getAttributes(path);
    if (attrs.orientation === 'leftHanded') flipWinding(mesh.geometry, !(attrs.normals || attrs['primvars:normals']));
    if (attrs.doubleSided === true) mesh.userData.usdDoubleSided = true;
    return mesh;
};
function flipWinding(geometry, flipNormals) {
    const index = geometry.index;
    if (index) {
        const a = index.array;
        for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    } else {
        // no index (the composer's usual output): corners 1 and 2 of every triangle swapped in every attribute
        for (const attr of Object.values(geometry.attributes)) {
            if (attr.isInterleavedBufferAttribute) continue;
            const a = attr.array, n = attr.itemSize;
            for (let v = 0; v + 2 < attr.count; v += 3) {
                for (let k = 0; k < n; k++) { const t = a[(v + 1) * n + k]; a[(v + 1) * n + k] = a[(v + 2) * n + k]; a[(v + 2) * n + k] = t; }
            }
        }
    }
    const normal = geometry.getAttribute('normal');
    if (flipNormals && normal && !normal.isInterleavedBufferAttribute) for (let i = 0; i < normal.array.length; i++) normal.array[i] = -normal.array[i];
}

// "/Rig/{rigComplexity=high}/Skel" (a prim inside a variant) → "/Rig/Skel"
const plainSkelPath = path => path.replace(/\/?\{[^}]*\}\/?/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

// the composed stage: skinned meshes left unbound get their skeleton – the one whose path ends the mesh's (or a
// skel:skeleton target's) path, else the one holding all the mesh's joints; one skeleton object per skinning root
// (two characters from the same files: own bones each). Meshes without a match: plain meshes in their bind pose.
// The clips of all layers go onto the root (time codes shifted to the stage's start), tracks of joints the stage does
// not have are dropped (the mixer warned for each).
function bindAcrossLayers(root, data, stage) {
    const { skeletons, skelTargets } = data;
    const pending = [];
    root.traverse(o => { if (o.isSkinnedMesh && !o.skeleton && o.userData.usdSkin) pending.push(o); });
    const endsWith = (path, tail) => path === tail || path.endsWith(tail.startsWith('/') ? tail : '/' + tail);
    const matches = (entry, path) => path && (endsWith(path, entry.path) || endsWith(entry.path, path));
    const holds = (entry, joints) => !joints?.length || joints.every(j => entry.data.joints.includes(j));
    const used = new Set();
    const remapped = new WeakSet();   // shared geometries (cached clones): skin indices remapped once
    for (const mesh of pending) {
        const { skeletonPath, localJoints, geomBindTransform } = mesh.userData.usdSkin;
        delete mesh.userData.usdSkin;
        const fits = skeletons.filter(s => holds(s, localJoints));
        const entry = fits.find(s => matches(s, skeletonPath))
            ?? fits.find(s => [...skelTargets].some(target => matches(s, target)))
            ?? (fits.length === 1 || !skeletonPath ? fits[0] : null);
        if (!entry) { unskin(mesh); continue; }
        // the skinning root: the nearest SkelRoot above the mesh (else the stage) – its skeleton object of this entry
        let skelRoot = mesh.parent;
        while (skelRoot && skelRoot !== root && !skelRoot.userData.isSkelRoot) skelRoot = skelRoot.parent;
        const owners = entry.owners ??= new Map();
        let skeleton = owners.get(skelRoot);
        if (!skeleton) {
            skeleton = owners.size ? cloneSkeleton(entry.data.skeleton) : entry.data.skeleton;
            owners.set(skelRoot, skeleton);
            // bones below the first mesh of that root (three's convention: skeleton space = mesh space)
            for (const bone of skeleton.bones) if (!bone.parent?.isBone) mesh.add(bone);
        }
        const skinIndex = mesh.geometry.getAttribute('skinIndex');
        if (localJoints?.length && skinIndex && !remapped.has(mesh.geometry)) {
            remapped.add(mesh.geometry);
            const toGlobal = localJoints.map(j => Math.max(0, entry.data.joints.indexOf(j)));
            const a = skinIndex.array;
            for (let i = 0; i < a.length; i++) if (a[i] < toGlobal.length) a[i] = toGlobal[a[i]];
            skinIndex.needsUpdate = true;
        }
        const bindMatrix = new THREE.Matrix4();
        if (geomBindTransform?.length === 16) bindMatrix.fromArray(geomBindTransform);   // row-major USD = column-major array order
        mesh.bind(skeleton, bindMatrix);
        used.add(skeleton);
    }
    // skeletons bound by three inside one layer count as well (the mixer finds bones by name)
    root.traverse(o => { if (o.isSkinnedMesh && o.skeleton) used.add(o.skeleton); });
    if (used.size === 1) root.skeleton = [...used][0];   // bones before same-named prims (see USDComposer.compose)
    else if (!used.size) root.skeleton = undefined;

    const out = [...skeletalClips(root, used, data), ...transformClips(root, used, data.clips)];
    // keys at the time codes (a walk cycle at 101…129) – the playbar starts at 0: the stage's first time code, else the
    // earliest key
    let shift = stage.startTimeCode !== undefined ? stage.startTimeCode / stage.fps : null;
    if (shift === null && out.length) shift = Math.min(...out.flatMap(clip => clip.tracks.map(track => track.times[0])));
    for (const clip of out) {
        if (shift) for (const track of clip.tracks) track.shift(-shift);
        clip.resetDuration();
    }
    root.animations = out;
    root.traverse(o => { delete o.userData.usdLayers; });
    return { skinned: pending.length, skeletons: used.size, clips: out.length, poses: data.posed || 0 };
}

// SkelAnimations → tracks on the bones of the skeletons they drive. A skeleton object is driven by the animation a
// skel:animationSource names on its skinning root or above (in the layer that built that object); animations nobody
// names drive every skeleton sharing joints with them. Joints by path (the skeleton's joint list), not by name. Values
// without time samples: one key at the animation's first time – or, in an animation without any time samples, a pose
// set on the bones right away (the pose at import then). Bound animations play together (one clip: the stage), unbound
// ones are clips of their own.
function skeletalClips(root, used, data) {
    const { skeletons, anims, animBindings, composerIds } = data;
    if (!anims.length || !used.size) return [];
    const skels = [];
    for (const skeleton of used) {
        const entry = skeletons.find(e => e.data.skeleton === skeleton || [...(e.owners?.values() || [])].includes(skeleton));
        if (!entry) continue;
        let mesh = null;
        root.traverse(o => { if (!mesh && o.isSkinnedMesh && o.skeleton === skeleton) mesh = o; });
        skels.push({ skeleton, joints: entry.data.joints, path: entry.path, mesh });
    }
    const endsWith = (path, tail) => path === tail || path.endsWith(tail.startsWith('/') ? tail : '/' + tail);
    // binding prim = the skeleton's own prim, or an object above its meshes composed in the binding's layer
    const binds = (binding, s) => {
        if (endsWith(s.path, binding.prim)) return true;
        const name = binding.prim.split('/').pop(), layer = composerIds.get(binding.composer);
        for (let o = s.mesh?.parent; o; o = o.parent) if (o.name === name && o.userData.usdLayers?.includes(layer)) return true;
        return false;
    };
    const driven = new Map();   // anim → skels
    for (const binding of animBindings) {
        const anim = anims.find(a => a.composer === binding.composer && a.path === binding.anim)
            ?? anims.find(a => endsWith(a.path, binding.anim) || endsWith(binding.anim, a.path));
        if (!anim) continue;
        const list = driven.get(anim) ?? [];
        for (const s of skels) if (binds(binding, s) && !list.includes(s)) list.push(s);
        driven.set(anim, list);
    }
    const stageTracks = [], out = [];
    let stageName = null;
    data.posed = 0;
    // the skeletons' rest pose (before stored poses are set): joints a pose leaves out keep it
    const rest = new Map();
    for (const s of skels) for (const b of s.skeleton.bones) rest.set(b, [...b.position.toArray(), ...b.quaternion.toArray()]);
    const poses = root.userData.filePoses = [];
    const onlyOne = anims.length === 1 && !animBindings.length;
    for (const anim of anims) {
        const bound = driven.has(anim);
        const targets = bound ? driven.get(anim) : skels.filter(s => anim.joints.some(j => s.joints.includes(j)));
        const sampled = anim.channels.filter(c => c.times);
        if (!sampled.length) {
            // a stored pose: one entry of the pose list (all joints of its skeletons); set at once when an
            // animationSource names it (or it is the file's only animation and nothing is bound) – the pose at import then
            const bones = [];
            for (const s of targets) {
                const value = new Map(s.skeleton.bones.map(b => [b, [...rest.get(b)]]));
                anim.joints.forEach((joint, j) => {
                    const bone = s.skeleton.bones[s.joints.indexOf(joint)];
                    if (!bone) return;
                    for (const { property, size, values } of anim.channels) {
                        const v = values[0];
                        if (v.length < (j + 1) * size) continue;
                        if (property === 'position') value.get(bone).splice(0, 3, ...Array.from(v.slice(j * 3, j * 3 + 3)));
                        else if (property === 'quaternion') value.get(bone).splice(3, 4, ...Array.from(v.slice(j * 4, j * 4 + 4)));
                        else if (bound || onlyOne) bone.scale.fromArray(v, j * 3);
                    }
                });
                for (const [bone, v] of value) bones.push({ bone, value: v });
            }
            if (!bones.length) continue;
            poses.push({ name: anim.name, layer: anim.composer.usdLayerName, bones });
            if (bound || onlyOne) {
                for (const { bone, value } of bones) { bone.position.fromArray(value, 0); bone.quaternion.fromArray(value, 3); }
                data.posed++;
            }
            continue;
        }
        const t0 = Math.min(...sampled.map(c => c.times[0]));
        const tracks = [];
        for (const s of targets) {
            anim.joints.forEach((joint, j) => {
                const bone = s.skeleton.bones[s.joints.indexOf(joint)];
                if (!bone) return;
                for (const { property, size, times, values } of anim.channels) {
                    const keys = times ?? [t0];
                    const kt = [], kv = [];
                    keys.forEach((t, k) => {
                        const v = values[k];
                        if (!v || v.length < (j + 1) * size) return;
                        kt.push(t);
                        for (let c = 0; c < size; c++) kv.push(v[j * size + c]);
                    });
                    if (!kt.length) continue;
                    const Track = property === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
                    tracks.push(new Track(`${bone.uuid}.${property}`, new Float32Array(kt), new Float32Array(kv)));
                }
            });
        }
        if (!tracks.length) continue;
        if (bound) { stageTracks.push(...tracks); stageName ??= anim.name; } else out.push(new THREE.AnimationClip(anim.name, -1, tracks));
    }
    if (stageTracks.length) out.unshift(new THREE.AnimationClip(stageName, -1, stageTracks));
    // pose names: the prim's; the same name twice (every layer calls it "SkelAnim") with the layer's file name
    const count = new Map();
    for (const p of poses) count.set(p.name, (count.get(p.name) || 0) + 1);
    for (const p of poses) if (count.get(p.name) > 1 && p.layer) p.name = `${p.layer.replace(/\.[^.]+$/, '')} – ${p.name}`;
    return out;
}

// three's clips from time-sampled transforms (other than skeletons), each once; tracks of objects the stage does not have
// dropped (the mixer warned for each)
function transformClips(root, used, clips) {
    const names = new Set();
    root.traverse(o => { if (o.name) names.add(o.name); });
    for (const s of used) for (const b of s.bones) names.add(b.name);
    const out = [];
    for (const { clip } of clips) {
        if (out.includes(clip)) continue;
        clip.tracks = clip.tracks.filter(track => names.has(track.name.slice(0, track.name.lastIndexOf('.'))));
        if (clip.tracks.length) out.push(clip);
    }
    return out;
}

// own bones for a second skinning root (same order, same rest pose, same inverse bind matrices)
function cloneSkeleton(skeleton) {
    const map = new Map();
    for (const bone of skeleton.bones) {
        if (bone.parent?.isBone) continue;
        const copy = bone.clone(true);
        const a = [], b = [];
        bone.traverse(o => a.push(o));
        copy.traverse(o => b.push(o));
        a.forEach((o, i) => map.set(o, b[i]));
    }
    return new THREE.Skeleton(skeleton.bones.map(bone => map.get(bone)), skeleton.boneInverses.map(m => m.clone()));
}

// a skinned mesh without a skeleton → plain mesh: its points are the bind pose
function unskin(mesh) {
    const plain = new THREE.Mesh(mesh.geometry, mesh.material);
    plain.name = mesh.name;
    plain.userData = mesh.userData;
    plain.visible = mesh.visible;
    plain.position.copy(mesh.position);
    plain.quaternion.copy(mesh.quaternion);
    plain.scale.copy(mesh.scale);
    for (const child of [...mesh.children]) plain.add(child);
    mesh.geometry.deleteAttribute('skinIndex');
    mesh.geometry.deleteAttribute('skinWeight');
    const parent = mesh.parent;
    if (parent) {
        parent.children[parent.children.indexOf(mesh)] = plain;
        plain.parent = parent;
        mesh.parent = null;
    }
}

// a reference resolving to one mesh is merged into the referencing prim – three took the first mesh of the group even
// when it had siblings, and dropped those (a car body of 180 parts became one mesh). Only a mesh without a transform of
// its own: the merge sets the referencing prim's transform on it and dropped the mesh's (a kitchen scene: 329 props,
// each mesh offset to its asset's origin with translate + pivot ops, 1–3 m off). Otherwise the container stays.
const originalSingleMesh = USDComposer.prototype._findSingleMesh;
USDComposer.prototype._findSingleMesh = function (group) {
    if (group.children.length !== 1) return null;
    const candidate = group.children[0].isMesh ? group.children[0] : group.children[0].children?.length === 1 ? group.children[0].children[0] : null;
    if (candidate?.isMesh && this._hasNonIdentityTransform(candidate)) return null;
    return originalSingleMesh.call(this, group);
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
        const segments = (refValue.match(/<([^>]+)>/)?.[1] || '').split('/').filter(Boolean);
        if (segments.length > 1) {
            // three looks for the target among the layer's top prims only – a nested one ("</Character/Hair", payloads of
            // a character's parts) gave the whole layer, every part held all of them: the top prim (cached), then down
            const top = this._resolveReference(`@${m[1]}@</${segments[0]}>`, localVariants);
            let node = top?.children.length === 1 && top.children[0].name === segments[0] ? top.children[0] : top;
            for (const name of segments.slice(1)) node = node?.children.find(child => child.name === name) ?? null;
            if (node) {
                node.removeFromParent();
                group = new THREE.Group();
                group.add(node);
            } else group = null;
        } else group = originalResolve.call(this, refValue, localVariants);
    } finally {
        active.resolving.delete(key);
    }
    // the referenced prim stands for the referencing one (USD): its children directly under it, unless it carries a
    // transform of its own or is a skinning root (kept as a level then – its skeletons are told apart by it)
    const only = group?.children.length === 1 && refValue.includes('<') ? group.children[0] : null;
    if (only && !only.isMesh && !only.userData.isSkelRoot && only.position.lengthSq() === 0 && only.quaternion.w === 1 && only.scale.x === 1 && only.scale.y === 1 && only.scale.z === 1) {
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
    active = { cache: new Map(), composers: [], missing: new Set(), resolving: new Set(), textures, skeletons: [], skelTargets: new Set(), clips: [], anims: [], animBindings: [], composerIds: new Map(),
        layerNames: new Map([...layers].map(([path, parsed]) => [parsed, path.split('/').pop()])) };
    const { composers, missing: missingSet } = active;
    let object, hidden, overridden, skinning;
    try {
        const composer = new USDComposer(manager);
        object = composer.compose(root, assets, {}, dirOf(rootKey));
        hidden = hideComposed(object, hiddenPaths);
        overridden = overrideComposed(object, root, composer);
        skinning = bindAcrossLayers(object, active, { startTimeCode: root.specsByPath['/']?.fields?.startTimeCode, fps: composer.fps });
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
    const stats = { layers: layers.size, missing: missing.length, hiddenByOverrides: hidden, movedByOverrides: overridden, welded, materials: materials.length, textures: { ...texStats, missing: missingTextures.length }, skinning, metersPerUnit: authored ?? 0.01, upAxis: root.specsByPath['/']?.fields?.upAxis || 'Y' };
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
    // doubleSided meshes (clothes, shoes): their materials both sides – unless a one-sided mesh shares it (the gums share
    // the skin material with the body)
    const single = new Set(), double = new Set();
    root.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) if (m) (o.userData.usdDoubleSided ? double : single).add(m); });
    for (const m of double) if (!single.has(m)) m.side = THREE.DoubleSide;
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
    return obj.isMesh || obj.isLight || obj.isCamera || obj.isBone || obj.children.length > 0;   // leaf bones belong to a skeleton
}
