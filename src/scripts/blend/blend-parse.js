// .blend reader (Blender 4.x): the scene's objects, their meshes (evaluated data as saved – modifiers are listed, not
// applied), Principled BSDF materials with their image textures, packed images, cameras, units. Own implementation on top
// of the file's self description (blend-file.js); field names as the file's DNA has them (older names, e.g. totpoly).
//
// Meshes (4.x): attributes in CustomData layers by name – vdata "position" (float3), ldata ".corner_vert" / ".corner_edge"
// (int), UV maps (float2, the first not starting with "."), pdata "material_index" (int), "sharp_face" (bool), edata
// "sharp_edge" (bool); faces from poly_offset_indices (faces + 1). Normals like Blender's: per corner the faces around its
// vertex that are smooth and joined across edges that are not sharp (custom normals – CD_CUSTOMLOOPNORMAL – not decoded;
// on the test scene they were all but empty). Closed meshes wound inwards are turned outwards (orient-outward.js).
// Objects: loc / rot (rotmode: 0 quaternion, 1…6 Euler XYZ…ZYX, −1 axis angle) / size, parent · parentinv · local; only
// objects of the scene's collections; restrictflag render/viewport off = hidden.
// Materials: Principled BSDF inputs (default values; linked from an image texture – through Mapping for its scale /
// location –: Base Color, Roughness, Metallic, Alpha, Emission Color; Normal ← Normal Map (Color) or Bump (Height)).

import { BlendFile } from './blend-file.js';
import { orientOutward } from '../orient-outward.js';

const OB_MESH = 1, OB_CAMERA = 11;

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
            if (m) { mat.maps.bump = m; mat.bumpStrength = socketValue(input(nn, 'Strength')) ?? 1; }
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
    const meshOf = ptr => {
        if (geometryIndex.has(ptr)) return geometryIndex.get(ptr);
        const me = f.view(f.deref(ptr), 0, 'Mesh');
        const index = me ? geometries.push(buildMesh(me)) - 1 : -1;
        geometryIndex.set(ptr, index);
        return index;
    };
    function buildMesh(me) {
        const nv = me.int('totvert'), nf = me.int('totpoly') ?? me.int('faces_num'), nc = me.int('totloop') ?? me.int('corners_num');
        const V = layersOf(me.sub('vdata')), E = layersOf(me.sub('edata')), P = layersOf(me.sub('pdata')), L = layersOf(me.sub('ldata'));
        const pos = typed(V.get('position')?.block, Float32Array, nv * 3);
        const cv = typed(L.get('.corner_vert')?.block, Int32Array, nc);
        const offsets = typed(f.deref(me.pointer('poly_offset_indices')), Int32Array, nf + 1);
        if (!pos || !cv || !offsets) return { parts: [], materials: [] };
        const ce = typed(L.get('.corner_edge')?.block, Int32Array, nc);
        const matIndex = typed(P.get('material_index')?.block, Int32Array, nf);
        const sharpFace = P.get('sharp_face')?.block ? bytes.subarray(P.get('sharp_face').block.data, P.get('sharp_face').block.data + nf) : null;
        const sharpEdge = E.get('sharp_edge')?.block ? bytes.subarray(E.get('sharp_edge').block.data, E.get('sharp_edge').block.data + (me.int('totedge') || 0)) : null;
        let uv = null;
        for (const [name, l] of L) if (l.type === 49 && !name.startsWith('.')) { uv = typed(l.block, Float32Array, nc * 2); break; }
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
            for (const cs of byEdge.values()) {
                for (let i = 1; i < cs.length; i++) {
                    const a = cs[0], b = cs[i];
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
            hidden: !!(restrict & 4) || !!(restrict & 1), geometry: -1, slots: [], camera: null,
            modifiers: list(ob.sub('modifiers'), null).map(m => m.string('name')),
        };
        if (type === OB_MESH) {
            o.geometry = meshOf(ob.pointer('data'));
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
