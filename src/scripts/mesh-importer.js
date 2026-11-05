// Import of mesh formats (glTF/GLB, FBX) via the three.js loaders.
// The loaded object is converted into the same structure as the STEP import:
//   nodes      – object tree ({ name, parent }, children after parents)
//   geometries – own buffers per geometry (positions/normals/uvs/index), BVH + tangents in the worker pool
//   meshes     – instances with absolute matrix, node and material
// Units are converted to mm (like STEP): glTF is in metres, FBX in cm × UnitScaleFactor, MAX in its system unit,
// 3MF in the unit of its model part.
// Materials become separate entries (source 'import') in the MaterialManager, textures are kept.
import * as THREE from 'three/webgpu';
import { boxProject, buildGeometryBVHs, importPool, readStepFile, releaseImportPool, UV_TILE } from './step-importer.js';
import { importStlParts, stlLayout, colorOfCode } from './stl/stl-import.js';
import { isBinaryFbx } from './fbx/fbx-parse.js';
import { isCompoundFile } from './max/max-parse.js';
import { isC4dFile } from './c4d/c4d-parse.js';
import { creaseCornerNormals } from './crease-normals.js';
import { kelvinRgb } from './kelvin.js';
import { IMPORT } from './config.js';
import { t, getLocale } from './i18n.js';
import { minCopies } from './model-instances.js';
import { IMPORT_SLOTS } from './material-graph.js';
import { debugLog } from './log.js';
import { uvLengthHistogram, UvMetric } from './uv-metric.js';

// IFC (BIM) goes the same way but has its own importer (ifc/ifc-importer.js, web-ifc – loaded on demand)
export const MESH_EXTENSIONS = ['glb', 'gltf', 'fbx', 'max', 'c4d', 'blend', 'obj', '3mf', 'usd', 'usda', 'usdc', 'usdz', 'stl', 'pbrt', 'ifc', 'ifczip'];
const USD_FORMATS = ['usd', 'usda', 'usdc', 'usdz'];   // usd-importer.js (loaded on demand)

// The loaders are loaded only with the first glTF/FBX (~170 KB that a STEP-only session never needs).
// Draco/Basis decoders: three.js references them itself (new URL(…, import.meta.url)) – Vite ships them
// with hashed names in _astro/; the old copy in public/decoders is gone.
let libs = null;
const loadLibs = () => (libs ??= Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/FBXLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
    import('three/addons/loaders/STLLoader.js'),
    import('three/addons/loaders/PLYLoader.js'),
]).then(([gltf, fbx, draco, ktx2, meshopt, stl, ply]) => ({
    GLTFLoader: gltf.GLTFLoader, FBXLoader: fbx.FBXLoader, DRACOLoader: draco.DRACOLoader,
    KTX2Loader: ktx2.KTX2Loader, MeshoptDecoder: meshopt.MeshoptDecoder, STLLoader: stl.STLLoader, PLYLoader: ply.PLYLoader,
})));
let dracoLoader = null;
let ktx2Loader = null;

// Map slots taken over from the source material
const MAP_KEYS = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap',
    'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap',
    'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'iridescenceMap',
];
export { MAP_KEYS as IMPORT_MAP_KEYS };

const extOf = name => name.split('.').pop().toLowerCase();
const baseName = path => path.split(/[\\/]/).pop().toLowerCase();

/**
 * @param {{ name: string, main: Blob, files: {path: string, file: Blob}[], baseUrl?: string }} source
 *   main = main file, files = all supplied files (textures, .bin), baseUrl = fallback for relative paths
 * @param {{ renderer, materialManager, onStatus?, bvh?: boolean, checkSize?: (info) => Promise<boolean>, onLarge?: () => void,
 *   largeAbove?: number }} options
 *   checkSize({ name, triangles }): asked once the triangle count is known, before the BVHs and the GPU upload
 *   onLarge(): STL – the triangles that need memory (copies counted once) exceed largeAbove (viewer: opens in Basic)
 *   limit: STL – the triangles above which checkSize asks (parts certainly needed are built before the copies are known)
 *   onNodes(nodes), onSolid(meshes, geometries): STL – streaming of finished parts (as tessellateStep's onPlan / onSolid)
 *   (the memory-heavy part) – false = cancel (AbortError)
 */
export async function importMeshFile(source, { renderer, materialManager, onStatus = () => {}, bvh = false, checkSize = null, limit, onLarge = null, largeAbove = 0, onNodes = null, onSolid = null }) {
    const t0 = performance.now();
    const ext = extOf(source.name);
    if (ext === 'ifc' || ext === 'ifczip') return (await import('./ifc/ifc-importer.js')).importIfc(source, { materialManager, onStatus, bvh });
    onStatus(t('import.mesh.reading', { name: source.name }));
    let result, missing;
    // binary FBX: own lean reader in a worker (typed arrays only – three.js' FBXLoader needs several times the
    // file size in JS heap, a large CAD export crashed the tab); animated/skinned files below
    // IMPORT.fbxLoaderMaxBytes still go to FBXLoader (it reads animation, skinning, blend shapes)
    let buffer = null, fbxCameraScene = null;
    // MAX: own reader in a worker (max/max-parse.js)
    if (ext === 'max') {
        const data = await source.main.arrayBuffer();
        if (!isCompoundFile(data)) throw new Error(t('import.max.notMax'));
        const lean = await readMaxLean(data, { onStatus });
        ({ result, missing } = await convertMax(lean, source, materialManager));
    }
    // 3MF: own reader in a worker (3mf/3mf-parse.js)
    if (ext === '3mf') {
        const data = await source.main.arrayBuffer();
        if (data.byteLength < 4 || new DataView(data).getUint32(0, true) !== 0x04034b50) throw new Error(t('import.3mf.not3mf'));
        const scene = await read3mfLean(data, { onStatus });
        ({ result, missing } = await convert3mf(scene, source, materialManager));
    }
    if (ext === 'fbx') {
        buffer = await source.main.arrayBuffer();
        // ?fbxLoader (testing): always three.js' FBXLoader – comparison with the lean reader
        if (isBinaryFbx(buffer) && !new URLSearchParams(globalThis.location?.search || '').has('fbxLoader')) {
            // ?fbxLean (testing): the lean reader also for animated files
            const fallback = buffer.byteLength <= IMPORT.fbxLoaderMaxBytes && !new URLSearchParams(globalThis.location?.search || '').has('fbxLean');
            const lean = await readFbxLean(buffer, { fallback, onStatus });
            if (lean.buffer) { buffer = lean.buffer; fbxCameraScene = lean.cameraScene; }   // animated, small enough: three.js' loader
            else {
                buffer = null;
                ({ result, missing } = await convertLeanFbx(lean, source, materialManager));
                if (lean.scene.hasAnimation || lean.scene.hasDeformers) result.warnings = ['fbxStatic'];
            }
        }
    }
    // pbrt-v4 scene: own reader in a worker (pbrt/) – shapes, materials, lights, camera, environment
    if (ext === 'pbrt') ({ result, missing } = await (await import('./pbrt/pbrt-import.js')).importPbrt(source, { materialManager, onStatus }));
    // STL: in parts on all workers (stl/) – size check, BVHs and tangents done there
    if (ext === 'stl') ({ result, missing } = await importStl(source, { materialManager, onStatus, bvh, checkSize, limit, onLarge, largeAbove, onNodes, onSolid }));
    if (!result) {
        const loaded = await load(source, ext, renderer, onStatus, buffer);
        missing = loaded.missing;
        const { object, scale } = loaded;
        onStatus(t('import.mesh.buildingGeometries'));
        result = convert(object, scale, materialManager, source.name);
        if (fbxCameraScene) { result.cameras = fbxCameras(fbxCameraScene, scale); result.lights = fbxLights(fbxCameraScene, scale); }   // read by the lean reader
        if (object.userData.blend) {
            // Blender cameras look along −Z, up +Y; modifiers are not applied (the saved meshes are their input)
            const { cameras, lights, modifiers } = object.userData.blend;
            object.updateMatrixWorld(true);
            result.cameras = cameras.map(c => importedCamera(c.name, c.object.matrixWorld, { forward: FORWARD_MINUS_Z, up: UP_Y, fov: c.fov, fovAxis: c.fovAxis, aspect: c.aspect, scale, near: c.near }));
            result.lights = (lights || []).map(l => blendLight(l, scale));
            if (modifiers.length) result.blendModifiers = modifiers;
            delete object.userData.blend;
        }
        if (object.userData.c4d) {
            // C4D cameras and lights look along their −Z after the mirroring (C4D: +Z), up = +Y; objects the reader does not
            // build: notice
            const { cameras, lights, unsupported } = object.userData.c4d;
            object.updateMatrixWorld(true);
            result.cameras = cameras.map(c => importedCamera(c.name, c.object.matrixWorld, {
                forward: FORWARD_MINUS_Z, up: UP_Y, target: c.target ? new THREE.Vector3().setFromMatrixPosition(c.target.matrixWorld) : null,
                fov: c.fov, fovAxis: 'h', scale,
            }));
            result.lights = (lights || []).map(l => c4dLight(l, scale)).filter(l => l.intensity > 0);
            if (unsupported.length) result.c4dSkipped = { count: unsupported.reduce((a, x) => a + x.count, 0), what: unsupported.map(x => x.name) };
            delete object.userData.c4d;
        }
        // animated file: keep the source object as a "puppet" (animation.js drives it and copies every frame)
        const clips = (object.animations || []).filter(c => c.duration > 0 && c.tracks.length);
        // also without clips when there are morph targets (blend shapes: sliders in the properties panel) or a skeleton
        // (posed by hand in the skeleton view)
        result.animation = clips.length || result.links.some(l => hasMorphs(l.mesh) || l.mesh.isSkinnedMesh) ? { root: object, clips, scale, links: result.links } : null;
        delete result.links;
    }
    if (missing.size) console.warn('[Import] Files not found:', [...missing]);
    if (!result.meshes.length) throw new Error(t('import.mesh.noFaces'));
    fitImportRelief(result, materialManager);
    if (checkSize && !result.prepared) {
        let triangles = 0;
        for (const g of result.geometries) triangles += g.index.length / 3;
        if (!await checkSize({ name: source.name, triangles })) throw new DOMException('Import cancelled', 'AbortError');
    }
    const t1 = performance.now();
    if (bvh && !result.prepared) await buildGeometryBVHs(result.geometries, onStatus);
    let triangles = 0;
    for (const g of result.geometries) triangles += g.index.length / 3;
    result.stats = {
        format: ext, geometries: result.geometries.length, meshes: result.meshes.length, triangles,
        missingFiles: [...missing], loadMs: Math.round(t1 - t0), bvhMs: Math.round(performance.now() - t1),
    };
    result.missing = [...missing];
    debugLog('[Import]', result.stats);
    return result;
}

/**
 * A glTF needs files that were not supplied (its .bin buffers – without them there is no geometry).
 * files: all missing external files of the glTF ({ uri, kind: 'buffer'|'image' }), images included,
 * so the user can hand everything in at once.
 */
export class MissingFilesError extends Error {
    constructor(files) {
        super('Missing files: ' + files.map(f => f.uri).join(', '));
        this.name = 'MissingFilesError';
        this.files = files;
    }
}

// --- Loading ---

// Loading manager that resolves the files a model references (textures, .bin) against the supplied files or the
// model's URL; missing = references that could not be resolved, idle() = all started loads done.
function createResolver(source) {
    // Resolve supplied files by relative path or file name (FBX often contains absolute Windows paths)
    const byPath = new Map(), byName = new Map();
    for (const { path, file } of source.files) {
        byPath.set(path.toLowerCase().replace(/^\.?\//, ''), file);
        byName.set(baseName(path), file);
    }
    const urls = [];
    const missing = new Set();
    const fromServer = new Map();   // resolved URL -> path in the file
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
        if (/^(data|blob):/.test(url)) return url;
        let rel = url;
        try { rel = decodeURIComponent(url); } catch { /* unchanged */ }
        rel = rel.replace(/^\.?\//, '').toLowerCase();
        const file = byPath.get(rel) || byName.get(baseName(rel));
        if (file) {
            const u = URL.createObjectURL(file);
            urls.push(u);
            return u;
        }
        // another server (absolute https address): never on its own – the asset window offers to load it
        // (remote-textures.js); the CSP allows such images since then
        if (/^https?:\/\//i.test(url) && new URL(url).origin !== location.origin) {
            missing.add(url);
            return 'data:,';
        }
        // loaded via URL (?model=): relative to the model file – missing only if that fails (onError). Absolute local
        // paths of the authoring machine (N:\…, file:, \\server\…) → the file name next to the model (the browser
        // refuses local files: "Not allowed to load local resource")
        if (source.baseUrl) {
            const local = /^([a-z]:[\\/]|file:|\\\\|\/\/)/i.test(url);   // also //server/… (UNC with slashes)
            const href = new URL(local ? encodeURIComponent(url.split(/[\\/]/).pop()) : url, new URL(source.baseUrl, location.href)).href;
            fromServer.set(href, url);
            return href;
        }
        missing.add(url);
        return 'data:,';   // dropped files: never fetch anything from the server
    });
    manager.onError = href => { if (fromServer.has(href)) missing.add(fromServer.get(href)); };
    // Wait until all textures are loaded (FBX returns the object before that)
    let started = false;
    const loaded = new Promise(resolve => {
        manager.onStart = () => { started = true; };
        manager.onLoad = resolve;
    });
    return {
        manager, missing, byPath, byName,
        idle: () => (started ? loaded : Promise.resolve()),
        // images are decoded by then; release the blob URLs
        release: () => setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 1000),
    };
}

async function load(source, ext, renderer, onStatus = () => {}, preloaded = null) {
    const { manager, missing, byPath, byName, idle, release } = createResolver(source);
    try {
        const { GLTFLoader, FBXLoader, DRACOLoader, KTX2Loader, MeshoptDecoder, STLLoader, PLYLoader } = await loadLibs();
        const buffer = preloaded ?? await source.main.arrayBuffer();
        // dropped .gltf: check the external buffers first (GLTFLoader would fail with an unclear error)
        if (ext === 'gltf' && !source.baseUrl) checkGltfFiles(buffer, byPath, byName);
        let object, scale;
        if (ext === 'ply') {
            // PLY mesh (scanner/photogrammetry; Gaussian splat PLYs go to splat/ instead): like STL – mm, no
            // materials (colours per vertex → a white material that shows them), Z up → Y up; normals from the file if
            // present
            const geometry = new PLYLoader().parse(buffer);
            if (!geometry.index) throw new Error(t('import.mesh.noFaces'));   // point cloud without faces
            const mesh = new THREE.Mesh(geometry, geometry.getAttribute('color') ? VERTEX_COLOR_MATERIAL : DEFAULT_MATERIAL);
            mesh.name = source.name.replace(/\.[^.]+$/, '');
            geometry.computeBoundingBox();
            if (meshUpAxis(geometry.boundingBox, '') === 'z') mesh.rotation.x = -Math.PI / 2;
            object = new THREE.Group();
            object.add(mesh);
            scale = 1;
        } else if (USD_FORMATS.includes(ext)) {
            // USD: layers + references resolved against the supplied files / the server (usd-importer.js)
            const usd = await (await import('./usd-importer.js')).loadUsd(source, buffer, manager, onStatus);
            for (const m of usd.missing) missing.add(m);
            object = usd.object;
            scale = usd.scale;
        } else if (ext === 'c4d') {
            // C4D: own reader in a worker (c4d/c4d-parse.js), built into three.js objects (c4d/c4d-build.js) – skinning
            // and animation then go the way of FBX/glTF (puppet)
            if (!isC4dFile(buffer)) throw new Error(t('import.c4d.notC4d'));
            const scene = await readC4dLean(buffer.slice(0), { onStatus });
            onStatus(t('import.mesh.buildingGeometries'));
            const built = (await import('./c4d/c4d-build.js')).buildC4d(scene, manager, source.name.replace(/\.[^.]+$/, ''));
            object = built.object;
            object.userData.c4d = { cameras: built.cameras, lights: built.lights, unsupported: built.unsupported };
            scale = built.scale;   // project unit → mm
        } else if (ext === 'blend') {
            // Blender: own reader in a worker (blend/blend-parse.js, the file's self description), packed images from the
            // file; built into three.js objects (blend/blend-build.js)
            const { isBlendFile } = await import('./blend/blend-file.js');
            if (!isBlendFile(new Uint8Array(buffer, 0, 16))) throw new Error(t('import.blend.notBlend'));
            const scene = await readBlendLean(buffer.slice(0), { onStatus });
            onStatus(t('import.mesh.buildingGeometries'));
            const built = (await import('./blend/blend-build.js')).buildBlend(scene, manager, source.name.replace(/\.[^.]+$/, ''));
            object = built.object;
            object.userData.blend = { cameras: built.cameras, lights: built.lights, modifiers: built.modifiers };
            setTimeout(() => built.urls.forEach(u => URL.revokeObjectURL(u)), 30000);
            scale = built.scale;
        } else if (ext === 'obj') {
            // OBJ: own reader in a worker (obj/obj-parse.js – files of hundreds of MB), materials from the MTL files it
            // names (dropped / next to the model, through the resolver); no unit – metres like glTF (Blender writes them)
            const scene = await readObjLean(buffer.slice(0), { onStatus });
            const { buildObj, parseMtl } = await import('./obj/obj-build.js');
            const mtl = {};
            for (const lib of scene.mtllibs) {
                const url = manager.resolveURL(lib);
                if (url === 'data:,') { missing.add(lib); continue; }
                const res = await fetch(url).catch(() => null);
                if (res?.ok) Object.assign(mtl, parseMtl(await res.text())); else missing.add(lib);
            }
            onStatus(t('import.mesh.buildingGeometries'));
            object = buildObj(scene, mtl, manager, source.name.replace(/\.[^.]+$/, ''), { linear: scene.writer === 'blender' });
            scale = 1000;   // m → mm
        } else if (ext === 'fbx') {
            const loader = new FBXLoader(manager);
            object = loader.parse(buffer, '');
            // FBX: unit cm × UnitScaleFactor (1 = cm, 100 = m, 0.1 = mm, 2.54 = inch)
            scale = 10 * (object.userData.unitScaleFactor || 1);
        } else {
            const loader = new GLTFLoader(manager);
            dracoLoader ??= new DRACOLoader();
            loader.setDRACOLoader(dracoLoader);
            ktx2Loader ??= new KTX2Loader().detectSupport(renderer);
            loader.setKTX2Loader(ktx2Loader);
            loader.setMeshoptDecoder(MeshoptDecoder);
            const gltf = await loader.parseAsync(ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer, '');
            object = gltf.scene || gltf.scenes?.[0];
            if (!object) throw new Error(t('import.mesh.gltfNoScene'));
            object.animations = gltf.animations || [];   // FBXLoader puts them on the object itself
            await collectUnlit(gltf, object);
            scale = 1000;   // m -> mm
        }
        await idle();
        dropGreyNormalMaps(object);
        return { object, scale, missing };
    } finally {
        release();
    }
}

// Bump maps from the file are the relief of the import graph (material-graph.js IMPORT_SLOTS): its height in mm, set
// once the meshes are known – from the file where the format gives a length (Blender: Distance × Strength), else from
// its unitless factor (OBJ -bm, FBX BumpFactor, MAX, C4D: 1): factor × one picture's length on the model / 1024 – the
// slope three.js showed a 1K picture with at one texel per screen pixel, now at any distance and resolution, and it
// grows with the picture like a normal map's. The picture's length: the meshes' surface length per UV unit / repeat.
const BUMP_TEXELS = 1024;
function fitImportRelief(result, materialManager) {
    const wanted = new Map();   // material id → UvMetric
    for (const m of result.meshes) {
        if (wanted.has(m.materialId)) continue;
        const def = materialManager.get(m.materialId)?.def;
        if (def?.render?.maps?.bumpMap && def.graph?.links?.some(l => l.to.node === 'out' && l.to.port === 'height')) wanted.set(m.materialId, new UvMetric());
    }
    if (!wanted.size) return;
    const hists = new Map();   // geometry → its lengths per UV unit
    for (const m of result.meshes) {
        const metric = wanted.get(m.materialId);
        if (!metric) continue;
        if (!hists.has(m.geometry)) { const g = result.geometries[m.geometry]; hists.set(m.geometry, uvLengthHistogram(g.positions, g.uvs, g.index)); }
        if (m.instances) metric.addCopies(hists.get(m.geometry), m.matrix, m.instances, m.instances.length / 16);   // an instanced part (model-instances.js)
        else metric.add(hists.get(m.geometry), m.matrix);
    }
    for (const [id, metric] of wanted) {
        const render = materialManager.get(id).def.render;
        let height = Number.isFinite(render.bumpHeight) ? render.bumpHeight : null;   // negative: sunk (pbrt, Blender's invert)
        if (height === null) {
            const tex = render.maps.bumpMap;
            const repeat = (Math.abs(tex.repeat.x) + Math.abs(tex.repeat.y)) / 2 || 1;
            height = (Number(render.bumpScale) || 0) * (metric.length ?? UV_TILE) / repeat / BUMP_TEXELS;
        }
        materialManager.setImportRelief(id, Math.round(height * 1e4) / 1e4, metric.length);
    }
}

// A "normal map" without the blue cast of one is no normal map – exporters connect height images to the normal input
// (a bedroom scene through USD: every fabric glittered; in its source scene those images drove nothing). Checked on a
// 16 × 16 copy of each image once: tangent-space normal maps have b well above r and g (measured +65 … +110), height maps
// and stray photos not (−9 … 0) → left out. Used as a bump map instead they still glittered (UVs tiled ~900 times).
function dropGreyNormalMaps(object) {
    const verdict = new Map();
    const grey = tex => {
        const img = tex?.image;
        if (!img?.width || typeof OffscreenCanvas === 'undefined') return false;
        if (verdict.has(img)) return verdict.get(img);
        let result = false;
        try {
            const canvas = new OffscreenCanvas(16, 16), ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, 16, 16);
            const d = ctx.getImageData(0, 0, 16, 16).data;
            let blue = 0;
            for (let i = 0; i < d.length; i += 4) blue += d[i + 2] - (d[i] + d[i + 1]) / 2;
            result = blue / (d.length / 4) < 20;
        } catch { /* image not readable (tainted) */ }
        verdict.set(img, result);
        return result;
    };
    object.traverse(o => {
        if (!o.isMesh) return;
        for (const m of [o.material].flat()) {
            if (!m?.normalMap || !grey(m.normalMap)) continue;
            m.normalMap = null;
            m.needsUpdate = true;
        }
    });
}

/**
 * Makes an STL safe for STLLoader, whose format check only compares the face count at byte 80 with the
 * file length and otherwise looks for "solid" in the first 5 bytes. Files that miss both (ASCII with
 * leading blank lines or without "solid", binary with a wrong face count or trailing bytes) were read
 * as binary with a garbage count → "Invalid typed array length".
 * ASCII → string starting with "solid"; binary with a wrong count → copy with the count the file
 * length allows (the original buffer stays untouched, it may be kept as a scene asset).
 */
export function normalizeStl(buffer) {
    const len = buffer.byteLength;
    if (len >= 84 && 84 + new DataView(buffer).getUint32(80, true) * 50 === len) return buffer;
    // ASCII: "facet"/"vertex" keywords near the start and only text bytes there
    const head = new Uint8Array(buffer, 0, Math.min(len, 1024));
    const text = !head.some(b => b === 0 || (b < 9) || (b > 13 && b < 32));
    if (text) {
        // text without STL keywords (e.g. an HTML page saved as .stl): would only yield garbage triangles
        if (!/^\uFEFF?\s*solid|\bfacet\s+normal\b|\bvertex\s+[-+.\d]/i.test(new TextDecoder().decode(head))) throw new Error(t('import.mesh.notStl'));
        let str = new TextDecoder().decode(buffer).replace(/^\uFEFF?\s*/, '');
        if (!/^solid/i.test(str)) str = 'solid\n' + str;
        if (!/endsolid/i.test(str)) str += '\nendsolid\n';   // STLLoader only reads solid … endsolid blocks
        return str;
    }
    if (len < 84) throw new Error('STL file too short');
    const faces = Math.floor((len - 84) / 50);
    console.warn(`[STL] header face count ${new DataView(buffer).getUint32(80, true)} does not match the file length – reading ${faces} faces`);
    const fixed = buffer.slice(0, 84 + faces * 50);
    new DataView(fixed).setUint32(80, faces, true);
    return fixed;
}

// STL in parts on all workers (stl/stl-import.js): binary files are read by the workers directly (with cross-origin
// isolation from one SharedArrayBuffer), text files through three's STLLoader (rare and small). Result in the common
// structure: one node per part ("Part n" below the file's node; a single part is the file's node itself, as before),
// copies use the first part's geometries with an alignment matrix, one material per facet colour ("Colour #RRGGBB",
// replaceable like every import material), without colours the default material. mm, up axis guessed (meshUpAxis).
// Streaming like STEP: onNodes(nodes) once the parts are known, onSolid(meshes, geometries) for every finished part and
// its copies (viewer: in the scene at once, the camera follows); the result repeats them with the same keys.
async function importStl(source, { materialManager, onStatus, bvh, checkSize, limit, onLarge, largeAbove, onNodes, onSolid }) {
    const blob = source.main;
    const layout = stlLayout(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()), blob.size);
    const shared = !!self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    let input;
    if (layout.kind === 'text') {
        const { STLLoader } = await loadLibs();
        const geometry = new STLLoader().parse(normalizeStl(await blob.arrayBuffer()));
        input = { positions: geometry.getAttribute('position').array };
    } else {
        onStatus(t('import.mesh.reading', { name: source.name }));
        const bytes = shared ? await readStepFile(blob) : new Uint8Array(await blob.arrayBuffer());
        input = { bytes, count: layout.count, colors: layout.colors };
    }
    if (!(input.positions?.length || input.count)) throw new Error(t('import.mesh.noFaces'));

    // nodes, up axis and materials – set up once the parts are known (onPlan), used for the streamed and the final meshes
    const name = source.name.replace(/\.[^.]+$/, '');
    const materialId = materialIdFactory(materialManager, 1, source.name);
    const colorMaterials = new Map();   // #RRGGBB → source material
    const materialOf = code => {
        const rgb = colorOfCode(code, layout.defaultRgb);
        if (!rgb) return materialId(DEFAULT_MATERIAL);
        const color = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
        const hex = '#' + color.getHexString(THREE.SRGBColorSpace).toUpperCase();
        if (!colorMaterials.has(hex)) colorMaterials.set(hex, new THREE.MeshStandardMaterial({ name: t('import.mesh.colorMaterial', { color: hex }), color, roughness: 0.6 }));
        return materialId(colorMaterials.get(hex));
    };
    let nodes = null, single = false, upMatrix = null;
    const plan = ({ count, box: b }) => {
        const up = meshUpAxis({ min: { y: b[1], z: b[2] }, max: { y: b[4], z: b[5] } }, layout.header || '');
        upMatrix = up === 'z' ? new THREE.Matrix4().makeRotationX(-Math.PI / 2) : new THREE.Matrix4();
        single = count === 1;
        nodes = [{ name: '', parent: -1 }, { name, parent: 0 }];
        if (!single) for (let i = 0; i < count; i++) nodes.push({ name: t('import.stl.part', { number: i + 1 }), parent: 1 });
        onNodes?.(nodes);
    };
    const m = new THREE.Matrix4(), a = new THREE.Matrix4();
    const meshesOf = (i, p, geometries) => {
        const node = single ? 1 : 2 + i;
        m.copy(upMatrix);
        if (p.align) m.multiply(a.fromArray(p.align));
        const matrix = m.toArray();
        return p.geometries.map(({ code, gi }) => {
            geometries[gi].name ??= nodes[node].name;
            // key: a single-colour single part keeps the key of the one mesh before (scene states)
            return { geometry: gi, matrix, materialId: materialOf(code), name: nodes[node].name, node, instance: i,
                key: single && p.geometries.length === 1 ? '0/all' : `${i}/${code}` };
        });
    };

    const STEPS = { analyzing: 'import.stl.analyzing', joining: 'import.stl.joining', orienting: 'import.mesh.orienting', matching: 'import.step.matching', building: 'import.stl.building' };
    let r;
    try {
        r = await importStlParts(input, {
            pool: importPool(blob.size, shared), shared: shared && input.bytes?.buffer instanceof SharedArrayBuffer, bvh, onLarge, largeAbove,
            status: (step, fraction) => onStatus(t(STEPS[step]), fraction ?? undefined),
            checkSize: checkSize ? triangles => checkSize({ name: source.name, triangles }) : null, limit,
            onPlan: plan,
            onParts: onSolid ? (list, geometries) => onSolid(list.flatMap(p => meshesOf(p.index, p, geometries)), geometries) : null,
        });
    } finally {
        releaseImportPool();
    }
    if (!r.parts.length) throw new Error(t('import.mesh.noFaces'));
    const meshes = r.parts.flatMap((p, i) => meshesOf(i, p, r.geometries));
    return { result: { nodes, geometries: r.geometries, meshes, cameras: [], lights: [], animation: null, prepared: true, stl: r.stats }, missing: new Set() };
}

/**
 * Up axis of a mesh without metadata (STL/PLY): 'z' (CAD/3D printing, scanners – turned to Y up) or 'y'.
 * SolidWorks exports Y up (header). Otherwise the bounding box: a model lies on its floor → the axis whose
 * minimum is ~0 while the other's is not; a model centred around 0 on an axis has that axis horizontal
 * (cars, CAD assemblies: centred sideways). Undecided → Z (most STLs). Override: ?upAxis=y|z.
 * Example car STL: y 0 … 1257, z −1010 … 1010 → Y (lay on its side with the old fixed Z).
 */
function meshUpAxis(box, header) {
    const forced = new URLSearchParams(globalThis.location?.search || '').get('upAxis');
    let up = 'z', reason = 'default';
    if (forced === 'y' || forced === 'z') { up = forced; reason = '?upAxis'; }
    else if (/solid\s*works/i.test(header)) { up = 'y'; reason = 'SolidWorks'; }
    else {
        const { min, max } = box;
        const ext = { y: max.y - min.y, z: max.z - min.z };
        const onFloor = a => ext[a] > 0 && Math.abs(min[a]) <= 0.02 * ext[a];
        const centred = a => ext[a] > 0 && Math.abs(min[a] + max[a]) <= 0.02 * ext[a];
        if (onFloor('z') !== onFloor('y')) { up = onFloor('z') ? 'z' : 'y'; reason = 'floor'; }
        else if (centred('z') !== centred('y')) { up = centred('z') ? 'y' : 'z'; reason = 'centred'; }
    }
    debugLog(`[Import] up axis ${up.toUpperCase()} (${reason})`);
    return up;
}

function checkGltfFiles(buffer, byPath, byName) {
    let json;
    try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { return; }   // the loader reports it
    const external = uri => typeof uri === 'string' && !/^(data|blob):/.test(uri);
    const found = uri => {
        let rel = uri;
        try { rel = decodeURIComponent(uri); } catch { /* unchanged */ }
        rel = rel.replace(/^\.?\//, '').toLowerCase();
        return byPath.has(rel) || byName.has(baseName(rel));
    };
    const buffers = (json.buffers || []).filter(b => external(b.uri) && !found(b.uri)).map(b => ({ uri: b.uri, kind: 'buffer' }));
    if (!buffers.length) return;
    const images = (json.images || []).filter(i => external(i.uri) && !found(i.uri)).map(i => ({ uri: i.uri, kind: 'image' }));
    throw new MissingFilesError([...buffers, ...images]);
}

// --- Conversion ---

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isPosed = mesh => mesh.isSkinnedMesh || hasMorphs(mesh) || !!mesh.morphTargetInfluences?.some(v => v !== 0);
// meshes convert would make of a subtree (copies of an InstancedMesh counted)
function shownMeshes(o) {
    if (!o.visible || o.isLight || o.isCamera) return 0;
    let n = o.isMesh && !o.isBatchedMesh && o.geometry?.getAttribute('position') ? (o.isInstancedMesh ? o.count : 1) : 0;
    for (const c of o.children) n += shownMeshes(c);
    return n;
}

/**
 * Subtrees placed at least minCopies times: same meshes (geometry, materials) in the same arrangement below them – the
 * placement of the subtree itself may differ. Topmost ones win (a copied assembly, not each of its screws); skinned,
 * morphed and instanced meshes are never part of one. → [{ members: Object3D[], parents: [] }]
 */
function findCopies(root, minCopies) {
    const ids = new Map(), sigOf = new Map(), withMesh = new Set();
    const intern = s => { let id = ids.get(s); if (id === undefined) ids.set(s, id = ids.size); return id; };
    const sig = o => {
        if (!o.visible || o.isLight || o.isCamera) return -1;   // no node of its own (convert skips it)
        let own = 'G', ok = true, mesh = false;
        if (o.isMesh && o.geometry?.getAttribute('position')) {
            if (o.isInstancedMesh || o.isBatchedMesh || isPosed(o)) ok = false;
            own = 'M' + o.geometry.uuid + '|' + (Array.isArray(o.material) ? o.material : [o.material]).map(x => x?.uuid).join(',');
            mesh = true;
        }
        const parts = [];
        for (const c of o.children) {
            const cs = sig(c);
            if (cs === -1) continue;
            if (cs === null) { ok = false; continue; }
            if (withMesh.has(cs)) mesh = true;
            parts.push(cs + '@' + c.matrix.elements.join(','));
        }
        const id = ok ? intern(own + '[' + parts.join(';') + ']') : null;
        if (id !== null && mesh) withMesh.add(id);
        sigOf.set(o, id);
        return id;
    };
    sig(root);
    const count = new Map();
    for (const id of sigOf.values()) if (id !== null) count.set(id, (count.get(id) || 0) + 1);
    const chosen = new Set([...count].filter(([id, n]) => n >= minCopies && withMesh.has(id)).map(([id]) => id));
    if (!chosen.size) return [];
    // members = copies not inside another copy; a choice left with too few of them is dropped and the walk repeated
    for (let round = 0; round < 8; round++) {
        const members = new Map();
        const walk = o => {
            const id = sigOf.get(o);
            if (id === undefined || id === -1) return;
            if (o !== root && id !== null && chosen.has(id)) {
                if (!members.has(id)) members.set(id, []);
                members.get(id).push(o);
                return;
            }
            for (const c of o.children) walk(c);
        };
        walk(root);
        const few = [...chosen].filter(id => (members.get(id)?.length || 0) < minCopies);
        if (!few.length) return [...members.values()].map(list => ({ members: list, parents: [] }));
        for (const id of few) chosen.delete(id);
        if (!chosen.size) return [];
    }
    return [];
}

function convert(object, scale, materialManager, fileName = '') {
    // Apply the scale only to the final matrices – skinning computes in the space of the bind matrices
    object.updateMatrixWorld(true);
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);

    const nodes = [];
    const geometries = [];
    const meshes = [];
    const links = [];   // per mesh entry: source mesh + instance (animation)
    const geometryCache = new Map();   // geometry.uuid:group -> index in geometries
    let instance = 0;
    const materialId = materialIdFactory(materialManager, scale, fileName);

    // Copies as InstancedMeshes (model-instances.js) – glTF and USD, not in animated files (clips may move every copy on
    // its own): the file's own instancing (glTF EXT_mesh_gpu_instancing → InstancedMesh) from minCopies() on, and copies
    // of one subtree (USD: an asset referenced many times, composed once and cloned; glTF: nodes using the same meshes)
    // – one Scene Graph row "name (n×)" each
    const animated = (object.animations || []).some(c => c.duration > 0 && c.tracks.length);
    const copiesFrom = /\.(gltf|glb|usd[acz]?)$/i.test(fileName) && !animated ? minCopies() : Infinity;
    const copyGroups = Number.isFinite(copiesFrom) ? findCopies(object, copiesFrom) : [];
    const groupOf = new Map();
    for (const g of copyGroups) for (const o of g.members) groupOf.set(o, g);
    const im = new THREE.Matrix4(), m = new THREE.Matrix4();

    const visit = (o, parent) => {
        if (!o.visible || o.isLight || o.isCamera) return;
        const group = groupOf.get(o);
        if (group) {
            // a copy: its meshes come with the group after the walk; the numbers stay reserved (keys of later meshes
            // are the same as without instancing – scene states)
            group.parents.push(parent);
            instance += shownMeshes(o);
            return;
        }
        const node = nodes.length;
        nodes.push({ name: o.name || (o.isMesh ? t('import.mesh.unnamedMesh') : ''), parent });
        if (o.isMesh && !o.isBatchedMesh && o.geometry?.getAttribute('position')) {
            if (o.isInstancedMesh && o.count >= copiesFrom && !isPosed(o)) {
                const copies = new Float32Array(o.count * 16);
                for (let k = 0; k < o.count; k++) m.multiplyMatrices(toMm, o.matrixWorld).multiply((o.getMatrixAt(k, im), im)).toArray(copies, 16 * k);
                nodes[node].name = t('import.mesh.instancedObject', { name: nodes[node].name || t('import.mesh.unnamedMesh'), count: o.count.toLocaleString(getLocale()) });
                addMesh(o, node, { copies, id: instance, key: `${instance}i` });
                instance += o.count;
            } else addMesh(o, node);
        }
        for (const c of o.children) visit(c, node);
    };

    // copies: { copies: Float32Array (16 per copy, mm), id, key } – one entry per material bucket for all of them
    const addMesh = (mesh, node, copies = null) => {
        const geometry = mesh.geometry;
        const multi = Array.isArray(mesh.material);
        // groups with the same material → one mesh of ours (FBX often has thousands of groups for a few
        // materials – one mesh each made loading and drawing slow). key = first group (stable for scene states)
        const buckets = new Map();
        if (multi && geometry.groups.length) {
            geometry.groups.forEach((g, i) => {
                const mi = g.materialIndex ?? 0;
                if (!buckets.has(mi)) buckets.set(mi, { key: i, materialIndex: mi, ranges: [] });
                buckets.get(mi).ranges.push(g);
            });
        } else buckets.set(0, { key: 'all', materialIndex: 0, ranges: [{ start: 0, count: Infinity }] });
        const list = [...buckets.values()];
        // Skinning/morph targets: bake the current pose into a separate geometry (morph targets always –
        // their sliders deform it later)
        const posed = isPosed(mesh);
        const worldScale = mesh.matrixWorld.getMaxScaleOnAxis() * scale;
        const instances = mesh.isInstancedMesh ? mesh.count : 1;
        let gis = posed ? undefined : geometryCache.get(geometry.uuid);
        if (!gis) {
            gis = extractGeometries(mesh, list, posed, worldScale).map(g => {
                if (!g) return -1;
                const gi = geometries.length;
                geometries.push({ ...g, name: mesh.name });
                if (posed) posedSource.set(gi, g.sourceVertex);
                return gi;
            });
            if (!posed) geometryCache.set(geometry.uuid, gis);
        }
        list.forEach((bucket, j) => {
            const gi = gis[j];
            if (gi < 0) return;
            const mat = materialId(multi ? mesh.material[bucket.materialIndex] : mesh.material);
            if (copies) {
                links.push({ mesh, instance: -1, posed, geometry: gi, sourceVertex: null, materialIndex: multi ? bucket.materialIndex : -1 });
                meshes.push({ geometry: gi, matrix: IDENTITY.slice(), instances: copies.copies, copies: copies.copies.length / 16, materialId: mat, name: mesh.name,
                    node, instance: copies.id, key: `${copies.key}/${bucket.key}` });
                return;
            }
            for (let k = 0; k < instances; k++) {
                m.multiplyMatrices(toMm, mesh.matrixWorld);
                if (mesh.isInstancedMesh) m.multiply((mesh.getMatrixAt(k, im), im));
                links.push({ mesh, instance: mesh.isInstancedMesh ? k : -1, posed, geometry: gi, sourceVertex: posed ? posedSource.get(gi) : null,
                    materialIndex: multi ? bucket.materialIndex : -1 });
                meshes.push({ geometry: gi, matrix: m.toArray(), materialId: mat, name: mesh.name, node, instance: instance + k, key: `${instance + k}/${bucket.key}` });
            }
        });
        if (!copies) instance += instances;
    };

    const posedSource = new Map();   // posed geometry -> our vertex → source vertex
    visit(object, -1);
    // the copy groups: one node below the deepest node holding all copies, an InstancedMesh per mesh of the first copy
    const ancestors = n => { const out = []; for (; n >= 0; n = nodes[n].parent) out.push(n); return out; };
    const base = instance;
    copyGroups.forEach((group, gi) => {
        let chain = null;
        for (const p of new Set(group.parents)) { const up = ancestors(p); chain = chain ? chain.filter(n => up.includes(n)) : up; }
        const first = group.members[0], count = group.members.length;
        const node = nodes.length;
        nodes.push({ name: t('import.mesh.instancedObject', { name: first.name || t('import.mesh.unnamedMesh'), count: count.toLocaleString(getLocale()) }), parent: chain?.[0] ?? -1 });
        const inverse = first.matrixWorld.clone().invert(), local = new THREE.Matrix4();
        let mi = 0;
        const walk = o => {
            if (!o.visible || o.isLight || o.isCamera) return;
            if (o.isMesh && !o.isBatchedMesh && o.geometry?.getAttribute('position')) {
                local.multiplyMatrices(inverse, o.matrixWorld);   // the mesh in its copy
                const copies = new Float32Array(count * 16);
                group.members.forEach((c, k) => m.multiplyMatrices(toMm, c.matrixWorld).multiply(local).toArray(copies, 16 * k));
                addMesh(o, node, { copies, id: base + gi, key: `c${gi}.${mi++}` });
            }
            for (const c of o.children) walk(c);
        };
        walk(first);
    });
    if (copyGroups.length) debugLog('[Import] copies as instances', { groups: copyGroups.length, copies: copyGroups.reduce((a, g) => a + g.members.length, 0) });
    for (const g of geometries) delete g.sourceVertex;   // not to the BVH worker
    // glTF cameras: look along −Z, vertical field of view, no target (FBX cameras: fbxCameras, from the own reader for
    // both ways of loading)
    const cameras = [], lights = [];
    if (/\.(gltf|glb)$/i.test(fileName)) object.traverseVisible(o => {
        if (o.isPerspectiveCamera) cameras.push(importedCamera(o.name, o.matrixWorld, { forward: FORWARD_MINUS_Z, up: UP_Y, fov: o.fov, fovAxis: 'v', scale }));
        // KHR_lights_punctual (GLTFLoader: three.js lights, shining along −Z): point / spot in candela, directional in lux
        if (o.isLight && (o.isPointLight || o.isSpotLight || o.isDirectionalLight)) {
            lights.push(importedLight(o.name, o.matrixWorld, {
                kind: o.isDirectionalLight ? 'directional' : o.isSpotLight ? 'spot' : 'point', forward: FORWARD_MINUS_Z,
                color: [o.color.r, o.color.g, o.color.b], intensity: o.intensity, unit: o.isDirectionalLight ? 'lux' : 'candela',
                angle: o.isSpotLight ? THREE.MathUtils.radToDeg(o.angle) : null, penumbra: o.isSpotLight ? o.penumbra : null, scale,
            }));
        }
    });
    // UsdLux lights (usd-importer.js keeps their values in userData.usdLight)
    if (/\.usd[acz]?$/i.test(fileName)) object.traverseVisible(o => { if (o.isLight && o.userData.usdLight) lights.push(usdLight(o, scale)); });
    // glTF that brings its own light (user: "dann würden wir natürlich unsere lichter/kameras ausschmeißen und nur das aus
    // dem gltf übernehmen"): lamps (KHR_lights_punctual) or glowing surfaces meant as light sources – emissive strength
    // from LAMP_STRENGTH on (KHR_materials_emissive_strength; screens and LEDs stay at 1) → the viewer switches all its
    // default lights off; the file's first camera becomes the active view
    const gltf = /\.(gltf|glb)$/i.test(fileName);
    const ownLight = gltf && (lights.length > 0 || glowsAsLamp(object));
    return { nodes, geometries, meshes, links, cameras, lights, ownLight, activateCamera: gltf && cameras.length > 0 };
}

// emissive strength from which a glowing surface counts as a lamp of the scene (a glTF lit by a small emitter of strength
// 15 000 kept RINDR's studio lights on top of it)
const LAMP_STRENGTH = 10;
function glowsAsLamp(object) {
    let found = false;
    object.traverseVisible(o => {
        if (found || !o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m?.emissive && m.emissiveIntensity >= LAMP_STRENGTH && Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0) { found = true; return; }
        }
    });
    return found;
}

// Source material → id of an import material in the MaterialManager (once per source material)
function materialIdFactory(materialManager, scale, fileName) {
    const materialIds = new Map();     // source material -> material id
    let unnamed = 0;
    return src => {
        if (!src) src = DEFAULT_MATERIAL;
        let id = materialIds.get(src);
        if (!id) {
            const def = convertMaterial(src, scale);
            if (src === DEFAULT_MATERIAL) def.name = t('import.mesh.defaultMaterial');
            if (src === VERTEX_COLOR_MATERIAL) def.name = t('import.mesh.vertexColorMaterial');
            if (!def.name) def.name = t('import.mesh.unnamedMaterial', { number: ++unnamed });
            // origin: file + order in the file – stable, so scene states find the material again; with the file
            // name, materials of different models no longer collide (previously all were import:0, import:1 …)
            id = materialManager.create({ ...def, source: 'import', origin: `import:${fileName}:${materialIds.size}` }, { silent: true }).def.id;
            materialIds.set(src, id);
        }
        return id;
    };
}

// --- lean FBX (fbx/fbx-parse.js in a worker) ---

/**
 * Read a binary FBX in a worker. Resolves { scene, geometries } – or { buffer } (the file handed back) when it is
 * animated / has deformers and `fallback` allows three.js' loader for it.
 */
function readFbxLean(buffer, { fallback, onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./fbx/fbx-worker.js', import.meta.url), { type: 'module', name: 'fbx' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.buildingGeometries'), data.done / data.total); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else if (data.type === 'fallback') resolve({ buffer: data.buffer, cameraScene: data.cameraScene });
            else resolve({ scene: data.scene, geometries: data.geometries });
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'FBX worker failed')); };
        worker.postMessage({ buffer, fallback }, [buffer]);
    });
}

const fbxUp = scene => (scene.upAxis === 2 ? new THREE.Matrix4().makeRotationX(-Math.PI / 2) : new THREE.Matrix4());   // Z up → Y up (as FBXLoader)

/**
 * Cameras of an FBX scene description (fbx-parse.js) in the model's space – also for files FBXLoader loads (same up
 * axis and unit). An FBX camera looks along its local +X with Y up. world: the models' world matrices if computed already
 */
function fbxCameras(scene, scale, world = null) {
    if (!scene?.cameras?.length) return [];
    const up = fbxUp(scene);
    if (!world) {
        world = [];
        scene.models.forEach((m, i) => { world[i] = new THREE.Matrix4().multiplyMatrices(m.parent >= 0 ? world[m.parent] : up, fbxLocalMatrix(m.transform)); });
    }
    return scene.cameras.map(c => importedCamera(c.name, new THREE.Matrix4().multiplyMatrices(c.parent >= 0 ? world[c.parent] : up, fbxLocalMatrix(c.transform)), {
        forward: new THREE.Vector3(1, 0, 0), up: UP_Y, target: c.target >= 0 ? new THREE.Vector3().setFromMatrixPosition(world[c.target]) : null,
        distance: c.distance, fov: c.fov, fovAxis: c.fovAxis, aspect: c.aspect, scale,
    }));
}

/**
 * Lights of an FBX scene description (fbx-parse.js) in the model's space. An FBX light shines along its local −Y; the
 * intensity is relative (percent / 100, no unit) – the viewer keeps the ratios. Area lights: 1 × 1 unit times the
 * node's scale (no size in the file). world: the models' world matrices if computed already
 */
function fbxLights(scene, scale, world = null) {
    if (!scene?.lights?.length) return [];
    const up = fbxUp(scene);
    if (!world) {
        world = [];
        scene.models.forEach((m, i) => { world[i] = new THREE.Matrix4().multiplyMatrices(m.parent >= 0 ? world[m.parent] : up, fbxLocalMatrix(m.transform)); });
    }
    // Blender's exporter (detected from the header): linear colours, intensity = its light value – watts (point, spot,
    // area) and W/m² (sun), converted like its glTF exporter (683 lm/W; point/spot over the sphere 4π, area: radiance
    // P / (π · A)); others: sRGB colours, relative intensity
    const blender = /^blender/i.test(scene.creator || '');
    return scene.lights.filter(l => l.visible && l.enabled && l.intensity > 0).map(l => {
        const matrix = new THREE.Matrix4().multiplyMatrices(l.parent >= 0 ? world[l.parent] : up, fbxLocalMatrix(l.transform));
        const kind = l.type === 1 ? 'directional' : l.type === 2 ? 'spot' : l.type === 3 ? (l.areaShape === 1 ? 'disc' : 'rect') : 'point';
        const outer = Math.min(Math.max(l.outer, 1), 179) / 2;
        const size = new THREE.Vector3().setFromMatrixScale(matrix);
        const areaM2 = Math.max(size.x * size.y * (kind === 'disc' ? Math.PI / 4 : 1) * (scale / 1000) ** 2, 1e-9);
        const physical = !blender ? { intensity: l.intensity, unit: 'relative' }
            : kind === 'directional' ? { intensity: l.intensity * 683, unit: 'lux' }
                : kind === 'rect' || kind === 'disc' ? { intensity: l.intensity * 683 / (Math.PI * areaM2), unit: 'nits' }
                    : { intensity: l.intensity * 683 / (4 * Math.PI), unit: 'candela' };
        return importedLight(l.name, matrix, {
            kind, forward: FORWARD_MINUS_Y, color: blender ? l.color : new THREE.Color().setRGB(...l.color, THREE.SRGBColorSpace).toArray(), ...physical,
            target: l.target >= 0 ? new THREE.Vector3().setFromMatrixPosition(world[l.target]) : null,
            angle: kind === 'spot' ? outer : null, penumbra: kind === 'spot' ? Math.min(Math.max(1 - Math.min(l.inner, l.outer) / Math.max(l.outer, 1e-6), 0), 1) : null,
            width: kind === 'rect' || kind === 'disc' ? size.x * scale : null, height: kind === 'rect' || kind === 'disc' ? size.y * scale : null,
            scale, noScaleSize: true,
        });
    });
}

// FBX RotationOrder (extrinsic eXYZ …) → three.js (intrinsic) Euler order
const FBX_EULER = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];

// Local matrix of an FBX model (FBX SDK: T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹)
function fbxLocalMatrix(tr) {
    const m = new THREE.Matrix4(), tmp = new THREE.Matrix4();
    const trans = v => new THREE.Matrix4().makeTranslation(v?.[0] || 0, v?.[1] || 0, v?.[2] || 0);
    const rot = (v, order) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(v || [0, 0, 0]).map(THREE.MathUtils.degToRad), order));
    const pre = rot(tr.preRotation, 'ZYX'), r = rot(tr.rotation, FBX_EULER[tr.rotationOrder] || 'ZYX'), post = rot(tr.postRotation, 'ZYX').invert();
    const rp = trans(tr.rotationPivot), sp = trans(tr.scalingPivot);
    const s = tr.scale ? new THREE.Matrix4().makeScale(...tr.scale) : new THREE.Matrix4();
    m.copy(trans(tr.translation)).multiply(trans(tr.rotationOffset)).multiply(rp).multiply(pre).multiply(r).multiply(post)
        .multiply(tmp.copy(rp).invert()).multiply(trans(tr.scalingOffset)).multiply(sp).multiply(s).multiply(tmp.copy(sp).invert());
    return m;
}

/** Lean FBX result → { nodes, geometries, meshes } like convert(); materials as three.js Phong/Lambert like FBXLoader */
async function convertLeanFbx({ scene, geometries: parts }, source, materialManager) {
    const scale = 10 * (scene.unitScaleFactor || 1);   // cm × UnitScaleFactor → mm
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);
    const { manager, missing, idle, release } = createResolver(source);
    const embedded = [];
    try {
        // textures: embedded ones from their bytes, the others by file name (supplied files / next to the model)
        const loader = new THREE.TextureLoader(manager);
        const textures = scene.textures.map(tx => {
            let url = tx.file.replace(/\\/g, '/');
            if (tx.content) { url = URL.createObjectURL(new Blob([tx.content])); embedded.push(url); }
            if (!url) return null;
            const texture = loader.load(url);
            texture.name = tx.name;
            if (!tx.content) texture.userData.sourceUrl = tx.file;   // the path in the file (missing image → its node)
            texture.wrapS = tx.wrapU === 1 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            texture.wrapT = tx.wrapV === 1 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            if (tx.uvScaling) texture.repeat.set(tx.uvScaling[0], tx.uvScaling[1]);
            if (tx.uvTranslation) texture.offset.set(tx.uvTranslation[0], tx.uvTranslation[1]);
            return texture;
        });
        const srgb = v => (Array.isArray(v) ? THREE.ColorManagement.colorSpaceToWorking(new THREE.Color().fromArray(v), THREE.SRGBColorSpace) : undefined);
        const SLOTS = { DiffuseColor: 'map', 'Maya|TEX_color_map': 'map', Bump: 'bumpMap', NormalMap: 'normalMap', 'Maya|TEX_normal_map': 'normalMap',
            EmissiveColor: 'emissiveMap', TransparentColor: 'alphaMap', TransparencyFactor: 'alphaMap', 'Maya|TEX_ao_map': 'aoMap' };
        const materials = scene.materials.map(m => {
            const p = m.props;
            const params = {};
            const color = srgb(p.Diffuse) || srgb(p.DiffuseColor);
            if (color) params.color = color;
            const emissive = srgb(p.Emissive) || srgb(p.EmissiveColor);
            if (emissive) params.emissive = emissive;
            if (p.EmissiveFactor !== undefined) params.emissiveIntensity = Number(p.EmissiveFactor);
            // transparency like FBXLoader: 1 − TransparencyFactor, else Opacity, else opaque
            let opacity = 1 - (p.TransparencyFactor !== undefined ? Number(p.TransparencyFactor) : 0);
            if (opacity === 1 || opacity === 0) opacity = p.Opacity !== undefined ? Number(p.Opacity) : 1;
            params.opacity = opacity;
            if (opacity < 1) params.transparent = true;
            if (p.Shininess !== undefined) params.shininess = Number(p.Shininess);
            if (p.BumpFactor !== undefined) params.bumpScale = Number(p.BumpFactor);
            for (const [rel, ti] of Object.entries(m.maps)) {
                const slot = SLOTS[rel], tex = textures[ti];
                if (!slot || !tex) continue;
                if (slot === 'map' || slot === 'emissiveMap') tex.colorSpace = THREE.SRGBColorSpace;
                params[slot] = tex;
            }
            const material = m.shading === 'lambert' ? new THREE.MeshLambertMaterial(params) : new THREE.MeshPhongMaterial(params);
            material.name = m.name;
            return material;
        });
        await idle();

        const materialId = materialIdFactory(materialManager, scale, source.name);
        // nodes: one root for several top-level models (like FBXLoader's scene group), parents before children
        const top = scene.models.filter(m => m.parent < 0).length;
        const nodes = [];
        const base = top > 1 ? (nodes.push({ name: '', parent: -1 }), 1) : 0;
        const up = fbxUp(scene);
        const world = [], visible = [];
        const geometries = [], meshes = [];
        const cache = new Map();   // lean geometry → our geometry indices (models sharing a geometry = instances)
        let instance = 0;
        scene.models.forEach((m, i) => {
            const parentWorld = m.parent >= 0 ? world[m.parent] : up;
            world[i] = new THREE.Matrix4().multiplyMatrices(parentWorld, fbxLocalMatrix(m.transform));
            visible[i] = m.visible && (m.parent < 0 || visible[m.parent]);
            nodes.push({ name: m.name, parent: m.parent >= 0 ? base + m.parent : (base ? 0 : -1) });
            if (!visible[i]) return;
            const node = base + i;
            for (const lg of m.geometries) {
                let gis = cache.get(lg);
                if (!gis) {
                    const worldScale = world[i].getMaxScaleOnAxis() * scale;
                    gis = (parts[lg] || []).map(part => {
                        let normals = part.normals;
                        if (!normals) computeNormals(part.positions, part.index, normals = new Float32Array(part.positions.length));
                        const g = part.uvs ? { positions: part.positions, normals, index: part.index, uvs: part.uvs, colors: part.colors }
                            : boxProject({ positions: part.positions, normals, index: part.index, colors: part.colors }, UV_TILE / Math.max(worldScale, 1e-12));
                        geometries.push({ positions: g.positions, normals: g.normals, index: g.index, uvs: g.uvs, colors: g.colors, name: m.name });
                        return { gi: geometries.length - 1, material: part.material };
                    });
                    cache.set(lg, gis);
                }
                const matrix = new THREE.Matrix4().multiplyMatrices(toMm, world[i]).toArray();
                for (const { gi, material } of gis) {
                    const src = m.materials.length ? materials[m.materials[material] ?? m.materials[0]] : null;
                    meshes.push({ geometry: gi, matrix, materialId: null, src, name: m.name, node, instance, key: `${instance}/${material}` });
                }
                instance++;
            }
        });
        // materials once every geometry is known: one used with colours per vertex shows them (before it is converted)
        for (const mm of meshes) if (geometries[mm.geometry].colors && mm.src) mm.src.vertexColors = true;
        for (const mm of meshes) {
            mm.materialId = materialId(mm.src ?? (geometries[mm.geometry].colors ? VERTEX_COLOR_MATERIAL : null));
            delete mm.src;
        }
        return { result: { nodes, geometries, meshes, cameras: fbxCameras(scene, scale, world), lights: fbxLights(scene, scale, world), animation: null }, missing };
    } finally {
        release();
        setTimeout(() => embedded.forEach(u => URL.revokeObjectURL(u)), 1000);
    }
}

// --- cameras of a file (MAX, FBX, glTF) → saved views in the viewer (docs/mesh-import.md "Kameras") ---

/**
 * One camera in the model's space (mm, Y up – like the meshes): { name, position, direction, target (null: unknown – the
 * viewer picks a point in front of the model), up, fov (degrees along fovAxis 'h' | 'v' | 'd'), aspect (width / height
 * of the file's frame, null = unknown) }. world: the camera's matrix (file units, Y up); forward / up: its view direction and up
 * vector in its own space; target: the point looked at (world, file units), else `distance` along the view direction.
 */
function importedCamera(name, world, { forward, up, target = null, distance = 0, fov, fovAxis = 'h', aspect = null, scale, near = 0 }) {
    const position = new THREE.Vector3().setFromMatrixPosition(world);
    const dir = forward.clone().transformDirection(world);
    let look = target?.clone() ?? (distance > 0 ? position.clone().addScaledVector(dir, distance) : null);
    if (look && look.distanceToSquared(position) < 1e-12) look = null;
    return {
        name, position: position.multiplyScalar(scale).toArray(), direction: dir.toArray(), target: look ? look.multiplyScalar(scale).toArray() : null,
        up: up.clone().transformDirection(world).toArray(), fov, fovAxis, aspect: aspect > 0 ? aspect : null,
        ...(near > 0 ? { near: near * new THREE.Vector3().setFromMatrixScale(world).x * scale } : {}),   // clip start, mm
    };
}
const FORWARD_MINUS_Z = new THREE.Vector3(0, 0, -1), UP_Y = new THREE.Vector3(0, 1, 0), FORWARD_MINUS_Y = new THREE.Vector3(0, -1, 0);

// --- lights of a file (glTF, FBX, MAX, C4D, Blender, USD) → scene lights in the viewer (docs/mesh-import.md "Lichter") ---

/**
 * One light in the model's space (mm, Y up – like the meshes and cameras):
 *   { name, kind ('directional' | 'point' | 'spot' | 'rect' | 'disc'), position, direction (where it shines), target
 *     (point aimed at or null), color (linear rgb), intensity + unit ('lux' directional, 'candela' point/spot – peak,
 *     'nits' area luminance, 'relative' – no unit: the illuminance at the model, as lights without falloff give it),
 *     angle (spot: half angle of the cone, degrees), penumbra (0…1: share of the cone that fades), width / height
 *     (area, mm), radius (soft shadows, mm) }
 * world: the light's matrix (file units, Y up); forward: its direction in its own space; sizes are in file units
 * (× scale → mm) unless noScaleSize (already mm).
 */
function importedLight(name, world, { kind, forward, color = [1, 1, 1], intensity = 1, unit = 'relative', target = null, distance = 0,
    angle = null, penumbra = null, width = null, height = null, radius = null, scale, noScaleSize = false }) {
    const position = new THREE.Vector3().setFromMatrixPosition(world);
    const dir = forward.clone().transformDirection(world);
    let aim = target?.clone() ?? (distance > 0 ? position.clone().addScaledVector(dir, distance) : null);
    if (aim && aim.distanceToSquared(position) < 1e-12) aim = null;
    if (aim) dir.copy(aim).sub(position).normalize();
    const mm = v => (v > 0 ? v * (noScaleSize ? 1 : scale) : null);
    return {
        name, kind, position: position.multiplyScalar(scale).toArray(), direction: dir.toArray(), target: aim ? aim.multiplyScalar(scale).toArray() : null,
        color: color.map(c => Math.max(Number(c) || 0, 0)), intensity: Math.max(Number(intensity) || 0, 0), unit,
        angle, penumbra, width: mm(width), height: mm(height), radius: mm(radius),
    };
}

/**
 * A Blender light (blend-parse.js) → importedLight. Shines along its −Z. Watts → photometric like Blender's glTF
 * exporter (683 lm/W): point/spot candela = P / 4π (a spot has the power of the point light it cuts), sun lux = W/m²,
 * area luminance = P / (π · A) (A in m² – Blender's units × metersPerUnit; scale = mm per unit).
 */
function blendLight(l, scale) {
    const m = l.object.matrixWorld, s = new THREE.Vector3().setFromMatrixScale(m);
    const kind = l.type === 1 ? 'directional' : l.type === 2 ? 'spot' : l.type === 4 ? (l.shape === 4 || l.shape === 5 ? 'disc' : 'rect') : 'point';
    const width = l.sizeX * s.x, height = (l.shape === 1 || l.shape === 5 ? l.sizeY : l.sizeX) * s.y;
    const areaM2 = Math.max(width * height * (kind === 'disc' ? Math.PI / 4 : 1) * (scale / 1000) ** 2, 1e-9);
    const physical = kind === 'directional' ? { intensity: l.energy * 683, unit: 'lux' }
        : kind === 'rect' || kind === 'disc' ? { intensity: l.energy * 683 / (Math.PI * areaM2), unit: 'nits' }
            : { intensity: l.energy * 683 / (4 * Math.PI), unit: 'candela' };
    return importedLight(l.name, m, {
        kind, forward: FORWARD_MINUS_Z, color: l.color, ...physical,
        angle: kind === 'spot' ? THREE.MathUtils.radToDeg(l.spotSize) / 2 : null, penumbra: kind === 'spot' ? l.spotBlend : null,
        width: kind === 'rect' || kind === 'disc' ? width : null, height: kind === 'rect' || kind === 'disc' ? height : null,
        radius: l.radius > 0 ? l.radius * s.x : null, scale,
    });
}

/**
 * A C4D light (c4d/c4d-build.js, values from c4d-parse.js readLight) → importedLight. Shines along its −Z after the
 * mirroring. Types: omni / tube → point, spot / square spot → spot (cone = half the stored whole angle, penumbra =
 * 1 − inner / outer), infinite / parallel / parallel spots → directional, area: rectangle (size X = 2 × outer radius
 * along X, size Y along Y), disc (2 × outer radius), other shapes → point with that radius, photometric → point (IES
 * file name in iesFile). Brightness (1 = 100 %) without falloff: relative; with falloff (inverse square & co.) the
 * brightness holds at the falloff radius r0: candela = brightness × r0² (m), area luminance = that / area. Photometric
 * units on: intensity × brightness in candela, lumen (point / spot: / 4π, area: / (π · A)) or lux.
 */
function c4dLight(l, scale) {
    const m = l.object.matrixWorld, s = new THREE.Vector3().setFromMatrixScale(m);
    const area = l.type === 8, round = l.shape === 0;
    const kind = l.type === 1 || l.type === 2 ? 'spot' : l.type >= 3 && l.type <= 6 ? 'directional'
        : area && (l.shape === 1 || round) ? (round ? 'disc' : 'rect') : 'point';
    const sized = kind === 'rect' || kind === 'disc';
    const width = 2 * l.radius * s.x, height = (round ? 2 * l.radius : l.sizeY) * s.y;
    const areaM2 = Math.max(width * height * (round ? Math.PI / 4 : 1) * (scale / 1000) ** 2, 1e-9);
    let physical;
    if (l.photometric) {
        const k = l.photometric.intensity * l.brightness, unit = l.photometric.unit;   // 0 lumen, 1 candela, 2 lux
        physical = kind === 'directional' ? { intensity: k, unit: 'lux' }
            : sized ? { intensity: unit === 0 ? k / (Math.PI * areaM2) : unit === 1 ? k / areaM2 : k / Math.PI, unit: 'nits' }
                : { intensity: unit === 0 ? k / (4 * Math.PI) : k, unit: 'candela' };
    } else if (kind === 'directional' || !l.falloff) physical = { intensity: l.brightness, unit: 'relative' };
    else {
        const r0 = Math.max(l.decay * (scale / 1000), 1e-6);   // m
        physical = sized ? { intensity: l.brightness * r0 * r0 / areaM2, unit: 'nits' } : { intensity: l.brightness * r0 * r0, unit: 'candela' };
    }
    const outer = Math.min(Math.max(l.outer, 1e-4), THREE.MathUtils.degToRad(175));
    const light = importedLight(l.name, m, {
        kind, forward: FORWARD_MINUS_Z, color: l.color, ...physical,
        target: l.target ? new THREE.Vector3().setFromMatrixPosition(l.target.matrixWorld) : null,
        angle: kind === 'spot' ? THREE.MathUtils.radToDeg(outer) / 2 : null,
        penumbra: kind === 'spot' ? Math.min(Math.max(1 - Math.min(l.inner, outer) / outer, 0), 1) : null,
        width: sized ? width : null, height: sized ? height : null,
        radius: kind === 'point' && area && l.radius > 0 ? l.radius * s.x : null, scale,
    });
    if (l.iesFile) light.iesFile = l.iesFile.split(/[\\/]/).pop();
    return light;
}

/**
 * A UsdLux light → importedLight. Shines along its −Z (rect: width along X, height along Y). Radiance = intensity ×
 * 2^exposure × colour; normalize divides it by the light's area (sphere 4πr², rect, disc πr²) – the power is then
 * π × intensity whatever the size. Distant light: illuminance = intensity (normalize) or intensity × the disc's solid
 * angle. Sphere light → point (spot with ShapingAPI: cone angle = half angle, softness = penumbra), intensity
 * Φ / 4π. Units as authored (scale = mm per stage unit).
 */
function usdLight(o, scale) {
    const u = o.userData.usdLight, m = o.matrixWorld, s = new THREE.Vector3().setFromMatrixScale(m);
    const k = u.intensity * 2 ** u.exposure;
    const unitM = scale / 1000;   // stage unit in metres
    const common = { forward: FORWARD_MINUS_Z, color: [o.color.r, o.color.g, o.color.b], scale };
    if (u.typeName === 'DistantLight') {
        const half = THREE.MathUtils.degToRad(Math.max(u.angle, 1e-3)) / 2;
        return importedLight(o.name, m, { ...common, kind: 'directional', intensity: u.normalize ? k : k * 2 * Math.PI * (1 - Math.cos(half)), unit: 'lux' });
    }
    if (u.typeName === 'RectLight' || u.typeName === 'DiskLight') {
        const disc = u.typeName === 'DiskLight';
        const width = (disc ? 2 * u.radius : u.width) * s.x, height = (disc ? 2 * u.radius : u.height) * s.y;
        const areaM2 = Math.max(width * height * (disc ? Math.PI / 4 : 1) * unitM ** 2, 1e-12);
        return importedLight(o.name, m, { ...common, kind: disc ? 'disc' : 'rect', intensity: u.normalize ? k / areaM2 : k, unit: 'nits', width, height });
    }
    const r = u.radius * s.x, areaM2 = 4 * Math.PI * (r * unitM) ** 2;
    const power = Math.PI * k * (u.normalize ? 1 : areaM2);
    const spot = u.coneAngle > 0 && u.coneAngle < 90;
    return importedLight(o.name, m, {
        ...common, kind: spot ? 'spot' : 'point', intensity: power / (4 * Math.PI), unit: 'candela',
        angle: spot ? u.coneAngle : null, penumbra: spot ? Math.min(Math.max(u.softness, 0), 1) : null, radius: r > 0 ? r : null,
    });
}

// --- Blender (blend/blend-parse.js in a worker) ---

function readBlendLean(buffer, { onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./blend/blend-worker.js', import.meta.url), { type: 'module', name: 'blend' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.reading', { name: 'Blender' }), data.done); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data.scene);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Blender worker failed')); };
        worker.postMessage({ buffer }, [buffer]);
    });
}

// --- OBJ (obj/obj-parse.js in a worker) ---

function readObjLean(buffer, { onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./obj/obj-worker.js', import.meta.url), { type: 'module', name: 'obj' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.reading', { name: 'OBJ' }), data.done); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data.scene);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'OBJ worker failed')); };
        worker.postMessage({ buffer }, [buffer]);
    });
}

// --- C4D (c4d/c4d-parse.js in a worker) ---

function readC4dLean(buffer, { onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./c4d/c4d-worker.js', import.meta.url), { type: 'module', name: 'c4d' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.reading', { name: 'C4D' }), data.done); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data.scene);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'C4D worker failed')); };
        worker.postMessage({ buffer }, [buffer]);
    });
}

// --- MAX (max/max-parse.js in a worker) ---

function readMaxLean(buffer, { onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./max/max-worker.js', import.meta.url), { type: 'module', name: 'max' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.buildingGeometries'), data.done / data.total); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve({ scene: data.scene, geometries: data.geometries });
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'MAX worker failed')); };
        worker.postMessage({ buffer }, [buffer]);
    });
}

// MAX Euler orders (XYZ = about X first, XZY, YZX, YXZ, ZXY, ZYX) → three.js orders (intrinsic, reversed)
const MAX_EULER = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];
const maxQuaternion = r => {
    if (r.euler) return new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.euler, MAX_EULER[r.order] || 'ZYX'));
    if (r.list) return r.list.reduce((q, x) => maxQuaternion(x).multiply(q), new THREE.Quaternion());   // first applied first
    return new THREE.Quaternion(...r.quat);
};
// translation · rotation · scale along the scale axis (axis · S · axis⁻¹)
function maxMatrix(position, quaternion, scale, axis) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(1, 1, 1));
    const a = new THREE.Quaternion(...axis);
    const s = new THREE.Matrix4().makeRotationFromQuaternion(a).multiply(new THREE.Matrix4().makeScale(...scale))
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(a.clone().invert()));
    return m.multiply(s);
}

/**
 * A MAX light (max-parse.js lightOf) → importedLight. matrix: the light's (file units, Y up; −Z = where it shines);
 * target: the aimed-at point of a target light. Colours sRGB (like the materials), times the kelvin colour.
 *   - standard: multiplier as relative intensity; with inverse-square decay MAX keeps the multiplier up to the decay
 *     start r0 and falls off as (r0 / d)² beyond – a point light of multiplier × r0² (m²) candela; spots: hotspot /
 *     falloff are full angles → half angle of the falloff, penumbra 1 − hotspot / falloff (rectangular cone → round)
 *   - photometric: candela (× dimmer); spotlight distribution → spot, rectangle / disc emitters → area light with
 *     luminance cd / A (uniform diffuse = the emitter's cosine lobe), uniform diffuse from a point → spot over the
 *     hemisphere, photometric web → point light (`iesFile`: the profile's file name), line / sphere / cylinder → point
 *   - render plugin area light: units → luminance – default "image" units taken as luminance (multiplier), lm / W over
 *     the emitting area (L = Φ / (π A), 683 lm/W); sphere → point light of L × π r²
 */
function maxLight(name, matrix, L, target, scale) {
    const color = new THREE.Color().setRGB(...L.color, THREE.SRGBColorSpace).toArray();
    if (L.kelvin > 0) { const k = kelvinRgb(L.kelvin); for (let i = 0; i < 3; i++) color[i] *= k[i]; }
    const s = new THREE.Vector3().setFromMatrixScale(matrix);   // node scale (aimed lights: 1)
    const m2 = (scale / 1000) ** 2;                               // file unit² → m²
    const common = { forward: FORWARD_MINUS_Z, color, target, scale };
    const cone = (hot, fall) => ({ angle: Math.min(Math.max(fall, 0.5), 179) / 2, penumbra: Math.min(Math.max(1 - Math.min(hot, fall) / Math.max(fall, 1e-6), 0), 1) });
    if (L.type === 'omni' || L.type === 'spot' || L.type === 'directional') {
        if (!(L.multiplier > 0)) return null;   // a negative multiplier darkens in MAX
        if (L.type === 'directional') return importedLight(name, matrix, { ...common, kind: 'directional', intensity: L.multiplier, unit: 'relative' });
        const physical = L.decay === 2 && L.decayStart > 0 ? { intensity: L.multiplier * L.decayStart ** 2 * m2, unit: 'candela' } : { intensity: L.multiplier, unit: 'relative' };
        return importedLight(name, matrix, { ...common, kind: L.type === 'spot' ? 'spot' : 'point', ...physical, ...(L.type === 'spot' ? cone(L.hotspot, L.falloff) : {}) });
    }
    if (L.type === 'photometric') {
        if (!(L.candela > 0)) return null;
        const radius = (L.shape === 'sphere' || L.shape === 'cylinder' || L.shape === 'disc') && L.radius > 0 ? L.radius * s.x : null;
        if (L.distribution === 1) return importedLight(name, matrix, { ...common, kind: 'spot', intensity: L.candela, unit: 'candela', ...cone(L.hotspot, L.falloff), radius });
        if (L.distribution !== 3 && (L.shape === 'rect' || L.shape === 'disc')) {
            const disc = L.shape === 'disc';
            const width = (disc ? 2 * L.radius : L.width) * s.x, height = (disc ? 2 * L.radius : L.length) * s.y;
            const area = Math.max(width * height * (disc ? Math.PI / 4 : 1) * m2, 1e-12);
            return importedLight(name, matrix, { ...common, kind: L.shape, intensity: L.candela / area, unit: 'nits', width, height });
        }
        if (L.distribution === 2) return importedLight(name, matrix, { ...common, kind: 'spot', intensity: L.candela, unit: 'candela', angle: 90, penumbra: 1, radius });
        const light = importedLight(name, matrix, { ...common, kind: 'point', intensity: L.candela, unit: 'candela', radius });
        if (L.distribution === 3 && L.web) light.iesFile = L.web.split(/[\\/]/).pop();
        return light;
    }
    if (L.type === 'area') {
        if (!(L.multiplier > 0)) return null;
        const r = L.halfLength * s.x;
        const width = L.shape === 'disc' ? 2 * r : 2 * L.halfLength * s.x, height = L.shape === 'disc' ? 2 * r : 2 * L.halfWidth * s.y;
        const areaM2 = Math.max((L.shape === 'sphere' ? 4 * Math.PI * r * r : L.shape === 'disc' ? Math.PI * r * r : width * height) * m2, 1e-12);
        const v = L.multiplier;
        const nits = [v, v / (Math.PI * areaM2), v, 683 * v / (Math.PI * areaM2), 683 * v][L.units] ?? v;
        if (L.shape === 'sphere') return importedLight(name, matrix, { ...common, kind: 'point', intensity: nits * Math.PI * r * r * m2, unit: 'candela', radius: r > 0 ? r : null });
        return importedLight(name, matrix, { ...common, kind: L.shape === 'disc' ? 'disc' : 'rect', intensity: nits, unit: 'nits', width, height });
    }
    return null;
}

/** .max scene → { nodes, geometries, meshes } like convert(); Physical Materials with their values, others by colour */
async function convertMax({ scene, geometries: parts }, source, materialManager) {
    const scale = scene.unitMm;
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);
    const { manager, missing, idle, release } = createResolver(source);
    try {
        // textures by file name (MAX stores absolute paths of the authoring machine – resolved against the supplied
        // files / next to the model)
        const loader = new THREE.TextureLoader(manager);
        const textures = new Map();
        // loaded = only textures whose image arrived (after idle(); a missing one keeps the material's colour)
        let loaded = false;
        const texture = (i, color) => {
            if (i == null || i < 0 || !scene.textures[i]) return null;
            const key = `${i}/${color}`;
            if (loaded) { const tex = textures.get(key); return tex && hasImage(tex) ? tex : null; }
            if (!textures.has(key)) {
                const tex = loader.load(scene.textures[i].file.replace(/\\/g, '/'));
                tex.name = scene.textures[i].file.split(/[\\/]/).pop();
                tex.userData.sourceUrl = scene.textures[i].file;
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                if (color) tex.colorSpace = THREE.SRGBColorSpace;
                // the Bitmap's placement: MAX tiles and turns about the map's centre, the offset counts before the tiling
                // (u' = (u − offset − ½) × tiling + ½ – the centre pivot fits a demo scene: tiling 0.2 across a band shows
                // the middle of its picture, where the lettering is)
                const { offset = [0, 0], tiling = [1, 1], angle = 0 } = scene.textures[i];
                tex.center.set(0.5, 0.5);
                tex.repeat.set(tiling[0], tiling[1]);
                tex.offset.set(-tiling[0] * offset[0], -tiling[1] * offset[1]);
                tex.rotation = angle;
                textures.set(key, tex);
            }
            return textures.get(key);
        };
        const srgb = c => THREE.ColorManagement.colorSpaceToWorking(new THREE.Color().fromArray(c), THREE.SRGBColorSpace);
        const built = new Map();
        const threeMaterial = i => {
            const m = scene.materials[i];
            if (!m || m.kind === 'multi') return null;
            if (built.has(i)) return built.get(i);
            let mat;
            if (m.kind === 'physical') {
                const params = {
                    color: m.color ? srgb(m.color.map(v => v * (m.baseWeight ?? 1))) : new THREE.Color(0.8, 0.8, 0.8),
                    roughness: Math.min(1, Math.max(0, m.roughnessInverted ? 1 - m.roughness : m.roughness)),
                    metalness: m.metalness,
                };
                if (m.transparency > 0) Object.assign(params, { transmission: m.transparency, ior: m.ior || 1.52, thickness: 1 });
                if (m.transparency > 0 && m.transColor) params.attenuationColor = srgb(m.transColor);
                if (m.emission > 0 && m.emitColor) { params.emissive = srgb(m.emitColor); params.emissiveIntensity = m.emission; }
                if (m.coating > 0) Object.assign(params, { clearcoat: m.coating, clearcoatRoughness: m.coatRoughness });
                const map = texture(m.map, true), bump = texture(m.bumpMap, false), rough = texture(m.roughnessMap, false);
                if (map) { params.map = map; params.color = new THREE.Color(1, 1, 1); }   // the map replaces the colour
                else if (m.map >= 0 && m.preview) params.color = srgb(m.preview);   // map missing: the colour it gave in MAX' preview
                if (bump) params.bumpMap = bump;
                if (rough && !m.roughnessInverted) params.roughnessMap = rough;
                mat = new THREE.MeshPhysicalMaterial(params);
            } else {
                // Standard, plugin materials … : the colour of the material preview; a render plugin's material also its
                // diffuse map and bump (the preview colour stays while the picture is missing)
                mat = new THREE.MeshStandardMaterial({ color: m.color ? srgb(m.color) : new THREE.Color(0.7, 0.7, 0.7), roughness: 0.5, metalness: 0 });
                if (m.kind === 'plugin') {
                    const map = texture(m.map, true), bump = texture(m.bumpMap, false);
                    if (map) { mat.map = map; mat.color.set(1, 1, 1); }
                    if (bump) mat.bumpMap = bump;
                }
            }
            mat.name = m.name;
            built.set(i, mat);
            return mat;
        };
        // material of a face group: Multi/Sub-Object → sub-material by material ID (wraps like MAX)
        const resolve = (i, id) => {
            const m = scene.materials[i];
            if (m?.kind === 'multi') return m.sub.length ? resolve(m.sub[id % m.sub.length], id) : null;
            return threeMaterial(i);
        };
        const wire = new Map();   // no material: the object's wire colour (as in MAX' viewport)
        const wireMaterial = c => {
            const hex = new THREE.Color().fromArray(c).getHexString();
            if (!wire.has(hex)) wire.set(hex, new THREE.MeshStandardMaterial({ name: `#${hex}`, color: srgb(c), roughness: 0.6, metalness: 0 }));
            return wire.get(hex);
        };
        for (const m of scene.materials) if (m.kind === 'physical' || m.kind === 'plugin') { texture(m.map, true); texture(m.bumpMap, false); texture(m.roughnessMap, false); }
        await idle();
        loaded = true;

        const materialId = materialIdFactory(materialManager, scale, source.name);
        // only nodes that show something or hold such nodes (no lights, cameras, empty helpers)
        const n = scene.nodes.length;
        const keep = new Uint8Array(n);
        for (let k = n - 1; k >= 0; k--) {   // children after parents: bottom-up
            if (scene.nodes[k].geometry >= 0 && parts[scene.nodes[k].geometry]?.length) keep[k] = 1;
            if (keep[k] && scene.nodes[k].parent >= 0) keep[scene.nodes[k].parent] = 1;
        }
        const top = scene.nodes.filter((m, k) => keep[k] && m.parent < 0).length;
        const nodes = [];
        const base = top > 1 ? (nodes.push({ name: '', parent: -1 }), 1) : 0;
        const ours = new Int32Array(n).fill(-1);
        const up = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // Z up → Y up
        const world = [];
        const geometries = [], meshes = [];
        const cache = new Map();   // max geometry → our geometry indices (nodes sharing an object = instances)
        let instance = 0;
        scene.nodes.forEach((m, k) => {
            const tr = m.transform;
            const local = maxMatrix(tr.position, maxQuaternion(tr.rotation), tr.scale, tr.scaleAxis);
            world[k] = new THREE.Matrix4().multiplyMatrices(m.parent >= 0 ? world[m.parent] : up, local);
            if (!keep[k]) return;
            ours[k] = nodes.length;
            nodes.push({ name: m.name, parent: m.parent >= 0 && ours[m.parent] >= 0 ? ours[m.parent] : (base ? 0 : -1) });
            if (m.geometry < 0 || !parts[m.geometry]?.length) return;
            const o = m.offset;
            const objectMatrix = new THREE.Matrix4().multiplyMatrices(world[k], maxMatrix(o.position, new THREE.Quaternion(...o.quat), o.scale, o.scaleAxis));
            let gis = cache.get(m.geometry);
            if (!gis) {
                const worldScale = objectMatrix.getMaxScaleOnAxis() * scale;
                gis = parts[m.geometry].map(part => {
                    const g = part.uvs ? part : boxProject(part, UV_TILE / Math.max(worldScale, 1e-12));
                    geometries.push({ positions: g.positions, normals: g.normals, index: g.index, uvs: g.uvs, colors: g.colors, name: m.name });
                    return { gi: geometries.length - 1, material: part.material };
                });
                cache.set(m.geometry, gis);
            }
            const matrix = new THREE.Matrix4().multiplyMatrices(toMm, objectMatrix).toArray();
            for (const { gi, material } of gis) {
                const src = m.material >= 0 ? resolve(m.material, material) : (m.wireColor ? wireMaterial(m.wireColor) : null);
                meshes.push({ geometry: gi, matrix, materialId: materialId(src), name: m.name, node: ours[k], instance, key: `${instance}/${material}` });
            }
            instance++;
        });
        // cameras and lights: MAX looks / shines along local −Z with Y up; a Look At controller aims at its target node,
        // level to the world's up (Z in MAX, Y here) and rolled about the view axis
        const aimed = (k, look) => {
            const position = new THREE.Vector3().setFromMatrixPosition(world[k]);
            const target = new THREE.Vector3().setFromMatrixPosition(world[look.target]);
            const z = position.clone().sub(target).normalize();
            const x = new THREE.Vector3(0, 1, 0).cross(z);
            if (x.lengthSq() < 1e-12) x.set(1, 0, 0); else x.normalize();   // looking straight up/down
            const y = z.clone().cross(x);
            const c = Math.cos(look.roll || 0), s = Math.sin(look.roll || 0);
            const xr = x.clone().multiplyScalar(c).addScaledVector(y, s), yr = y.multiplyScalar(c).addScaledVector(x, -s);
            return { matrix: new THREE.Matrix4().makeBasis(xr, yr, z).setPosition(position), target };
        };
        const cameras = [];
        scene.nodes.forEach((m, k) => {
            if (!m.camera) return;
            const look = m.transform.lookAt;
            const { matrix, target } = look && look.target >= 0 ? aimed(k, look) : { matrix: world[k], target: null };
            cameras.push(importedCamera(m.name, matrix, { forward: FORWARD_MINUS_Z, up: UP_Y, target, distance: m.camera.distance,
                fov: THREE.MathUtils.radToDeg(m.camera.fov), fovAxis: m.camera.fovAxis, aspect: scene.renderAspect, scale }));
        });
        // lights that are on (free lights: node · object offset)
        const lights = [];
        scene.nodes.forEach((m, k) => {
            if (!m.light?.on) return;
            const look = m.transform.lookAt, o = m.offset;
            const { matrix, target } = look && look.target >= 0 ? aimed(k, look)
                : { matrix: new THREE.Matrix4().multiplyMatrices(world[k], maxMatrix(o.position, new THREE.Quaternion(...o.quat), o.scale, o.scaleAxis)), target: null };
            const light = maxLight(m.name, matrix, m.light, target, scale);
            if (light) lights.push(light);
        });
        const result = { nodes, geometries, meshes, cameras, lights, animation: null };
        const u = scene.unsupported;
        if (u.nodes || u.objects.length) result.maxSkipped = { count: u.nodes, what: [...u.modifiers, ...u.objects].map(x => x.name) };
        if (u.approx?.length) result.maxApprox = { count: u.approx.reduce((a, x) => a + x.count, 0), what: u.approx.map(x => x.name) };
        if (u.controllers.length) console.warn('[Import] MAX: transform controllers not read:', u.controllers);
        return { result, missing };
    } finally {
        release();
    }
}

// --- 3MF (3mf/3mf-parse.js in a worker) ---

function read3mfLean(buffer, { onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./3mf/3mf-worker.js', import.meta.url), { type: 'module', name: '3mf' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.buildingGeometries'), data.done / data.total); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data.scene);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || '3MF worker failed')); };
        worker.postMessage({ buffer }, [buffer]);
    });
}

// 3MF transform (3×4, row vectors: x' = x·m00 + y·m10 + z·m20 + m30) → Matrix4
const threeMfMatrix = v => (v ? new THREE.Matrix4().set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1) : new THREE.Matrix4());
const TILE_3MF = { wrap: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping, none: THREE.ClampToEdgeWrapping };

/**
 * 3MF scene → { nodes, geometries, meshes } like convert(): one node per build item and component, objects placed
 * several times share their geometry (instances); base materials / colours / textures as import materials.
 */
async function convert3mf(scene, source, materialManager) {
    const scale = scene.unitMm;
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);
    const up = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // Z up (build plate) → Y up
    // textures from the package (a broken image keeps the material's colour)
    const textures = await Promise.all(scene.textures.map(async tex => {
        const url = URL.createObjectURL(new Blob([tex.bytes], tex.type ? { type: tex.type } : {}));
        try {
            const texture = await new THREE.TextureLoader().loadAsync(url);
            texture.name = tex.name;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = TILE_3MF[tex.tileu] ?? THREE.RepeatWrapping;
            texture.wrapT = TILE_3MF[tex.tilev] ?? THREE.RepeatWrapping;
            return texture;
        } catch {
            console.warn('[Import] 3MF: texture could not be read:', tex.path);
            return null;
        } finally {
            URL.revokeObjectURL(url);
        }
    }));
    const srgb = c => THREE.ColorManagement.colorSpaceToWorking(new THREE.Color(c[0], c[1], c[2]), THREE.SRGBColorSpace);
    // printed parts: plastic look (3MF only carries a display colour)
    const mats = scene.materials.map(m => {
        const map = m.texture >= 0 ? textures[m.texture] : null;
        const mat = new THREE.MeshStandardMaterial({ name: m.name, color: map ? new THREE.Color(1, 1, 1) : srgb(m.color), roughness: 0.5, metalness: 0, map });
        if (m.color[3] < 1) { mat.transparent = true; mat.opacity = m.color[3]; }
        return mat;
    });
    const materialId = materialIdFactory(materialManager, scale, source.name);

    const nodes = [], geometries = [], meshes = [];
    const base = scene.build.length > 1 ? (nodes.push({ name: scene.title || '', parent: -1 }), 1) : 0;
    const cache = new Map();   // 3MF mesh object → our geometry indices (placed several times = instances)
    let instance = 0;
    const visit = (oi, matrix, parent, depth) => {
        const o = scene.objects[oi];
        if (depth > 32) return;   // components referencing each other in a loop (invalid file)
        const node = nodes.length;
        nodes.push({ name: o.name || t('import.mesh.unnamedMesh'), parent });
        const parts = o.geometry >= 0 ? scene.geometries[o.geometry] : null;
        if (parts?.length) {
            let gis = cache.get(o.geometry);
            if (!gis) {
                const worldScale = matrix.getMaxScaleOnAxis() * scale;
                gis = parts.map(part => {
                    const g = part.uvs ? part : boxProject(part, UV_TILE / Math.max(worldScale, 1e-12));
                    return { gi: geometries.push({ positions: g.positions, normals: g.normals, index: g.index, uvs: g.uvs, colors: g.colors, name: o.name }) - 1, material: part.material };
                });
                cache.set(o.geometry, gis);
            }
            const m = new THREE.Matrix4().multiplyMatrices(toMm, matrix).toArray();
            for (const { gi, material } of gis) {
                meshes.push({ geometry: gi, matrix: m, materialId: materialId(material >= 0 ? mats[material] : null), name: nodes[node].name, node, instance, key: `${instance}/${material}` });
            }
            instance++;
        }
        for (const c of o.components) visit(c.object, matrix.clone().multiply(threeMfMatrix(c.transform)), node, depth + 1);
    };
    for (const b of scene.build) visit(b.object, up.clone().multiply(threeMfMatrix(b.transform)), base ? 0 : -1, 0);
    if (scene.unsupported.length) console.warn('[Import] 3MF: not read:', scene.unsupported);
    return { result: { nodes, geometries, meshes, animation: null }, missing: new Set() };
}

const hasMorphs = mesh => !!mesh.geometry?.morphAttributes?.position?.length && !!mesh.morphTargetDictionary;

const DEFAULT_MATERIAL = new THREE.MeshStandardMaterial({ name: 'Standard', color: 0xb0b0b0, roughness: 0.5 });
// files without materials but with colours per vertex (PLY, STL): white × the vertex colours
const VERTEX_COLOR_MATERIAL = new THREE.MeshStandardMaterial({ name: 'Vertex colours', color: 0xffffff, roughness: 0.6, vertexColors: true });

// Own compact buffers per material bucket of a mesh (its groups with that material): only used vertices,
// index always Uint32. One pass over the index for all buckets, every source vertex computed once (posed:
// skinning/morphs once per vertex – previously per group over all vertices, i.e. groups × vertices).
function extractGeometries(mesh, buckets, posed, worldScale) {
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    // colours per vertex only where the material shows them (rgb, linear – three.js / the loaders convert)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const col = materials.some(m => m?.vertexColors) ? geometry.getAttribute('color') : null;
    const src = geometry.index ? geometry.index.array : null;
    const total = src ? src.length : pos.count;
    const nb = buckets.length;

    // 1. distribute the corners: local vertex number per (vertex, bucket); a vertex used by two buckets
    //    (rare) gets its second number from a map
    const owner = new Int32Array(pos.count).fill(-1), local = new Int32Array(pos.count);
    const extra = new Map();
    const out = buckets.map(b => {
        let corners = 0;
        const ranges = b.ranges.map(r => {
            const start = Math.max(0, r.start), end = Math.min(total, start + r.count);
            const count = Math.max(0, end - start - ((end - start) % 3));
            corners += count;
            return [start, count];
        });
        return { ranges, index: new Uint32Array(corners), order: [], nv: 0 };
    });
    for (let b = 0; b < nb; b++) {
        const o = out[b];
        let w = 0;
        for (const [start, count] of o.ranges) {
            for (let i = start; i < start + count; i++) {
                const v = src ? src[i] : i;
                let l;
                if (owner[v] === b) l = local[v];
                else if (owner[v] < 0) { owner[v] = b; l = local[v] = o.nv++; o.order.push(v); }
                else {
                    const k = v * nb + b;
                    l = extra.get(k);
                    if (l === undefined) { l = o.nv++; extra.set(k, l); o.order.push(v); }
                }
                o.index[w++] = l;
            }
        }
    }

    // 2. vertex data once per used source vertex: skinning/morphs only if the pose differs from the file
    //    (a character in its bind pose without active morphs is taken as it is)
    const transform = posed && (mesh.morphTargetInfluences?.some(v => v !== 0) || (mesh.isSkinnedMesh && !inBindPose(mesh)));
    let P = null, N = null;
    if (transform) {
        P = new Float32Array(pos.count * 3);
        N = nor ? new Float32Array(pos.count * 3) : null;
        const p = new THREE.Vector3(), n = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3();
        const done = new Uint8Array(pos.count);
        for (const o of out) for (const v of o.order) {
            if (done[v]) continue;
            done[v] = 1;
            mesh.getVertexPosition(v, p);
            P[v * 3] = p.x; P[v * 3 + 1] = p.y; P[v * 3 + 2] = p.z;
            if (N) {
                n.fromBufferAttribute(nor, v);
                if (mesh.isSkinnedMesh) {
                    // bone transforms are affine: T(base + n) − T(base) = linear part · n
                    base.fromBufferAttribute(pos, v);
                    tip.copy(base).add(n);
                    mesh.applyBoneTransform(v, base);
                    mesh.applyBoneTransform(v, tip);
                    n.subVectors(tip, base).normalize();
                }
                N[v * 3] = n.x; N[v * 3 + 1] = n.y; N[v * 3 + 2] = n.z;
            }
        }
    }

    // 3. per bucket: copy into compact buffers
    return out.map(o => {
        if (!o.index.length) return null;
        const nv = o.nv;
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null;
        const colors = col ? new Float32Array(nv * 3) : null;
        for (let l = 0; l < nv; l++) {
            const v = o.order[l];
            if (P) { positions[l * 3] = P[v * 3]; positions[l * 3 + 1] = P[v * 3 + 1]; positions[l * 3 + 2] = P[v * 3 + 2]; }
            else { positions[l * 3] = pos.getX(v); positions[l * 3 + 1] = pos.getY(v); positions[l * 3 + 2] = pos.getZ(v); }
            if (nor) {
                if (N) { normals[l * 3] = N[v * 3]; normals[l * 3 + 1] = N[v * 3 + 1]; normals[l * 3 + 2] = N[v * 3 + 2]; }
                else { normals[l * 3] = nor.getX(v); normals[l * 3 + 1] = nor.getY(v); normals[l * 3 + 2] = nor.getZ(v); }
            }
            if (uvs) { uvs[l * 2] = uv.getX(v); uvs[l * 2 + 1] = uv.getY(v); }
            if (colors) { colors[l * 3] = col.getX(v); colors[l * 3 + 1] = col.getY(v); colors[l * 3 + 2] = col.getZ(v); }
        }
        if (!nor) computeNormals(positions, o.index, normals);
        // our vertex → source vertex (animation/morphs re-deform from the source)
        const sourceVertex = posed ? Int32Array.from(o.order) : null;
        // without UVs: box projection like STEP (UV_TILE in mm, geometry in source units)
        if (uvs) return { positions, normals, index: o.index, uvs, sourceVertex, colors };
        return boxProject({ positions, normals, index: o.index, sourceVertex, colors }, UV_TILE / Math.max(worldScale, 1e-12));
    });
}

// Skinned mesh in its bind pose? Then skinning returns the file's positions unchanged: per bone
// bindMatrixInverse · boneWorld · boneInverse · bindMatrix = identity (same product as applyBoneTransform)
function inBindPose(mesh) {
    const { bones, boneInverses } = mesh.skeleton;
    const m = new THREE.Matrix4();
    for (let i = 0; i < bones.length; i++) {
        if (!bones[i]) continue;
        m.multiplyMatrices(mesh.bindMatrixInverse, bones[i].matrixWorld).multiply(boneInverses[i]).multiply(mesh.bindMatrix);
        const e = m.elements;
        for (let k = 0; k < 16; k++) {
            const id = k % 5 === 0 ? 1 : 0;
            const tol = k >= 12 && k < 15 ? 1e-4 * (1 + mesh.geometry.boundingSphere?.radius || 1) : 1e-5;
            if (Math.abs(e[k] - id) > tol) return false;
        }
    }
    return true;
}

// Normals for meshes without any: smooth across vertices at the same position (FBX/glTF often have none
// shared), edges sharper than 30° stay hard – otherwise every triangle was flat (faceted). Corner normals from
// crease-normals.js, corners of our indexed buffer that share a vertex averaged (vertex = index value).
function computeNormals(positions, index, normals) {
    const corners = creaseCornerNormals(positions, index);
    normals.fill(0);
    for (let i = 0; i < index.length; i++) {
        const v = index[i] * 3;
        normals[v] += corners[i * 3]; normals[v + 1] += corners[i * 3 + 1]; normals[v + 2] += corners[i * 3 + 2];
    }
    for (let v = 0; v < normals.length; v += 3) {
        const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
        normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
    }
}

// glTF KHR_materials_unlit (typical for exports with baked lighting): GLTFLoader creates a
// MeshBasicMaterial and drops the emissive texture – often the base colour is black and the picture is
// only in the emissive texture. Remember emissive texture/colour/strength from the JSON for convertMaterial.
async function collectUnlit(gltf, object) {
    const { parser } = gltf;
    const seen = new Set();
    const materials = [];
    object.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (m?.isMeshBasicMaterial && !seen.has(m)) { seen.add(m); materials.push(m); } });
    for (const m of materials) {
        const index = parser.associations.get(m)?.materials;
        const def = index != null ? parser.json.materials?.[index] : null;
        if (!def) continue;
        const factor = def.emissiveFactor || [0, 0, 0];
        const strength = def.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
        let map = null;
        if (def.emissiveTexture) {
            // null if the image is missing (dropped .gltf without its textures)
            map = await parser.getDependency('texture', def.emissiveTexture.index).catch(() => null);
            if (map) {
                map = map.clone();
                map.colorSpace = THREE.SRGBColorSpace;
                map.needsUpdate = true;
            }
        }
        m.userData.unlit = { map, color: new THREE.Color().fromArray(factor), strength };
    }
}

// Source material (Standard/Physical from glTF, Phong/Lambert from FBX) -> parameters + textures
function convertMaterial(m, scale) {
    const hex = c => '#' + c.getHexString();
    const params = { color: m.color ? hex(m.color) : '#ffffff' };
    if (m.isMeshStandardMaterial) {
        params.metalness = m.metalness;
        params.roughness = m.roughness;
    } else if (m.isMeshPhongMaterial) {
        params.metalness = 0;
        params.roughness = Math.min(1, Math.sqrt(2 / (m.shininess + 2)));   // Blinn-Phong exponent -> roughness
    } else {
        params.metalness = 0;
        params.roughness = 1;
    }
    if (m.emissive) {
        params.emissive = hex(m.emissive);
        params.emissiveIntensity = m.emissiveIntensity ?? 1;
    }
    params.opacity = m.opacity ?? 1;
    if (m.isMeshPhysicalMaterial) {
        Object.assign(params, {
            specularIntensity: m.specularIntensity,
            clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness,
            transmission: m.transmission, ior: m.ior, thickness: m.thickness * scale,
            attenuationColor: hex(m.attenuationColor),
            attenuationDistance: Number.isFinite(m.attenuationDistance) ? m.attenuationDistance * scale : 100,
            sheen: m.sheen, sheenColor: hex(m.sheenColor), sheenRoughness: m.sheenRoughness,
            iridescence: m.iridescence,
        });
        // thin film (KHR_materials_iridescence): one thickness – without a thickness picture glTF takes the maximum
        if (m.iridescence > 0) Object.assign(params, { iridescenceIOR: m.iridescenceIOR, iridescenceThickness: m.iridescenceThicknessMaximum ?? 400 });
        // anisotropy (KHR_materials_anisotropy: strength + direction, three.js keeps both – radians → degrees)
        if (m.anisotropy > 0) Object.assign(params, { anisotropy: m.anisotropy, anisotropyRotation: THREE.MathUtils.radToDeg(m.anisotropyRotation || 0) });
    }
    const maps = {};
    // only textures with a loaded image (missing files yield image = null -> path tracer crashes); a missing one is
    // remembered with its slot (render.missing – any format, USD fills it in usd-mdl.js): its image node shows a warning
    // and a file handed in later is linked straight into the slot. flipY: how the image is to be oriented (FBX/MAX
    // like three's default, glTF not flipped)
    const missingMaps = { ...(m.userData?.usdMissingMaps || {}) };
    for (const key of MAP_KEYS) {
        const tex = m[key];
        if (!tex?.isTexture) continue;
        if (hasImage(tex)) { maps[key] = tex; continue; }
        const url = tex.userData?.sourceUrl || tex.name;
        if (url && IMPORT_SLOTS[key] && !missingMaps[key]) {
            missingMaps[key] = { url, srgb: tex.colorSpace === THREE.SRGBColorSpace, flipY: tex.flipY,
                repeat: tex.repeat.toArray(), offset: tex.offset.toArray(), rotation: tex.rotation * 180 / Math.PI };
        }
    }
    // unlit (glTF): shows its picture without lighting → black, non-reflective surface that emits the picture
    // (emissive texture/colour, otherwise base colour texture/colour)
    if (m.isMeshBasicMaterial) {
        const u = m.userData.unlit;
        const emissiveMap = (u?.map && hasImage(u.map) && u.map) || maps.map || null;
        const emissive = u && (u.map || u.color.getHex()) ? u.color : m.color;
        Object.assign(params, { color: '#000000', metalness: 0, roughness: 1, specularIntensity: 0,
            emissive: hex(u?.map && !u.color.getHex() ? new THREE.Color(1, 1, 1) : emissive), emissiveIntensity: u?.strength ?? 1 });
        delete maps.map;
        if (emissiveMap) maps.emissiveMap = emissiveMap;
    }
    // Phong specular maps have no counterpart; bump maps become the relief (material-graph.js IMPORT_SLOTS) – its height
    // from the file where the format has one (Blender: in scene units → mm), else from the factor (fitImportRelief)
    const render = {
        maps,
        side: m.side,
        alphaTest: m.alphaTest || 0,
        transparent: !!m.transparent,
        normalScale: m.normalScale ? m.normalScale.toArray() : null,
        bumpScale: m.bumpScale ?? 1,
        bumpHeight: Number.isFinite(m.userData?.bumpHeight) ? m.userData.bumpHeight * scale : null,
        aoMapIntensity: m.aoMapIntensity ?? 1,
        // colours per vertex (glTF COLOR_0, PLY, OBJ, FBX …): × the material's colour, raster and path tracer
        vertexColors: !!m.vertexColors,
        // slots whose image is missing – { slot: { url, srgb, flipY?, repeat?, offset?, rotation?, color? } };
        // the viewer links a file handed in later into them without reopening the scene
        missing: Object.keys(missingMaps).length ? structuredClone(missingMaps) : null,
    };
    return { name: m.name, params, render };
}

function hasImage(texture) {
    const img = texture.image;
    return !!img && (img.data || img.width > 0 || img.naturalWidth > 0 || img.mipmaps?.length > 0 || texture.isCompressedTexture);
}
