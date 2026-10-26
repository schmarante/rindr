// C4D reader (.c4d) – own analysis of the file format (no public description; no third-party code).
//
// File: "?C4DC4D6" (8 bytes), u32 program version (e.g. 18057), then one stream of tokens, big-endian:
//   0x01 chunk start: u32 id, u32 version      0x02 chunk end
//   0x0c u8   0x0f i32   0x10 u32   0x11 8 bytes (date)   0x13 f64   0x15 bool (u8)   0x16 time (f64 num, f64 den)
//   0x17 vector (3 × f64)   0x19 matrix (12 × f64: offset, v1, v2, v3)
//   0x80 / 0x81 / 0x84 memory (u32 length + bytes)   0x82 / 0x83 string / file name (u32 byte length + UTF-16)
//   0x8c array (u32 length + 1 byte element size code – 2: 16 bit, 3: 32 bit, 6: 64 bit – + elements)
// A BaseContainer is chunk 132: i32 container id, then entries i32 key, i32 data type, value token (type 132 = a
// nested container chunk, large type numbers = custom data in a chunk of their own).
// Every list node (object, tag, material, shader, track, curve, key) holds:
//   110050 data: i32, i32, the parameter container, u8 flag (1 = a link marker "agoal1" + 8 bytes follows: other nodes
//          point at it with "alias2" + the same 8 bytes – the node's address at saving), name string, …
//   110064 type: i32 type id, i32, type name string, then type-specific data (joints, weights …)
//   110100 children list (header 110069, then the child nodes)
// Objects (nodes 5154 / 1001091 – the class of the node, not of the object): 110417 tracks, 110050, 110064 (5100
// polygon, 5140 null, 5103 camera, 1019362 joint, 1019363 skin …), 110100 child objects, 110108 tags, 110052
// transform (relative position, scale, rotation HPB; frozen scale, rotation, position; rotation order last).
// Tags: 5600 points (i32 count, x/y/z each an f64 array), 5604 polygons (i32 count, a/b/c/d each an i32 array –
// c = d: triangle), 5671 UVW (i32 count, f32 array: per polygon 4 corners × u, v), 5711 normals (i32 count, i16 array:
// per polygon 4 corners × x, y, z / 32000), 5612 phong (1001 angle limit on,
// 1002 angle), 5616 texture (1010 link to the material, 1004 projection, 1002/1003 tiling), 5691 plugin tag – type
// 1019365 weights (see readWeights).
// Tracks: 5350 track (110414: its parameter as a DescID – 903 relative position / 904 rotation / 905 scale, then
// 1000/1001/1002 = x/y/z resp. H/P/B) > 5351 curve > 5352 keys (110416: time, value, interpolation).
// Materials: 5703 > 110131 > shaders 5707 (5833 bitmap: 1000 file name; 1011123 layer: bitmaps inside), the material
// container: 2100 colour, 8000 colour shader, 8012 normal shader (as in the test files).
// Coordinates: left-handed, Y up – read as they are; conversion in mesh-importer.js (convertC4d).

const MAGIC = 'C4DC4D6';
const T_START = 0x01, T_END = 0x02;
const FIXED = new Uint8Array(256);
FIXED[0x0c] = 1; FIXED[0x0f] = 4; FIXED[0x10] = 4; FIXED[0x11] = 8; FIXED[0x13] = 8; FIXED[0x15] = 1; FIXED[0x16] = 16;
FIXED[0x17] = 24; FIXED[0x19] = 96;

export function isC4dFile(buffer) {
    if (buffer.byteLength < 12) return false;
    const b = new Uint8Array(buffer, 0, 8);
    return String.fromCharCode(...b.subarray(1)) === MAGIC;
}

/**
 * Parse a .c4d file.
 * @param {ArrayBuffer} buffer
 * @param {(done: number) => void} [onProgress]  share 0…1 of the file read
 * @returns {{ version: number, objects: object[], materials: object[], unsupported: { name: string, count: number }[] }}
 */
export function parseC4d(buffer, onProgress = () => {}) {
    if (!isC4dFile(buffer)) throw new Error('not a C4D file');
    const reader = new Reader(buffer, onProgress);
    const root = reader.tree();
    return interpret(root, reader.version, reader.buf);
}

// --- tokens → chunk tree ---

class Reader {
    constructor(buffer, onProgress) {
        this.buf = new Uint8Array(buffer);
        this.dv = new DataView(buffer);
        this.onProgress = onProgress;
        this.version = this.dv.getUint32(8);
        this.p = 13;   // magic, version, one byte
    }

    // the whole stream as nodes { id, ver, kids: [], vals: [] }; keys (110416) compact: { id, t, v, interp }
    tree() {
        const { buf, dv } = this;
        const top = { id: 0, ver: 0, kids: [], vals: [] };
        const stack = [top];
        let next = 1 << 20;
        while (this.p < buf.length) {
            const t = buf[this.p++];
            const node = stack[stack.length - 1];
            if (t === T_START) {
                const id = dv.getUint32(this.p), ver = dv.getUint32(this.p + 4);
                this.p += 8;
                if (id === 110416) { node.kids.push(this.key(ver)); continue; }
                const child = { id, ver, kids: [], vals: [] };
                node.kids.push(child);
                stack.push(child);
                continue;
            }
            if (t === T_END) {
                if (stack.length > 1) stack.pop();
                continue;
            }
            node.vals.push(this.value(t));
            if (this.p > next) { next = this.p + (1 << 20); this.onProgress(this.p / buf.length); }
        }
        return top;
    }

    value(t) {
        const { buf, dv } = this;
        const p = this.p;
        const size = FIXED[t];
        if (size) {
            this.p += size;
            switch (t) {
                case 0x0f: return dv.getInt32(p);
                case 0x10: return dv.getUint32(p);
                case 0x13: return dv.getFloat64(p);
                case 0x0c: case 0x15: return buf[p];
                case 0x16: return { time: dv.getFloat64(p) / (dv.getFloat64(p + 8) || 1) };
                case 0x17: return { vec: [dv.getFloat64(p), dv.getFloat64(p + 8), dv.getFloat64(p + 16)] };
                case 0x19: { const m = new Array(12); for (let i = 0; i < 12; i++) m[i] = dv.getFloat64(p + i * 8); return { mat: m }; }
                default: return null;
            }
        }
        const n = dv.getUint32(p);
        const start = p + 4;
        this.p = start + n;
        if (this.p > buf.length) throw new Error(`C4D: block beyond the end of the file at ${p}`);
        switch (t) {
            case 0x82: case 0x83: {
                let s = '';
                for (let i = 0; i + 1 < n; i += 2) s += String.fromCharCode(dv.getUint16(start + i));
                return { str: s };
            }
            case 0x8c: return { arr: { size: buf[start], offset: start + 1, length: n - 1 } };
            case 0x80: case 0x81: case 0x84:
                if (n === 14 && (buf[start] === 0x61)) return { mark: this.mark(start) };   // "agoal1" / "alias2"
                return { mem: { offset: start, length: n } };
            default:
                throw new Error(`C4D: unknown token 0x${t.toString(16)} at ${p - 1}`);
        }
    }

    // link marker: 6 letters + 8 bytes – the node's memory address when the file was saved (little-endian; nodes 0x80
    // apart, so the first byte's top bit belongs to it – masking it made different joints collide); 0 = no link
    mark(start) {
        const { buf } = this;
        const kind = String.fromCharCode(...buf.subarray(start, start + 6));
        let key = '', any = false;
        for (let i = 6; i < 14; i++) {
            const b = buf[start + i];
            if (b) any = true;
            key += b.toString(16).padStart(2, '0');
        }
        return { kind, key: any ? key : null };
    }

    // key data (chunk 110416, until its end token): time, two tangent times, value, two tangent values, interpolation …
    key(ver) {
        const vals = [];
        while (this.p < this.buf.length) {
            const t = this.buf[this.p++];
            if (t === T_END) break;
            if (t === T_START) { this.p += 8; continue; }   // not seen inside keys
            vals.push(this.value(t));
        }
        const times = vals.filter(v => v && typeof v === 'object' && 'time' in v);
        const reals = vals.filter(v => typeof v === 'number');
        return { id: 110416, ver, key: true, t: times[0]?.time ?? 0, v: reals[0] ?? 0, interp: reals[3] ?? 1 };
    }
}

// --- helpers on the tree ---

const kid = (node, id) => node?.kids.find(k => k.id === id) ?? null;
const kidsOf = (node, id) => node?.kids.filter(k => k.id === id) ?? [];
// the list nodes of a 110100 list (its 110069 header left out)
const listItems = list => (list ? list.kids.filter(k => k.id !== 110069) : []);

// parameter container of a node's 110050: key → value (nested containers as Map)
function container(data) {
    const bc = kid(data, 132);
    return bc ? readContainer(bc) : new Map();
}
function readContainer(bc) {
    const out = new Map();
    const vals = bc.vals;
    let k = 1, c = 0;   // vals[0] = container id; nested containers / custom data chunks in order of their entries
    const chunks = bc.kids;
    while (k + 1 < vals.length) {
        const key = vals[k], type = vals[k + 1];
        k += 2;
        if (type === 132) { const sub = chunks[c++]; out.set(key, sub ? readContainer(sub) : new Map()); continue; }
        if (type > 1000 || type === 0) { out.set(key, { custom: chunks[c++] ?? null, type }); continue; }   // custom data: a chunk
        out.set(key, vals[k++]);
    }
    return out;
}

// name and link marker of a list node (from its 110050)
function nodeInfo(node) {
    const data = kid(node, 110050);
    let name = '', mark = null;
    if (data) {
        for (const v of data.vals) {
            if (v && v.mark && v.mark.kind === 'agoal1' && !mark) mark = v.mark.key;
            if (v && typeof v.str === 'string' && !name) name = v.str;
        }
    }
    const type = kid(node, 110064);
    return { name, mark, data, type, typeId: type?.vals[0] ?? null };
}

function arrayOf(buf, a) {
    if (!a) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset + a.offset, a.length);
    const size = { 2: 2, 3: 4, 6: 8 }[a.size] ?? 4;
    return { dv, count: Math.floor(a.length / size), size };
}

// --- interpretation ---

function interpret(root, version, buf) {
    const top = root.kids.find(k => k.id === 110059) ?? root;
    const marks = new Map();   // link key → node info
    const materials = [];

    // materials (inside 110308): 5703 the program's own, 5705 those of render plugins (their parameters are not read –
    // only the bitmaps in them, by the role their file name tells)
    for (const list of kidsOf(top, 110308)) {
        for (const m of listItems(kid(list, 110100))) {
            if (m.id !== 5703 && m.id !== 5705) continue;
            const info = nodeInfo(m);
            // shaders (5707, nested: a layer shader holds its layers): each with the bitmap files in it (its own first)
            const shaders = [];
            const walkShaders = (node, owners) => {
                for (const s of node.kids) {
                    if (s.id === 5707) {
                        const si = nodeInfo(s);
                        // the bitmap shader's file (1000) – shaders of render plugins keep it under keys of their own: the first
                        // value that names an image
                        const sbc = container(si.data);
                        let file = si.typeId === 5833 ? sbc.get(1000)?.str || null : null;
                        if (!file) for (const v of sbc.values()) if (typeof v?.str === 'string' && IMAGE_FILE.test(v.str)) { file = v.str; break; }
                        const shader = { mark: si.mark, typeId: si.typeId, name: si.name, files: file ? [file] : [] };
                        for (const o of owners) if (file) o.files.push(file);
                        shaders.push(shader);
                        walkShaders(s, [...owners, shader]);
                    } else walkShaders(s, owners);
                }
            };
            walkShaders(m, []);
            const bc = container(info.data);
            const mat = { name: info.name, mark: info.mark, bc, shaders, plugin: m.id === 5705, typeId: info.typeId };
            materials.push(mat);
            if (info.mark) marks.set(info.mark, { kind: 'material', mat });
            for (const s of shaders) if (s.mark) marks.set(s.mark, { kind: 'shader', shader: s });
        }
    }

    // objects (inside 110107)
    const objects = [];
    const visit = (node, parent) => {
        const info = nodeInfo(node);
        if (!info.type) return;
        const obj = {
            index: objects.length, parent, name: info.name, typeId: info.typeId, typeName: info.type.vals.find(v => v?.str)?.str ?? '',
            mark: info.mark, bc: container(info.data), transform: readTransform(kid(node, 110052)), tags: [], tracks: [],
        };
        objects.push(obj);
        if (info.mark) marks.set(info.mark, { kind: 'object', obj });
        for (const tagNode of listItems(kid(kid(node, 110108), 110100))) obj.tags.push(readTag(tagNode, buf));
        for (const trackNode of listItems(kid(kid(node, 110417), 110100))) {
            const track = readTrack(trackNode);
            if (track) obj.tracks.push(track);
        }
        for (const child of listItems(kid(node, 110100))) visit(child, obj.index);
    };
    for (const list of kidsOf(top, 110107)) for (const node of listItems(kid(list, 110100))) visit(node, -1);

    // links → indices
    for (const obj of objects) {
        for (const tag of obj.tags) {
            if (tag.kind === 'texture') tag.material = marks.get(tag.materialMark)?.mat ?? null;
            if (tag.kind === 'weights') for (const j of tag.joints) j.object = marks.get(j.mark)?.obj?.index ?? -1;
            if (tag.kind === 'target') tag.target = marks.get(tag.targetMark)?.obj?.index ?? -1;
        }
    }
    for (const mat of materials) {
        const link = key => { const v = mat.bc.get(key); return v?.mark?.key ? marks.get(v.mark.key)?.shader ?? null : null; };
        // a bitmap's file; a layer shader: its first bitmap that is not a mask (the base layer of a colour composite)
        const fileOf = sh => (sh ? sh.files.find(f => !/mask/i.test(f)) ?? sh.files[0] ?? null : null);
        const vec = key => mat.bc.get(key)?.vec ?? null;
        if (mat.typeId === PLUGIN_MATERIAL) {
            // the render plugin's material (keys found on two scenes): 2509 kind, 2515/2517 diffuse colour/texture,
            // 2522/2524 specular colour/texture (a metal's colour), 2532 roughness, 2542 normal, 2551 index of
            // refraction, 2554/2555 transmission colour/texture, 2557 emission
            const kind = { 2510: 'diffuse', 2511: 'glossy', 2513: 'specular', 2514: 'metallic', 2516: 'universal' }[mat.bc.get(2509)] ?? 'diffuse';
            mat.kind = kind;
            const metal = kind === 'metallic';
            mat.color = metal ? vec(2522) : kind === 'specular' ? vec(2554) : vec(2515);
            mat.colorMap = fileOf(link(metal ? 2524 : kind === 'specular' ? 2555 : 2517));
            mat.normalMap = fileOf(link(2542));
            mat.emissionMap = fileOf(link(2557));
            mat.roughness = num(mat.bc.get(2532));
            mat.ior = num(mat.bc.get(2551));
        } else if (mat.typeId === VRAY_MATERIAL) {
            // another render plugin's material: keys are hashes (found on one scene) – 2131196938 / 605015197 diffuse
            // colour / texture, 1668198367 bump, 451657623 reflection glossiness (1 = mirror), 2035585782 reflection
            // colour (black = no reflection); a normal-map shader linked anywhere: the normal map
            mat.kind = 'vray';
            mat.color = vec(2131196938);
            mat.colorMap = fileOf(link(605015197));
            mat.bumpMap = fileOf(link(1668198367));
            const reflect = vec(2035585782), gloss = num(mat.bc.get(451657623));
            mat.roughness = reflect && Math.max(...reflect) < 0.02 ? 0.9 : gloss !== null ? 1 - gloss : 0.5;
            for (const v of mat.bc.values()) {
                const sh = v?.mark?.key ? marks.get(v.mark.key)?.shader : null;
                if (sh?.typeId === VRAY_NORMAL_MAP && !mat.normalMap) mat.normalMap = fileOf(sh);
            }
        } else {
            mat.colorMap = fileOf(link(8000));
            mat.normalMap = fileOf(link(8012));
            mat.color = mat.plugin ? null : vec(2100);
        }
        // nothing linked (other plugin materials): the material's bitmaps by their name
        if (mat.plugin && mat.typeId !== PLUGIN_MATERIAL) {
            const files = [...new Set(mat.shaders.flatMap(sh => sh.files))];
            const byName = re => files.find(f => re.test(f.split(/[\\/]/).pop())) ?? null;
            mat.colorMap ??= byName(/^(?!.*(mask|norm|nrm|gloss|rough|spec|refl|bump|disp|height|_ao|occl|opac|alpha|metal)).*/i);
            mat.normalMap ??= byName(/norm|nrm/i);
        }
        delete mat.bc;
        delete mat.shaders;
        delete mat.mark;
    }
    for (const obj of objects) {
        for (const tag of obj.tags) {
            if (tag.kind === 'texture') { tag.material = tag.material ? materials.indexOf(tag.material) : -1; delete tag.materialMark; }
            if (tag.kind === 'weights') for (const j of tag.joints) delete j.mark;
            delete tag.targetMark;
        }
        delete obj.mark;
        // camera: focal length (500) and sensor width (1006) in mm
        if (obj.typeId === 5103) obj.camera = { focal: num(obj.bc.get(500)) ?? 36, aperture: num(obj.bc.get(1006)) ?? 36 };
        delete obj.bc;
    }
    // object types without a reading here (generators, splines, deformers other than the skin …): named for the notice;
    // lights and the scene's environment (sky, floor, background, physical sky …) are left out without one (as with MAX).
    // Type names are in the language of the program that saved the file.
    const KNOWN = new Set([5100, 5140, 5103, 1019362, 1019363]);
    const unsupported = new Map();
    for (const o of objects) {
        if (KNOWN.has(o.typeId) || IGNORED.has(o.typeId)) continue;
        const name = o.typeName || String(o.typeId);
        unsupported.set(name, (unsupported.get(name) || 0) + 1);
    }
    // units: 1 unit = 1 cm. The document's unit (container key 2127 with 2076 = metres per unit: cm 3 / 0.01, mm 5 / 0.001)
    // is the display unit only – read as the scale, a room modelled in centimetres (3.03 m ceiling) became 30 cm high
    return { version, unitMeters: 0.01, objects, materials, unsupported: [...unsupported].map(([name, count]) => ({ name, count })) };
}

const num = v => (typeof v === 'number' ? v : null);
const PLUGIN_MATERIAL = 1029501, VRAY_MATERIAL = 1053286, VRAY_NORMAL_MAP = 1057881;
// light, sky, environment, floor, background, foreground, stage, physical sky; a render plugin's lights (rectangle, sphere,
// sun …: 1053280–1053290) and its scene assets (1061766 – meshes of lights from an external scene file)
const IGNORED = new Set([5102, 5105, 5106, 5168, 5122, 5123, 5136, 1011146, 1061766]);
for (let id = 1053280; id <= 1053290; id++) if (id !== 1053283 && id !== 1053286) IGNORED.add(id);
const IMAGE_FILE = /\.(png|jpe?g|tiff?|exr|hdr|bmp|tga|webp|psd)$/i;

// relative position / scale / rotation (HPB, radians), frozen scale / rotation / position, rotation order
function readTransform(chunk) {
    if (!chunk) return null;
    const vecs = chunk.vals.filter(v => v && v.vec).map(v => v.vec);
    const ints = chunk.vals.filter(v => typeof v === 'number');
    // after the three vectors: visibility in the editor and when rendering (0 on, 1 off, 2 default = like the parent)
    const [editor, render] = chunk.vals.slice(3, 5);
    return {
        editor: typeof editor === 'number' ? editor : 2, render: typeof render === 'number' ? render : 2,
        position: vecs[0] ?? [0, 0, 0], scale: vecs[1] ?? [1, 1, 1], rotation: vecs[2] ?? [0, 0, 0],
        frozenScale: vecs[3] ?? [1, 1, 1], frozenRotation: vecs[4] ?? [0, 0, 0], frozenPosition: vecs[5] ?? [0, 0, 0],
        order: ints[ints.length - 1] ?? 6,
    };
}


function readTag(node, buf) {
    const info = nodeInfo(node);
    const bc = container(info.data);
    const inner = node.kids.find(k => k.id === node.id && k !== info.data);
    switch (node.id) {
        case 5600: {   // points
            const arrs = inner?.vals.filter(v => v?.arr).map(v => arrayOf(buf, v.arr)) ?? [];
            const count = inner?.vals.find(v => typeof v === 'number') ?? 0;
            const points = new Float64Array(count * 3);
            for (let c = 0; c < 3 && c < arrs.length; c++) {
                const a = arrs[c];
                for (let i = 0; i < count; i++) points[i * 3 + c] = a.size === 8 ? a.dv.getFloat64(i * 8) : a.dv.getFloat32(i * 4);
            }
            return { kind: 'points', points, count };
        }
        case 5604: {   // polygons a/b/c/d
            const arrs = inner?.vals.filter(v => v?.arr).map(v => arrayOf(buf, v.arr)) ?? [];
            const count = inner?.vals.find(v => typeof v === 'number') ?? 0;
            const polys = new Int32Array(count * 4);
            for (let c = 0; c < 4 && c < arrs.length; c++) for (let i = 0; i < count; i++) polys[i * 4 + c] = arrs[c].dv.getInt32(i * 4);
            return { kind: 'polygons', polys, count };
        }
        case 5671: {   // UVW: per polygon 4 × (u, v)
            const a = arrayOf(buf, inner?.vals.find(v => v?.arr)?.arr);
            const count = inner?.vals.find(v => typeof v === 'number') ?? 0;
            const uvs = new Float32Array(count * 8);
            if (a) for (let i = 0; i < uvs.length && i < a.count; i++) uvs[i] = a.size === 8 ? a.dv.getFloat64(i * 8) : a.dv.getFloat32(i * 4);
            return { kind: 'uvw', uvs, count, name: info.name };
        }
        case 5711: {   // normals: per polygon 4 corners × x, y, z as i16 / 32000
            const a = arrayOf(buf, inner?.vals.find(v => v?.arr)?.arr);
            const count = inner?.vals.find(v => typeof v === 'number') ?? 0;
            if (!a || a.size !== 2 || a.count < count * 12) return { kind: 'other', id: 5711 };
            const normals = new Float32Array(count * 12);
            for (let i = 0; i < normals.length; i++) normals[i] = a.dv.getInt16(i * 2) / 32000;
            return { kind: 'normals', normals, count };
        }
        case 5612:   // phong
            return { kind: 'phong', limit: !!bc.get(1001), angle: bc.get(1002) ?? Math.PI / 2 };
        case 5616:   // texture
            return {
                kind: 'texture', materialMark: bc.get(1010)?.mark?.key ?? null, projection: bc.get(1004) ?? 6,
                offset: [bc.get(1000) ?? 0, bc.get(1001) ?? 0], tiles: [bc.get(1002) ?? 1, bc.get(1003) ?? 1],
            };
        case 5676:   // target expression (camera / light aims at an object): its link – untested, no sample file
            return { kind: 'target', targetMark: [...bc.values()].find(v => v?.mark?.key)?.mark.key ?? null };
        case 5691:
            if (info.typeId === 1019365) return { kind: 'weights', ...readWeights(info.type, buf) };
            return { kind: 'plugin', typeId: info.typeId, name: info.type?.vals.find(v => v?.str)?.str ?? '' };
        default:
            return { kind: 'other', id: node.id };
    }
}

// Weight tag (type data of 110064): i32 joint count, matrix (the mesh at binding), then per joint: link marker, its
// global matrix at binding, a length, and its weights as a sparse map – i32 count, i32, i32 range count + i32 array of
// ranges (first point, last point, index of the first weight), a lookup table (not needed) and the weights as an
// array of u16 (/ 65535) or f32/f64. Read by position: from one joint's link marker to the next.
function readWeights(type, buf) {
    const vals = type.vals;
    const joints = [];
    let geomMatrix = null;
    const starts = [];
    vals.forEach((v, i) => { if (v?.mark && v.mark.kind === 'alias2' && v.mark.key && vals[i + 1]?.mat) starts.push(i); });
    for (const v of vals) if (v?.mat) { geomMatrix = v.mat; break; }
    for (let s = 0; s < starts.length; s++) {
        const from = starts[s], to = s + 1 < starts.length ? starts[s + 1] : vals.length;
        const bind = vals[from + 1].mat;
        // ranges: the first array (32-bit, 3 values each); weights: the last one (its length = the number of points – the
        // count before it follows a length stored as a real, which can be a whole number)
        const arrs = vals.slice(from, to).filter(v => v?.arr).map(v => v.arr);
        let points = null, weights = null;
        if (arrs.length >= 2) {
            const r = arrayOf(buf, arrs[0]);
            const w = arrayOf(buf, arrs[arrs.length - 1]);
            const count = w.count;
            points = new Int32Array(count);
            weights = new Float32Array(count);
            for (let i = 0; i + 2 < r.count; i += 3) {
                const first = r.dv.getInt32(i * 4), last = r.dv.getInt32(i * 4 + 4), at = r.dv.getInt32(i * 4 + 8);
                for (let pt = first, o = at; pt <= last && o < count; pt++, o++) points[o] = pt;
            }
            for (let i = 0; i < count; i++) {
                weights[i] = w.size === 2 ? w.dv.getUint16(i * 2) / 65535 : w.size === 8 ? w.dv.getFloat64(i * 8) : w.dv.getFloat32(i * 4);
            }
        }
        joints.push({ mark: vals[from].mark.key, bind, points, weights });
    }
    return { geomMatrix, joints };
}

function readTrack(node) {
    const info = nodeInfo(node);
    const desc = kid(node, 110414);
    const levels = desc ? kidsOf(desc, 1).flatMap(l => l.vals) : [];
    // DescID: level count, then per level: id, data type, creator
    const ids = [];
    if (levels.length) {
        const n = levels[0];
        for (let i = 0; i < n; i++) ids.push(levels[1 + i * 3]);
    }
    // curves of the track (a track may hold several – the one with the most keys counts)
    let best = [];
    for (const c of kidsOf(kid(node, 110418), 5351)) {
        const keys = [];
        const collect = n => { for (const k of n.kids) { if (k.key) keys.push(k); else collect(k); } };
        collect(c);
        if (keys.length > best.length) best = keys;
    }
    if (!ids.length || !best.length) return null;
    const times = new Float32Array(best.length), values = new Float32Array(best.length);
    best.forEach((k, i) => { times[i] = k.t; values[i] = k.v; });
    return { name: info.name, param: ids[0], component: ids[1] ?? null, times, values };
}
