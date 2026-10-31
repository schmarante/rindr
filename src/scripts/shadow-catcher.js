// Shadow catcher for the ground ("ground shadow"): the ground shows only the model's shadow, otherwise
// the background behind it – no HDRI projection of its own. Prerequisite for transparent images with shadow.
//
// Raster: ShadowNodeMaterial (shadow maps of the lights).
// Path tracer: three-gpu-pathtracer has no shadow catcher ("matte" only cuts surfaces out). The Vite
// plugin in astro.config.mjs replaces the matte branch of the megakernel with shadow-catcher.patch.wgsl:
// background × (irradiance with occluders / irradiance without), estimated with one shadow ray per sample.
// The weights come from here (uniforms shared with the kernel):
//   params.x = probability to sample the environment (E_env / E_total)
//   params.y = 1 / E_env (luminance of the upward irradiance of the environment, incl. intensity; unused by
//              the rejection sampling in the kernel, kept for debugging)
//   params.z = strength (0 = no shadow, 1 = full)
//   params.w = active (1) – otherwise the library's matte behaviour (transparent)
//   lights, lights2 = probability per light, in the path tracer's light order (scene.traverseVisible), max. 8 –
//              by the unshadowed irradiance at the centre of the ground (point/spot/area lights fall off with the
//              distance: their share there; a light pool on the ground itself is not shown – the catcher shows the
//              background × the share of light that arrives, at most 1)
//   bounce   = colour bleeding: x = strength (0 = off, scales the bounce seen by the camera), y = π / E_total –
//              every ground hit sends a ray upwards; where it hits the model the path continues with the albedo
//              HDRI floor colour × y (≤ 0.9), so the model's light tints the ground, over all bounces
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

export const SHADOW_CATCHER = {
    params: uniform(new THREE.Vector4(1, 0, 1, 0)),
    lights: uniform(new THREE.Vector4()),
    lights2: uniform(new THREE.Vector4()),
    bounce: uniform(new THREE.Vector4()),
};

const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const isPathTracerLight = c => c.isRectAreaLight || c.isSpotLight || c.isPointLight || c.isDirectionalLight;

/**
 * Update the weights (after changes of HDRI, intensity, lights).
 * @param {THREE.Scene} scene
 * @param {THREE.Color|null} envIrradiance  upward irradiance of the HDRI (without environmentIntensity)
 * @param {{ enabled: boolean, strength?: number, bounce?: number }} o  bounce = colour bleeding strength (0 = off)
 */
export function updateShadowCatcher(scene, envIrradiance, { enabled, strength = 1, bounce = 1, point = new THREE.Vector3() }) {
    const eEnv = scene.environment && envIrradiance ? luminance(envIrradiance) * scene.environmentIntensity : 0;
    // lights in the same order as the path tracer collects them
    const lights = [];
    scene.traverseVisible(c => { if (isPathTracerLight(c)) lights.push(c); });
    const eLights = lights.slice(0, MAX_LIGHTS).map(light => irradianceAt(light, point) * luminance(light.color));
    const total = eEnv + eLights.reduce((s, e) => s + e, 0);
    const p = SHADOW_CATCHER.params.value, l = SHADOW_CATCHER.lights.value, l2 = SHADOW_CATCHER.lights2.value;
    const on = enabled && total > 0 && strength > 0;
    SHADOW_CATCHER.bounce.value.set(on ? Math.max(bounce, 0) : 0, on ? Math.PI / total : 0, 0, 0);
    if (!enabled || total <= 0) {
        p.set(1, 0, strength, enabled ? 1 : 0);
        l.set(0, 0, 0, 0);
        l2.set(0, 0, 0, 0);
        return;
    }
    p.set(eEnv / total, eEnv > 0 ? 1 / eEnv : 0, strength, 1);
    l.set(...[0, 1, 2, 3].map(i => (eLights[i] || 0) / total));
    l2.set(...[4, 5, 6, 7].map(i => (eLights[i] || 0) / total));
}

const MAX_LIGHTS = 8;
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();
// unshadowed irradiance (per unit colour) of a light on an upward surface at `point`
function irradianceAt(light, point) {
    light.updateMatrixWorld();
    _p.setFromMatrixPosition(light.matrixWorld);
    if (light.isDirectionalLight) {
        light.target.updateMatrixWorld();
        _d.copy(_p).sub(_t.setFromMatrixPosition(light.target.matrixWorld)).normalize();
        return Math.max(_d.y, 0) * light.intensity;
    }
    _d.copy(_p).sub(point);
    const d2 = Math.max(_d.lengthSq(), 1e-9);
    _d.normalize();
    const up = Math.max(_d.y, 0);
    if (light.isRectAreaLight) {
        // small source: luminance × area × cos at the light × cos at the ground / d² (the light faces −z)
        _n.set(0, 0, -1).transformDirection(light.matrixWorld);
        const area = light.width * light.height * (light.isCircular ? Math.PI / 4 : 1);
        return light.intensity * area * Math.max(-_n.dot(_d), 0) * up / d2;
    }
    let e = light.intensity * up / d2;
    if (light.isSpotLight) {
        light.target.updateMatrixWorld();
        _n.setFromMatrixPosition(light.target.matrixWorld).sub(_p).normalize();
        const cos = -_n.dot(_d), outer = Math.cos(light.angle), inner = Math.cos(light.angle * (1 - light.penumbra));
        e *= THREE.MathUtils.smoothstep(cos, outer, inner);
    }
    return e;
}
