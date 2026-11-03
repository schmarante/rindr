// Ground shadow ("shadow catcher"): a disc below the model that shows only the model's shadow – everywhere else the
// background behind it (HDRI, dome or vignette) shows through unchanged. No HDRI projection of its own, so it always
// matches the background and later also works for transparent images.
//
// Raster: ShadowNodeMaterial (shadow maps of the directional lights). Path tracer: material flag `matte`,
// the megakernel is patched to a real shadow catcher (shadow-catcher.js / shadow-catcher.patch.wgsl):
// background × share of the light (HDRI + lights) that reaches the ground point.
//
// Soft edge between fadeStart and fadeEnd (smootherstep over the distance from the centre). The disc ends at fadeEnd:
// a unit disc of a few hundred triangles, scaled to fadeEnd (radius slider = a transform, no new BVH). Raster: the fade
// per pixel from the world position (opacityNode). Path tracer: nothing beyond the disc; inside it the catcher is a
// full hit (its branch runs before the transparency test), ground reflection and puddles fade by position themselves
// (ground-reflection.js). Before (Nov. 2026, found with the ray cost heat map, debug-raycost.js): a disc of 384 rings
// × 128 segments = 98,304 triangles out to 150 × the model size (±300 m for the sample scene) with the fade in a
// 1-pixel alpha map along uv.v (hence the fine rings) – in the path tracer every ray towards the horizon traversed it
// and read the alpha map for the triangles beyond the fade only to skip them.
import * as THREE from 'three/webgpu';
import { uniform, positionWorld, clamp, float } from 'three/tsl';
import { updateShadowCatcher } from './shadow-catcher.js';

const RINGS = [0.125, 0.25, 0.5, 0.75, 1];   // ring radii of the unit disc (roughly square cells out to the rim)
const SEGMENTS = 64;                          // azimuth segments (rim 0.12 % inside the circle – where the fade is ~0)
// raster preview: shadow maps give hard, fully black shadows – dampened to come closer to the soft
// path traced shadow (only via opacityNode: material.opacity is read by the path tracer as transparency)
const RASTER_SHADOW_OPACITY = 0.5;

export class GroundProjection {
    constructor() {
        // raster: only the shadow (transparent black); path tracer: matte = shadow catcher (patched kernel)
        this.material = new THREE.ShadowNodeMaterial({ transparent: true, opacity: 1 });
        this.material.matte = true;
        this._center = uniform(new THREE.Vector2());
        this._fade = uniform(new THREE.Vector2(1e30, 1e30));   // fadeStart, fadeEnd (world units)
        this._shadowOn = uniform(1);   // 0: disc only for the ground reflection (ground-reflection.js), no shadow
        const e = clamp(positionWorld.xz.sub(this._center).length().sub(this._fade.x).div(this._fade.y.sub(this._fade.x).max(1e-6)), 0, 1);
        const fade = float(1).sub(e.mul(e).mul(e).mul(e.mul(e.mul(6).sub(15)).add(10)));   // 1 - smootherstep
        this.material.opacityNode = fade.mul(RASTER_SHADOW_OPACITY).mul(this._shadowOn);
        this.mesh = new THREE.Mesh(createGeometry(), this.material);
        this.mesh.name = 'GroundProjection';
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;
        this.mesh.visible = false;
        this.mesh.renderOrder = -1;
        this.height = 1;          // model size the disc was placed for (model units)
        this.groundY = 0;
        this.strength = 1;        // shadow strength 0…1
        this.bounce = 1;          // colour bleeding (light of the model onto the ground, path tracer) 0 = off
        this._irradiance = null;  // E of the HDRI upper hemisphere (without environmentIntensity)
        this._texture = null;
    }

    /** Shadow shown (false: the disc is only there for the ground reflection / puddles) */
    set shadow(v) {
        this._shadowOn.value = v ? 1 : 0;
        this.strength = v ? 1 : 0;
    }

    get enabled() {
        return this.mesh.visible;
    }

    set enabled(v) {
        this.mesh.visible = v;
    }

    /** Set the HDRI (equirect DataTexture with CPU data) – its upward irradiance weights the shadow rays */
    setEnvironment(texture) {
        if (this._texture === texture) return;
        this._texture = texture;
        this._irradiance = upwardIrradiance(texture);
    }

    /**
     * Placement: ground at height groundY (world), centre (x, z); soft edge from fadeStart to fadeEnd (distance from the
     * centre, world units) – the disc ends at fadeEnd (without one: 150 × height, the old extent)
     */
    place(groundY, height, fadeStart = Infinity, fadeEnd = Infinity, x = 0, z = 0) {
        this.groundY = groundY;
        this.height = Math.max(height, 1e-6);
        const radius = Number.isFinite(fadeEnd) && fadeEnd > 0 ? fadeEnd : 150 * this.height;
        const start = Math.min(Number.isFinite(fadeStart) ? fadeStart : radius, radius);
        this.mesh.position.set(x, groundY, z);   // centre of the scene's footprint
        this.mesh.scale.setScalar(radius);
        this.mesh.updateMatrixWorld(true);
        this._center.value.set(x, z);
        this._fade.value.set(start, radius);
    }

    /** Update the shadow catcher weights (after changes of HDRI, intensity or lights) */
    update(scene) {
        updateShadowCatcher(scene, this._irradiance, { enabled: this.enabled, strength: this.strength, bounce: this.bounce, point: this.mesh.position });
    }
}

// unit disc in the xz plane (radius 1): a fan around the centre, then rings – counter-clockwise seen from above
function createGeometry() {
    const positions = [0, 0, 0], uvs = [0.5, 0.5], normals = [0, 1, 0], index = [];
    for (const r of RINGS) {
        for (let i = 0; i < SEGMENTS; i++) {
            const phi = i / SEGMENTS * 2 * Math.PI;
            positions.push(r * Math.cos(phi), 0, r * Math.sin(phi));
            uvs.push(0.5 + 0.5 * r * Math.cos(phi), 0.5 + 0.5 * r * Math.sin(phi));
            normals.push(0, 1, 0);
        }
    }
    const at = (ring, i) => 1 + ring * SEGMENTS + (i % SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) index.push(0, at(0, i + 1), at(0, i));
    for (let ring = 0; ring + 1 < RINGS.length; ring++) {
        for (let i = 0; i < SEGMENTS; i++) {
            const a = at(ring, i), b = at(ring, i + 1), c = at(ring + 1, i), d = at(ring + 1, i + 1);
            index.push(a, b, c, b, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(index);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
}

// E = ∫ L(ω) · max(ω_y, 0) dω over the equirect texture (half or float data)
function upwardIrradiance(texture) {
    const { data, width, height } = texture.image;
    const read = texture.type === THREE.HalfFloatType ? x => THREE.DataUtils.fromHalfFloat(x) : x => x;
    const e = new THREE.Color(0, 0, 0);
    const dPhi = 2 * Math.PI / width, dTheta = Math.PI / height;
    for (let y = 0; y < height; y++) {
        const lat = ((y + 0.5) / height - 0.5) * Math.PI;   // v = asin(dir.y)/π + 0.5
        const up = Math.sin(lat);
        if (up <= 0) continue;
        const w = up * Math.cos(lat) * dPhi * dTheta;
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            e.r += read(data[i]) * w;
            e.g += read(data[i + 1]) * w;
            e.b += read(data[i + 2]) * w;
        }
    }
    return e;
}
