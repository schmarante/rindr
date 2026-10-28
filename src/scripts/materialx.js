// MaterialX with OpenPBR (docs/material-format.md): a material as a package (.zip – .mtlx with open_pbr_surface,
// RINDR's own description, a glTF sphere, preview, textures) and reading .mtlx files / packages back
// (open_pbr_surface, Autodesk standard_surface).
//
// Export reads the live three.js material (RindrMaterial): what the node graph baked and what an imported file
// brought are both its maps, the factors its values – one way for every kind of material. Textures go out one per
// OpenPBR input (values as grey, no packed channels), origin bottom left (MaterialX).
import * as THREE from 'three/webgpu';
import { encodePng } from './png-encode.js';
import { zipStore } from './zip.js';
import { readZip } from './splat/splat-formats.js';
import { createImportGraph } from './material-graph.js';
import { UV_TILE } from './step-importer.js';
import { SUBSURFACE_RADIUS_SCALE } from './materials/medium.js';

export const MATERIAL_PACKAGE = 'rindr-material';
const PACKAGE_VERSION = 1;
const EMISSION_NITS = 100;   // nits per unit of emissiveIntensity – the export's convention (three.js has no unit)

const fmt = v => String(Number(Number(v).toFixed(5)));
const color3 = c => `${fmt(c.r)}, ${fmt(c.g)}, ${fmt(c.b)}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isWhite = c => c.r > 0.999 && c.g > 0.999 && c.b > 0.999;
/** file / node name of a material: ASCII letters, digits, underscore */
export const slug = name => (name || 'material').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'material';
const ident = s => (/^[A-Za-z_]/.test(s) ? s : 'm_' + s);

// --- export ---

// OpenPBR inputs written, in this order (all of them – explicit values: OpenPBR's defaults differ from RINDR's)
const OPENPBR_TYPES = {
    base_weight: 'float', base_color: 'color3', base_metalness: 'float', base_diffuse_roughness: 'float',
    specular_weight: 'float', specular_color: 'color3', specular_roughness: 'float', specular_roughness_anisotropy: 'float', specular_ior: 'float',
    transmission_weight: 'float', transmission_color: 'color3', transmission_depth: 'float',
    transmission_scatter: 'color3', transmission_scatter_anisotropy: 'float',
    transmission_dispersion_scale: 'float', transmission_dispersion_abbe_number: 'float',
    subsurface_weight: 'float', subsurface_color: 'color3', subsurface_radius: 'float', subsurface_radius_scale: 'color3',
    subsurface_scatter_anisotropy: 'float',
    fuzz_weight: 'float', fuzz_color: 'color3', fuzz_roughness: 'float',
    coat_weight: 'float', coat_color: 'color3', coat_roughness: 'float', coat_ior: 'float',
    thin_film_weight: 'float', thin_film_thickness: 'float', thin_film_ior: 'float',
    emission_luminance: 'float', emission_color: 'color3',
    geometry_opacity: 'float', geometry_thin_walled: 'boolean',
};

// maps of the three.js material → OpenPBR input (channel three reads; values written as grey)
const EXPORT_MAPS = [
    { input: 'base_color', prop: 'map', kind: 'color' },
    { input: 'base_metalness', prop: 'metalnessMap', kind: 'float', channel: 2 },
    { input: 'specular_roughness', prop: 'roughnessMap', kind: 'float', channel: 1 },
    { input: 'specular_color', prop: 'specularColorMap', kind: 'color' },
    { input: 'transmission_weight', prop: 'transmissionMap', kind: 'float', channel: 0 },
    { input: 'fuzz_color', prop: 'sheenColorMap', kind: 'color' },
    { input: 'coat_weight', prop: 'clearcoatMap', kind: 'float', channel: 0 },
    { input: 'coat_roughness', prop: 'clearcoatRoughnessMap', kind: 'float', channel: 1 },
    { input: 'thin_film_weight', prop: 'iridescenceMap', kind: 'float', channel: 0 },
    { input: 'emission_color', prop: 'emissiveMap', kind: 'color' },
    { input: 'geometry_opacity', prop: 'alphaMap', kind: 'float', channel: 1 },
    { input: 'geometry_normal', prop: 'normalMap', kind: 'normal' },
];

/** OpenPBR values of a material (constants; with a map they are its factor) – p: RINDR params */
function openPbrValues(m, p) {
    const lin = hex => new THREE.Color(hex);
    // scattering inside the glass: the raster's approximation changes colour and transmission (toon.js) – the params
    const scatter = m._scatterKeys?.length > 0;
    const attenuated = m.attenuationDistance !== Infinity && (!isWhite(m.attenuationColor) || scatter);
    return {
        base_weight: 1,
        // subsurface: the material's colour is blended towards the scatter colour (toon.js) – the base is the param
        base_color: p.subsurface > 0 || scatter ? lin(p.color) : m.color.clone(),
        base_metalness: m.metalness,
        base_diffuse_roughness: m.diffuseRoughness ?? 0,
        specular_weight: m.specularIntensity,
        specular_color: m.specularColor.clone(),
        specular_roughness: m.roughness,
        specular_roughness_anisotropy: m.anisotropy,
        specular_ior: m.ior,
        transmission_weight: scatter ? p.transmission : m.transmission,
        transmission_color: m.attenuationColor.clone(),
        transmission_depth: attenuated ? m.attenuationDistance : 0,
        transmission_scatter: scatter ? lin(p.transmissionScatter) : new THREE.Color(0, 0, 0),
        transmission_scatter_anisotropy: scatter ? p.transmissionScatterAnisotropy ?? 0 : 0,
        transmission_dispersion_scale: p.dispersion ?? 0,
        transmission_dispersion_abbe_number: p.dispersionAbbe ?? 20,
        subsurface_weight: p.subsurface ?? 0,
        subsurface_color: lin(p.subsurfaceColor ?? '#ffffff'),
        subsurface_radius: p.subsurfaceRadius ?? 1,
        subsurface_radius_scale: new THREE.Color(...SUBSURFACE_RADIUS_SCALE),   // the accurate mode's (medium.js)
        subsurface_scatter_anisotropy: p.subsurfaceAnisotropy ?? 0,
        fuzz_weight: m.sheen,
        fuzz_color: m.sheenColor.clone(),
        fuzz_roughness: m.sheenRoughness,
        coat_weight: m.clearcoat,
        coat_color: m.coatColor?.clone() ?? new THREE.Color(1, 1, 1),
        coat_roughness: m.clearcoatRoughness,
        coat_ior: m.coatIor ?? 1.5,
        thin_film_weight: m.iridescence,
        thin_film_thickness: (m.iridescenceThicknessRange?.[1] ?? 400) / 1000,   // nm → µm
        thin_film_ior: m.iridescenceIOR,
        emission_luminance: m.emissive.getHex() === 0 ? 0 : m.emissiveIntensity * EMISSION_NITS,
        emission_color: m.emissive.clone(),
        geometry_opacity: m.opacity,
        geometry_thin_walled: (p.thinWalled ?? 0) > 0,
    };
}

// pixels of a texture, first row = v 1 (MaterialX: origin bottom left); null if not readable (compressed, placeholder)
async function texturePixels(tex) {
    const img = tex?.image;
    if (!img || tex.isCompressedTexture) return null;
    let w, h, data, vTop;
    if (img.data) {
        // DataTexture (baked maps of the node graph): first row = v 0
        w = img.width; h = img.height;
        if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length < w * h * 4) return null;
        data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, w * h * 4);
        vTop = !!tex.flipY;
    } else {
        w = img.naturalWidth || img.videoWidth || img.width;
        h = img.naturalHeight || img.videoHeight || img.height;
        if (!w || !h || typeof OffscreenCanvas === 'undefined') return null;
        const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        try { data = ctx.getImageData(0, 0, w, h).data; } catch { return null; }   // tainted
        // a picture as loaded: three flips it for the GPU (flipY) → its top row is v 1; glTF-style (flipY false): v 0
        vTop = tex.flipY !== false;
        if (tex.userData?.flippedImage) vTop = !vTop;
    }
    if (w <= 1 && h <= 1) return null;   // the white placeholder of graph-apply.js
    return { w, h, data: vTop ? data : flipRows(data, w, h) };
}

function flipRows(data, w, h) {
    const row = w * 4, out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) out.set(data.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    return out;
}

function greyOf(data, channel) {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
        const v = data[i + channel];
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
    }
    return out;
}

const pngBytes = async (data, w, h) => new Uint8Array(await (await encodePng(data, w, h)).arrayBuffer());

/**
 * Package of a material entry ({ def, material } of the material manager).
 * @param {{ preview?: string|null, json?: object, version?: string }} opts  preview: URL of the sphere picture,
 *   json: the material as materialManager.toJSON writes it
 * @returns {Promise<{ name: string, bytes: Uint8Array }>}
 */
export async function exportMaterialPackage({ def, material: m }, { preview = null, json = null, version = '' } = {}) {
    const name = slug(def.name);
    const p = def.params || {};
    const values = openPbrValues(m, p);
    const files = [];
    const maps = {};   // material slot → file in the package
    const textured = {};   // OpenPBR input → { file, kind }
    const outNode = def.graph?.nodes?.find(n => n.type === 'output');
    const uvMode = !!m.userData.graphUvMode;
    // tile size (mm) of baked node maps – an imported material's maps follow the model's UVs (no size)
    const tileSize = def.graph?.nodes?.some(n => n.type !== 'output' && n.type !== 'importMap') && !uvMode ? (outNode?.params?.size ?? 100) : null;
    const pixelCache = new Map();
    for (const slot of EXPORT_MAPS) {
        const tex = m[slot.prop];
        if (!tex) continue;
        if (slot.prop === 'alphaMap' && !(m.alphaTest > 0 || m.transparent)) continue;
        if (!pixelCache.has(tex)) pixelCache.set(tex, await texturePixels(tex));
        const px = pixelCache.get(tex);
        if (!px) continue;
        const file = `textures/${name}_${slot.input === 'geometry_normal' ? 'normal' : slot.input}.png`;
        let data = slot.kind === 'float' ? greyOf(px.data, slot.channel) : px.data;
        if (slot.kind === 'normal' && m.normalScale?.y < 0) {
            // three's glTF convention (normalScale.y negative with flipY false): green back to OpenGL (+Y)
            data = new Uint8ClampedArray(data);
            for (let i = 1; i < data.length; i += 4) data[i] = 255 - data[i];
        }
        if (slot.kind !== 'float') {
            data = new Uint8ClampedArray(data);
            for (let i = 3; i < data.length; i += 4) data[i] = 255;   // opaque (alpha of a colour map is not OpenPBR's)
        }
        files.push({ name: file, data: await pngBytes(data, px.w, px.h) });
        maps[slot.prop] = file;
        textured[slot.input] = { file, kind: slot.kind };
    }
    const mtlx = writeMtlx({ name, label: def.name, values, textured, tileSize, clamp: uvMode, normalScale: Math.abs(m.normalScale?.x ?? 1),
        rotation: p.anisotropy > 0 ? (p.anisotropyRotation ?? 0) : 0, version });
    files.unshift({ name: `${name}.mtlx`, data: new TextEncoder().encode(mtlx) });
    const description = {
        format: MATERIAL_PACKAGE, version: PACKAGE_VERSION, generator: `RINDR ${version}`.trim(),
        material: json, maps, tileSize,
        openpbr: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v?.isColor ? [v.r, v.g, v.b] : v])),
        notOpenPbr: notOpenPbr(p),
    };
    files.splice(1, 0, { name: `${name}.rindr.json`, data: new TextEncoder().encode(JSON.stringify(description, null, 2)) });
    try {
        files.splice(2, 0, { name: `${name}.glb`, data: new Uint8Array(await previewGlb(m, def.name)) });
    } catch (err) { console.warn('[MaterialX] glTF preview not written:', err?.message || err, err?.stack?.split('\n').slice(0, 4).join(' | ')); }
    if (preview) {
        try { files.push({ name: 'preview.png', data: new Uint8Array(await (await fetch(preview)).arrayBuffer()) }); } catch { /* no preview */ }
    }
    return { name: `${name}.zip`, bytes: zipStore(files) };
}

// RINDR effects without an OpenPBR counterpart (named in the description; the .mtlx carries the base surface)
function notOpenPbr(p) {
    const out = [];
    for (const k of ['toon', 'flat', 'contour', 'cloud', 'wool', 'grass', 'soap', 'marble', 'edgeRadius']) if (p[k] > 0) out.push(k);
    return out;
}

function writeMtlx({ name, label, values, textured, tileSize, clamp, normalScale, rotation, version }) {
    const shader = ident(`${name}_shader`);
    const nodes = [];
    const inputs = [];
    const address = clamp ? 'clamp' : 'periodic';
    const image = (node, type, file, colorspace) => nodes.push(`  <image name="${node}" type="${type}">
    <input name="file" type="filename" value="${esc(file)}"${colorspace ? ` colorspace="${colorspace}"` : ''} />
    <input name="uaddressmode" type="string" value="${address}" />
    <input name="vaddressmode" type="string" value="${address}" />
  </image>`);
    for (const [input, type] of Object.entries(OPENPBR_TYPES)) {
        const v = values[input];
        const tex = textured[input];
        if (tex) {
            const node = ident(`${input}_image`);
            image(node, type, tex.file, tex.kind === 'color' ? 'srgb_texture' : null);
            // three.js multiplies map × value: the factor as a multiply node (not for a neutral factor)
            const neutral = type === 'color3' ? isWhite(v) : Math.abs(v - 1) < 1e-4;
            if (neutral || input === 'emission_color' && v.getHex() === 0) inputs.push(`    <input name="${input}" type="${type}" nodename="${node}" />`);
            else {
                const mul = ident(`${input}_factor`);
                nodes.push(`  <multiply name="${mul}" type="${type}">
    <input name="in1" type="${type}" nodename="${node}" />
    <input name="in2" type="${type}" value="${type === 'color3' ? color3(v) : fmt(v)}" />
  </multiply>`);
                inputs.push(`    <input name="${input}" type="${type}" nodename="${mul}" />`);
            }
            continue;
        }
        const value = type === 'color3' ? color3(v) : type === 'boolean' ? String(!!v) : fmt(v);
        inputs.push(`    <input name="${input}" type="${type}" value="${value}" />`);
    }
    if (textured.geometry_normal) {
        const img = ident('normal_image'), nm = ident('normal_map');
        image(img, 'vector3', textured.geometry_normal.file, null);
        nodes.push(`  <normalmap name="${nm}" type="vector3">
    <input name="in" type="vector3" nodename="${img}" />
    <input name="scale" type="float" value="${fmt(normalScale)}" />
  </normalmap>`);
        inputs.push(`    <input name="geometry_normal" type="vector3" nodename="${nm}" />`);
    }
    if (rotation) {
        // anisotropy direction: the surface tangent turned around the normal (OpenPBR has no rotation input)
        nodes.push(`  <tangent name="tangent_world" type="vector3">
    <input name="space" type="string" value="world" />
  </tangent>
  <normal name="normal_world" type="vector3">
    <input name="space" type="string" value="world" />
  </normal>
  <rotate3d name="tangent_rotated" type="vector3">
    <input name="in" type="vector3" nodename="tangent_world" />
    <input name="amount" type="float" value="${fmt(rotation)}" />
    <input name="axis" type="vector3" nodename="normal_world" />
  </rotate3d>`);
        inputs.push('    <input name="geometry_tangent" type="vector3" nodename="tangent_rotated" />');
    }
    return `<?xml version="1.0"?>
<!-- ${esc(label)} – exported by RINDR ${esc(version)} (OpenPBR surface, docs/material-format.md) -->
<materialx version="1.39" colorspace="lin_rec709">
${nodes.join('\n')}${nodes.length ? '\n' : ''}  <open_pbr_surface name="${shader}" type="surfaceshader">
${inputs.join('\n')}
  </open_pbr_surface>
  <surfacematerial name="${ident(name)}" type="material"${tileSize ? ` doc="${esc(`RINDR: one texture tile = ${fmt(tileSize)} mm`)}"` : ''}>
    <input name="surfaceshader" type="surfaceshader" nodename="${shader}" />
  </surfacematerial>
</materialx>
`;
}

// a sphere with a MeshPhysicalMaterial copy as GLB (KHR extensions) – for programs without MaterialX
const GLTF_PROPS = ['color', 'map', 'metalness', 'metalnessMap', 'roughness', 'roughnessMap', 'normalMap', 'normalScale', 'emissive',
    'emissiveMap', 'emissiveIntensity', 'clearcoat', 'clearcoatMap', 'clearcoatRoughness', 'clearcoatRoughnessMap', 'transmission',
    'transmissionMap', 'ior', 'thickness', 'attenuationColor', 'attenuationDistance', 'sheen', 'sheenColor', 'sheenColorMap',
    'sheenRoughness', 'iridescence', 'iridescenceIOR', 'iridescenceThicknessRange', 'specularIntensity', 'specularColor',
    'anisotropy', 'anisotropyRotation', 'dispersion', 'opacity', 'transparent', 'alphaMap', 'alphaTest', 'aoMap'];
// GLTFExporter draws textures onto a canvas – the baked maps are pixel data (DataTexture): as a canvas, v 1 on top
async function gltfTexture(tex) {
    if (tex.image?.width <= 1 && tex.image?.height <= 1) return null;   // placeholder
    if (!tex.image?.data) return tex;
    const px = await texturePixels(tex);
    if (!px) return null;
    const canvas = document.createElement('canvas');
    canvas.width = px.w; canvas.height = px.h;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
    const out = new THREE.CanvasTexture(canvas);
    out.colorSpace = tex.colorSpace;
    out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
    return out;
}

async function previewGlb(source, name) {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const m = new THREE.MeshPhysicalMaterial({ name });
    for (const k of GLTF_PROPS) {
        const v = source[k];
        if (v === undefined || v === null) continue;
        if (v.isTexture) { const tex = await gltfTexture(v); if (tex) m[k] = tex; continue; }
        if (v.isColor || v.isVector2) m[k].copy(v);
        else if (Array.isArray(v)) m[k] = [...v];
        else m[k] = v;
    }
    // distances: RINDR mm → glTF metres; tinted glass needs a volume thickness for KHR_materials_volume (the sphere's
    // diameter – without it the exporter leaves the absorption out and the glass came out clear)
    if (m.attenuationDistance !== Infinity) m.attenuationDistance /= 1000;
    const thinWall = source.thickness === 0 && source.attenuationDistance === Infinity;
    m.thickness = m.transmission > 0 && !thinWall ? 0.2 : 0;
    const geometry = new THREE.SphereGeometry(0.1, 96, 48);   // 10 cm (glTF: metres)
    geometry.computeTangents();
    const mesh = new THREE.Mesh(geometry, m);
    mesh.name = name;
    try {
        return await new GLTFExporter().parseAsync(mesh, { binary: true });
    } finally {
        geometry.dispose();
    }
}

// --- import ---

const extOf = path => path.split('.').pop().toLowerCase();
const baseName = path => path.split('/').pop().toLowerCase();

/** is this zip a material package (or does it hold a .mtlx)? names from its directory */
export function isMaterialZip(buffer) {
    try {
        const names = [...readZip(buffer, { paths: true }).keys()];
        return names.some(n => /\.mtlx$/i.test(n) || /\.rindr\.json$/i.test(n));
    } catch { return false; }
}

/**
 * Material files among dropped / picked ones ({ path, file }[]): .mtlx (textures next to it) and packages (.zip).
 * @returns {Promise<{ defs: object[], used: Set<object> }>} defs for materialManager.create; used = files taken
 */
export async function readMaterialFiles(files) {
    const defs = [];
    const used = new Set();
    // loose files by path and by name (a .mtlx names its textures relative to itself)
    const loose = new Map();
    for (const f of files) { loose.set(f.path.toLowerCase(), f); if (!loose.has(baseName(f.path))) loose.set(baseName(f.path), f); }
    for (const f of files) {
        const ext = extOf(f.path);
        if (ext === 'zip') {
            const buffer = await f.file.arrayBuffer();
            if (!isMaterialZip(buffer)) continue;
            used.add(f);
            const entries = readZip(buffer, { paths: true });
            const byPath = new Map([...entries].map(([k, v]) => [k.toLowerCase(), v]));
            const byName = new Map([...entries].map(([k, v]) => [baseName(k), v]));
            const read = async path => {
                const fn = byPath.get(path.toLowerCase().replace(/^\.\//, '')) ?? byName.get(baseName(path));
                return fn ? new Blob([await fn()]) : null;
            };
            const jsonName = [...entries.keys()].find(n => /\.rindr\.json$/i.test(n));
            const mtlxName = [...entries.keys()].find(n => /\.mtlx$/i.test(n));
            const json = jsonName ? JSON.parse(new TextDecoder().decode(await entries.get(jsonName)())) : null;
            if (json?.format === MATERIAL_PACKAGE && json.material) defs.push(await fromPackage(json, read));
            else if (mtlxName) defs.push(...await fromMtlx(new TextDecoder().decode(await entries.get(mtlxName)()), dirOf(mtlxName), read));
        } else if (ext === 'mtlx') {
            used.add(f);
            const dir = dirOf(f.path);
            const read = async path => {
                const full = (dir + path).toLowerCase().replace(/^\.\//, '');
                const hit = loose.get(full) ?? loose.get(baseName(path));
                if (hit) used.add(hit);
                return hit?.file ?? null;
            };
            defs.push(...await fromMtlx(await f.file.text(), dir, read));
        }
    }
    return { defs, used };
}

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

async function loadTexture(blob, { srgb = false, name = '' } = {}) {
    const url = URL.createObjectURL(blob);
    try {
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.name = name;
        return tex;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// one channel of a picture as a grey texture (a packed map read with <extract>)
async function channelTexture(blob, channel, name) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    img.data.set(greyOf(img.data, channel));
    ctx.putImageData(img, 0, 0);
    return loadTexture(await canvas.convertToBlob({ type: 'image/png' }), { name });
}

// RINDR package: params and graph as written; its textures for the image-from-file nodes of the graph (an imported
// material) – a procedural graph bakes its maps itself again
async function fromPackage(json, read) {
    const m = json.material;
    const wanted = new Set((m.graph?.nodes || []).filter(n => n.type === 'importMap').map(n => n.params?.map));
    const maps = {};
    for (const [prop, file] of Object.entries(json.maps || {})) {
        if (m.graph && !wanted.has(prop)) continue;
        const blob = await read(file);
        if (blob) maps[prop] = await loadTexture(blob, { srgb: ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'].includes(prop), name: baseName(file) });
    }
    const graph = m.graph ?? (Object.keys(maps).length ? createImportGraph(maps) : null);
    return { name: m.name, source: 'custom', libraryId: null, params: { ...m.params }, graph, render: Object.keys(maps).length ? { maps } : null };
}

// OpenPBR input → RINDR param (+ map slot); conv: value conversion; defaults = OpenPBR's for inputs not in the file
const FROM_OPENPBR = {
    base_color: { param: 'color', map: 'map', kind: 'color', def: [0.8, 0.8, 0.8] },
    base_metalness: { param: 'metalness', map: 'metalnessMap', def: 0 },
    base_diffuse_roughness: { param: 'diffuseRoughness', def: 0 },
    specular_weight: { param: 'specularIntensity', def: 1, conv: v => Math.min(Math.max(v, 0), 1) },
    specular_color: { param: 'specularColor', map: 'specularColorMap', kind: 'color', def: [1, 1, 1] },
    specular_roughness: { param: 'roughness', map: 'roughnessMap', def: 0.3 },
    specular_roughness_anisotropy: { param: 'anisotropy', def: 0 },
    specular_ior: { param: 'ior', def: 1.5 },
    transmission_weight: { param: 'transmission', map: 'transmissionMap', def: 0 },
    transmission_color: { param: 'attenuationColor', kind: 'color', def: [1, 1, 1] },
    transmission_depth: { param: 'attenuationDistance', def: 0, conv: v => (v > 0 ? v : 100) },
    transmission_scatter: { param: 'transmissionScatter', kind: 'color', def: [0, 0, 0] },
    transmission_scatter_anisotropy: { param: 'transmissionScatterAnisotropy', def: 0 },
    transmission_dispersion_scale: { param: 'dispersion', def: 0 },
    transmission_dispersion_abbe_number: { param: 'dispersionAbbe', def: 20 },
    subsurface_weight: { param: 'subsurface', def: 0 },
    subsurface_color: { param: 'subsurfaceColor', kind: 'color', def: [0.8, 0.8, 0.8] },
    subsurface_radius: { param: 'subsurfaceRadius', def: 1 },
    subsurface_scatter_anisotropy: { param: 'subsurfaceAnisotropy', def: 0 },
    fuzz_weight: { param: 'sheen', def: 0 },
    fuzz_color: { param: 'sheenColor', map: 'sheenColorMap', kind: 'color', def: [1, 1, 1] },
    fuzz_roughness: { param: 'sheenRoughness', def: 0.5 },
    coat_weight: { param: 'clearcoat', map: 'clearcoatMap', def: 0 },
    coat_color: { param: 'clearcoatColor', kind: 'color', def: [1, 1, 1] },
    coat_roughness: { param: 'clearcoatRoughness', map: 'clearcoatRoughnessMap', def: 0 },
    coat_ior: { param: 'clearcoatIor', def: 1.6 },
    thin_film_weight: { param: 'iridescence', def: 0 },
    thin_film_thickness: { param: 'iridescenceThickness', def: 0.5, conv: v => v * 1000 },   // µm → nm
    thin_film_ior: { param: 'iridescenceIOR', def: 1.4 },
    emission_color: { param: 'emissive', map: 'emissiveMap', kind: 'color', def: [1, 1, 1] },
    emission_luminance: { param: 'emissiveIntensity', def: 0, conv: v => v / EMISSION_NITS },
    geometry_opacity: { param: 'opacity', map: 'alphaMap', def: 1 },
    geometry_thin_walled: { param: 'thinWalled', def: 0, conv: v => (v ? 1 : 0) },
    geometry_normal: { map: 'normalMap', kind: 'normal' },
};
// Autodesk Standard Surface → the same (weights multiplied in afterwards)
const FROM_STANDARD = {
    base_color: 'base_color', metalness: 'base_metalness', diffuse_roughness: 'base_diffuse_roughness', specular: 'specular_weight',
    specular_color: 'specular_color', specular_roughness: 'specular_roughness', specular_anisotropy: 'specular_roughness_anisotropy',
    specular_IOR: 'specular_ior', transmission: 'transmission_weight', transmission_color: 'transmission_color',
    transmission_depth: 'transmission_depth', transmission_scatter: 'transmission_scatter',
    transmission_scatter_anisotropy: 'transmission_scatter_anisotropy', subsurface: 'subsurface_weight', subsurface_color: 'subsurface_color',
    subsurface_anisotropy: 'subsurface_scatter_anisotropy',
    sheen: 'fuzz_weight', sheen_color: 'fuzz_color', sheen_roughness: 'fuzz_roughness', coat: 'coat_weight', coat_color: 'coat_color',
    coat_roughness: 'coat_roughness', coat_IOR: 'coat_ior', thin_film_IOR: 'thin_film_ior', emission_color: 'emission_color',
    thin_walled: 'geometry_thin_walled', normal: 'geometry_normal',
};

/** materials of a MaterialX document (open_pbr_surface, standard_surface) → defs */
async function fromMtlx(text, dir, read) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.nodeName !== 'materialx') throw new Error('not a MaterialX document');
    const root = doc.documentElement;
    const defs = [];
    const children = el => [...el.children];
    const byName = (scope, name) => children(scope).find(c => c.getAttribute('name') === name) ?? null;
    const prefixOf = el => {
        let prefix = '';
        for (let e = el; e && e.nodeType === 1; e = e.parentElement) prefix = (e.getAttribute('fileprefix') || '') + prefix;
        return prefix;
    };
    // what an input carries: { value } or { texture: { file, colorspace, channel, factor } }
    const resolve = (input, scope, depth = 0) => {
        if (!input || depth > 12) return null;
        if (input.hasAttribute('value') && !input.hasAttribute('nodename') && !input.hasAttribute('nodegraph')) {
            return { value: input.getAttribute('value'), type: input.getAttribute('type') };
        }
        let node = null, nodeScope = scope;
        const graphName = input.getAttribute('nodegraph');
        if (graphName) {
            const graph = byName(root, graphName);
            if (!graph) return null;
            const outName = input.getAttribute('output');
            const out = children(graph).find(c => c.nodeName === 'output' && (!outName || c.getAttribute('name') === outName));
            if (!out) return null;
            nodeScope = graph;
            node = byName(graph, out.getAttribute('nodename'));
        } else if (input.hasAttribute('nodename')) {
            node = byName(scope, input.getAttribute('nodename')) ?? byName(root, input.getAttribute('nodename'));
        } else if (input.hasAttribute('interfacename') && scope !== root) {
            return null;   // nodegraph interface inputs – not followed
        }
        if (!node) return null;
        const inp = name => children(node).find(c => c.nodeName === 'input' && c.getAttribute('name') === name);
        switch (node.nodeName) {
            case 'image': case 'tiledimage': {
                const file = inp('file');
                if (!file?.getAttribute('value')) return null;
                const cs = file.getAttribute('colorspace') || node.getAttribute('colorspace') || '';
                return { texture: { file: prefixOf(file) + file.getAttribute('value'), colorspace: cs, channel: null, factor: null } };
            }
            case 'multiply': {
                const a = resolve(inp('in1'), nodeScope, depth + 1), b = resolve(inp('in2'), nodeScope, depth + 1);
                const tex = a?.texture ? a : b?.texture ? b : null;
                const val = tex === a ? b : a;
                if (!tex) return a ?? b;
                return { texture: { ...tex.texture, factor: val?.value ?? null } };
            }
            case 'normalmap': return resolve(inp('in'), nodeScope, depth + 1);
            case 'extract': {
                const r = resolve(inp('in'), nodeScope, depth + 1);
                if (r?.texture) r.texture.channel = Number(inp('index')?.getAttribute('value') ?? 0);
                return r;
            }
            case 'convert': case 'dot': case 'constant':
                return resolve(inp('in') ?? inp('value'), nodeScope, depth + 1);
            default:
                return null;
        }
    };
    const num = s => Number(String(s).split(',')[0]);
    const vec = s => String(s).split(',').map(Number);
    for (const mat of children(root).filter(c => c.nodeName === 'surfacematerial')) {
        const ref = children(mat).find(c => c.nodeName === 'input' && c.getAttribute('name') === 'surfaceshader');
        const shader = ref && byName(root, ref.getAttribute('nodename'));
        if (!shader || !['open_pbr_surface', 'standard_surface'].includes(shader.nodeName)) continue;
        const raw = {};   // OpenPBR input name → resolved
        for (const input of children(shader).filter(c => c.nodeName === 'input')) {
            let name = input.getAttribute('name');
            if (shader.nodeName === 'standard_surface') name = FROM_STANDARD[name] ?? `std:${name}`;
            raw[name] = resolve(input, root);
        }
        const std = shader.nodeName === 'standard_surface';
        const params = {}, maps = {};
        for (const [input, info] of Object.entries(FROM_OPENPBR)) {
            const r = raw[input];
            if (r?.texture && info.map) {
                const blob = await read(r.texture.file.replace(/^\.\//, ''));
                if (blob) {
                    const srgb = info.kind === 'color' && !/lin|raw/i.test(r.texture.colorspace);
                    const name = baseName(r.texture.file);
                    maps[info.map] = r.texture.channel !== null && info.kind !== 'color'
                        ? await channelTexture(blob, r.texture.channel, name)
                        : await loadTexture(blob, { srgb, name });
                }
                // the factor of the map as the param (three.js multiplies), else neutral
                if (info.param) {
                    if (info.kind === 'color') params[info.param] = '#' + colorOf(r.texture.factor ? vec(r.texture.factor) : [1, 1, 1]).getHexString();
                    else params[info.param] = info.conv ? info.conv(r.texture.factor ? num(r.texture.factor) : 1) : (r.texture.factor ? num(r.texture.factor) : 1);
                }
                continue;
            }
            if (!info.param) continue;
            const v = r?.value ?? (std ? null : info.def);
            if (v === null || v === undefined) continue;
            if (info.kind === 'color') params[info.param] = '#' + colorOf(Array.isArray(v) ? v : vec(v)).getHexString();
            else {
                const n = typeof v === 'string' ? (v === 'true' ? 1 : v === 'false' ? 0 : num(v)) : v;
                params[info.param] = info.conv ? info.conv(n) : n;
            }
        }
        if (std) standardWeights(raw, params, num, vec);
        // no depth: no medium inside the glass (OpenPBR) – the scatter colour does nothing then
        const depth = raw.transmission_depth?.value;
        if (!(depth !== undefined && depth !== null && num(depth) > 0)) delete params.transmissionScatter;
        // anisotropy direction: RINDR writes it as the tangent turned around the normal (rotate3d) – read back
        const tangentInput = children(shader).find(c => c.nodeName === 'input' && c.getAttribute('name') === 'geometry_tangent');
        const rot = tangentInput && byName(root, tangentInput.getAttribute('nodename') || '');
        if (rot?.nodeName === 'rotate3d') {
            const amount = children(rot).find(c => c.getAttribute('name') === 'amount')?.getAttribute('value');
            if (amount !== undefined && amount !== null) params.anisotropyRotation = num(amount);
        }
        // tile size of baked maps (RINDR's own note on the material): the textures repeat like on RINDR's model UVs
        const tile = Number(/tile = ([\d.]+) mm/.exec(mat.getAttribute('doc') || '')?.[1]);
        if (tile > 0) for (const tex of Object.values(maps)) tex.repeat.setScalar(UV_TILE / tile);
        // base_weight (OpenPBR) into the colour
        const baseWeight = raw.base_weight?.value !== undefined ? num(raw.base_weight.value) : 1;
        if (baseWeight !== 1 && params.color) params.color = '#' + new THREE.Color(params.color).multiplyScalar(baseWeight).getHexString();
        if (params.emissiveIntensity > 0 && !params.emissive) params.emissive = '#ffffff';
        if (!(params.emissiveIntensity > 0)) { delete params.emissive; delete params.emissiveIntensity; }
        const render = Object.keys(maps).length ? { maps } : null;
        if (maps.alphaMap) Object.assign(render, { alphaTest: 0.5 });
        defs.push({
            name: mat.getAttribute('name') || 'MaterialX', source: 'custom', params,
            graph: render ? createImportGraph(maps) : null, render,
        });
    }
    return defs;
}

// linear rgb (MaterialX, lin_rec709) → THREE.Color in the working space
const colorOf = ([r, g, b]) => new THREE.Color().setRGB(r ?? 0, g ?? r ?? 0, b ?? r ?? 0, THREE.LinearSRGBColorSpace);

// Standard Surface: base / emission weights, opacity (colour), subsurface radius (colour × scale), thin film
function standardWeights(raw, params, num, vec) {
    const value = (k, d) => (raw[`std:${k}`]?.value !== undefined ? raw[`std:${k}`].value : d);
    const base = num(value('base', 0.8));
    if (params.color && base !== 1) params.color = '#' + new THREE.Color(params.color).multiplyScalar(base).getHexString();
    const emission = num(value('emission', 0));
    if (emission > 0) params.emissiveIntensity = emission;
    const opacity = value('opacity', null);
    if (opacity !== null) { const o = vec(opacity); params.opacity = (o[0] + (o[1] ?? o[0]) + (o[2] ?? o[0])) / 3; }
    const radius = value('subsurface_radius', null), scale = num(value('subsurface_scale', 1));
    if (radius !== null) params.subsurfaceRadius = Math.max(...vec(radius)) * scale;
    const film = num(value('thin_film_thickness', 0));
    if (film > 0) { params.iridescence = 1; params.iridescenceThickness = film; }
}
