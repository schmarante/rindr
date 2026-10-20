// USD materials written as MDL shaders (info:implementationSource = sourceAsset) – three's composer only reads
// UsdPreviewSurface, scenes from DCC pipelines often carry nothing but MDL: every material came out white. No MDL
// compiler here – the constant inputs and the image inputs of the three common shader families are mapped onto
// MeshPhysicalMaterial, recognised by their input names (names of the format, not of a product):
//  - standard PBR: diffuse_color_constant / diffuse_texture, reflection_roughness_constant, metallic_constant, ORM,
//    normalmap_texture, emissive_*, opacity_*, texture_scale/translate
//  - glass: glass_color, glass_ior, frosting_roughness, thin_walled, normal_map_texture
//  - layered "uber" (vehicle materials): diffuse_reflection_color / base_color_image, metalness(_image),
//    roughness_range_position + roughness_image, coat (tinted: the paint's colour often sits in coat_color over a grey
//    base), flakes, normal_image, emission_*, opacity, uv_scale_01/uv_offset_01/uv_rotation_01
// Approximations: roughness of the layered shader = the position of its range (the image modulates around it),
// flakes = a little metal, coat tint multiplied into the base colour; a referenced base colour image that cannot be
// found scales the colour to a typical average albedo (the colour is a tint over an unknown image – white tyres
// otherwise).
// Textures (also those of UsdPreviewSurface – the composer's own loading missed them for scenes opened by URL):
// requested during composing (placeholders), loaded afterwards in one go (UsdTextures.load) with a size limit from
// the memory budget – a vehicle scene references 258 images of ~14 MB each.
import * as THREE from 'three/webgpu';
import { textureMaxSide } from './memory-budget.js';

const isMdl = attrs => attrs['info:implementationSource'] === 'sourceAsset' || attrs['info:mdl:sourceAsset'] !== undefined;
const asset = v => (typeof v === 'string' ? v.replace(/^@|@$/g, '') : v?.assetPath ?? v?.path ?? '');
const color = v => (Array.isArray(v) && v.length >= 3 ? new THREE.Color(v[0], v[1], v[2]) : null);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const on = v => v === true || v === 1;

/** MDL shader of a material: { path, attrs } or null */
export function mdlShader(composer, materialPath) {
    for (const path of composer.shadersByMaterialPath.get(materialPath) || []) {
        const attrs = composer._getAttributes(path);
        if (isMdl(attrs)) return { path, attrs };
    }
    return null;
}

/**
 * Inputs of the MDL shader → material. textures.request(assetPath, layerDir, { srgb }) returns a placeholder texture
 * (filled by textures.load) or null; onMissing(material) is called when a referenced base colour image is missing.
 */
export function applyMdl(material, { attrs }, textures, layerDir) {
    const v = name => attrs['inputs:' + name];
    // key: the material slot (a missing image is remembered per slot – linked in place later, usd-importer/viewer)
    const tex = (key, name, srgb = false) => {
        const path = asset(v(name));
        return path ? textures.request(path, layerDir, { srgb, material, key }) : null;
    };
    const repeat = (scale, offset, rotation) => ({ scale: Array.isArray(scale) ? scale : null, offset: Array.isArray(offset) ? offset : null, rotation: num(rotation, 0) });
    let uv;
    material.metalness = 0;
    material.roughness = 0.5;

    if (v('glass_color') !== undefined || v('glass_ior') !== undefined) {
        // glass
        material.color.copy(color(v('glass_color')) || new THREE.Color(1, 1, 1));
        material.transmission = 1;
        material.ior = num(v('glass_ior'), 1.5);
        material.roughness = num(v('frosting_roughness'), 0);
        material.thickness = on(v('thin_walled')) ? 0 : 1;
        material.normalMap = tex('normalMap', 'normal_map_texture');
        if (material.normalMap) material.normalScale.setScalar(num(v('normal_map_strength'), 1));
        if (on(v('use_glass_color_texture'))) material.map = tex('map', 'glass_color_texture', true);
        uv = repeat(v('texture_scale'), v('texture_translate'), v('texture_rotate'));
    } else if (v('diffuse_reflection_color') !== undefined || v('base_color_image') !== undefined || v('roughness_range_position') !== undefined) {
        // layered vehicle shader
        const base = color(v('diffuse_reflection_color')) || new THREE.Color(1, 1, 1);
        material.metalness = num(v('metalness'), 0);
        const range = v('roughness_range_position');
        material.roughness = Array.isArray(range) ? THREE.MathUtils.clamp(range[1], 0, 1) : num(v('roughness_u'), 0.5);
        material.specularIntensity = num(v('specular_reflection_weight'), 1);
        const specular = color(v('specular_reflection_color'));
        if (specular) material.specularColor.copy(specular);
        if (on(v('enable_coat'))) {
            material.clearcoat = 1;
            material.clearcoatRoughness = num(v('coat_roughness'), 0.05);
            const tint = color(v('coat_color'));
            if (tint) base.multiply(tint);
        }
        if (on(v('enable_flakes'))) material.metalness = Math.max(material.metalness, 0.25);
        material.color.copy(base);
        material.map = tex('map', 'base_color_image', true);
        // packed images (ORM): three reads roughness from green, metalness from blue – used where the channel fits
        const channel = (name, fallback) => num(v(name), fallback);
        if (channel('roughness_channel', 1) === 1) material.roughnessMap = tex('roughnessMap', 'roughness_image');
        if (channel('metalness_channel', 2) === 2 && material.metalness > 0) material.metalnessMap = tex('metalnessMap', 'metalness_image');
        material.normalMap = tex('normalMap', 'normal_image');
        if (material.normalMap) {
            const s = num(v('normal_scale'), 1);
            material.normalScale.set(s, on(v('normal_flip_green')) ? -s : s);
        }
        if (on(v('enable_emission'))) {
            material.emissive.copy(color(v('emission_color')) || new THREE.Color(1, 1, 1));
            material.emissiveMap = tex('emissiveMap', 'emission_image', true);
            material.emissiveIntensity = Math.min(num(v('emission_intensity'), 1), 10);
        }
        if (on(v('enable_opacity'))) {
            material.alphaMap = tex('alphaMap', 'opacity_image');
            if (material.alphaMap) material.transparent = true;
        }
        uv = repeat(v('uv_scale_01'), v('uv_offset_01'), v('uv_rotation_01'));
    } else {
        // standard PBR
        const tint = color(v('diffuse_tint'));
        material.color.copy(color(v('diffuse_color_constant')) || new THREE.Color(0.2, 0.2, 0.2));
        if (tint) material.color.multiply(tint);
        material.map = tex('map', 'diffuse_texture', true);
        material.roughness = num(v('reflection_roughness_constant'), 0.5);
        material.metalness = num(v('metallic_constant'), 0);
        if (on(v('enable_ORM_texture'))) {
            material.roughnessMap = tex('roughnessMap', 'ORM_texture');
            material.metalnessMap = tex('metalnessMap', 'ORM_texture');
            material.aoMap = tex('aoMap', 'ORM_texture');
        } else {
            if (v('reflectionroughness_texture') !== undefined) material.roughnessMap = tex('roughnessMap', 'reflectionroughness_texture');
            if (v('metallic_texture') !== undefined) material.metalnessMap = tex('metalnessMap', 'metallic_texture');
        }
        if (material.roughnessMap && v('reflection_roughness_texture_influence') !== undefined) material.roughness = Math.max(material.roughness, num(v('reflection_roughness_texture_influence'), 1));
        if (material.metalnessMap) material.metalness = num(v('metallic_texture_influence'), 1) > 0 ? 1 : material.metalness;
        material.normalMap = tex('normalMap', 'normalmap_texture');
        if (material.normalMap) material.normalScale.setScalar(num(v('bump_factor'), 1));
        if (on(v('enable_emission'))) {
            material.emissive.copy(color(v('emissive_color')) || new THREE.Color(1, 1, 1));
            material.emissiveMap = tex('emissiveMap', 'emissive_color_texture', true);
            material.emissiveIntensity = Math.min(num(v('emissive_intensity'), 1), 10);
        }
        if (on(v('enable_opacity'))) {
            material.opacity = num(v('opacity_constant'), 1);
            material.alphaMap = tex('alphaMap', 'opacity_texture');
            material.transparent = material.opacity < 1 || !!material.alphaMap;
        }
        uv = repeat(v('texture_scale'), v('texture_translate'), v('texture_rotate'));
    }
    material.userData.usdUv = uv;
    material.userData.usdTint = '#' + material.color.getHexString();
}

// --- textures ---


/**
 * Texture requests during composing, loaded afterwards. resolve(path, layerDir) → { key, remote, read(): Promise<Blob|null> }
 * or null (cannot be located); missing paths are collected (asset window: "missing").
 */
export class UsdTextures {
    constructor(resolve) {
        this.resolve = resolve;
        this.byKey = new Map();    // key → { base, read, users: [{ material, key, srgb }], textures }
        this.missing = new Set();
        this.missingUsers = new Map();   // path → Set of materials (null: a request without one – UsdPreviewSurface)
    }

    /** missing paths that one of the materials still in use needs (others belonged to replaced or hidden ones) */
    missingFor(usedMaterials) {
        return [...this.missing].filter(p => [...(this.missingUsers.get(p) || [null])].some(m => m === null || usedMaterials.has(m)));
    }

    _miss(path, material) {
        this.missing.add(path);
        if (!this.missingUsers.has(path)) this.missingUsers.set(path, new Set());
        this.missingUsers.get(path).add(material);
    }

    /** a texture for this request (own wrap/tiling/colour space, image shared with all requests of the file) */
    request(path, layerDir, { srgb = false, material = null, key = null } = {}) {
        const found = this.resolve(path, layerDir);
        if (!found) {
            this._miss(path, material);
            if (material && key) missingSlot(material, key, path, srgb);
            return null;
        }
        let entry = this.byKey.get(found.key);
        if (!entry) {
            const base = new THREE.Texture();
            base.name = path.split(/[\\/]/).pop();
            base.wrapS = base.wrapT = THREE.RepeatWrapping;
            base.flipY = false;   // the bitmap is flipped while decoding (USD texture coordinates start bottom left)
            base.userData.flippedImage = true;   // previews of the picture turn it back (node editor)
            entry = { base, read: found.read, path, users: [], textures: [] };
            this.byKey.set(found.key, entry);
        }
        const texture = entry.base.clone();   // shares the image source
        if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
        entry.textures.push(texture);
        entry.users.push({ material, key, srgb });
        return texture;
    }

    /** load all requested images, at most `maxSide` px (from the memory budget); onProgress(done, total) */
    async load(onProgress = () => {}) {
        const entries = [...this.byKey.values()];
        if (!entries.length) return { loaded: 0, maxSide: 0 };
        const maxSide = textureMaxSide(entries.length);
        let done = 0, loaded = 0, next = 0;
        const worker = async () => {
            while (next < entries.length) {
                const entry = entries[next++];
                let bitmap = null;
                try {
                    const blob = await entry.read();
                    if (blob) {
                        const probe = await createImageBitmap(blob);
                        const s = Math.min(1, maxSide / Math.max(probe.width, probe.height));
                        if (s < 1) {
                            probe.close();
                            bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', resizeWidth: Math.max(1, Math.round(probe.width * s)), resizeHeight: Math.max(1, Math.round(probe.height * s)), resizeQuality: 'high' });
                        } else {
                            probe.close();
                            bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
                        }
                    }
                } catch (err) {
                    console.warn('[USD] texture not readable:', entry.path, err?.message || err);
                }
                if (bitmap) {
                    entry.base.image = bitmap;
                    for (const t of entry.textures) t.needsUpdate = true;
                    loaded++;
                } else {
                    for (const u of entry.users) {
                        this._miss(entry.path, u.material);
                        if (u.material && u.key) missingSlot(u.material, u.key, entry.path, u.srgb);
                    }
                }
                onProgress(++done, entries.length);
            }
        };
        // a few at a time: decoding a 4K image takes ~64 MB until it is scaled down
        await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));
        return { loaded, maxSide };
    }
}

// a material slot whose image is missing: { url, srgb } in userData.usdMissingMaps (finishMaterials adds tiling and
// the base colour before toning it down) – mesh-importer hands it on as render.missing, the viewer links a file
// dropped or loaded later into exactly these slots without reopening the scene
function missingSlot(material, key, url, srgb) {
    (material.userData.usdMissingMaps ||= {})[key] = { url, srgb };
}

/** after loading: maps without an image removed, tiling per material, base colour toned down where its image is
 * missing */
export function finishMaterials(materials) {
    const KEYS = ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'emissiveMap', 'alphaMap', 'aoMap'];
    for (const m of materials) {
        for (const key of KEYS) {
            const t = m[key];
            if (!t) continue;
            if (!t.image) { m[key] = null; continue; }
            const uv = m.userData.usdUv;
            if (uv && (uv.scale || uv.offset || uv.rotation)) {
                // each request has its own texture object – tiling set on it
                if (uv.scale) t.repeat.set(uv.scale[0], uv.scale[1]);
                if (uv.offset) t.offset.set(uv.offset[0], uv.offset[1]);
                t.rotation = uv.rotation * Math.PI / 180;
            }
        }
        const missing = m.userData.usdMissingMaps;
        const uv = m.userData.usdUv;
        if (missing) for (const info of Object.values(missing)) if (uv) Object.assign(info, { repeat: uv.scale, offset: uv.offset, rotation: uv.rotation });
        if (missing?.map && !m.map) {
            // the colour tints an image we do not have: a typical average albedo (≈ 0.2; metals reflect more); the
            // shader's own tint comes back with the image (the composer may have put a display colour on it meanwhile)
            missing.map.color = m.userData.usdTint || '#' + m.color.getHexString();
            m.color.multiplyScalar(m.metalness >= 0.5 ? 0.6 : 0.2);
        }
        delete m.userData.usdTint;
        if (m.alphaMap === null && m.transparent && m.opacity >= 1) m.transparent = false;
        delete m.userData.usdUv;
        m.needsUpdate = true;
    }
}
