// pbrt-v4 scene files (.pbrt, also gzip-compressed) → scene description – worker side, no three.js.
// Format: pbrt.org/fileformat-v4. Directives with positional strings and a parameter list ("type name" value / [values]);
// the current transformation matrix (CTM) is post-multiplied (CTM = CTM · T), points go p_world = CTM · p_object.
// Kept: Camera, Film, shapes (with material, area light, ReverseOrientation, transform), named materials and textures,
// lights, object instances (ObjectBegin/End/Instance), Attribute defaults, Include/Import (read relative to the main file).
// Media: MakeNamedMedium kept with its transform (grid media → volumes, glass interiors → tint), MediumInterface per shape.
// Left out: motion (only the start transform counts), Sampler, Integrator,
// PixelFilter, Accelerator, Option, ColorSpace (scenes use sRGB – other spaces are reported once).
//
// Matrices: Float64Array(16), row-major (m[4 * row + col]) like pbrt; Transform / ConcatTransform give the transposed
// matrix (column after column, translation last).
//
// read(path) → Promise<Uint8Array> (decompressed); paths are relative to the main file's folder.

const T_EOF = 0, T_WORD = 1, T_STRING = 2, T_NUMBER = 3, T_OPEN = 4, T_CLOSE = 5;

// --- 4×4 matrices (row-major) ---

export const identity = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul(a, b) {
    const o = new Float64Array(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            o[4 * r + c] = a[4 * r] * b[c] + a[4 * r + 1] * b[4 + c] + a[4 * r + 2] * b[8 + c] + a[4 * r + 3] * b[12 + c];
        }
    }
    return o;
}
const fromRows = (...v) => Float64Array.from(v);
const translate = (x, y, z) => fromRows(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
const scale = (x, y, z) => fromRows(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1);
function rotate(deg, x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const s = Math.sin(deg * Math.PI / 180), c = Math.cos(deg * Math.PI / 180), t = 1 - c;
    return fromRows(
        x * x * t + c, x * y * t - z * s, x * z * t + y * s, 0,
        x * y * t + z * s, y * y * t + c, y * z * t - x * s, 0,
        x * z * t - y * s, y * z * t + x * s, z * z * t + c, 0,
        0, 0, 0, 1);
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// camera-from-world of a look-at (pbrt: left-handed camera, right = up × dir)
function lookAt(ex, ey, ez, lx, ly, lz, ux, uy, uz) {
    const dir = norm([lx - ex, ly - ey, lz - ez]);
    let right = cross(norm([ux, uy, uz]), dir);
    if (Math.hypot(...right) < 1e-12) right = cross(Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], dir);
    right = norm(right);
    const up = cross(dir, right);
    const worldFromCamera = fromRows(right[0], up[0], dir[0], ex, right[1], up[1], dir[1], ey, right[2], up[2], dir[2], ez, 0, 0, 0, 1);
    return inverse(worldFromCamera);
}
const transpose = m => fromRows(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]);
export function inverse(m) {
    const inv = new Float64Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (!det) return identity();
    for (let i = 0; i < 16; i++) inv[i] /= det;
    return inv;
}
/** determinant of the linear part (< 0: the transform swaps handedness) */
export const det3 = m => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

// --- tokenizer (bytes – files of several hundred MB never become one string) ---

const pow10 = Array.from({ length: 23 }, (_, i) => 10 ** i);

class Tokenizer {
    constructor(bytes, file) {
        this.b = bytes;
        this.p = 0;
        this.file = file;
        this.type = T_EOF;
        this.num = 0;
        this.start = 0;
        this.end = 0;
        this.peeked = false;
        this.onComment = null;   // (text) – comments may carry object names of the exporter
    }
    text() { return latin1(this.b, this.start, this.end); }
    peek() {
        if (!this.peeked) { this.read(); this.peeked = true; }
        return this.type;
    }
    next() {
        if (this.peeked) { this.peeked = false; return this.type; }
        return this.read();
    }
    read() {
        const b = this.b, n = b.length;
        let p = this.p;
        for (;;) {
            while (p < n && (b[p] === 32 || b[p] === 10 || b[p] === 13 || b[p] === 9 || b[p] === 12)) p++;
            if (p < n && b[p] === 35) {   // '#' … end of line
                const s = p;
                while (p < n && b[p] !== 10 && b[p] !== 13) p++;
                if (this.onComment) this.onComment(latin1(b, s + 1, p));
                continue;
            }
            break;
        }
        if (p >= n) { this.p = p; return (this.type = T_EOF); }
        const c = b[p];
        if (c === 91) { this.p = p + 1; return (this.type = T_OPEN); }
        if (c === 93) { this.p = p + 1; return (this.type = T_CLOSE); }
        if (c === 34) {   // "…" (no escapes in scene files that matter here – \" kept as is)
            let q = p + 1;
            while (q < n && b[q] !== 34) { if (b[q] === 92) q++; q++; }
            this.start = p + 1;
            this.end = Math.min(q, n);
            this.p = q + 1;
            return (this.type = T_STRING);
        }
        let q = p;
        while (q < n) {
            const d = b[q];
            if (d === 32 || d === 10 || d === 13 || d === 9 || d === 12 || d === 91 || d === 93 || d === 34 || d === 35) break;
            q++;
        }
        this.start = p;
        this.end = q;
        this.p = q;
        if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
            this.num = parseNumber(b, p, q);
            return (this.type = T_NUMBER);
        }
        return (this.type = T_WORD);
    }
}
function latin1(b, s, e) {
    let out = '';
    for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)));
    return out;
}
function parseNumber(b, p, e) {
    let i = p, neg = false;
    if (b[i] === 45) { neg = true; i++; } else if (b[i] === 43) i++;
    let mant = 0, digits = 0, exp = 0;
    while (i < e && b[i] >= 48 && b[i] <= 57) { if (digits < 17) { mant = mant * 10 + (b[i] - 48); digits++; } else exp++; i++; }
    if (i < e && b[i] === 46) {
        i++;
        while (i < e && b[i] >= 48 && b[i] <= 57) { if (digits < 17) { mant = mant * 10 + (b[i] - 48); digits++; exp--; } i++; }
    }
    if (i < e && (b[i] === 101 || b[i] === 69)) {
        i++;
        let eneg = false, ev = 0;
        if (b[i] === 45) { eneg = true; i++; } else if (b[i] === 43) i++;
        while (i < e && b[i] >= 48 && b[i] <= 57) { ev = ev * 10 + (b[i] - 48); i++; }
        exp += eneg ? -ev : ev;
    }
    if (i !== e) {   // something odd (e.g. "1.2.3") – the slow way
        const v = Number(latin1(b, p, e));
        return Number.isFinite(v) ? v : 0;
    }
    let v = mant;
    if (exp > 0) v *= exp < 23 ? pow10[exp] : 10 ** exp;
    else if (exp < 0) v /= -exp < 23 ? pow10[-exp] : 10 ** -exp;
    return neg ? -v : v;
}

// --- parameter lists ---

/**
 * Parameter list after a directive: { name: { type, v } } – v: Float64Array (numbers), string[] or boolean[].
 * Types as in the file ("float", "rgb", "spectrum", "texture", "point3" …; pbrt-v3 aliases "point"/"normal"/"color" mapped).
 */
let scratch = new Float64Array(1 << 16);
function readParams(tk, warn) {
    const params = {};
    while (tk.peek() === T_STRING) {
        const decl = tk.text().trim().split(/\s+/);
        if (decl.length !== 2) break;   // a positional string of the next directive cannot follow – stop anyway
        tk.next();
        let [type, name] = decl;
        type = { point: 'point3', normal: 'normal3', vector: 'vector3', color: 'rgb' }[type] || type;
        const values = [];
        let nums = 0, kind = 0;   // 1 numbers, 2 strings, 3 bools
        const take = () => {
            const t = tk.next();
            if (t === T_NUMBER) {
                if (nums === scratch.length) { const s = new Float64Array(scratch.length * 2); s.set(scratch); scratch = s; }
                scratch[nums++] = tk.num;
                kind ||= 1;
            } else if (t === T_STRING || t === T_WORD) {
                const s = tk.text();
                if (type === 'bool') { values.push(s === 'true'); kind = 3; } else { values.push(s); kind = 2; }
            }
            return t;
        };
        if (tk.peek() === T_OPEN) {
            tk.next();
            for (;;) {
                const t = tk.peek();
                if (t === T_CLOSE) { tk.next(); break; }
                if (t === T_EOF) { warn(`unterminated parameter list "${name}"`); break; }
                take();
            }
        } else take();
        params[name] = { type, v: kind === 1 ? scratch.slice(0, nums) : values };
    }
    return params;
}

// directives that are parsed and dropped (with their arguments)
const IGNORED = new Set(['Sampler', 'Integrator', 'PixelFilter', 'Accelerator', 'Option']);

/**
 * @param {string} mainPath  main file (its folder = base of all relative paths)
 * @param {(path: string) => Promise<Uint8Array>} read
 * @param {{ onProgress?: (file: string) => void }} options
 */
export async function parsePbrt(mainPath, read, { onProgress } = {}) {
    const warnings = new Map();
    const warn = text => warnings.set(text, (warnings.get(text) || 0) + 1);
    const scene = {
        camera: null, film: {}, cameraTime: [0, 1],
        shapes: [], objects: [], instances: [], materials: [], namedMaterials: new Map(), textures: [],
        textureByName: { float: new Map(), spectrum: new Map() }, lights: [], media: {}, warnings,
    };
    const namedCoordinates = new Map();
    const objectByName = new Map();
    let gs = { ctm: identity(), reverse: false, material: -1, areaLight: null, name: null, attr: {}, media: null };
    const stack = [];
    let ctmStack = [];
    let activeStart = true;
    let object = null;   // instance definition being read
    // default material: diffuse 0.5 (pbrt)
    scene.materials.push({ type: 'diffuse', params: {}, name: '' });
    gs.material = 0;
    let pendingName = null;   // a name comment right before AttributeBegin

    const applyTransform = m => { if (activeStart) gs.ctm = mul(gs.ctm, m); };
    const withDefaults = (kind, params) => {
        const d = gs.attr[kind];
        return d ? { ...d, ...params } : params;
    };

    async function parseFile(path, depth) {
        if (depth > 32) { warn('Include nested too deep'); return; }
        onProgress?.(path);
        let bytes;
        try {
            bytes = await read(path);
        } catch (err) {
            warn(`file not found: ${path}`);
            if (depth === 0) throw err;
            return;
        }
        const tk = new Tokenizer(bytes, path);
        tk.onComment = text => {
            // exporters write object names as comments: # "Plane.005" or # ["Plane.005"]
            const m = /^\s*\[?\s*"([^"]+)"\s*\]?\s*$/.exec(text);
            if (m && m[1].trim()) { pendingName = m[1].trim(); if (stack.length) gs.name = pendingName; }
        };
        const str = () => (tk.next() === T_STRING ? tk.text() : (warn('string expected'), ''));
        const numbers = count => {
            const out = new Float64Array(count);
            let bracket = false;
            if (tk.peek() === T_OPEN) { tk.next(); bracket = true; }
            for (let i = 0; i < count; i++) {
                if (tk.peek() !== T_NUMBER) { warn('number expected'); break; }
                tk.next();
                out[i] = tk.num;
            }
            if (bracket && tk.peek() === T_CLOSE) tk.next();
            return out;
        };
        for (;;) {
            const t = tk.next();
            if (t === T_EOF) break;
            if (t !== T_WORD) { warn('unexpected token'); continue; }
            const d = tk.text();
            switch (d) {
                case 'AttributeBegin': {
                    stack.push(gs);
                    gs = { ...gs, name: pendingName ?? gs.name };
                    pendingName = null;
                    break;
                }
                case 'AttributeEnd':
                    if (stack.length) gs = stack.pop(); else warn('unmatched AttributeEnd');
                    pendingName = null;
                    break;
                case 'TransformBegin': ctmStack.push(gs.ctm); break;
                case 'TransformEnd': if (ctmStack.length) gs.ctm = ctmStack.pop(); break;
                case 'Identity': if (activeStart) gs.ctm = identity(); break;
                case 'Translate': { const v = numbers(3); applyTransform(translate(v[0], v[1], v[2])); break; }
                case 'Scale': { const v = numbers(3); applyTransform(scale(v[0], v[1], v[2])); break; }
                case 'Rotate': { const v = numbers(4); applyTransform(rotate(v[0], v[1], v[2], v[3])); break; }
                case 'LookAt': { const v = numbers(9); applyTransform(lookAt(...v)); break; }
                case 'ConcatTransform': applyTransform(transpose(numbers(16))); break;
                case 'Transform': { const m = transpose(numbers(16)); if (activeStart) gs.ctm = m; break; }
                case 'CoordinateSystem': namedCoordinates.set(str(), gs.ctm); break;
                case 'CoordSysTransform': {
                    const name = str();
                    if (namedCoordinates.has(name)) gs.ctm = namedCoordinates.get(name);
                    else warn(`unknown coordinate system "${name}"`);
                    break;
                }
                case 'ActiveTransform': {
                    tk.next();
                    const w = tk.text();
                    activeStart = w !== 'EndTime';
                    break;
                }
                case 'TransformTimes': numbers(2); break;
                case 'ReverseOrientation': gs.reverse = !gs.reverse; break;
                case 'ColorSpace': { const cs = str(); if (cs.toLowerCase() !== 'srgb') warn(`colour space ${cs} read as sRGB`); break; }
                case 'Camera': {
                    const type = str();
                    const params = readParams(tk, warn);
                    scene.camera = { type, params, cameraFromWorld: gs.ctm };
                    namedCoordinates.set('camera', inverse(gs.ctm));
                    break;
                }
                case 'Film': str(); scene.film = readParams(tk, warn); break;
                case 'WorldBegin':
                    gs.ctm = identity();
                    namedCoordinates.set('world', gs.ctm);
                    break;
                case 'WorldEnd': break;
                case 'Attribute': {
                    const kind = str();
                    gs.attr = { ...gs.attr, [kind]: { ...(gs.attr[kind] || {}), ...readParams(tk, warn) } };
                    break;
                }
                case 'Material': {
                    const type = str();
                    scene.materials.push({ type, params: withDefaults('material', readParams(tk, warn)), name: '' });
                    gs.material = scene.materials.length - 1;
                    break;
                }
                case 'MakeNamedMaterial': {
                    const name = str();
                    const params = withDefaults('material', readParams(tk, warn));
                    const type = params.type?.v?.[0] ?? '';
                    delete params.type;
                    if (scene.namedMaterials.has(name)) warn(`material "${name}" defined twice`);
                    scene.materials.push({ type, params, name });
                    scene.namedMaterials.set(name, scene.materials.length - 1);
                    break;
                }
                case 'NamedMaterial': gs.material = 'n:' + str(); break;
                case 'Texture': {
                    const name = str(), kind = str(), type = str();
                    const params = withDefaults('texture', readParams(tk, warn));
                    const k = kind === 'color' ? 'spectrum' : kind;
                    if (!scene.textureByName[k]) { warn(`texture kind ${kind}`); break; }
                    scene.textures.push({ name, kind: k, type, params, ctm: gs.ctm });
                    scene.textureByName[k].set(name, scene.textures.length - 1);
                    break;
                }
                case 'LightSource': {
                    const type = str();
                    scene.lights.push({ type, params: withDefaults('light', readParams(tk, warn)), ctm: gs.ctm, name: gs.name });
                    break;
                }
                case 'AreaLightSource': {
                    const type = str();
                    gs.areaLight = { type, params: withDefaults('light', readParams(tk, warn)) };
                    break;
                }
                case 'Shape': {
                    const type = str();
                    const params = withDefaults('shape', readParams(tk, warn));
                    const shape = { type, params, ctm: gs.ctm, reverse: gs.reverse, material: gs.material, areaLight: gs.areaLight, name: gs.name, file: path, object: object ? object.index : -1, media: gs.media };
                    scene.shapes.push(shape);
                    if (object) object.shapes.push(scene.shapes.length - 1);
                    break;
                }
                case 'ObjectBegin': {
                    const name = str();
                    stack.push(gs);
                    gs = { ...gs };
                    if (object) warn('ObjectBegin inside an object');
                    object = { name, shapes: [], index: scene.objects.length };
                    scene.objects.push(object);
                    objectByName.set(name, object.index);
                    break;
                }
                case 'ObjectEnd':
                    object = null;
                    if (stack.length) gs = stack.pop();
                    break;
                case 'ObjectInstance': {
                    const name = str();
                    if (!objectByName.has(name)) { warn(`unknown object "${name}"`); break; }
                    scene.instances.push({ object: objectByName.get(name), ctm: gs.ctm, name: gs.name });
                    break;
                }
                case 'MediumInterface': {
                    // interior, exterior (one name: both) – a glass shape's coloured inside comes from one of them
                    const inside = str();
                    let outside = inside;
                    if (tk.peek() === T_STRING && !/\s/.test(tk.text().trim())) outside = str();
                    gs.media = inside || outside ? [inside, outside] : null;
                    break;
                }
                case 'MakeNamedMedium': {
                    const name = str();
                    const params = withDefaults('medium', readParams(tk, warn));
                    scene.media[name] = { type: params.type?.v?.[0] ?? '', params, ctm: gs.ctm };   // medium space = the transform here
                    break;
                }
                case 'Include':
                case 'Import': {
                    const file = str();
                    await parseFile(resolvePath(path, file, mainPath), depth + 1);
                    break;
                }
                default:
                    if (IGNORED.has(d)) {
                        // positional name (not for Option – its first string is already a parameter)
                        if (d !== 'Option' && tk.peek() === T_STRING && !/\s/.test(tk.text().trim())) str();
                        readParams(tk, warn);
                    } else {
                        warn(`unknown directive ${d}`);
                    }
            }
        }
    }
    await parseFile(mainPath, 0);
    scene.objects.forEach(o => { delete o.index; });
    return scene;
}

// pbrt resolves relative paths against the main file's folder (the folder of the file named on the command line)
export function resolvePath(_from, file, mainPath) {
    if (/^([a-z]:[\\/]|\/)/i.test(file)) return file.replace(/\\/g, '/');
    const dir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
    return normalizePath(dir + file.replace(/\\/g, '/'));
}
export function normalizePath(p) {
    const out = [];
    for (const part of p.split('/')) {
        if (part === '.' || part === '') continue;
        if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop(); else out.push(part);
    }
    return out.join('/');
}
