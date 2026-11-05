// pbrt-v4 scenes (.pbrt) → the import structure of mesh-importer.js ({ nodes, geometries, meshes, cameras, lights }) plus
// the scene's environment. Reading and geometry in a worker (pbrt-worker.js); here: materials and textures, lights,
// camera, Scene Graph. Details and decisions: docs/mesh-import.md "pbrt".
//
// Light in absolute units (pbrt: radiance in nits – rgb (1, 1, 1) and every normalised spectrum = 1 nit, the picture =
// radiance × ISO / 100 × shutter time): the lights keep their values (`absolute` – the viewer does not scale them to its
// default lights), the environment its scale, the camera view carries the film's exposure.
import * as THREE from 'three/webgpu';
import { boxProject, UV_TILE } from '../step-importer.js';
import { kelvinRgb } from '../kelvin.js';
import { normalizePath } from './pbrt-parse.js';
import { uniformHdr } from './pbrt-env.js';
import { spectrumToRgb, pairsFunction, readMeasured, blackbodyRgb } from './pbrt-spectrum.js';
import { textureMaxSide } from '../memory-budget.js';
import { colorFromAlbedo } from '../materials/medium.js';
import { minCopies } from '../model-instances.js';
import { gridVoxelBudget } from '../volumes/grid-volumes.js';
import { curvePieceBudget } from '../curves/curve-mesh.js';
import { withLook } from '../volumes/volume-look.js';
import { t, getLocale } from '../i18n.js';
import { debugLog } from '../log.js';

// --- spectra → RGB (own tables: published optical constants, rounded) ---

// normal-incidence reflectance (linear sRGB) of pbrt's named metals (eta/k pairs)
const METAL_F0 = {
    Au: [1.0, 0.766, 0.336], Ag: [0.972, 0.96, 0.915], Al: [0.913, 0.922, 0.924], Cu: [0.955, 0.638, 0.538],
    CuZn: [0.91, 0.778, 0.423], MgO: [0.074, 0.074, 0.074], TiO2: [0.21, 0.21, 0.21],
};
// pbrt's named glasses: refractive index at the d line, Abbe number (catalogue values)
const GLASS = {
    'glass-BK7': [1.5168, 64.17], 'glass-BAF10': [1.67, 47.11], 'glass-FK51A': [1.4866, 84.47], 'glass-LASF9': [1.8503, 32.17],
    'glass-F5': [1.6727, 32.21], 'glass-F10': [1.7283, 28.41], 'glass-F11': [1.7847, 25.68],
};
// standard illuminants as colour temperatures (CIE A, D series, fluorescent F1–F12 by their correlated temperature)
const ILLUMINANT_K = {
    'stdillum-A': 2856, 'stdillum-D50': 5003, 'stdillum-D65': 6504, 'illum-acesD60': 6000,
    'stdillum-F1': 6430, 'stdillum-F2': 4230, 'stdillum-F3': 3450, 'stdillum-F4': 2940, 'stdillum-F5': 6350, 'stdillum-F6': 4150,
    'stdillum-F7': 6500, 'stdillum-F8': 5000, 'stdillum-F9': 4150, 'stdillum-F10': 5000, 'stdillum-F11': 4000, 'stdillum-F12': 3000,
};
const luminance = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// pbrt's named subsurface media (Material "subsurface" "string name"): reduced scattering σs' and absorption σa in mm⁻¹,
// red/green/blue – the published measurements of Jensen, Marschner, Levoy & Hanrahan 2001 (table 2); pbrt multiplies
// them by "scale" and reads them per scene unit. Without a name and without coefficients pbrt takes whole milk.
const NAMED_MEDIA = {
    Apple: [[2.29, 2.39, 1.97], [0.0030, 0.0034, 0.046]],
    Chicken1: [[0.15, 0.21, 0.38], [0.015, 0.077, 0.19]],
    Chicken2: [[0.19, 0.25, 0.32], [0.018, 0.088, 0.20]],
    Cream: [[7.38, 5.47, 3.15], [0.0002, 0.0028, 0.0163]],
    Ketchup: [[0.18, 0.07, 0.03], [0.061, 0.97, 1.45]],
    Marble: [[2.19, 2.62, 3.00], [0.0021, 0.0041, 0.0071]],
    Potato: [[0.68, 0.70, 0.55], [0.0024, 0.0090, 0.12]],
    Skimmilk: [[0.70, 1.22, 1.90], [0.0014, 0.0025, 0.0142]],
    Skin1: [[0.74, 0.88, 1.01], [0.032, 0.17, 0.48]],
    Skin2: [[1.09, 1.59, 1.79], [0.013, 0.070, 0.145]],
    Spectralon: [[11.6, 20.4, 14.9], [0, 0, 0]],
    Wholemilk: [[2.55, 3.21, 3.77], [0.0011, 0.0024, 0.014]],
};
// a light's colour: Y = 1 (pbrt normalises every emission spectrum photometrically)
const unitY = c => { const y = luminance(c); return y > 0 ? c.map(x => x / y) : [1, 1, 1]; };
const fresnelF0 = (n, k) => ((n - 1) ** 2 + k * k) / ((n + 1) ** 2 + k * k);
const MAX_IOR = 3.5;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// diffuse reflectance of a dielectric boundary for light from inside (relative index η > 1; Egan & Hilgeman's fit)
const coatingFdr = eta => Math.min(Math.max(-1.440 / (eta * eta) + 0.710 / eta + 0.668 + 0.0636 * eta, 0), 0.99);   // RINDR's IOR range (material-manager.js) – a scene's diamonds at 3.39 keep their sparkle
const hex = c => '#' + new THREE.Color(Math.min(Math.max(c[0], 0), 1), Math.min(Math.max(c[1], 0), 1), Math.min(Math.max(c[2], 0), 1)).getHexString();

/**
 * @param {{ name: string, main?: Blob, files: {path, file}[], baseUrl?: string }} source
 * @returns {Promise<{ result, missing: Set<string> }>}
 */
export async function importPbrt(source, { materialManager, onStatus = () => {} }) {
    const t0 = performance.now();
    const { scene, geometries, meshes, volumes: gridVolumes, curvesThinned } = await runWorker(source, onStatus);
    debugLog('[pbrt] read', { ms: Math.round(performance.now() - t0), geometries: geometries.length, meshes: meshes.count, warnings: scene.warnings });
    onStatus(t('import.pbrt.materials'));
    const files = fileAccess(source);
    const missing = new Set();
    const spectra = await loadSpectra(scene, files, missing);
    const measured = await loadMeasured(scene, files, missing);
    const conv = new MaterialConverter(scene, files, missing, spectra, measured);
    const stem = source.name.split(/[\\/]/).pop().replace(/\.pbrt(\.gz)?$/i, '');

    // --- Scene Graph: the file, one node per name of the loose shapes (exporter's object name, else material, PLY file,
    // included file), one per object instance ---
    const nodes = [{ name: stem, parent: -1 }];
    const nodeByName = new Map();
    const materialName = ref => (typeof ref === 'string' ? ref.slice(2) : scene.materials[ref]?.name || '');
    const looseNode = shape => {
        const stemOf = (path, ext) => path?.split('/').pop().replace(ext, '');
        let name = shape.name || materialName(shape.material) || stemOf(shape.ply, /\.ply(\.gz)?$/i) || stemOf(shape.file, /\.pbrt(\.gz)?$/i) || t('import.mesh.unnamedMesh');
        if (shape.type === 'curves') name = t('import.curves.node', { name });   // hair/fur: a row of its own
        if (!nodeByName.has(name)) { nodeByName.set(name, nodes.length); nodes.push({ name, parent: 0 }); }
        return nodeByName.get(name);
    };
    const instanceNode = new Map();

    // --- materials per shape (material, alpha, emission) ---
    const materialIds = new Map();
    const materialFor = shape => {
        const key = `${shape.material}|${alphaKey(shape.alpha)}|${shape.areaLight ? JSON.stringify(shape.areaLight.params) : ''}|${shape.media || ''}`;
        if (!materialIds.has(key)) materialIds.set(key, conv.plan(shape));
        return materialIds.get(key);
    };
    const plans = [];
    const meshPlan = new Int32Array(meshes.count);
    for (let m = 0; m < meshes.count; m++) {
        const shape = scene.shapes[meshes.shape[m]];
        const plan = materialFor(shape);
        if (plan === null) { meshPlan[m] = -1; continue; }   // invisible (interface, index-matched glass, no material)
        if (!plans.includes(plan)) plans.push(plan);
        meshPlan[m] = plans.indexOf(plan);
    }
    // --- geometries (box UVs where the file has none – scaled as the first placement shows them) ---
    const firstMatrix = new Int32Array(geometries.length).fill(-1);
    for (let m = 0; m < meshes.count; m++) if (firstMatrix[meshes.geometry[m]] < 0) firstMatrix[meshes.geometry[m]] = m;
    const outGeometries = geometries.map((g, gi) => {
        const m = firstMatrix[gi];
        if (!g.uvs && m >= 0) {
            const M = new THREE.Matrix4().fromArray(meshes.matrices, 16 * m);
            const b = boxProject(g, UV_TILE / Math.max(M.getMaxScaleOnAxis(), 1e-12));
            return { positions: b.positions, normals: b.normals, index: b.index, uvs: b.uvs, name: '' };
        }
        return { positions: g.positions, normals: g.normals, index: g.index, uvs: g.uvs, tangents: g.tangents ?? null, curves: g.curves ?? null, name: '' };
    });

    // --- material definitions (bump maps: their relief height is set with the other importers' – mesh-importer.js
    // fitImportRelief, once the meshes are known) ---
    conv.mirror = !!scene.mirror;
    await conv.loadTextures(plans, onStatus);
    let origin = 0;
    const create = materialManager.importMaterials();   // copies of one material ("Wood.3", "Wood.4" …) become one
    const defIds = plans.map(plan => create({ ...conv.def(plan), source: 'import', origin: `import:${source.name}:${origin++}` }));

    // --- meshes. An object placed at least minCopies() times (vegetation: thousands of plants of 7–21 parts) –
    // one InstancedMesh per part for all its copies (model-instances.js), one Scene Graph row "name (n×)" ---
    const outMeshes = [];
    let instance = 0;
    const instanceId = new Map();
    const fromCopies = minCopies();
    const uses = new Int32Array(scene.objects.length);
    for (const ins of scene.instances) uses[ins.object]++;
    const objectNode = new Map(), objectId = new Map(), copied = new Map();   // object → node, instance id; shape → part
    for (let m = 0; m < meshes.count; m++) {
        if (meshPlan[m] < 0) continue;
        const si = meshes.shape[m], ii = meshes.instance[m];
        const shape = scene.shapes[si];
        const object = ii >= 0 ? scene.instances[ii].object : -1;
        if (object >= 0 && uses[object] >= fromCopies) {
            let part = copied.get(si);
            if (!part) {
                const name = scene.objects[object].name || t('import.mesh.unnamedMesh');
                if (!objectNode.has(object)) {
                    objectNode.set(object, nodes.length);
                    nodes.push({ name: t('import.mesh.instancedObject', { name, count: uses[object].toLocaleString(getLocale()) }), parent: 0 });
                    objectId.set(object, instance++);
                }
                part = { geometry: meshes.geometry[m], matrix: IDENTITY.slice(), instances: new Float32Array(uses[object] * 16), materialId: defIds[meshPlan[m]],
                    name, node: objectNode.get(object), instance: objectId.get(object), key: `o${object}/${si}`, copies: uses[object], filled: 0,
                    ...(geometries[meshes.geometry[m]].curves ? { curves: true } : {}) };
                copied.set(si, part);
                outMeshes.push(part);
            }
            part.instances.set(meshes.matrices.subarray(16 * m, 16 * m + 16), 16 * part.filled++);
            continue;
        }
        let node, inst;
        if (ii < 0) { node = looseNode(shape); inst = instance++; } else {
            if (!instanceNode.has(ii)) {
                const ins = scene.instances[ii];
                instanceNode.set(ii, nodes.length);
                nodes.push({ name: ins.name || scene.objects[ins.object].name, parent: 0 });
                instanceId.set(ii, instance++);
            }
            node = instanceNode.get(ii);
            inst = instanceId.get(ii);
        }
        outMeshes.push({ geometry: meshes.geometry[m], matrix: Array.from(meshes.matrices.subarray(16 * m, 16 * m + 16)), materialId: defIds[meshPlan[m]],
            name: nodes[node].name, node, instance: inst, key: String(m), ...(geometries[meshes.geometry[m]].curves ? { curves: true } : {}) });
    }
    for (const part of copied.values()) {
        if (part.filled * 16 < part.instances.length) part.instances = part.instances.slice(0, part.filled * 16);
        delete part.filled;
    }
    if (copied.size) debugLog('[pbrt] instanced objects', { objects: objectNode.size, parts: copied.size, copies: [...objectNode.keys()].reduce((a, o) => a + uses[o], 0), meshes: outMeshes.length });

    const lights = convertLights(scene, spectra);
    const cameras = scene.camera ? [convertCamera(scene, stem)] : [];
    const environment = convertEnvironment(scene, spectra, stem);
    const volumes = (gridVolumes || []).map(v => gridMedium(v, scene, spectra)).filter(Boolean);
    for (const v of volumes) {
        conv.usedMedia.add(v.name);
        v.node = nodes.length;   // an object of its own in the Scene Graph (its shape – Material "interface" – is not drawn)
        nodes.push({ name: t('import.volume.node', { name: v.name }), parent: 0 });
    }
    if (Object.keys(scene.media || {}).some(n => !conv.usedMedia.has(n))) scene.warnings.push(['media left out', 1]);
    const what = skippedWhat(scene);
    const render = renderSettings(plans, lights, environment);
    const result = { nodes, geometries: outGeometries, meshes: outMeshes, cameras, lights, environment, render, animation: null, activateCamera: true, volumes };
    if (what.length) result.pbrtSkipped = { what };
    if (curvesThinned) result.curvesThinned = curvesThinned;   // hair over the device's budget: every k-th kept
    debugLog('[pbrt] converted', { materials: plans.length, lights: lights.length, environment: environment && (environment.file ? 'map' : environment.off ? 'off' : 'uniform'), mirror: scene.mirror, up: scene.upAxis, render });
    return { result, missing };
}

/**
 * A grid medium for the volume walk (volumes/grid-volumes.js): grey extinction σt (luminance of σa + σs, × scale, at
 * the grid's maximum density, per mm – the medium's unit through its transform), RGB albedo σs / σt, g; fire: emission
 * table over the stored temperature – pbrt: T' = (T − offset) · scale, above 100 K Lescale × blackbody (normalised to
 * its peak), weighted by σa in the walk.
 */
function gridMedium(v, scene, spectra) {
    const p = scene.media?.[v.name]?.params;
    if (!p) return null;
    const sa = spectrumRgb(p.sigma_a, spectra) || [1, 1, 1], ss = spectrumRgb(p.sigma_s, spectra) || [1, 1, 1];
    const scale = p.scale?.v?.[0] ?? 1;
    const st = sa.map((a, i) => (a + ss[i]) * scale);
    const sigmaT = luminance(st);
    const albedo = st.map((x, i) => (x > 0 ? ss[i] * scale / x : 0));
    let emission = null;
    if (v.temperature && v.temperatureMax > 0) {
        const LeScale = p.Lescale?.v?.[0] ?? 1;
        const offset = p.temperatureoffset?.v?.[0] ?? p.temperaturecutoff?.v?.[0] ?? 0, tScale = p.temperaturescale?.v?.[0] ?? 1;
        emission = new Float32Array(3 * 32);
        for (let i = 0; i < 32; i++) {
            const T = (i / 31 * v.temperatureMax - offset) * tScale;
            if (T > 100) emission.set(blackbodyRgb(T).map(c => c * LeScale), 3 * i);
        }
    }
    debugLog('[pbrt] volume', { name: v.name, type: v.type, dims: v.dims, factor: v.factor, densityMax: +v.densityMax.toFixed(3), sigmaT, albedo, g: p.g?.v?.[0] ?? 0, emission: !!emission });
    // base = as pbrt describes it; the Properties panel edits a look on top (volume-look.js)
    return withLook({ ...v }, { sigma: sigmaT * v.densityMax / v.unitScale, albedo, g: Math.min(Math.max(p.g?.v?.[0] ?? 0, -0.95), 0.95), emission });
}

/**
 * Path tracing settings the scene needs to look as pbrt renders it (null = leave them): solid glass and something that
 * shines on it → caustics (pbrt's paths find the light focused through glass by themselves; RINDR's default lets it pass
 * straight) and more refractions on top of the bounces (pbrt traces up to its maxdepth – a gem whose light is reflected
 * inside again and again stayed dull after RINDR's 4); gems (IOR ≥ 2) the most. Thin glass passes light straight anyway.
 */
function renderSettings(plans, lights, environment) {
    const solid = plans.filter(p => p.params.transmission > 0 && !p.params.thinWalled);
    if (!solid.length) return null;
    const lit = lights.length > 0 || (environment && !environment.off) || plans.some(p => p.params.emissiveIntensity > 0);
    if (!lit) return null;
    const gem = solid.some(p => p.params.ior >= 2);
    return { glassShadow: 'caustics', refractionBounces: gem ? 16 : 8 };
}

function runWorker(source, onStatus) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./pbrt-worker.js', import.meta.url), { type: 'module', name: 'pbrt' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') {
                if (data.phase === 'parse') onStatus(t('import.pbrt.reading', { name: data.file.split('/').pop() }));
                else if (data.phase === 'geometry') onStatus(t('import.mesh.buildingGeometries'), data.done / data.total);
                else if (data.phase === 'volume') onStatus(t('import.pbrt.volume', { name: data.name }));
                else onStatus(t('import.pbrt.environment'));
                return;
            }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'pbrt worker failed')); };
        worker.postMessage({ mainPath: source.name.split(/[\\/]/).pop(), main: source.main || null, files: source.files || [], baseUrl: source.baseUrl ? new URL(source.baseUrl, location.href).href : null,
            volumeVoxels: gridVoxelBudget(), curvePieces: curvePieceBudget() });
    });
}

// files of the scene: the dropped ones (path relative to the main file, else by name), else next to the model's URL
function fileAccess(source) {
    const byPath = new Map(), byName = new Map();
    for (const { path, file } of source.files || []) {
        const p = normalizePath(path.replace(/\\/g, '/')).toLowerCase();
        byPath.set(p, file);
        byName.set(p.split('/').pop(), file);
    }
    const base = source.baseUrl ? new URL(source.baseUrl, location.href) : null;
    return async path => {
        const p = normalizePath(path.replace(/\\/g, '/')).toLowerCase();
        const blob = byPath.get(p) || (!base && byName.get(p.split('/').pop()));
        if (blob) return blob;
        if (!base) return null;
        const res = await fetch(new URL(normalizePath(path.replace(/\\/g, '/')).split('/').map(encodeURIComponent).join('/'), base)).catch(() => null);
        return res?.ok ? res.blob() : null;
    };
}

// spectrum files named by parameters ("spectrum eta" "spds/Au.eta.spd") – pairs of wavelength and value
async function loadSpectra(scene, files, missing) {
    const names = new Set();
    const visit = params => {
        for (const p of Object.values(params || {})) {
            if (p.type === 'spectrum' && typeof p.v[0] === 'string' && !isNamedSpectrum(p.v[0])) names.add(p.v[0]);
        }
    };
    scene.materials.forEach(m => visit(m.params));
    scene.lights.forEach(l => visit(l.params));
    scene.textures.forEach(tx => visit(tx.params));
    scene.shapes.forEach(s => visit(s.areaLight?.params));
    const out = new Map();
    for (const name of names) {
        const blob = await files(name);
        if (!blob) { missing.add(name); continue; }
        const nums = (await blob.text()).replace(/#[^\n]*/g, ' ').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
        out.set(name, nums);
    }
    return out;
}
// measured materials (tabulated BRDFs): colour and roughness read from their files (pbrt-spectrum.js)
async function loadMeasured(scene, files, missing) {
    const out = new Map();
    for (const m of scene.materials) {
        const file = m.type === 'measured' ? m.params.filename?.v?.[0] : null;
        if (!file || out.has(file)) continue;
        const blob = await files(file);
        if (!blob) { missing.add(file); out.set(file, null); continue; }
        try { out.set(file, readMeasured(await blob.arrayBuffer(), file)); } catch (err) { console.warn('[Import] pbrt: measured material not readable:', file, err.message); out.set(file, null); }
    }
    return out;
}
// pbrt's built-in spectra (not files): metals, glasses, illuminants, colour spaces, camera sensor curves (…_r/_g/_b)
const isNamedSpectrum = s => /^(metal-|glass-|stdillum-|illum-|ntsc|aces)/i.test(s) || /_[rgb]$/i.test(s);

// one spectrum parameter → RGB (reflectances: the value per channel; emission: Y = 1 with `unit`)
function spectrumRgb(p, spectra, { emission = false } = {}) {
    if (!p) return null;
    if (p.type === 'rgb') return [p.v[0], p.v[1], p.v[2]].map(x => x ?? 0);
    if (p.type === 'blackbody') return unitY(kelvinRgb(p.v[0] || 6500));
    if (p.type === 'spectrum') {
        const v = p.v[0];
        if (typeof v === 'string') {
            if (ILLUMINANT_K[v]) return unitY(kelvinRgb(ILLUMINANT_K[v]));
            const metal = /^metal-(\w+)-(eta|k)$/.exec(v);
            if (metal) return null;   // handled with its partner by the conductor
            if (GLASS[v]) return [GLASS[v][0], GLASS[v][0], GLASS[v][0]];
            const pairs = spectra.get(v);
            if (pairs) { const c = spectrumToRgb(pairsFunction(pairs)); return emission ? unitY(c) : c; }
            return null;
        }
        const c = spectrumToRgb(pairsFunction(p.v));
        return emission ? unitY(c) : c;
    }
    if (p.type === 'float') return [p.v[0], p.v[0], p.v[0]];
    return null;
}

const alphaKey = a => (!a ? '' : a.type === 'texture' ? 't:' + a.v[0] : String(a.v[0]));

// --- materials ---

class MaterialConverter {
    constructor(scene, files, missing, spectra, measured) {
        this.scene = scene;
        this.measured = measured;
        this.usedMedia = new Set();   // media taken over as glass tint – the others (fog, smoke) are left out
        this.files = files;
        this.missing = missing;
        this.spectra = spectra;
        this.images = new Map();     // file → Promise<HTMLImageElement | null>
        this.textures = new Map();   // key → THREE.Texture
        this.unnamed = 0;
    }
    materialIndex(ref) {
        if (typeof ref === 'string') return this.scene.namedMaterials[ref.slice(2)] ?? -1;
        return ref ?? -1;
    }
    // --- textures (as plans: { value, image } – the image as a description, loaded later) ---
    texture(name, kind, depth = 0) {
        const idx = this.scene.textureByName[kind]?.[name] ?? this.scene.textureByName[kind === 'float' ? 'spectrum' : 'float']?.[name];
        const tx = idx !== undefined ? this.scene.textures[idx] : null;
        const one = kind === 'float' ? 1 : [1, 1, 1];
        if (!tx || depth > 8) return { value: one, image: null };
        const p = tx.params;
        const sub = (key, def) => this.param(p, key, kind, def, depth + 1);
        switch (tx.type) {
            case 'imagemap': {
                const file = p.filename?.v?.[0];
                if (!file) return { value: one, image: null };
                const s = p.scale?.v?.[0] ?? 1;
                const encoding = p.encoding?.v?.[0] || 'sRGB';
                return {
                    value: kind === 'float' ? s : [s, s, s],
                    image: { file, encoding, wrap: p.wrap?.v?.[0] || 'repeat', invert: !!p.invert?.v?.[0],
                        uscale: p.uscale?.v?.[0] ?? 1, vscale: p.vscale?.v?.[0] ?? 1, udelta: p.udelta?.v?.[0] ?? 0, vdelta: p.vdelta?.v?.[0] ?? 0,
                        mapping: p.mapping?.v?.[0] || 'uv' },
                };
            }
            case 'scale': {
                const a = sub('tex', kind === 'float' ? 1 : [1, 1, 1]), b = this.param(p, 'scale', 'float', 1, depth + 1);
                return { value: times(a.value, b.value), image: a.image || b.image };
            }
            case 'mix': case 'directionmix': {
                const a = sub('tex1', kind === 'float' ? 0 : [0, 0, 0]), b = sub('tex2', kind === 'float' ? 1 : [1, 1, 1]);
                const amount = tx.type === 'mix' ? this.param(p, 'amount', 'float', 0.5, depth + 1) : { value: 0.5 };
                const w = typeof amount.value === 'number' ? amount.value : 0.5;
                return { value: lerp(a.value, b.value, w), image: (w >= 0.5 ? b.image || a.image : a.image || b.image) };
            }
            case 'constant': return { value: this.param(p, 'value', kind, one, depth + 1).value, image: null };
            case 'checkerboard': case 'dots': {
                const a = sub(tx.type === 'dots' ? 'inside' : 'tex1', one), b = sub(tx.type === 'dots' ? 'outside' : 'tex2', kind === 'float' ? 0 : [0, 0, 0]);
                return { value: lerp(a.value, b.value, 0.5), image: null };
            }
            case 'bilerp': {
                const vals = ['v00', 'v01', 'v10', 'v11'].map((k, i) => sub(k, kind === 'float' ? i % 2 : [i % 2, i % 2, i % 2]).value);
                return { value: vals.reduce((acc, v) => lerp(acc, v, 0.5)), image: null };
            }
            default:   // fbm, wrinkled, windy, marble, ptex: their mean
                return { value: kind === 'float' ? 0.5 : [0.5, 0.5, 0.5], image: null };
        }
    }
    /** a material / texture parameter: { value (number or rgb), image } */
    param(params, key, kind, def, depth = 0) {
        const p = params?.[key];
        if (!p) return { value: def, image: null };
        if (p.type === 'texture') return this.texture(p.v[0], kind, depth);
        if (kind === 'float') return { value: typeof p.v[0] === 'number' ? p.v[0] : def, image: null };
        const c = spectrumRgb(p, this.spectra);
        return { value: c || def, image: null };
    }

    // --- one shape's material → plan { name, params, maps: { slot: { image, use, lut } }, render } (null = not drawn) ---
    plan(shape) {
        const index = this.materialIndex(shape.material);
        const mat = index >= 0 ? this.scene.materials[index] : { type: 'diffuse', params: {}, name: '' };
        const plan = this.planMaterial(mat, 0);
        if (!plan) return null;
        // alpha of the shape: a mask (cut-out) or a constant
        const a = shape.alpha;
        if (a) {
            if (a.type === 'texture') {
                const tx = this.texture(a.v[0], 'float');
                if (tx.image) { plan.maps.alphaMap = { image: tx.image, use: 'float', scale: typeof tx.value === 'number' ? tx.value : 1 }; plan.render.alphaTest = 0.5; }
                else if (tx.value < 1) Object.assign(plan.params, { opacity: Math.max(tx.value, 0) });
            } else if (a.v[0] < 1) { plan.params.opacity = Math.max(a.v[0], 0); plan.render.transparent = true; }
        }
        // glass with a homogeneous medium inside (gems, coloured liquids): its absorption and scattering as RINDR's tint
        // and turbidity (OpenPBR transmission colour / depth / scatter: μt = −ln(colour) / depth, μs = scatter / depth)
        if (plan.params.transmission > 0 && shape.media) {
            const name = shape.media.find(n => this.scene.media?.[n]?.type === 'homogeneous');
            const medium = name ? this.scene.media[name] : null;
            if (medium) {
                this.usedMedia.add(name);
                const mp = medium.params, sc = mp.scale?.v?.[0] ?? 1;
                const sa = (spectrumRgb(mp.sigma_a, this.spectra) || [1, 1, 1]).map(x => Math.max(x * sc, 0) / 1000);   // per mm
                const ss = (spectrumRgb(mp.sigma_s, this.spectra) || [1, 1, 1]).map(x => Math.max(x * sc, 0) / 1000);
                const st = sa.map((a, i) => a + ss[i]), most = Math.max(...st);
                if (most > 0) {
                    const depth = 1 / most;
                    Object.assign(plan.params, { attenuationColor: hex(st.map(x => Math.exp(-x * depth))), attenuationDistance: depth });
                    if (Math.max(...ss) > 0) plan.params.transmissionScatter = hex(ss.map(x => Math.min(x * depth, 1)));
                }
            }
        }
        // emitting shape that is no real light (pbrt: diffuse area light – one-sided; the material stays as is)
        if (shape.areaLight) {
            const { color, intensity } = emission(shape.areaLight.params, 'L', this.spectra);
            if (intensity > 0) { plan.params.emissive = hex(color); plan.params.emissiveIntensity = intensity; }
        }
        return plan;
    }
    planMaterial(mat, depth) {
        const p = mat.params;
        const params = { metalness: 0, roughness: 0.5, specularIntensity: 1, ior: 1.5 };
        const maps = {};
        const render = { side: THREE.DoubleSide, alphaTest: 0, transparent: false, normalScale: null, bumpScale: 1, aoMapIntensity: 1, vertexColors: false };
        const name = mat.name || t('import.mesh.unnamedMaterial', { number: ++this.unnamed });
        const color = (key, def) => {
            const c = this.param(p, key, 'spectrum', def);
            const v = Array.isArray(c.value) ? c.value : [c.value, c.value, c.value];
            params.color = hex(v);
            if (c.image) { maps.map = { image: c.image, use: 'color' }; }
            return v;
        };
        // roughness: pbrt's (remapped: α = √r, else α = r) → RINDR's (α = r²); anisotropic as RINDR's mapping
        const rough = (prefix = '', target = 'roughness') => {
            const remap = p.remaproughness?.v?.[0] ?? true;
            const base = this.param(p, prefix + 'roughness', 'float', 0);
            const u = p[prefix + 'uroughness'] ? this.param(p, prefix + 'uroughness', 'float', 0) : base;
            const v = p[prefix + 'vroughness'] ? this.param(p, prefix + 'vroughness', 'float', 0) : base;
            const alpha = x => Math.max(remap ? Math.sqrt(Math.max(x, 0)) : Math.max(x, 0), 0);
            if (u.image && target === 'roughness') {
                params.roughness = 1;
                maps.roughnessMap = { image: u.image, use: 'float', scale: typeof u.value === 'number' ? u.value : 1, curve: remap ? 0.25 : 0.5 };
                return;
            }
            const au = alpha(u.value), av = alpha(v.value);
            const lo = Math.min(au, av), hi = Math.max(au, av);
            params[target] = Math.min(Math.sqrt(lo), 1);
            if (target === 'roughness' && hi - lo > 1e-4 && lo < 1) {
                params.anisotropy = Math.min(Math.sqrt((Math.min(hi, 1) - lo) / (1 - lo)), 1);
                params.anisotropyRotation = au > av ? 0 : 90;
            }
        };
        // normal map, else bump (displacement texture) – as pbrt: the normal map wins. The bump is the import graph's
        // relief like any importer's bump map (material-graph.js IMPORT_SLOTS): baked into a normal map – the path
        // tracer has no bump mapping (a mirror-smooth metal with an embossed pattern showed only a plain reflection in
        // HQ) – with pbrt's own height: the texture's value is a displacement in scene units (→ mm), its slopes over the
        // meshes' surface length per texture unit (graph-apply.js reliefSlopes); editable as "Relief (mm)"
        const surface = () => {
            const nm = p.normalmap?.v?.[0];
            if (nm) { maps.normalMap = { image: { file: nm, encoding: 'linear', wrap: 'repeat', uscale: 1, vscale: 1, udelta: 0, vdelta: 0 }, use: 'data' }; render.normalScale = [1, 1]; return; }
            const d = p.displacement;
            if (d?.type === 'texture') {
                const tx = this.texture(d.v[0], 'float');
                if (tx.image) { maps.bumpMap = { image: tx.image, use: 'height' }; render.bumpHeight = (typeof tx.value === 'number' ? tx.value : 1) * 1000; }
            }
        };
        switch (mat.type) {
            case 'diffuse':
                color('reflectance', [0.5, 0.5, 0.5]);
                Object.assign(params, { roughness: 1, specularIntensity: 0 });
                break;
            case 'coateddiffuse': {
                // diffuse base under a dielectric interface = plastic: the interface is the base's specular layer. Light
                // inside the coating is partly reflected back onto the base (diffuse internal reflectance Fdr) – the base
                // shows darker: albedo R (1 − Fdr) / (1 − R Fdr), the entry Fresnel left to RINDR's specular layer.
                // A velvet of 0.15 red shows as ~0.07 (pbrt's layered BSDF; it was twice as strong)
                const r = color('reflectance', [0.5, 0.5, 0.5]);
                rough();
                params.ior = Math.min(Math.max(this.param(p, 'eta', 'float', 1.5).value || 1.5, 1), MAX_IOR);
                const fdr = coatingFdr(params.ior);
                const under = x => Math.max(x, 0) * (1 - fdr) / (1 - Math.min(Math.max(x, 0), 1) * fdr);
                // a picture's texels: the factor at a middle reflectance (the colour multiplies the picture)
                params.color = hex(maps.map ? r.map(x => x * under(0.5) / 0.5) : r.map(under));
                break;
            }
            case 'conductor':
                params.metalness = 1;
                this.metal(p, '', params, maps);
                rough();
                break;
            case 'coatedconductor':
                params.metalness = 1;
                this.metal(p, 'conductor.', params, maps);
                rough('conductor.');
                params.clearcoat = 1;
                rough('interface.', 'clearcoatRoughness');
                params.clearcoatIor = Math.min(Math.max(this.param(p, 'interface.eta', 'float', 1.5).value || 1.5, 1), 3);
                break;
            case 'dielectric': case 'thindielectric': {
                const eta = p.eta;
                let ior = 1.5, abbe = 0;
                if (eta?.type === 'spectrum' && typeof eta.v[0] === 'string' && GLASS[eta.v[0]]) [ior, abbe] = GLASS[eta.v[0]];
                else if (eta?.type === 'spectrum') {
                    const pairs = typeof eta.v[0] === 'string' ? this.spectra.get(eta.v[0]) : eta.v;
                    if (pairs?.length) {
                        const n = pairsFunction(pairs);
                        ior = n(587.6);
                        const dn = n(486.1) - n(656.3);
                        abbe = dn > 1e-6 ? (ior - 1) / dn : 0;
                    }
                }
                else if (eta) ior = this.param(p, 'eta', 'float', 1.5).value;
                if (Math.abs(ior - 1) < 1e-4) return null;   // index-matched: only a boundary of a medium
                Object.assign(params, { color: '#ffffff', transmission: 1, ior: Math.min(Math.max(ior, 1), MAX_IOR) });
                if (abbe > 0) Object.assign(params, { dispersion: 1, dispersionAbbe: Math.min(Math.max(abbe, 2), 91) });
                if (mat.type === 'thindielectric') params.thinWalled = 1;
                rough();
                break;
            }
            case 'diffusetransmission': {
                // leaves, paper: diffuse in its reflectance (the transmitted part has no counterpart without media)
                const r = this.param(p, 'reflectance', 'spectrum', [0.25, 0.25, 0.25]), s = this.param(p, 'scale', 'float', 1).value;
                const v = (Array.isArray(r.value) ? r.value : [r.value, r.value, r.value]).map(x => x * s);
                params.color = hex(v);
                if (r.image) maps.map = { image: r.image, use: 'color' };
                Object.assign(params, { roughness: 1, specularIntensity: 0 });
                break;
            }
            case 'subsurface': {
                const refl = this.param(p, 'reflectance', 'spectrum', null);
                const mfp = this.param(p, 'mfp', 'spectrum', null);
                const g = this.param(p, 'g', 'float', 0).value;
                let c = refl.value, radius = 2;
                if (!c) {
                    // from the coefficients (named medium, or σa/σs; × scale, per scene unit = m): RINDR's subsurface
                    // colour is the observed one after many scatterings – the single-scattering albedo σs / (σs + σa)
                    // through the forward van de Hulst relation (as OpenPBR; materials/medium.js); radius = mean free
                    // path of red 1 / (σs + σa) in mm. Before: the name was not read (whole milk – white), the albedo
                    // itself as the colour (far too light) and the path in metres taken as mm (opaque)
                    const named = NAMED_MEDIA[p.name?.v?.[0]];
                    if (p.name?.v?.[0] && !named) this.scene.warnings.push([`subsurface medium "${p.name.v[0]}" unknown – whole milk`, 1]);
                    const [ssDefault, saDefault] = named || NAMED_MEDIA.Wholemilk;
                    const sa = (!named && spectrumRgb(p.sigma_a, this.spectra)) || saDefault, ss = (!named && spectrumRgb(p.sigma_s, this.spectra)) || ssDefault;
                    const sc = p.scale?.v?.[0] ?? 1;
                    c = sa.map((a, i) => colorFromAlbedo(ss[i] / Math.max(ss[i] + a, 1e-9), g));
                    radius = 1000 / Math.max((sa[0] + ss[0]) * sc, 1e-9);
                } else if (mfp.value) radius = (Array.isArray(mfp.value) ? mfp.value[0] : mfp.value) * 1000;
                params.color = hex(c);
                // the accurate (random walk) mode: pbrt traces the medium itself
                Object.assign(params, { subsurface: 1, subsurfaceColor: hex(c), subsurfaceRadius: Math.min(Math.max(radius, 0.05), 1000), subsurfaceMode: 1,
                    subsurfaceAnisotropy: Math.min(Math.max(g, -0.9), 0.9), ior: this.param(p, 'eta', 'float', 1.33).value });
                if (refl.image) maps.map = { image: refl.image, use: 'color' };
                rough();
                break;
            }
            case 'hair': {
                // hair fibres (curves – cylinders in the path tracer): the colour hair shows after many passes through its
                // fibres – given (`color`, as pbrt takes it) or from the absorption σa (melanin concentrations × the
                // published pigment absorptions, or given) by the published fit of Chiang et al. 2016: colour =
                // exp(−√σa · f(β_n))
                const e = p.eumelanin?.v?.[0] ?? (p.sigma_a || p.reflectance || p.color ? 0 : 1.3), ph = p.pheomelanin?.v?.[0] ?? 0;
                let c = p.reflectance ? spectrumRgb(p.reflectance, this.spectra) : p.color ? spectrumRgb(p.color, this.spectra) : null;
                if (!c) {
                    const sa = p.sigma_a ? spectrumRgb(p.sigma_a, this.spectra) : [0.419, 0.697, 1.37].map((x, i) => e * x + ph * [0.187, 0.4, 1.05][i]);
                    const bn = p.beta_n?.v?.[0] ?? 0.3;
                    const f = 5.969 - 0.215 * bn + 2.532 * bn ** 2 - 10.73 * bn ** 3 + 5.574 * bn ** 4 + 0.245 * bn ** 5;
                    c = sa.map(x => Math.exp(-Math.sqrt(Math.max(x, 0)) * f));
                }
                params.color = hex(c);
                // the hair model (curves/hair-bsdf.js) reads β_m from the roughness, β_n from the sheen roughness, η from the IOR
                Object.assign(params, { roughness: Math.min(Math.max(p.beta_m?.v?.[0] ?? 0.3, 0.02), 1), sheen: 0,
                    sheenRoughness: Math.min(Math.max(p.beta_n?.v?.[0] ?? 0.3, 0.05), 1), ior: p.eta?.v?.[0] ?? 1.55 });
                break;
            }
            case 'measured': {
                // tabulated BRDF: albedo at normal incidence and the width of its microfacet distribution (the file's
                // own description text is not taken over)
                const r = this.measured.get(p.filename?.v?.[0]);
                if (r) Object.assign(params, { color: hex(r.color), roughness: r.roughness, metalness: r.metal ? 1 : 0 });
                else Object.assign(params, { color: '#808080', roughness: 0.4 });
                // colour-shift material (wrap film, interference paint): the fitted thin film on its specular, the base
                // index the fit chose (pbrt-spectrum.js readMeasured)
                if (r?.film) Object.assign(params, { iridescence: 1, iridescenceThickness: r.film.thickness, iridescenceIOR: r.film.ior, ior: r.film.baseIor });
                break;
            }
            case 'mix': {
                // two named materials by amount: a fixed amount blends their values, a texture takes the first
                const names = p.materials?.v || [];
                const amount = this.param(p, 'amount', 'float', 0.5);
                const w = amount.image ? 0 : Math.min(Math.max(amount.value, 0), 1);
                const sub = names.map(n => this.scene.namedMaterials[n]).map(i => (i !== undefined && depth < 8 ? this.planMaterial(this.scene.materials[i], depth + 1) : null));
                const [a, b] = sub;
                if (!a && !b) return null;
                if (!a || !b || w <= 0.02 || w >= 0.98) { const pick = (w >= 0.5 ? b : a) || a || b; return { ...pick, name }; }
                const blended = { ...a.params };
                for (const [k, v] of Object.entries(b.params)) {
                    const x = a.params[k];
                    if (typeof v === 'number' && typeof x === 'number') blended[k] = x * (1 - w) + v * w;
                    else if (typeof v === 'string' && typeof x === 'string' && v[0] === '#') blended[k] = '#' + new THREE.Color(x).lerp(new THREE.Color(v), w).getHexString();
                    else if (x === undefined) blended[k] = v;
                }
                return { name, params: blended, maps: { ...b.maps, ...a.maps }, render: a.render };
            }
            case 'interface': case '': case 'none':
                return null;
            default:
                color('reflectance', [0.5, 0.5, 0.5]);
                params.roughness = 0.6;
        }
        surface();
        return { name, params, maps, render };
    }
    // metal colour: reflectance, or eta / k (named metals, spectrum files, pairs) → reflectance at normal incidence
    metal(p, prefix, params, maps) {
        const refl = p[prefix + 'reflectance'];
        if (refl) {
            const c = this.param(p, prefix + 'reflectance', 'spectrum', [0.9, 0.9, 0.9]);
            params.color = hex(Array.isArray(c.value) ? c.value : [c.value, c.value, c.value]);
            if (c.image) maps.map = { image: c.image, use: 'color' };
            return;
        }
        const eta = p[prefix + 'eta'], k = p[prefix + 'k'];
        const named = v => (typeof v === 'string' ? /^metal-(\w+)-(eta|k)$/.exec(v)?.[1] : null);
        const metalName = named(eta?.v?.[0]) || named(k?.v?.[0]) || (!eta && !k ? 'Cu' : null);   // pbrt: copper by default
        if (metalName && METAL_F0[metalName] && (!eta || named(eta.v[0])) && (!k || named(k.v[0]))) { params.color = hex(METAL_F0[metalName]); return; }
        const fn = (q, def) => {
            if (q?.type === 'float') { const x = q.v[0]; return [() => x, [x, x, x]]; }
            if (q?.type === 'rgb') return [() => q.v[1], [q.v[0], q.v[1], q.v[2]]];
            const pairs = q?.type === 'spectrum' ? (typeof q.v[0] === 'string' ? this.spectra.get(q.v[0]) : q.v) : null;
            return pairs?.length ? [pairsFunction(pairs), null] : [() => def, null];
        };
        const [nf, nRgb] = fn(eta, 0.27), [kf, kRgb] = fn(k, 2.8);
        if (nRgb || kRgb) {   // per channel
            const nn = nRgb || [nf(630), nf(532), nf(465)], kk = kRgb || [kf(630), kf(532), kf(465)];
            params.color = hex(nn.map((x, i) => fresnelF0(x, kk[i])));
        } else params.color = hex(spectrumToRgb(l => fresnelF0(nf(l), kf(l))));
    }

    // --- textures: load the images the plans name, then the THREE textures per use ---
    async loadTextures(plans, onStatus) {
        const files = [...new Set(plans.flatMap(plan => Object.values(plan.maps).map(m => m.image.file)))];
        if (!files.length) return;
        // at most the side the device's memory budget allows for this many pictures (as the USD import), flipped while
        // decoding (pbrt's texture coordinates start bottom left); a few at a time – a decoded 4K image takes ~64 MB
        const maxSide = textureMaxSide(files.length);
        let done = 0, next = 0;
        const worker = async () => {
            while (next < files.length) {
                const file = files[next++];
                this.images.set(file, await this._image(file, maxSide));
                onStatus(t('import.pbrt.materials'), ++done / files.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
    }
    async _image(file, maxSide) {
        const blob = await this.files(file);
        if (!blob) { this.missing.add(file); return null; }
        try {
            const probe = await createImageBitmap(blob);
            const s = Math.min(1, maxSide / Math.max(probe.width, probe.height));
            const w = Math.max(1, Math.round(probe.width * s)), h = Math.max(1, Math.round(probe.height * s));
            probe.close();
            return await createImageBitmap(blob, { imageOrientation: 'flipY', ...(s < 1 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : {}) });
        } catch {
            console.warn('[Import] pbrt: texture could not be read:', file);
            this.missing.add(file);
            return null;
        }
    }
    /** plan → material definition of the MaterialManager (textures of loaded images; missing ones remembered by slot) */
    def(plan) {
        const maps = {}, missing = {};
        for (const [slot, m] of Object.entries(plan.maps)) {
            const tex = this._threeTexture(m);
            if (tex) maps[slot] = tex;
            else if (slot === 'map' || slot === 'bumpMap' || (slot === 'normalMap' && m.use === 'data')) {
                const srgb = m.use === 'color' || (m.use === 'height' && /^srgb$/i.test(m.image.encoding || 'sRGB'));
                missing[slot] = { url: m.image.file, srgb, flipY: true, repeat: [m.image.uscale, m.image.vscale], offset: [m.image.udelta, m.image.vdelta], rotation: 0 };
            }
        }
        // mirrored world: the relief baked for the bump map turns its v slope (see the 'data' normal maps below)
        return { name: plan.name, params: plan.params, render: { ...plan.render, alphaTest: maps.alphaMap ? plan.render.alphaTest : 0, maps, missing: Object.keys(missing).length ? missing : null,
            ...(this.mirror && plan.maps.bumpMap ? { mirrored: true } : {}) } };
    }
    _threeTexture(m) {
        const img = this.images.get(m.image.file);
        if (!img) return null;
        const { encoding, wrap, uscale, vscale, udelta, vdelta, invert } = m.image;
        const key = JSON.stringify([m.image, m.use, m.scale ?? 1, m.curve ?? 1]);
        if (this.textures.has(key)) return this.textures.get(key);
        let tex;
        const gamma = /^gamma\s+([\d.]+)/i.exec(encoding)?.[1];
        const srgb = /^srgb$/i.test(encoding) || (gamma && +gamma >= 1.8);
        // the picture's pixels on a canvas of its own, written back as the texture
        const canvasOf = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            return { canvas, data, done: () => { ctx.putImageData(data, 0, 0); return new THREE.CanvasTexture(canvas); } };
        };
        // pbrt's value of a texel: the first channel, decoded by the image's encoding, × scale (+ the parameter's curve)
        const decode = (i, curve) => {
            let v = i / 255;
            v = srgb && !gamma ? (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) : v ** (gamma ? +gamma : 1);
            if (invert) v = 1 - v;
            v *= m.scale ?? 1;
            return curve ? Math.max(v, 0) ** curve : v;
        };
        if (m.use === 'color') {
            tex = new THREE.Texture(img);
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        } else if (m.use === 'data' && !this.mirror) {
            tex = new THREE.Texture(img);
            tex.colorSpace = THREE.NoColorSpace;
        } else if (m.use === 'data') {
            // mirrored world (see pbrt-worker sceneTransform): the renderers build the bitangent as normal × tangent, which
            // the mirror turns against the texture's v – the map's green flipped keeps the relief the right way up
            const c = canvasOf(), px = c.data.data;
            for (let i = 1; i < px.length; i += 4) px[i] = 255 - px[i];
            tex = c.done();
            tex.colorSpace = THREE.NoColorSpace;
        } else if (m.use === 'height' && !invert && (!gamma || srgb)) {
            // bump height: the picture as it is, sRGB decoded on the GPU (full precision – a decoded 8-bit copy lost the
            // dark steps); the relief bake reads its first channel
            tex = new THREE.Texture(img);
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        } else {
            // values (roughness, alpha): baked into a grey image (three reads roughness from G, the path tracer too)
            const c = canvasOf(), px = c.data.data;
            const lut = new Uint8Array(256).map((_, i) => Math.round(Math.min(Math.max(decode(i, m.curve), 0), 1) * 255));
            for (let i = 0; i < px.length; i += 4) { const v = lut[px[i]]; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
            tex = c.done();
            tex.colorSpace = THREE.NoColorSpace;
        }
        tex.flipY = false;   // flipped while decoding
        tex.userData.flippedImage = true;   // previews turn it back (node editor)
        tex.name = m.image.file.split('/').pop();
        tex.userData.sourceUrl = m.image.file;
        tex.wrapS = tex.wrapT = wrap === 'clamp' || wrap === 'black' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        tex.repeat.set(uscale, vscale);
        tex.offset.set(udelta, vdelta);
        tex.needsUpdate = true;
        this.textures.set(key, tex);
        return tex;
    }
}
const times = (a, b) => (Array.isArray(a) ? a.map(x => x * (Array.isArray(b) ? 1 : b)) : a * (typeof b === 'number' ? b : 1));
const lerp = (a, b, w) => (Array.isArray(a) || Array.isArray(b)
    ? [0, 1, 2].map(i => (Array.isArray(a) ? a[i] : a) * (1 - w) + (Array.isArray(b) ? b[i] : b) * w)
    : a * (1 - w) + b * w);

// --- lights ---

// emission of a light: colour (max 1) and intensity in the light's photometric unit (pbrt: × scale, Y-normalised spectra)
function emission(params, key, spectra) {
    const p = params[key];
    const scale = params.scale?.v?.[0] ?? 1;
    let c = p ? spectrumRgb(p, spectra, { emission: true }) : null;
    if (!c) c = [1, 1, 1];
    const m = Math.max(...c, 1e-12);
    return { color: c.map(x => x / m), intensity: scale * m };
}

function convertLights(scene, spectra) {
    const out = [];
    const M = arr => new THREE.Matrix4().set(...arr);   // row-major from the worker
    const pt = (m, p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
    const light = (name, kind, position, direction, rest) => ({ name, kind, position: position.toArray(), direction: direction.toArray(), target: null, absolute: true,
        angle: null, penumbra: null, width: null, height: null, radius: null, ...rest });
    scene.lights.forEach((l, i) => {
        const m = M(l.matrix), p = l.params;
        const v3 = (key, def) => (p[key]?.v?.length >= 3 ? [p[key].v[0], p[key].v[1], p[key].v[2]] : def);
        const name = l.name || `${l.type} ${i + 1}`;
        const power = p.power?.v?.[0] ?? 0;
        if (l.type === 'point' || l.type === 'goniometric') {
            const { color, intensity } = emission(p, 'I', spectra);
            out.push(light(name, 'point', pt(m, v3('from', [0, 0, 0])), new THREE.Vector3(0, -1, 0), { color, intensity: power > 0 ? (p.scale?.v?.[0] ?? 1) * power / (4 * Math.PI) : intensity, unit: 'candela' }));
        } else if (l.type === 'spot' || l.type === 'projection') {
            const { color, intensity } = emission(p, 'I', spectra);
            const from = pt(m, v3('from', [0, 0, 0])), to = pt(m, v3('to', [0, 0, 1]));
            const cone = l.type === 'spot' ? p.coneangle?.v?.[0] ?? 30 : (p.fov?.v?.[0] ?? 90) / 2;
            const delta = l.type === 'spot' ? p.conedeltaangle?.v?.[0] ?? 5 : 1;
            const cosEnd = Math.cos(cone * Math.PI / 180), cosStart = Math.cos(Math.max(cone - delta, 0) * Math.PI / 180);
            const I = power > 0 ? (p.scale?.v?.[0] ?? 1) * power / (2 * Math.PI * (1 - 0.5 * (cosStart + cosEnd))) : intensity;
            out.push({ ...light(name, 'spot', from, to.clone().sub(from).normalize(), { color, intensity: I, unit: 'candela', angle: cone, penumbra: Math.min(Math.max(delta / Math.max(cone, 1e-3), 0), 1) }), target: to.toArray() });
        } else if (l.type === 'distant') {
            const { color, intensity } = emission(p, 'L', spectra);
            const e = p.illuminance?.v?.[0];
            const dir = pt(m, v3('to', [0, 0, 1])).sub(pt(m, v3('from', [0, 0, 0]))).normalize();
            out.push(light(name, 'directional', new THREE.Vector3(), dir, { color, intensity: e > 0 ? (p.scale?.v?.[0] ?? 1) * e : intensity, unit: 'lux' }));
        }
    });
    // area lights that are rectangles, discs or spheres
    for (const e of scene.emitters) {
        const shape = scene.shapes[e.shape];
        const p = shape.areaLight.params;
        const { color, intensity } = emission(p, 'L', spectra);
        const twoSided = !!p.twosided?.v?.[0];
        const name = shape.name || t('import.pbrt.areaLight');
        const power = p.power?.v?.[0] ?? 0;
        const areaM2 = e.kind === 'point' ? 4 * Math.PI * (e.radius / 1000) ** 2 : e.width * e.height * (e.kind === 'disc' ? Math.PI / 4 : 1) / 1e6;
        const L = power > 0 ? (p.scale?.v?.[0] ?? 1) * power / (Math.PI * (twoSided ? 2 : 1) * Math.max(areaM2, 1e-12)) : intensity;
        if (e.kind === 'point') {
            // a glowing sphere seen from afar: luminance × its cross-section
            out.push(light(name, 'point', new THREE.Vector3(...e.position), new THREE.Vector3(0, -1, 0), { color, intensity: L * Math.PI * (e.radius / 1000) ** 2, unit: 'candela', radius: e.radius }));
            continue;
        }
        const pos = new THREE.Vector3(...e.position), n = new THREE.Vector3(...e.normal);
        const up = new THREE.Vector3(...e.v).normalize().toArray();
        const one = dir => light(name, e.kind, pos, dir, { color, intensity: L, unit: 'nits', width: e.width, height: e.height, up, noScaleSize: true });
        out.push(one(n));
        if (twoSided) out.push(one(n.clone().negate()));
    }
    return out;
}

// the camera → a saved view: field of view along the picture's shorter side, exposure of the film, depth of field
function convertCamera(scene, stem) {
    const c = scene.camera, p = c.params, film = scene.film || {};
    const w = film.xresolution?.v?.[0] ?? 1280, h = film.yresolution?.v?.[0] ?? 720;
    const aspect = w / h;
    const fov = c.type === 'perspective' ? p.fov?.v?.[0] ?? 90 : 40;
    const iso = film.iso?.v?.[0] ?? 100;
    const time = (p.shutterclose?.v?.[0] ?? 1) - (p.shutteropen?.v?.[0] ?? 0);
    const lens = p.lensradius?.v?.[0] ?? 0, focus = p.focaldistance?.v?.[0] ?? 0;
    return {
        name: stem, position: c.position, direction: c.forward, target: null, up: c.up, fov, fovAxis: aspect >= 1 ? 'v' : 'h', aspect,
        exposure: Math.max(iso / 100 * (time > 0 ? time : 1), 1e-6),
        // pbrt writes its image linearly (exposure, clipped) – RINDR's default curve pressed dark tones down and made deep
        // colours deeper (a dusty pink velvet came out saturated red)
        toneMapping: 'none',
        ...(lens > 0 && focus > 0 ? { aperture: lens * 1000, focusDistance: focus * 1000 } : {}),
    };
}

// the infinite light → { file (equirect .hdr), intensity } | { off } (no environment: pbrt's background is black)
function convertEnvironment(scene, spectra, stem) {
    const env = scene.environment;
    if (!env) return { off: true };
    const p = env.params || {};
    const scale = p.scale?.v?.[0] ?? 1;
    const e = p.illuminance?.v?.[0];
    if (env.bytes) {
        const intensity = e > 0 && env.illuminance > 0 ? scale * e / env.illuminance : scale;
        return { file: new File([env.bytes], `${stem} – ${env.name}.hdr`, { type: 'image/vnd.radiance' }), intensity };
    }
    // uniform: its radiance in a small panorama (illuminance E of a uniform sky = π L)
    const { color, intensity } = emission(p, 'L', spectra);
    const L = e > 0 ? scale * e / Math.PI : intensity;
    return { file: new File([uniformHdr(color.map(x => x * L))], `${stem} – environment.hdr`, { type: 'image/vnd.radiance' }), intensity: 1 };
}

// what the import left out, for the notice
function skippedWhat(scene) {
    const what = [];
    for (const [text] of scene.warnings) {
        if (/curves/.test(text)) what.push(t('import.pbrt.skipped.curves'));
        else if (/media|Medium/.test(text)) what.push(t('import.pbrt.skipped.media'));
        else if (/^shape /.test(text)) what.push(text.replace(/^shape (\S+).*/, '$1'));
        else if (/displacement/.test(text)) what.push(t('import.pbrt.skipped.displacement'));
    }
    return [...new Set(what)];
}
