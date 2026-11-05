// Worker of the pbrt-v4 importer: reads the scene files (main file + Include/Import, PLY meshes – from the dropped files
// or relative to the model's URL, gzip unpacked), builds the shapes' geometry and the environment map; answers with the
// scene description, the geometry buffers (transferred) and the placement of every mesh in RINDR's space (mm, Y up).
//
// Space: pbrt's world as it is, unit = metre (pbrt has none – scenes are mostly built in metres; × 1000 → mm). The up
// axis is the camera's up vector (Z up → Y up). pbrt's camera is left-handed: with a camera transform that keeps
// handedness (scenes written for pbrt) its picture is the mirror image of a right-handed camera's – the world is then
// mirrored in x, so RINDR shows the scene as the reference renders do; exporters from right-handed programs put a
// Scale -1 1 1 in front of the camera, those scenes stay as they are.
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { FloatType } from 'three';
import { parsePbrt, mul, inverse, det3, normalizePath } from './pbrt-parse.js';
import { buildShape, emitterShape } from './pbrt-shapes.js';
import { octahedralToEquirect, octahedralIlluminance, encodeRgbe, readPfm } from './pbrt-env.js';
import { unzlibSync } from 'three/addons/libs/fflate.module.js';
import { readVdbGrids, vdbVolume, reduceDense, packVolume } from '../volumes/vdb-import.js';

const MM = 1000;   // file unit (m) → mm

async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function fileReader({ files, baseUrl, main, mainPath }) {
    const byPath = new Map(), byName = new Map();
    for (const { path, file } of files) {
        const p = normalizePath(path.replace(/\\/g, '/')).toLowerCase();
        byPath.set(p, file);
        byName.set(p.split('/').pop(), file);
    }
    if (main) byPath.set(normalizePath(mainPath).toLowerCase(), main);
    return async path => {
        const p = normalizePath(path).toLowerCase();
        const blob = byPath.get(p) || (!baseUrl && byName.get(p.split('/').pop()));
        let bytes;
        if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
        else if (baseUrl) {
            const res = await fetch(new URL(path.split('/').map(encodeURIComponent).join('/'), baseUrl));
            if (!res.ok) throw new Error(`${path}: ${res.status}`);
            bytes = new Uint8Array(await res.arrayBuffer());
        } else throw new Error(`${path} not supplied`);
        return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzip(bytes) : bytes;
    };
}

// the scene's conversion G (pbrt world → RINDR, linear, orthonormal): up axis → +Y, mirror in x for pbrt's own cameras
function sceneTransform(camera) {
    let mirror = false, upAxis = 'y', upSign = 1;
    if (camera) {
        const C = camera.cameraFromWorld, W = inverse(C);
        const up = [W[1], W[5], W[9]];   // camera +y in the world
        const a = up.map(Math.abs);
        upAxis = a[2] >= a[0] && a[2] >= a[1] ? 'z' : a[1] >= a[0] ? 'y' : 'x';
        upSign = Math.sign(up['xyz'.indexOf(upAxis)]) || 1;
        mirror = det3(C) > 0;
    }
    // rotation taking (upSign · upAxis) to +Y (row-major 4×4)
    const R = {
        y: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        z: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0],    // (x, y, z) → (x, z, −y)
        x: [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],    // (x, y, z) → (−y, x, z)
    }[upAxis];
    let G = Float64Array.from([...R, 0, 0, 0, 1]);
    if (upSign < 0) G = mul(Float64Array.from([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]), G);   // 180° about X
    if (mirror) G = mul(G, Float64Array.from([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    return { G, mirror, upAxis: (upSign < 0 ? '-' : '') + upAxis };
}

const apply = (m, p, w = 1) => [0, 1, 2].map(r => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3] * w);
const normalOf = (m, n) => {   // normal through the inverse transpose
    const i = inverse(m);
    const v = [0, 1, 2].map(c => i[c] * n[0] + i[4 + c] * n[1] + i[8 + c] * n[2]);
    const l = Math.hypot(...v) || 1;
    return v.map(x => x / l);
};
const colMajor = (m, out, o) => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[o + 4 * c + r] = m[4 * r + c]; };
const MMS = Float64Array.from([MM, 0, 0, 0, 0, MM, 0, 0, 0, 0, MM, 0, 0, 0, 0, 1]);

// A grid medium as a dense grid over its box: density (+ temperature for fire) as bytes of their maximum, majorant
// blocks, the unit box (−0.5…0.5) → RINDR (mm) matrix (column-major) and mm per medium unit (σ conversion).
// nanovdb: the file's density and temperature grids through the shared VDB importer (vdb-import.js – an OpenVDB file
// would do as well); uniformgrid: nx·ny·nz samples over p0…p1 (cell centred, as pbrt samples them)
async function gridVolume(name, medium, read, toRindr, maxVoxels) {
    const p = medium.params;
    let packed, boxToMedium;
    if (medium.type === 'nanovdb') {
        const file = p.filename?.v?.[0];
        if (!file) throw new Error('no filename');
        const v = vdbVolume(readVdbGrids(await read(file), unzlibSync), maxVoxels, { density: 'density', temperature: 'temperature' });
        packed = v;
        boxToMedium = Float64Array.from(v.boxToWorld);
    } else {
        const n = ['nx', 'ny', 'nz'].map(k => p[k]?.v?.[0] ?? 1), values = p.density?.v;
        if (!values || values.length < n[0] * n[1] * n[2]) throw new Error('density grid incomplete');
        const density = reduceDense(Float32Array.from(values.slice(0, n[0] * n[1] * n[2])), n, maxVoxels);
        const tv = p.temperature?.v;
        const temperature = tv?.length >= n[0] * n[1] * n[2] ? reduceDense(Float32Array.from(tv.slice(0, n[0] * n[1] * n[2])), n, maxVoxels) : null;
        packed = packVolume(density, temperature);
        const p0 = p.p0?.v ?? [0, 0, 0], p1 = p.p1?.v ?? [1, 1, 1];
        boxToMedium = Float64Array.from([p1[0] - p0[0], 0, 0, (p0[0] + p1[0]) / 2, 0, p1[1] - p0[1], 0, (p0[1] + p1[1]) / 2, 0, 0, p1[2] - p0[2], (p0[2] + p1[2]) / 2, 0, 0, 0, 1]);
    }
    const mediumToRindr = mul(toRindr, medium.ctm);
    const matrix = new Float32Array(16);
    colMajor(mul(mediumToRindr, boxToMedium), matrix, 0);
    const { dims, factor, density, densityMax, blocks, blockDims, temperature, temperatureMax } = packed;
    return {
        name, type: medium.type, dims, factor, density, densityMax, blocks, blockDims, temperature, temperatureMax,
        matrix, unitScale: Math.cbrt(Math.abs(det3(mediumToRindr))),
    };
}

async function readEnvironment(light, read, G, warn) {
    const file = light.params.filename?.v?.[0];
    if (!file) return null;
    let img;
    try {
        const bytes = await read(file);
        if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) {
            const loader = new EXRLoader();
            loader.setDataType(FloatType);
            const r = loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            img = { data: r.data, width: r.width, height: r.height, channels: r.data.length / (r.width * r.height), bottomUp: true };
        } else if (bytes[0] === 0x50 && (bytes[1] === 0x46 || bytes[1] === 0x66)) img = readPfm(bytes);
        else {
            const bitmap = await createImageBitmap(new Blob([bytes]));
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const data = new Float32Array(bitmap.width * bitmap.height * 3);
            const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { data[j] = lin(px[i]); data[j + 1] = lin(px[i + 1]); data[j + 2] = lin(px[i + 2]); }
            img = { data, width: bitmap.width, height: bitmap.height, channels: 3, bottomUp: false };
        }
    } catch (err) {
        warn(`environment map ${file} could not be read (${err.message})`);
        return null;
    }
    if (img.width !== img.height) { warn(`environment map ${file} is not square (equal-area) – left out`); return null; }
    // our direction → light space: (Gᵀ, then the light's inverse)
    const Li = inverse(light.ctm);
    const toLight = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) toLight[3 * r + c] = Li[4 * r] * G[4 * c] + Li[4 * r + 1] * G[4 * c + 1] + Li[4 * r + 2] * G[4 * c + 2];
    }
    const width = Math.min(4096, Math.max(256, 2 * img.width));
    const eq = octahedralToEquirect(img, toLight, width);
    return { bytes: encodeRgbe(eq.width, eq.height, eq.data), name: file.split('/').pop().replace(/\.[^.]+$/, ''), illuminance: octahedralIlluminance(img) };
}

self.onmessage = async ({ data: msg }) => {
    try {
        const read = fileReader(msg);
        let files = 0;
        const scene = await parsePbrt(msg.mainPath, read, { onProgress: file => self.postMessage({ type: 'progress', phase: 'parse', file, done: ++files }) });
        const warn = text => scene.warnings.set(text, (scene.warnings.get(text) || 0) + 1);
        const { G, mirror, upAxis } = sceneTransform(scene.camera);
        const toRindr = mul(MMS, G);

        // shapes to build: loose ones and those of objects that are instanced
        const used = new Set(scene.instances.map(i => i.object));
        const shapeList = [];
        scene.shapes.forEach((s, i) => { if (s.object < 0 || used.has(s.object)) shapeList.push(i); });
        const geometries = [], transfer = [];
        const geometryOf = new Int32Array(scene.shapes.length).fill(-1);
        const plyCache = new Map();   // file + orientation → geometry index
        const emitters = [];
        const isEmitter = s => s.object < 0 && s.areaLight && s.areaLight.type === 'diffuse';
        // PLY files read ahead, several at a time (a scene folder holds thousands of small ones – one after the other
        // the fetches took most of the time), at most AHEAD files waiting
        const plyOrder = [...new Set(shapeList.map(si => scene.shapes[si]).filter(s => s.type === 'plymesh').map(s => s.params.filename?.v?.[0]).filter(Boolean))];
        const plyIndex = new Map(plyOrder.map((f, i) => [f, i]));
        const pending = new Map();
        let next = 0;
        const AHEAD = 24;
        const readPly = file => {
            const i = plyIndex.get(file);
            while (next < plyOrder.length && next <= i + AHEAD) { const f = plyOrder[next++]; pending.set(f, read(f).catch(() => null)); }
            const p = pending.get(file) ?? read(file).catch(() => null);
            pending.delete(file);
            return p;
        };
        let done = 0;
        for (const si of shapeList) {
            const s = scene.shapes[si];
            if (++done % 64 === 0) self.postMessage({ type: 'progress', phase: 'geometry', done, total: shapeList.length });
            const alpha = s.params.alpha;
            if (alpha?.type === 'float' && alpha.v[0] <= 0) continue;   // invisible
            const ply = s.type === 'plymesh' ? s.params.filename?.v?.[0] : null;
            const key = ply ? `${ply}|${s.reverse ? 1 : 0}` : null;
            if (key && plyCache.has(key) && !isEmitter(s)) { geometryOf[si] = plyCache.get(key); continue; }
            let bytes = null;
            if (ply) {
                bytes = await readPly(ply);
                if (!bytes) { warn(`PLY not found: ${ply}`); continue; }
            }
            let g;
            try { g = buildShape(s, bytes, warn); } catch (err) { warn(`shape ${s.type} could not be built (${err.message})`); continue; }
            if (!g) continue;
            // area lights that are real lights: flat rectangles, full discs, spheres (outside instances – pbrt ignores
            // area lights there)
            if (isEmitter(s)) {
                const shape = s.type === 'sphere' ? { kind: 'sphere' } : emitterShape(s, g);
                if (shape) {
                    const M = mul(toRindr, s.ctm);
                    if (shape.kind === 'sphere') {
                        const r = (s.params.radius?.v?.[0] ?? 1) * Math.cbrt(Math.abs(det3(M)));
                        emitters.push({ shape: si, kind: 'point', position: apply(M, [0, 0, 0]), radius: Math.abs(r) });
                    } else {
                        const c = apply(M, shape.center), u = apply(M, shape.u, 0), v = apply(M, shape.v, 0);
                        emitters.push({ shape: si, kind: shape.kind, position: c, u, v, normal: normalOf(M, shape.normal),
                            width: 2 * Math.hypot(...u), height: 2 * Math.hypot(...v) });
                    }
                    continue;
                }
            }
            geometryOf[si] = geometries.length;
            if (key && !isEmitter(s)) plyCache.set(key, geometries.length);
            geometries.push(g);
            for (const a of [g.positions, g.normals, g.uvs, g.index]) if (a) transfer.push(a.buffer);
        }
        // meshes: loose shapes, then every instance's shapes
        const objects = scene.objects.map(o => ({ name: o.name, shapes: o.shapes.filter(si => geometryOf[si] >= 0) }));
        let count = 0;
        scene.shapes.forEach((s, si) => { if (s.object < 0 && geometryOf[si] >= 0) count++; });
        for (const inst of scene.instances) count += objects[inst.object].shapes.length;
        const matrices = new Float32Array(count * 16), meshGeometry = new Int32Array(count), meshShape = new Int32Array(count), meshInstance = new Int32Array(count);
        let m = 0;
        scene.shapes.forEach((s, si) => {
            if (s.object >= 0 || geometryOf[si] < 0) return;
            colMajor(mul(toRindr, s.ctm), matrices, 16 * m);
            meshGeometry[m] = geometryOf[si]; meshShape[m] = si; meshInstance[m] = -1;
            m++;
        });
        scene.instances.forEach((inst, ii) => {
            const base = mul(toRindr, inst.ctm);
            for (const si of objects[inst.object].shapes) {
                colMajor(mul(base, scene.shapes[si].ctm), matrices, 16 * m);
                meshGeometry[m] = geometryOf[si]; meshShape[m] = si; meshInstance[m] = ii;
                m++;
            }
        });
        transfer.push(matrices.buffer, meshGeometry.buffer, meshShape.buffer, meshInstance.buffer);

        // grid media (smoke, clouds, fire: nanovdb files, uniformgrid) → dense 8-bit grids for the volume walk
        const volumes = [];
        for (const [name, medium] of Object.entries(scene.media)) {
            if (medium.type !== 'nanovdb' && medium.type !== 'uniformgrid') continue;
            self.postMessage({ type: 'progress', phase: 'volume', name });
            try {
                const v = await gridVolume(name, medium, read, toRindr, msg.volumeVoxels || 32e6);
                volumes.push(v);
                transfer.push(v.density.buffer, v.blocks.buffer);
                if (v.temperature) transfer.push(v.temperature.buffer);
            } catch (err) { warn(`medium "${name}" not read (${err.message})`); }
        }

        // camera in RINDR's space
        let camera = null;
        if (scene.camera) {
            const W = mul(toRindr, inverse(scene.camera.cameraFromWorld));
            const dir = v => { const d = apply(W, v, 0); const l = Math.hypot(...d) || 1; return d.map(x => x / l); };
            camera = { type: scene.camera.type, params: scene.camera.params, position: apply(W, [0, 0, 0]), forward: dir([0, 0, 1]), up: dir([0, 1, 0]) };
        }
        // lights: their matrix in RINDR's space (mm)
        const lights = [];
        let environment = null;
        for (const l of scene.lights) {
            if (l.type === 'infinite') {
                if (l.params.filename) {
                    if (environment?.bytes) { warn('more than one environment map – the first is used'); continue; }
                    self.postMessage({ type: 'progress', phase: 'environment' });
                    const env = await readEnvironment(l, read, G, warn);
                    if (env) { environment = { ...env, params: l.params }; transfer.push(env.bytes.buffer); }
                    continue;
                }
                if (!environment) environment = { params: l.params };
                continue;
            }
            lights.push({ type: l.type, params: l.params, matrix: Array.from(mul(toRindr, l.ctm)), name: l.name });
        }
        // what the main thread needs of the shapes (not their big arrays)
        const shapes = scene.shapes.map(s => ({
            type: s.type, material: s.material, name: s.name, object: s.object, file: s.file === msg.mainPath ? null : s.file,
            alpha: s.params.alpha ?? null, areaLight: s.object < 0 ? s.areaLight : null, media: s.media,
            ply: s.type === 'plymesh' ? s.params.filename?.v?.[0] ?? null : null,
        }));
        const textures = scene.textures.map(({ ctm, ...t }) => t);   // eslint-disable-line no-unused-vars
        self.postMessage({
            type: 'done',
            scene: {
                camera, film: scene.film, materials: scene.materials, namedMaterials: Object.fromEntries(scene.namedMaterials),
                textures, textureByName: { float: Object.fromEntries(scene.textureByName.float), spectrum: Object.fromEntries(scene.textureByName.spectrum) },
                shapes, objects: objects.map(o => ({ name: o.name })), instances: scene.instances.map(i => ({ object: i.object, name: i.name })),
                lights, emitters, environment, mirror, upAxis, media: scene.media, warnings: [...scene.warnings],
            },
            geometries,
            meshes: { count, matrices, geometry: meshGeometry, shape: meshShape, instance: meshInstance }, volumes,
        }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
