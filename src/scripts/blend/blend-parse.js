// .blend reader (Blender 2.8 – 4.x): the scene's objects, their meshes (evaluated data as saved – modifiers are listed, not
// applied), Principled BSDF materials with their image textures, packed images, cameras, units. Own implementation on top
// of the file's self description (blend-file.js); field names as the file's DNA has them (older names, e.g. totpoly).
//
// Meshes (4.x): attributes in CustomData layers by name – vdata "position" (float3), ldata ".corner_vert" / ".corner_edge"
// (int), UV maps (float2, the first not starting with "."), pdata "material_index" (int), "sharp_face" (bool), edata
// "sharp_edge" (bool); faces from poly_offset_indices (faces + 1). Normals like Blender's: per corner the faces around its
// vertex that are smooth and joined across edges that are not sharp (custom normals – CD_CUSTOMLOOPNORMAL – not decoded;
// on the test scene they were all but empty). Closed meshes wound inwards are turned outwards (orient-outward.js).
// Meshes up to 3.x: the same data as struct arrays in CustomData layers by type (MVert co, MLoop v/e, MPoly loopstart /
// totloop / mat_nr / flag ME_SMOOTH, MEdge flag ME_SHARP, MLoopUV) – moved to named attributes step by step in 3.4–4.0,
// so each piece falls back on its own; auto smooth (Mesh flag, smoothresh – until 4.0) marks edges sharp by angle.
// Objects: loc / rot (rotmode: 0 quaternion, 1…6 Euler XYZ…ZYX, −1 axis angle) / size, parent · parentinv · local (a bone
// as parent: parent · bone pose at its tail · parentinv · local); subdivision modifiers applied (subdivide.js); only
// objects of the scene's collections; restrictflag render/viewport off = hidden.
// Materials: Principled BSDF inputs (default values; linked from an image texture – through Mapping for its scale /
// location –: Base Color, Roughness, Metallic, Alpha, Emission Color; Normal ← Normal Map (Color) or Bump (Height)).

import { BlendFile } from './blend-file.js';
import { orientOutward } from '../orient-outward.js';
import { subdivideCorners } from '../subdivide.js';

const OB_MESH = 1, OB_LAMP = 10, OB_CAMERA = 11;
// subdivision modifier: at most this many faces per mesh (the level is lowered until it fits – like USD subdivision)
const SUBDIV_FACES = 2e6;

export function parseBlend(bytes, onProgress = () => {}) {
    const f = new BlendFile(bytes);
    onProgress(0.2);
    const list = (lb, type) => {
        const out = [];
        if (!lb) return out;
        let x = f.deref(lb.pointer('first'));
        while (x && out.length < 1e6) { const v = f.view(x, 0, type); out.push(v); x = f.deref(v.pointer('next')); }
        return out;
    };
    const idName = v => v?.sub('id')?.string('name').slice(2) ?? '';

    // scene: unit, camera, the objects of its collections
    const scene = f.view(f.blocksOf('SC')[0]);
    const scaleLength = scene?.sub('unit')?.float('scale_length') || 1;
    const inScene = new Set();
    const walkCollection = col => {
        if (!col) return;
        for (const co of list(col.sub('gobject'), 'CollectionObject')) { const ob = co.pointer('ob'); if (ob) inScene.add(ob); }
        for (const ch of list(col.sub('children'), 'CollectionChild')) walkCollection(ch.deref('collection', 'Collection'));
    };
    walkCollection(scene?.has('master_collection') ? scene.deref('master_collection', 'Collection') : null);

    // images: packed bytes or the file path
    const images = [];
    const imageIndex = new Map();
    const imageOf = ptr => {
        if (!ptr) return -1;
        if (imageIndex.has(ptr)) return imageIndex.get(ptr);
        const im = f.view(f.deref(ptr), 0, 'Image');
        let index = -1;
        if (im) {
            const path = im.string('name').replace(/\\/g, '/');
            let data = null;
            const pf = im.deref('packedfile', 'PackedFile');
            if (pf) {
                const block = f.deref(pf.pointer('data'));
                const size = pf.int('size');
                if (block && size > 0) data = bytes.slice(block.data, block.data + Math.min(size, block.len));
            }
            index = images.push({ name: idName(im), path, data }) - 1;
        }
        imageIndex.set(ptr, index);
        return index;
    };

    // materials
    const materials = [];
    const materialIndex = new Map();
    const socketValue = s => {
        if (!s) return null;
        const d = f.deref(s.pointer('default_value'));
        if (!d) return null;
        const ty = s.string('idname');
        if (/Color/.test(ty)) return f.view(d, 0, 'bNodeSocketValueRGBA')?.floats('value') ?? null;
        if (/Vector|Euler|Translation|XYZ/.test(ty)) return f.view(d, 0, 'bNodeSocketValueVector')?.floats('value') ?? null;
        if (/Float|Factor|Percentage|Distance/.test(ty)) return f.view(d, 0, 'bNodeSocketValueFloat')?.float('value') ?? null;
        return null;
    };
    const materialOf = ptr => {
        if (!ptr) return -1;
        if (materialIndex.has(ptr)) return materialIndex.get(ptr);
        const ma = f.view(f.deref(ptr), 0, 'Material');
        if (!ma) { materialIndex.set(ptr, -1); return -1; }
        const mat = {
            name: idName(ma), color: [ma.float('r'), ma.float('g'), ma.float('b')], alpha: ma.float('a') ?? 1,
            roughness: ma.float('roughness') ?? 0.5, metallic: ma.float('metallic') ?? 0, transmission: 0, ior: 1.5,
            emission: [0, 0, 0], emissionStrength: 0, maps: {}, cullBack: !!((ma.int('blend_flag') || 0) & 4),
        };
        const tree = ma.int('use_nodes') ? ma.deref('nodetree', 'bNodeTree') : null;
        if (tree) readPrincipled(tree, mat);
        const index = materials.push(mat) - 1;
        materialIndex.set(ptr, index);
        return index;
    };
    function readPrincipled(tree, mat) {
        const nodes = list(tree.sub('nodes'), 'bNode');
        const links = list(tree.sub('links'), 'bNodeLink');
        const nodeByPtr = new Map(nodes.map(n => [n.block.old, n]));
        const into = new Map();   // input socket pointer → link
        for (const l of links) into.set(l.pointer('tosock'), l);
        const inputs = n => list(n.sub('inputs'), 'bNodeSocket');
        const input = (n, name) => inputs(n).find(s => s.string('name') === name || s.string('identifier') === name) ?? null;
        const upstream = s => { const l = s && into.get(s.block.old); return l ? nodeByPtr.get(l.pointer('fromnode')) ?? null : null; };
        // the image texture feeding a socket (directly or through simple nodes), with the mapping of its vector input
        const imageFeeding = (s, depth = 0) => {
            const n = upstream(s);
            if (!n || depth > 6) return null;
            const id = n.string('idname');
            if (id === 'ShaderNodeTexImage') {
                const image = imageOf(n.pointer('id'));
                if (image < 0) return null;
                const map = { image };
                const mapping = upstream(input(n, 'Vector'));
                if (mapping?.string('idname') === 'ShaderNodeMapping') {
                    const scale = socketValue(input(mapping, 'Scale')), loc = socketValue(input(mapping, 'Location')), rot = socketValue(input(mapping, 'Rotation'));
                    if (scale) map.repeat = [scale[0], scale[1]];
                    if (loc) map.offset = [loc[0], loc[1]];
                    if (rot) map.rotation = rot[2];
                }
                return map;
            }
            // pass-through nodes: the first linked colour-like input
            for (const sock of inputs(n)) { if (into.has(sock.block.old)) { const m = imageFeeding(sock, depth + 1); if (m) return m; } }
            return null;
        };
        const principled = nodes.find(n => n.string('idname') === 'ShaderNodeBsdfPrincipled');
        if (!principled) return;
        const val = name => { const s = input(principled, name); return s ? socketValue(s) : null; };
        const base = val('Base Color'); if (base) { mat.color = base.slice(0, 3); }
        mat.roughness = val('Roughness') ?? mat.roughness;
        mat.metallic = val('Metallic') ?? mat.metallic;
        mat.alpha = val('Alpha') ?? mat.alpha;
        mat.transmission = val('Transmission Weight') ?? val('Transmission') ?? 0;
        mat.ior = val('IOR') ?? 1.5;
        // Specular IOR Level (4.x; 0.5 = the IOR's own reflection, 0 = none – fabrics of a converted scene) / Specular (older)
        mat.specular = val('Specular IOR Level') ?? val('Specular') ?? 0.5;
        const ec = val('Emission Color') ?? val('Emission');
        if (ec) mat.emission = ec.slice(0, 3);
        mat.emissionStrength = val('Emission Strength') ?? (ec ? 1 : 0);
        for (const [name, key] of [['Base Color', 'color'], ['Roughness', 'roughness'], ['Metallic', 'metallic'], ['Alpha', 'alpha'], ['Emission Color', 'emission']]) {
            const m = imageFeeding(input(principled, name));
            if (m) mat.maps[key] = m;
        }
        // normal: Normal Map (its Color) or Bump (its Height – only that drives a bump)
        const nn = upstream(input(principled, 'Normal'));
        if (nn?.string('idname') === 'ShaderNodeNormalMap') { const m = imageFeeding(input(nn, 'Color')); if (m) mat.maps.normal = m; }
        if (nn?.string('idname') === 'ShaderNodeBump') {
            const m = imageFeeding(input(nn, 'Height'));
            // Distance: the height of the picture's full range in scene units (Blender's bump is physical – world-space
            // derivatives); Strength blends towards the unbumped normal
            if (m) { mat.maps.bump = m; mat.bumpStrength = socketValue(input(nn, 'Strength')) ?? 1; mat.bumpDistance = socketValue(input(nn, 'Distance')) ?? 1; }
        }
    }

    // meshes (shared by objects using the same data)
    const geometries = [];
    const geometryIndex = new Map();
    const layersOf = cd => {
        const out = new Map();
        const n = cd.int('totlayer'), lb = f.deref(cd.pointer('layers'));
        for (let i = 0; i < n && lb; i++) {
            const l = f.view(lb, i, 'CustomDataLayer');
            const d = f.deref(l.pointer('data'));
            out.set(l.string('name') || `#${l.int('type')}`, { type: l.int('type'), block: d });
        }
        return out;
    };
    const typed = (block, Type, count) => {
        if (!block) return null;
        const size = Type.BYTES_PER_ELEMENT * count;
        const copy = bytes.slice(block.data, block.data + Math.min(size, block.len));
        return new Type(copy.buffer, 0, Math.floor(copy.byteLength / Type.BYTES_PER_ELEMENT));
    };
    // one geometry per mesh and subdivision (objects sharing a mesh may subdivide it differently)
    const meshOf = (ptr, subdiv = null) => {
        const key = subdiv ? `${ptr}|${subdiv.level}|${+subdiv.limit}|${+subdiv.crease}` : ptr;
        if (geometryIndex.has(key)) return geometryIndex.get(key);
        const me = f.view(f.deref(ptr), 0, 'Mesh');
        const index = me ? geometries.push(buildMesh(me, subdiv)) - 1 : -1;
        geometryIndex.set(key, index);
        return index;
    };
    // legacy layers (Blender ≤ 3.x, each moved to a named attribute between 3.4 and 4.0): CustomData type → struct
    const CD_MVERT = 0, CD_MEDGE = 3, CD_MLOOPUV = 16, CD_MPOLY = 25, CD_MLOOP = 26;
    const ME_SMOOTH = 1, ME_SHARP = 1 << 9, ME_AUTOSMOOTH = 1 << 5;
    const ofType = (layers, type) => { for (const l of layers.values()) if (l.type === type && l.block) return l.block; return null; };
    // one field of every element of a struct array (legacy layer) as a typed array
    const column = (block, structName, field, Type, count, width = 1) => {
        const st = f.structByName.get(structName), fd = st?.fields.get(field);
        if (!block || !fd) return null;
        const n = Math.min(count, Math.floor(block.len / st.size)), out = new Type(count * width);
        for (let i = 0; i < n; i++) {
            const p = block.data + i * st.size + fd.offset;
            for (let k = 0; k < width; k++) {
                const q = p + k * (fd.size / fd.count);
                out[i * width + k] = fd.type === 'float' ? f.f32(q) : fd.type === 'short' ? f.i16(q) : fd.type === 'char' ? bytes[q] : f.i32(q);
            }
        }
        return out;
    };
    function buildMesh(me, subdiv = null) {
        const nv = me.int('totvert');
        let nf = me.int('totpoly') ?? me.int('faces_num'), nc = me.int('totloop') ?? me.int('corners_num');
        let ne = me.int('totedge') ?? me.int('edges_num') ?? 0;
        const V = layersOf(me.sub('vdata')), E = layersOf(me.sub('edata')), P = layersOf(me.sub('pdata')), L = layersOf(me.sub('ldata'));
        const mloop = ofType(L, CD_MLOOP), mpoly = ofType(P, CD_MPOLY), medge = ofType(E, CD_MEDGE);
        let pos = typed(V.get('position')?.block, Float32Array, nv * 3) ?? column(ofType(V, CD_MVERT), 'MVert', 'co', Float32Array, nv, 3);
        let cv = typed(L.get('.corner_vert')?.block, Int32Array, nc) ?? column(mloop, 'MLoop', 'v', Int32Array, nc);
        let ce = typed(L.get('.corner_edge')?.block, Int32Array, nc) ?? column(mloop, 'MLoop', 'e', Int32Array, nc);
        let offsets = typed(f.deref(me.pointer('poly_offset_indices')), Int32Array, nf + 1);
        let uv = null;
        for (const [name, l] of L) if (l.type === 49 && !name.startsWith('.')) { uv = typed(l.block, Float32Array, nc * 2); break; }
        uv ??= column(ofType(L, CD_MLOOPUV), 'MLoopUV', 'uv', Float32Array, nc, 2);
        // faces as MPoly (loopstart, totloop): Blender writes them in corner order – else the corners are put in face order
        if (!offsets && mpoly && cv) {
            const start = column(mpoly, 'MPoly', 'loopstart', Int32Array, nf), count = column(mpoly, 'MPoly', 'totloop', Int32Array, nf);
            offsets = new Int32Array(nf + 1);
            let ordered = true;
            for (let fi = 0; fi < nf; fi++) { offsets[fi + 1] = offsets[fi] + count[fi]; if (start[fi] !== offsets[fi]) ordered = false; }
            if (!ordered) {
                const reorder = (a, w) => {
                    if (!a) return a;
                    const out = new a.constructor(offsets[nf] * w);
                    for (let fi = 0; fi < nf; fi++) for (let k = 0; k < count[fi] * w; k++) out[offsets[fi] * w + k] = a[start[fi] * w + k];
                    return out;
                };
                cv = reorder(cv, 1); ce = reorder(ce, 1); uv = reorder(uv, 2);
            }
        }
        if (!pos || !cv || !offsets) return { parts: [], materials: [] };
        let matIndex = typed(P.get('material_index')?.block, Int32Array, nf) ?? column(mpoly, 'MPoly', 'mat_nr', Int32Array, nf);
        let sharpFace = P.get('sharp_face')?.block ? bytes.subarray(P.get('sharp_face').block.data, P.get('sharp_face').block.data + nf) : null;
        let sharpEdge = E.get('sharp_edge')?.block ? bytes.subarray(E.get('sharp_edge').block.data, E.get('sharp_edge').block.data + ne) : null;
        if (!sharpFace && mpoly) sharpFace = column(mpoly, 'MPoly', 'flag', Uint8Array, nf).map(x => (x & ME_SMOOTH ? 0 : 1));
        if (!sharpEdge && medge) sharpEdge = column(medge, 'MEdge', 'flag', Int32Array, ne).map(x => (x & ME_SHARP ? 1 : 0));
        // subdivision modifier (Catmull–Clark, subdivide.js) before the normals: each new face keeps its input face's material
        // and smoothness, edges their sharpness; creases (edge crease 0…1: 4.x attribute "crease_edge", up to 3.x MEdge.crease
        // 0…255 while the mesh flags it) only when the modifier uses them
        if (subdiv?.level > 0 && ce && nf > 0) {
            let level = subdiv.level;
            while (level > 0 && nc * 4 ** (level - 1) > SUBDIV_FACES) level--;
            if (level > 0) {
                let crease = null;
                if (subdiv.crease) {
                    const attr = E.get('crease_edge')?.block;
                    crease = attr ? typed(attr, Float32Array, ne)
                        : medge && (me.int('cd_flag') & 4) ? column(medge, 'MEdge', 'crease', Float32Array, ne).map(x => x / 255) : null;
                    if (crease && !crease.some(x => x > 0)) crease = null;
                }
                const r = subdivideCorners({ pos, offsets, cv, ce, ne, uv, sharp: sharpEdge, crease }, level, { limit: subdiv.limit });
                const mi = matIndex, sf = sharpFace;
                if (mi) matIndex = Int32Array.from(r.root, x => mi[x]);
                if (sf) sharpFace = Uint8Array.from(r.root, x => sf[x]);
                ({ pos, cv, ce, offsets, uv, ne } = r);
                sharpEdge = r.sharp;
                nf = offsets.length - 1; nc = cv.length;
            }
        }
        // auto smooth (until 4.0): edges between faces at a greater angle than smoothresh are sharp too
        const autoSmooth = f.version < 401 && (me.int('flag') & ME_AUTOSMOOTH) ? Math.cos(me.float('smoothresh') ?? Math.PI / 6) : null;
        // face normals (Newell, area-weighted)
        const fn = new Float32Array(nf * 3);
        for (let fi = 0; fi < nf; fi++) {
            let x = 0, y = 0, z = 0;
            for (let c = offsets[fi], e = offsets[fi + 1]; c < e; c++) {
                const a = cv[c] * 3, b = cv[c + 1 < e ? c + 1 : offsets[fi]] * 3;
                x += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
                y += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
                z += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
            }
            fn[fi * 3] = x; fn[fi * 3 + 1] = y; fn[fi * 3 + 2] = z;
        }
        const faceOfCorner = new Int32Array(nc);
        for (let fi = 0; fi < nf; fi++) for (let c = offsets[fi]; c < offsets[fi + 1]; c++) faceOfCorner[c] = fi;
        // smooth fans: corners at the same vertex joined across non-sharp edges of smooth faces (union-find)
        const parent = new Int32Array(nc);
        for (let i = 0; i < nc; i++) parent[i] = i;
        const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
        if (ce) {
            const byEdge = new Map();   // edge → corners starting it (corner c: vertex cv[c] → next corner's vertex)
            for (let c = 0; c < nc; c++) {
                const fi = faceOfCorner[c];
                if (sharpFace?.[fi]) continue;
                const e = ce[c];
                if (sharpEdge?.[e]) continue;
                const l = byEdge.get(e);
                if (l) l.push(c); else byEdge.set(e, [c]);
            }
            const next = c => { const fi = faceOfCorner[c]; return c + 1 < offsets[fi + 1] ? c + 1 : offsets[fi]; };
            const angleSharp = (a, b) => {
                if (autoSmooth === null) return false;
                const p = faceOfCorner[a] * 3, q = faceOfCorner[b] * 3;
                const d = fn[p] * fn[q] + fn[p + 1] * fn[q + 1] + fn[p + 2] * fn[q + 2];
                return d < autoSmooth * Math.hypot(fn[p], fn[p + 1], fn[p + 2]) * Math.hypot(fn[q], fn[q + 1], fn[q + 2]);
            };
            for (const cs of byEdge.values()) {
                for (let i = 1; i < cs.length; i++) {
                    const a = cs[0], b = cs[i];
                    if (angleSharp(a, b)) continue;
                    // same vertex at the edge's ends in both faces
                    const a0 = a, a1 = next(a), b0 = b, b1 = next(b);
                    if (cv[a0] === cv[b0]) { union(a0, b0); union(a1, b1); } else { union(a0, b1); union(a1, b0); }
                }
            }
        }
        const groupN = new Float32Array(nc * 3);
        for (let c = 0; c < nc; c++) { const r = find(c) * 3, fi = faceOfCorner[c] * 3; groupN[r] += fn[fi]; groupN[r + 1] += fn[fi + 1]; groupN[r + 2] += fn[fi + 2]; }
        // parts per material slot: welded vertices (normal group + uv bits – hash table), fan triangulation
        const totcol = me.int('totcol') || 0;
        const uvBits = uv ? new Int32Array(uv.buffer, uv.byteOffset, uv.length) : null;
        const parts = new Map();
        for (let fi = 0; fi < nf; fi++) {
            const slot = Math.min(Math.max(matIndex ? matIndex[fi] : 0, 0), Math.max(totcol - 1, 0));
            let part = parts.get(slot);
            if (!part) { part = new Weld(slot, !!uv); parts.set(slot, part); }
            const s0 = offsets[fi], e = offsets[fi + 1];
            const vertexOf = c => part.vertex(find(c), uvBits ? uvBits[c * 2] : 0, uvBits ? uvBits[c * 2 + 1] : 0, c);
            const v0 = vertexOf(s0);
            for (let c = s0 + 1; c + 1 < e; c++) { const v1 = vertexOf(c), v2 = vertexOf(c + 1); part.tri(v0, v1, v2); }
        }
        for (const part of parts.values()) part.fill(cv, pos, groupN, uv);
        // slots of the mesh's material list (object slots may override them, see below)
        const slots = [];
        const matList = f.deref(me.pointer('mat'));
        for (let i = 0; i < totcol; i++) slots.push(matList ? materialOf(f.pointerAt(matList.data + i * f.ptr)) : -1);
        const built = [...parts.values()].filter(p => p.nIndex).map(p => p.result());
        orientOutward(built);
        return {
            slots,
            parts: built,
        };
    }

    // a bone as parent (partype 7): its pose matrix in the armature (as saved – the rig's pose), moved to the bone's tail
    // (Blender's rule for children of bones; "relative parenting" bones: their channel matrix); the rest pose if unposed
    const BONE_RELATIVE_PARENTING = 1 << 23;
    const boneMatrix = (arm, name) => {
        const ch = list(arm?.deref('pose', 'bPose')?.sub('chanbase'), 'bPoseChannel').find(c => c.string('name') === name);
        if (!ch) return null;
        const bone = ch.deref('bone', 'Bone');
        const relative = !!((bone?.int('flag') || 0) & BONE_RELATIVE_PARENTING);
        let m = ch.floats(relative ? 'chan_mat' : 'pose_mat');
        if (!m?.some(x => x)) m = bone?.floats('arm_mat') ?? null;
        if (!m?.some(x => x)) return null;
        if (!relative) { const len = bone?.float('length') || 0; m[12] += m[4] * len; m[13] += m[5] * len; m[14] += m[6] * len; }
        return m;
    };

    // objects
    const objects = [];
    const objectIndex = new Map();
    const obBlocks = f.blocksOf('OB');
    const objectOf = block => {
        if (objectIndex.has(block.old)) return objectIndex.get(block.old);
        const ob = f.view(block, 0, 'Object');
        objectIndex.set(block.old, -2);   // cycle guard
        const parentBlock = f.deref(ob.pointer('parent'));
        const parent = parentBlock ? objectOf(parentBlock) : -1;
        const type = ob.int('type');
        const restrict = ob.int('restrictflag') || 0;
        const o = {
            name: idName(ob), type, parent: parent >= 0 ? parent : -1,
            loc: ob.floats('loc'), rot: ob.floats('rot'), quat: ob.floats('quat'), size: ob.floats('size'), rotmode: ob.int('rotmode'),
            rotAxis: ob.floats('rotAxis'), rotAngle: ob.float('rotAngle'), parentinv: ob.floats('parentinv'),
            hidden: !!(restrict & 4) || !!(restrict & 1), geometry: -1, slots: [], camera: null, light: null,
            modifiers: [],
            parentBone: ob.int('partype') === 7 && parentBlock ? boneMatrix(f.view(parentBlock, 0, 'Object'), ob.string('parsubstr')) : null,
        };
        // modifiers (each block its own struct – SubsurfModifierData … – with the common ModifierData first): on in the
        // viewport or the render; subdivision (Catmull–Clark, render levels) is applied, the others are listed (notice).
        // Subdivision flags: 1 << 4 use creases, 1 << 6 "recursive" = limit surface off; type 1 (simple) changes no shape
        let subdiv = null;
        for (const md of list(ob.sub('modifiers'), 'ModifierData')) {
            const mode = md.int('mode') || 0;
            if (!(mode & 3)) continue;
            const own = f.view(md.block);
            if (own?.st.name === 'SubsurfModifierData' && type === OB_MESH && !subdiv) {
                if (!(mode & 2)) continue;   // viewport only
                const flags = own.int('flags') || 0;
                subdiv = own.int('subdivType') === 1 ? { level: 0 } : { level: Math.min(own.int('renderLevels') ?? own.int('levels') ?? 0, 6), limit: !(flags & 64), crease: !!(flags & 16) };
                continue;
            }
            const name = md.string('name');
            if (name) o.modifiers.push(name);
        }
        if (type === OB_MESH) {
            o.geometry = meshOf(ob.pointer('data'), subdiv?.level > 0 ? subdiv : null);
            // object-linked material slots (matbits) override the mesh's
            const totcol = ob.int('totcol') || 0, matList = f.deref(ob.pointer('mat')), bitsBlock = f.deref(ob.pointer('matbits'));
            for (let i = 0; i < totcol; i++) {
                const own = bitsBlock ? bytes[bitsBlock.data + i] : 0;
                o.slots.push(own && matList ? materialOf(f.pointerAt(matList.data + i * f.ptr)) : null);
            }
        }
        if (type === OB_CAMERA) {
            const ca = ob.deref('data', 'Camera');
            if (ca) o.camera = { lens: ca.float('lens') || 50, sensor: ca.float('sensor_x') || 36, sensorY: ca.float('sensor_y') || 24, fit: ca.int('sensor_fit') || 0, type: ca.int('type') || 0, clip: ca.float('clipsta') ?? ca.float('clip_start') ?? 0 };
        }
        if (type === OB_LAMP) {
            // Light (Lamp before 2.8): type 0 point, 1 sun, 2 spot, 4 area (area_shape 0 square, 1 rectangle, 4 disc,
            // 5 ellipse); energy in watts (sun: W/m²) × 2^exposure (newer files) – in the DNA `energy_new` (since 2.8;
            // `energy` is the old value, area lights × 4/π), struct name still `Lamp`; spot size = whole cone, blend = soft
            // share; radius = shadow soft size; colour linear
            const la = ob.deref('data', f.structByName.has('Light') ? 'Light' : 'Lamp');
            if (la) {
                const num = (k, d) => (la.has(k) ? la.float(k) : d);
                o.light = {
                    type: la.int('type') || 0, color: [num('r', 1), num('g', 1), num('b', 1)],
                    energy: num('energy_new', num('energy', 10)) * 2 ** num('exposure', 0), spotSize: num('spotsize', Math.PI / 4), spotBlend: num('spotblend', 0.15),
                    shape: la.has('area_shape') ? la.int('area_shape') : 0, sizeX: num('area_size', 0.25), sizeY: num('area_sizey', 0.25),
                    radius: la.has('radius') ? la.float('radius') : num('soft', 0),
                };
            }
        }
        const index = objects.push(o) - 1;
        objectIndex.set(block.old, index);
        return index;
    };
    for (const block of obBlocks) if (!inScene.size || inScene.has(block.old)) objectOf(block);
    onProgress(0.9);
    const r = scene?.sub('r');
    return {
        version: f.version, metersPerUnit: scaleLength, objects, geometries, materials, images,
        render: r ? { x: r.int('xsch') || 0, y: r.int('ysch') || 0, aspx: r.float('xasp') || 1, aspy: r.float('yasp') || 1 } : null,
        camera: scene?.pointer('camera') ? objectIndex.get(scene.pointer('camera')) ?? -1 : -1,
    };
}

// corners of one material slot welded by (normal group, u bits, v bits): open-addressing hash table, typed arrays
class Weld {
    constructor(slot, hasUv) {
        this.slot = slot; this.hasUv = hasUv;
        this.keys = new Int32Array(3 * 1024); this.corner = new Int32Array(1024); this.n = 0;
        this.table = new Int32Array(2048); this.mask = 2047;
        this.index = new Uint32Array(3072); this.nIndex = 0;
    }
    vertex(g, u, v, c) {
        let h = Math.imul(g, 73856093) ^ Math.imul(u, 19349663) ^ Math.imul(v, 83492791);
        let slot = (h ^ (h >>> 15)) & this.mask;
        const K = this.keys;
        for (;;) {
            const e = this.table[slot];
            if (e === 0) break;
            const i = (e - 1) * 3;
            if (K[i] === g && K[i + 1] === u && K[i + 2] === v) return e - 1;
            slot = (slot + 1) & this.mask;
        }
        const vi = this.n++;
        if (vi * 3 + 3 > this.keys.length) { const k = new Int32Array(this.keys.length * 2); k.set(this.keys); this.keys = k; const cc = new Int32Array(this.corner.length * 2); cc.set(this.corner); this.corner = cc; }
        this.keys[vi * 3] = g; this.keys[vi * 3 + 1] = u; this.keys[vi * 3 + 2] = v;
        this.corner[vi] = c;
        this.table[slot] = vi + 1;
        if (this.n * 2 > this.table.length) this.rehash();
        return vi;
    }
    rehash() {
        const table = new Int32Array(this.table.length * 2), mask = table.length - 1, K = this.keys;
        for (let vi = 0; vi < this.n; vi++) {
            let h = Math.imul(K[vi * 3], 73856093) ^ Math.imul(K[vi * 3 + 1], 19349663) ^ Math.imul(K[vi * 3 + 2], 83492791);
            let slot = (h ^ (h >>> 15)) & mask;
            while (table[slot] !== 0) slot = (slot + 1) & mask;
            table[slot] = vi + 1;
        }
        this.table = table; this.mask = mask;
    }
    tri(a, b, c) {
        if (this.nIndex + 3 > this.index.length) { const x = new Uint32Array(this.index.length * 2); x.set(this.index); this.index = x; }
        this.index[this.nIndex++] = a; this.index[this.nIndex++] = b; this.index[this.nIndex++] = c;
    }
    // vertex data from the first corner of each vertex
    fill(cv, pos, groupN, uv) {
        const n = this.n;
        this.positions = new Float32Array(n * 3); this.normals = new Float32Array(n * 3); this.uvs = this.hasUv ? new Float32Array(n * 2) : null;
        for (let vi = 0; vi < n; vi++) {
            const c = this.corner[vi], p = cv[c] * 3, g = this.keys[vi * 3] * 3;
            this.positions[vi * 3] = pos[p]; this.positions[vi * 3 + 1] = pos[p + 1]; this.positions[vi * 3 + 2] = pos[p + 2];
            const x = groupN[g], y = groupN[g + 1], z = groupN[g + 2], l = Math.hypot(x, y, z) || 1;
            this.normals[vi * 3] = x / l; this.normals[vi * 3 + 1] = y / l; this.normals[vi * 3 + 2] = z / l;
            if (this.uvs) { this.uvs[vi * 2] = uv[c * 2]; this.uvs[vi * 2 + 1] = uv[c * 2 + 1]; }
        }
    }
    result() {
        return { slot: this.slot, positions: this.positions, normals: this.normals, uvs: this.uvs, index: this.index.slice(0, this.nIndex) };
    }
}
