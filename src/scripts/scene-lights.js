// Lights of the scene (Scene Graph → Lights): the ambient light and any number of directional, point, spot and area
// lights (rectangle, disc) – created with "+ Light", copied, deleted, saved with the scene (viewer.js, scene-state.js).
//
// Strength: what the panel shows and the scene saves. Directional (and ambient): the light's intensity as before
// (illuminance). Point/spot: intensity = strength × size² – the illuminance at one model size from the light equals
// the strength, a point light 1 next to a model is about as bright as a directional light 1 (three.js and the path
// tracer both fall off with 1/d², and models come in mm or m). Area lights: intensity (luminance) = strength × size² /
// area – the same at one model size in front of the light, independent of its width/height. `size` = the scene size
// (environment.modelSize); a new size (another model) scales positions, targets and areas of the local lights with it
// (refitLight), like the directional lights keep their direction and move to twice the size.
//
// Spot and area lights aim at their target (userData.rindr.target, world) – moving one keeps it on the target
// (aimLight). Area lights in the raster need the LTC tables of three.js (~80 KB, loaded with the first one,
// prepareAreaLights); they cast no raster shadows (three.js has none for them), in HQ every light casts shadows.
//
// IES lights: a three.js IESSpotLight – its `iesMap` (x: angle from the axis 0…180°, y: around it 0…359° or one row)
// replaces the cone in the raster and in the path tracer (both read the same layout). Profiles: own procedural ones
// (IES_PROFILES – no third-party data shipped) or an .ies file of the user (three.js IESLoader; its text is saved with
// the scene, a few KB). The spot angle only sets the raster shadow camera: the profile's extent (where it falls below
// 2 % of its peak), at most 85°. Strength: like a spot – the peak of the profile.
import * as THREE from 'three/webgpu';

export const LIGHT_KINDS = ['directional', 'point', 'spot', 'ies', 'rect', 'disc'];
export const LOCAL_KINDS = new Set(['point', 'spot', 'ies', 'rect', 'disc']);

// own IES-like profiles: intensity (0…1) at the angle θ from the axis (radians) and φ around it
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const deg = Math.PI / 180;
export const IES_PROFILES = {
    narrow: { symmetric: true, at: th => Math.max(Math.cos(th), 0) ** 40 },                       // downlight, ~20° beam
    wide: { symmetric: true, at: th => Math.max(Math.cos(th), 0) ** 3 },                          // downlight, wide
    batwing: { symmetric: true, at: th => (th < 90 * deg ? Math.sin(2 * th) ** 2 * 0.85 + 0.15 * Math.cos(th) : 0) },   // peak ~45°
    wallwash: { symmetric: false, at: (th, ph) => {                                                // asymmetric: towards φ = 0
        const tilt = 30 * deg;
        const c = Math.sin(th) * Math.cos(ph) * Math.sin(tilt) + Math.cos(th) * Math.cos(tilt);   // cos of the angle to a tilted axis
        return th < 90 * deg ? Math.max(c, 0) ** 6 : 0;
    } },
    globe: { symmetric: true, at: th => 0.55 + 0.45 * Math.cos(th) * smooth(-0.2, 1, Math.cos(th)) + 0.1 * (1 - Math.cos(th)) },   // pendant, also up
};
const profileCache = new Map();   // id / file text → { texture, extent }

// texture of a profile function (layout of three.js' IESLoader) and its extent (degrees)
function profileTexture(fn, symmetric) {
    const rows = symmetric ? 1 : 360;
    const values = new Float32Array(180 * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < 180; x++) values[y * 180 + x] = fn(x * 180 / 179 * deg, y * deg);
    return toTexture(values, rows);
}
function toTexture(values, rows) {
    let max = 0;
    for (const v of values) max = Math.max(max, v);
    const data = new Uint16Array(values.length);
    let extent = 0;
    for (let i = 0; i < values.length; i++) {
        const v = max > 0 ? values[i] / max : 0;
        data[i] = THREE.DataUtils.toHalfFloat(v);
        if (v > 0.02) extent = Math.max(extent, (i % 180) * 180 / 179);
    }
    const texture = new THREE.DataTexture(data, 180, rows, THREE.RedFormat, THREE.HalfFloatType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return { texture, extent };
}

/**
 * Profile of an IES light: { id } (own profile) or { name, text } (.ies file). Sets the map and the angle of the raster
 * shadow camera; throws on an unreadable file.
 */
export async function setIesProfile(light, ies) {
    const key = ies.text ?? ies.id;
    let entry = profileCache.get(key);
    if (!entry) {
        if (ies.text) {
            const { IESLoader } = await import('three/addons/loaders/IESLoader.js');
            const texture = new IESLoader().parse(ies.text);
            const values = Float32Array.from(texture.image.data, v => THREE.DataUtils.fromHalfFloat(v));
            texture.dispose();
            if (!values.some(v => v > 0)) throw new Error('empty IES profile');
            entry = toTexture(values, values.length / 180);
        } else {
            const profile = IES_PROFILES[ies.id] ?? IES_PROFILES.wide;
            entry = profileTexture(profile.at, profile.symmetric);
        }
        profileCache.set(key, entry);
    }
    light.iesMap = entry.texture;
    light.angle = Math.min(Math.max(entry.extent + 5, 15), 85) * deg;
    light.userData.rindr.ies = ies.text ? { name: ies.name, text: ies.text } : { id: ies.id ?? 'wide' };
}

let areaReady = null;
/** LTC tables for area lights in the raster (once, before the first area light is added to the scene) */
export function prepareAreaLights() {
    areaReady ??= import('three/addons/lights/RectAreaLightTexturesLib.js').then(({ RectAreaLightTexturesLib }) => {
        THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
    });
    return areaReady;
}

/** kind of a light: ambient | directional | point | spot | rect | disc */
export function lightKind(light) {
    if (light.userData.rindr?.kind) return light.userData.rindr.kind;
    if (light.isAmbientLight) return 'ambient';
    if (light.isDirectionalLight) return 'directional';
    if (light.isSpotLight) return light.iesMap !== undefined ? 'ies' : 'spot';
    if (light.isPointLight) return 'point';
    if (light.isRectAreaLight) return light.isCircular ? 'disc' : 'rect';
    return 'other';
}

const area = light => light.width * light.height * (light.isCircular ? Math.PI / 4 : 1);

/** strength (see top) of a light */
export function strengthOf(light) {
    return light.userData.rindr?.strength ?? light.intensity;
}

/** set the strength and the intensity from it (size = scene size) */
export function setStrength(light, strength, size) {
    const meta = light.userData.rindr ??= { kind: lightKind(light) };
    meta.strength = strength;
    meta.size = size;
    const kind = meta.kind;
    const s2 = size * size;
    light.intensity = kind === 'point' || kind === 'spot' || kind === 'ies' ? strength * s2
        : kind === 'rect' || kind === 'disc' ? strength * s2 / Math.max(area(light), 1e-9)
            : strength;
}

/** a new light of this kind (not placed yet: placeLight) */
export function createLight(kind, name) {
    let light;
    if (kind === 'directional') light = new THREE.DirectionalLight(0xffffff, 1);
    else if (kind === 'point') light = new THREE.PointLight(0xffffff, 1, 0, 2);
    else if (kind === 'spot') light = new THREE.SpotLight(0xffffff, 1, 0, THREE.MathUtils.degToRad(30), 0.3, 2);
    else if (kind === 'ies') light = new THREE.IESSpotLight(0xffffff, 1, 0, THREE.MathUtils.degToRad(60), 0, 2);   // profile: setIesProfile
    else light = new THREE.RectAreaLight(0xffffff, 1, 1, 1);
    if (kind === 'disc') light.isCircular = true;   // the path tracer: elliptic area within the rectangle
    light.name = name;
    light.userData.rindr = { kind, strength: 1, target: [0, 0, 0], size: 1 };
    // raster shadows: directional and spot (one map each); point lights would need six (cube) – off by default
    if (kind === 'directional' || kind === 'spot' || kind === 'ies') {
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.bias = -0.0005;
    }
    return light;
}

/**
 * Default place of a new light: above the model, towards the camera's side (the light comes from where one looks,
 * a bit to the side). center/size: the scene; eye: camera position.
 */
export function placeLight(light, { center, size, eye }) {
    const meta = light.userData.rindr;
    const toEye = eye.clone().sub(center).setY(0);
    if (toEye.lengthSq() < 1e-9) toEye.set(0, 0, 1);
    toEye.normalize();
    const side = new THREE.Vector3(-toEye.z, 0, toEye.x);   // to the right of the view
    const dir = toEye.clone().multiplyScalar(0.6).addScaledVector(side, 0.6).add(new THREE.Vector3(0, 1, 0)).normalize();
    const distance = { directional: 2, point: 0.9, spot: 1.4, ies: 1.2, rect: 1.1, disc: 1.1 }[meta.kind] ?? 1;
    light.position.copy(center).addScaledVector(dir, size * distance);
    meta.target = center.toArray();
    if (light.isRectAreaLight) light.width = light.height = size * 0.4;
    if (light.isSpotLight) light.radius = size * 0.02;   // soft spot shadows in HQ (the path tracer's disc)
    setStrength(light, meta.kind === 'directional' ? 1 : 1.5, size);
    aimLight(light);
}

/** spot / area light: keep pointing at the target after a move */
export function aimLight(light) {
    const meta = light.userData.rindr;
    if (!meta?.target || !(light.isSpotLight || light.isRectAreaLight)) return;
    const target = new THREE.Vector3().fromArray(meta.target);
    if (light.isSpotLight) {
        light.target.position.copy(target);
        light.target.updateMatrixWorld();
    } else {
        light.lookAt(target);
    }
    light.updateMatrixWorld();
}

/**
 * New scene size / centre (another model): local lights keep their place relative to the model – offsets, target,
 * area and size-relative values scale with it; the intensity follows the strength.
 */
export function refitLight(light, { fromCenter, toCenter, size }) {
    const meta = light.userData.rindr;
    if (!meta || !LOCAL_KINDS.has(meta.kind)) return;
    const from = meta.size > 0 ? meta.size : size;
    const k = size / from;
    if (Math.abs(k - 1) > 1e-6 || !fromCenter.equals(toCenter)) {
        light.position.sub(fromCenter).multiplyScalar(k).add(toCenter);
        meta.target = new THREE.Vector3().fromArray(meta.target).sub(fromCenter).multiplyScalar(k).add(toCenter).toArray();
        if (light.isRectAreaLight) { light.width *= k; light.height *= k; }
        if (light.isSpotLight) light.radius = (light.radius || 0) * k;
    }
    setStrength(light, meta.strength ?? 1, size);
    aimLight(light);
}

const vec = v => v.toArray().map(x => +x.toFixed(4));

/** saved state of a light (scene-state.js) */
export function lightState(light) {
    const kind = lightKind(light);
    const s = {
        name: light.name, type: light.type, kind, visible: light.visible,
        position: vec(light.position), intensity: light.intensity, strength: strengthOf(light), color: '#' + light.color.getHexString(),
    };
    if (LOCAL_KINDS.has(kind)) {
        s.target = light.userData.rindr.target.map(x => +x.toFixed(4));
    }
    if (light.shadow && kind !== 'directional') s.castShadow = light.castShadow;
    if (light.isSpotLight) Object.assign(s, { angle: +THREE.MathUtils.radToDeg(light.angle).toFixed(3), penumbra: light.penumbra, radius: light.radius || 0 });
    if (kind === 'ies') s.ies = { ...light.userData.rindr.ies };
    if (light.isRectAreaLight) Object.assign(s, { width: light.width, height: light.height });
    return s;
}

/**
 * Apply a saved state to a light of the same kind. size = the current scene size: the strength sets the intensity
 * (older scenes without strength: their intensity). IES lights: their profile (async – await the result).
 */
export function applyLightState(light, s, size) {
    applyLightValues(light, s, size);
    // the profile sets the shadow angle – afterwards
    if (lightKind(light) === 'ies') return setIesProfile(light, s.ies ?? { id: 'wide' }).catch(() => setIesProfile(light, { id: 'wide' }));
    return Promise.resolve();
}

function applyLightValues(light, s, size) {
    const meta = light.userData.rindr ??= { kind: lightKind(light) };
    if (s.name) light.name = s.name;
    light.visible = s.visible !== false;
    light.position.fromArray(s.position);
    light.color.set(s.color);
    if (s.castShadow !== undefined && light.shadow) light.castShadow = !!s.castShadow;
    if (light.isSpotLight) {
        if (s.angle !== undefined) light.angle = THREE.MathUtils.degToRad(s.angle);
        if (s.penumbra !== undefined) light.penumbra = s.penumbra;
        if (s.radius !== undefined) light.radius = s.radius;
    }
    if (light.isRectAreaLight) {
        if (s.width) light.width = s.width;
        if (s.height) light.height = s.height;
    }
    if (s.target) meta.target = [...s.target];
    // positions are absolute (the scene's model has the size it was saved with); the strength refers to that size
    setStrength(light, s.strength ?? s.intensity ?? 1, size);
    light.updateMatrixWorld();
    aimLight(light);
}
