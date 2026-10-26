// Gaussian splat object for the WebGPU renderer (raster; in HQ the path tracer traces them as a volume, splat-volume.js).
// One instanced quad per splat; the vertex shader reads the splat data from storage buffers in the order of
// the last sort (splat-sorter.js, back to front), projects the 3D covariance to the screen (EWA, like the
// reference implementation of 3D Gaussian Splatting) and stretches the quad along its two axes (±3σ).
// The fragment shader fades with the Gaussian; blending premultiplied, no depth writes.
//
// Data (splat-formats.js): a = position + rgba8, b = log scales + rotation (halfs), sh = higher SH bands.
// Colours of splats are display values (sRGB). The viewer draws them in a pass of their own (splat-composite.js,
// setDisplayOutput: display values out, blended in display space like the reference) and composites them over the
// frame – with PBR models (tone curve on) back through the inverse curve; undoing the curve per splat failed: blending
// happens before the tone mapping, the inverse of bright splats is large and many overlapping ones summed up to white.
// Fisheye and wireframe draw them in the frame: turned linear here (the viewer switches tone mapping off for a splat
// scene alone, so the screen shows the trained colours; linear blending looks paler). Models block the
// main light: splat-shadow.js depth map, read at the splat centre (setShadow) – the splat is darkened there.
// Material variants (_variant) share the vertex logic: main (in the frame), composite (+ depth for AO), env (environment
// capture, own drawing order from sortEnv), light (opacity map of splat-opacity.js). Relighting / override material
// (setLook): per splat at its centre – normal from the shortest axis, the scene's lights and environment, own shadow
// from the opacity map – then through the renderer's tone curve.
//
// Progressive loading: the load worker fills shared buffers; setLoaded() uploads the new range, only the
// splats read so far are sorted/drawn. A reveal grows with the progress – splats at its edge fade in (size +
// opacity, colour unchanged) – and runs out to the farthest splats after loading (finish()). Shapes (`reveal.mode`):
// sphere from the centre outwards (default), plane from the bottom up, circle on screen (cone from the camera);
// settings in SPLATS.reveal (config.js). Pulse: in the edge band splats start larger, transparent and glowing (glow
// colour or own colour, brightened) and settle to their size/colour – the glow also covers the oddly coloured inner
// splats (never seen by the training cameras) that a spatial reveal exposes on its cut.
import * as THREE from 'three/webgpu';
import {
    Fn, If, Discard, storage, instanceIndex, uniform, vec2, vec3, vec4, float, uint, uintBitsToFloat, unpackHalf2x16,
    unpackUnorm4x8, unpackSnorm4x8, mix, abs, modelViewMatrix, modelWorldMatrixInverse, cameraProjectionMatrix, cameraPosition,
    positionGeometry, screenSize, varyingProperty, exp, sqrt, max, min, normalize, length, dot, select, sRGBTransferEOTF, smoothstep,
    modelWorldMatrix, textureLoad, ivec2, clamp, step, pow, mrt, log, reflect, pmremTexture, sRGBTransferOETF, texture, uv, atan, acos,
    floor, fract, screenUV,
    acesFilmicToneMapping, agxToneMapping, neutralToneMapping, cineonToneMapping, reinhardToneMapping, linearToneMapping,
} from 'three/tsl';
import { SplatSorter } from './splat-sorter.js';
import { SPLATS } from '../config.js';

// placeholder until a depth map exists (same texture kind → the shader keeps its binding)
const NO_SHADOW_MAP = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType);
NO_SHADOW_MAP.needsUpdate = true;
// stand-in environment of relit splats until the viewer passes the HDRI (grey, equirectangular)
const NO_ENVIRONMENT = new THREE.DataTexture(new Uint16Array([0x3800, 0x3800, 0x3800, 0x3c00]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
NO_ENVIRONMENT.mapping = THREE.EquirectangularReflectionMapping;
NO_ENVIRONMENT.needsUpdate = true;
// environment of relit splats: baked from the PMREM into a small panorama per roughness level (ENV_LEVELS, bands one
// below the other) – pmremTexture cannot be read in the vertex shader (three.js samples it with gradients)
const ENV_W = 64, ENV_H = 32, ENV_LEVELS = [0.2, 0.4667, 0.7333, 1];
// the renderer's tone curves (relit splats: display value as the output pass would show the models)
const TONE_CURVES = {
    [THREE.ACESFilmicToneMapping]: acesFilmicToneMapping, [THREE.AgXToneMapping]: agxToneMapping, [THREE.NeutralToneMapping]: neutralToneMapping,
    [THREE.CineonToneMapping]: cineonToneMapping, [THREE.ReinhardToneMapping]: reinhardToneMapping, [THREE.LinearToneMapping]: linearToneMapping,
};

export const REVEAL_MODES = ['sphere', 'plane', 'screen'];

const SH_C1 = 0.4886025119029199;
const SH_C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
const SH_C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];

// SH basis of the higher bands for direction d (3DGS ordering) – coefficient j ↔ f_rest index j
function shBasis(d) {
    const { x, y, z } = d;
    const xx = x.mul(x), yy = y.mul(y), zz = z.mul(z);
    return [
        y.mul(-SH_C1), z.mul(SH_C1), x.mul(-SH_C1),
        x.mul(y).mul(SH_C2[0]), y.mul(z).mul(SH_C2[1]), zz.mul(2).sub(xx).sub(yy).mul(SH_C2[2]), x.mul(z).mul(SH_C2[3]), xx.sub(yy).mul(SH_C2[4]),
        y.mul(xx.mul(3).sub(yy)).mul(SH_C3[0]), x.mul(y).mul(z).mul(SH_C3[1]), y.mul(zz.mul(4).sub(xx).sub(yy)).mul(SH_C3[2]),
        z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))).mul(SH_C3[3]), x.mul(zz.mul(4).sub(xx).sub(yy)).mul(SH_C3[4]),
        z.mul(xx.sub(yy)).mul(SH_C3[5]), x.mul(xx.sub(yy.mul(3))).mul(SH_C3[6]),
    ];
}

const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _widen = new THREE.Matrix4().makeScale(1 / 1.25, 1 / 1.25, 1);

export class SplatMesh extends THREE.Mesh {
    /**
     * @param {object} data result of splat-formats.js (count, a, b, sh, shWords, shCoeffs, shRange, bounds, pick sample)
     * @param {{ onSorted?: () => void }} options onSorted: a new order is ready (request a frame)
     */
    constructor(data, { onSorted } = {}) {
        const count = data.count;
        const { geometry, attrs } = createGeometry(data.a, data.b, data.sh, count);
        // bounds for framing/fitting: robust box (captured scenes have far floaters)
        geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...data.robustMin), new THREE.Vector3(...data.robustMax));
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        super(geometry, createMaterial());
        const { a: attrA, b: attrB, sh: attrSh, order: attrOrder } = attrs;
        this.isSplat = true;
        this.frustumCulled = false;
        this.castShadow = this.receiveShadow = false;
        this.renderOrder = 10;

        this.count = count;
        this.data = data;
        this.attrOrder = attrOrder;
        this.attrs = { a: attrA, b: attrB, sh: attrSh };
        this.loading = !!data.loading;
        this.ranges = this.loading ? [] : [[0, count]];   // splats read so far (parallel parsers: one range each)
        this.loaded = this.loading ? 0 : count;           // number of splats in `ranges`
        this._uploaded = new Map();                        // range start → uploaded up to (a/b and sh separately)
        this.onSorted = onSorted;
        this.sorter = new SplatSorter(data.a, count);
        this.sorting = false;
        this.lastSort = null;   // camera of the last sort (data space)
        this.fullBox = new THREE.Box3(new THREE.Vector3(...data.min), new THREE.Vector3(...data.max));
        this._release = [attrB, attrSh].filter(Boolean);
        this._drawn = 0;
        this.reveal = {
            center: uniform(new THREE.Vector3()), radius: uniform(0), width: uniform(1),
            mode: uniform(0), up: uniform(new THREE.Vector3(0, 1, 0)), base: uniform(0),
            glow: uniform(0), glowColor: uniform(new THREE.Color(1, 1, 1)), glowMix: uniform(1), startSize: uniform(1), minStart: uniform(0),
            band: 0.2, minStartSize: 0, r: 0, robust: 1, full: 1, active: true, t: 0,
        };
        this.setRevealOptions(SPLATS.reveal);
        // depth of field (dof.js values, set in update()): aperture diameter + focus in mm, focus as a sphere
        // around the camera (fisheye), focus line (green, like dof.renderLine for meshes)
        this.dof = { enabled: uniform(0), aperture: uniform(0), focus: uniform(1000), sphere: uniform(0), line: uniform(0) };
        // display = 1: display values out (own pass onto the finished image, setDisplayOutput); shadow of models (setShadow)
        this.display = uniform(0);
        this.shadow = { enabled: uniform(0), strength: uniform(SPLATS.shadowStrength), matrix: uniform(new THREE.Matrix4()), size: uniform(1), nodes: [] };
        // relighting / override material (setLook, setRenderState); opacity map for the own shadow (setOpacity)
        this.look = {
            mode: 'baked', material: null, structure: 'baked|false', toneMapping: THREE.NoToneMapping,
            color: uniform(new THREE.Color(1, 1, 1)), metalness: uniform(0), roughness: uniform(0.5), emissive: uniform(new THREE.Color(0, 0, 0)),
            detail: uniform(1), meanLuma: uniform(0.2), exposure: uniform(1), envIntensity: uniform(1),
            lights: [0, 1].map(() => ({ direction: uniform(new THREE.Vector3(0, 1, 0)), color: uniform(new THREE.Color(0, 0, 0)) })),
            ambient: uniform(new THREE.Color(0, 0, 0)),   // ambient light: colour × intensity
            envTexture: null,
            envRotation: uniform(new THREE.Matrix3()),   // world → environment texture direction (three.js: transpose)
        };
        this._envBake = null;   // { target, quad, node, baked } – built on first relighting
        this.opacity = null;
        this.envCount = 0;
        this.defaultLitMode = 'surface';
        this._revealBounds();
        this._buildMaterial(attrA, attrB, attrOrder, attrSh, data);
    }

    // centre (robust box) and radii of the reveal circle (robust box / all splats)
    _revealBounds() {
        const rv = this.reveal, box = this.geometry.boundingBox;
        if (!this._centerSet) { box.getCenter(rv.center.value); this._centerSet = true; }
        const far = b => {
            let d = 0;
            for (let i = 0; i < 8; i++) d = Math.max(d, rv.center.value.distanceTo(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)));
            return d || 1;
        };
        rv.robust = far(box);
        rv.full = Math.max(far(this.fullBox), rv.robust);
        rv.width.value = rv.robust * rv.band;
        rv.minStart.value = rv.robust * rv.minStartSize;
    }

    /**
     * Splats (and their SH) read so far – lists of [start, end) ranges: upload what is new since the last call
     * and sort/draw only these
     */
    setLoaded(ranges, shRanges = ranges) {
        const up = (attrs, list, key, words) => {
            for (const [start, end] of list) {
                const from = this._uploaded.get(key + start) ?? start;
                if (end <= from) continue;
                for (const attr of attrs) {
                    if (!attr) continue;
                    attr.addUpdateRange(from * words, (end - from) * words);
                    attr.needsUpdate = true;
                }
                this._uploaded.set(key + start, end);
            }
        };
        up([this.attrs.a, this.attrs.b], ranges, 'p', 4);
        if (this.attrs.sh) up([this.attrs.sh], shRanges, 's', this.data.shWords);
        this.ranges = ranges.map(r => [...r]);
        this.loaded = ranges.reduce((n, [s, e]) => n + e - s, 0);
    }

    /** loading finished: final bounds + pick sample (result of splat-formats.js) */
    finish(result) {
        const { min, max, robustMin, robustMax, unbounded, pickIndex, pickRadius, format, fileShCoeffs } = result;
        Object.assign(this.data, { min, max, robustMin, robustMax, unbounded, pickIndex, pickRadius, format, fileShCoeffs });
        // outdoor capture: the estimated bounds while loading (e.g. SOG: meta.json = everything incl. the sky shell)
        // may lie far off the core → reveal from the core's centre
        if (unbounded) this._centerSet = false;
        this.geometry.boundingBox.set(new THREE.Vector3(...robustMin), new THREE.Vector3(...robustMax));
        this.geometry.boundingSphere = this.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        this.fullBox.set(new THREE.Vector3(...min), new THREE.Vector3(...max));
        this.setLoaded([[0, this.count]]);
        this.loading = false;
        this.data.loading = false;
        this._revealBounds();
        this.look.meanLuma.value = meanLuma(this.data.a, this.count);
        // relit without a choice: flat splats (a surface scan) → normals; round ones (smoke, fur) → volume
        this.defaultLitMode = this.data.b && flatShare(this.data.b, this.count) > 0.5 ? 'surface' : 'volume';
    }

    // reveal radius: follows the progress while loading (at most the robust extent / 1.5 s), then out to the
    // farthest splat; afterwards switched off (radius "infinite")
    _animateReveal(camera) {
        const rv = this.reveal;
        if (!rv.active) return;
        const now = performance.now();
        this.updateWorldMatrix(true, false);
        _inv.copy(this.matrixWorld).invert();
        rv.up.value.set(0, 1, 0).transformDirection(_inv);   // world up in data space
        // extent to cover: robust bounds while loading, all splats at the end
        let load = rv.robust, end = rv.full;
        const mode = REVEAL_MODES[rv.mode.value];
        if (mode === 'plane') {
            const span = box => {
                let lo = Infinity, hi = -Infinity;
                for (let i = 0; i < 8; i++) {
                    const h = _d.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(rv.center.value).dot(rv.up.value);
                    lo = Math.min(lo, h); hi = Math.max(hi, h);
                }
                return [lo, hi];
            };
            const [lo, hi] = span(this.geometry.boundingBox);
            rv.base.value = -lo;   // distance = height above the bottom of the robust box
            load = hi - lo;
            end = Math.max(span(this.fullBox)[1] - lo, load);
        } else if (mode === 'screen') {
            // splats in front of the centre are magnified in the cone
            const dist = _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv).distanceTo(rv.center.value);
            end = rv.full * Math.min(dist > rv.full ? dist / (dist - rv.full) : 5, 5);
        }
        const dt = rv.t ? Math.min(now - rv.t, 100) / 1000 : 0;
        rv.t = now;
        const target = this.loading ? load * (0.1 + 0.9 * this.loaded / this.count) : end + rv.width.value;
        const speed = this.loading ? load / 1.5 : Math.max(load / 1.5, end - load);
        rv.r = Math.max(rv.r, Math.min(target, rv.r + speed * dt));
        rv.radius.value = rv.r;
        if (!this.loading && rv.r >= target) {
            rv.active = false;
            rv.radius.value = 1e30;
        }
    }

    /** shape of the reveal (REVEAL_MODES), edge band, pulse – see SPLATS.reveal in config.js */
    setRevealOptions({ mode, band, glow, startSize, minStartSize, glowColor } = {}) {
        const rv = this.reveal;
        if (mode !== undefined) rv.mode.value = Math.max(0, REVEAL_MODES.indexOf(mode));
        if (band !== undefined) rv.band = band;
        if (glow !== undefined) rv.glow.value = glow;
        if (startSize !== undefined) rv.startSize.value = startSize;
        if (minStartSize !== undefined) rv.minStartSize = minStartSize;
        if (glowColor !== undefined) {
            rv.glowMix.value = glowColor ? 1 : 0;
            if (glowColor) rv.glowColor.value.set(glowColor);
        }
    }

    _buildMaterial(attrA, attrB, attrOrder, attrSh, data) {
        const count = this.count;
        const W = data.shWords;
        this._src = {
            A: storage(attrA, 'uvec4', count).toReadOnly(),
            B: storage(attrB, 'uvec4', count).toReadOnly(),
            SH: attrSh ? storage(attrSh, 'uint', count * W).toReadOnly() : null,
            W, K: data.shCoeffs, antialias: !!data.antialias,
            order: storage(attrOrder, 'uint', count).toReadOnly(),
            orderEnv: null,   // environment capture (envMaterial)
        };
        this.uniforms = { shRange: uniform(data.shRange) };
        this._vary = { color: varyingProperty('vec4', 'vSplatColor'), coord: varyingProperty('vec2', 'vSplatCoord'), depth: varyingProperty('float', 'vSplatDepth') };
        this._variants = { main: this.material };   // + composite, env, light: built on first use
        this.material.fragmentNode = this._fragmentNode('main');
        this._setVertex(this.material, this._src.order);
    }

    // position + vertex node of a material variant. order: storage buffer of the drawing order (null = every splat
    // once in buffer order: light pass); light: orthographic light camera, opacity out
    _setVertex(material, order, light = false) {
        const { A } = this._src;
        // local position = splat centre: positionView/world of the material are then those of the centre –
        // the section plane (ClippingGroup) cuts whole splats at their centre
        material.positionNode = Fn(() => {
            const a = A.element(order ? order.element(instanceIndex) : instanceIndex);
            return vec3(uintBitsToFloat(a.x), uintBitsToFloat(a.y), uintBitsToFloat(a.z));
        })();
        material.vertexNode = this._vertexNode(order, light);
        material.needsUpdate = true;
    }

    // Material variants share the vertex logic:
    //  main      – drawn in the frame (fisheye, wireframe): premultiplied by three.js
    //  composite – own pass of splat-composite.js: colour (premultiplied in the shader) + depth × alpha (MRT, for AO)
    //  env       – environment capture (splat-environment.js): like composite, in the order of sortEnv
    //  light     – opacity map of splat-opacity.js: every splat once, optical depth per depth slice, added up
    _variant(kind, order, light = false, map = null) {
        const m = createMaterial();
        m.premultipliedAlpha = false;   // MRT output: done in the shader
        m.blending = THREE.CustomBlending;
        m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
        m.blendSrc = m.blendSrcAlpha = THREE.OneFactor;
        m.blendDst = m.blendDstAlpha = kind === 'light' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
        if (kind === 'light') m.depthTest = false;
        if (kind === 'front') {
            m.blending = THREE.NoBlending;
            m.depthTest = m.depthWrite = true;
        }
        m.name = `Gaussian Splats (${kind})`;
        m.fragmentNode = this._fragmentNode(kind, map);
        this._setVertex(m, order, light);
        return m;
    }

    /** material for the own pass of splat-composite.js (colour + depth) */
    get compositeMaterial() {
        return this._variants.composite ??= this._variant('mrt', this._src.order);
    }

    /** material for the environment capture: in the order of the last sortEnv (distance from the probe) */
    get envMaterial() {
        if (!this._variants.env) {
            this.attrOrderEnv = new THREE.StorageBufferAttribute(new Uint32Array(this.count), 1);
            this.geometry.setAttribute('splatOrderEnv', this.attrOrderEnv);   // freed with the geometry
            this._src.orderEnv = storage(this.attrOrderEnv, 'uint', this.count).toReadOnly();
            this._variants.env = this._variant('mrt', this._src.orderEnv);
        }
        return this._variants.env;
    }

    /**
     * materials for the light passes of a splat-opacity.js map (one pair per map – the main light's and the light
     * shafts' have slices of their own): front = the nearest clearly covering splat per texel (depth test), light =
     * optical depth into the slices relative to that front. map = { b0, b1 } slice ends (relative light depth), front
     * (texture of the front pass)
     */
    lightMaterials(map) {
        this._lightVariants ??= new Map();
        let pair = this._lightVariants.get(map);
        if (!pair) {
            pair = { front: this._variant('front', null, true), light: this._variant('light', null, true, map) };
            this._lightVariants.set(map, pair);
            this._variants[`front${this._lightVariants.size}`] = pair.front;
            this._variants[`light${this._lightVariants.size}`] = pair.light;
        }
        return pair;
    }

    /** draw with another material variant (and instance count) until the returned function restores the mesh */
    useVariant(material, instances) {
        const before = { material: this.material, count: this.geometry.instanceCount };
        this.material = material;
        if (instances !== undefined) this.geometry.instanceCount = instances;
        return () => {
            this.material = before.material;
            this.geometry.instanceCount = before.count;
        };
    }

    _fragmentNode(kind, map = null) {
        const { color: vColor, coord: vCoord, depth: vDepth } = this._vary;
        const alpha = Fn(() => {
            const d2 = dot(vCoord, vCoord);
            Discard(d2.greaterThan(9));
            const a = exp(d2.mul(-0.5)).mul(vColor.a).toVar();
            Discard(a.lessThan(1 / 255));
            return min(a, kind === 'light' ? 0.995 : 0.99);
        })().toVar();
        if (kind === 'main') return vec4(vColor.rgb, alpha);
        // front of the opacity map: the light depth of clearly covering splats (≥ 10 % – a smoke's haze counts), the
        // depth test keeps the nearest
        if (kind === 'front') {
            Discard(alpha.lessThan(0.1));
            return vec4(vColor.r, 0, 0, 1);
        }
        if (kind === 'mrt') return mrt({ output: vec4(vColor.rgb.mul(alpha), alpha), splatDepth: vec4(vDepth.mul(alpha), 0, 0, alpha) });
        // light: optical depth −ln(1 − α) into every slice that ends behind the splat – its light depth relative to the
        // front of this texel (deep opacity map: the slices follow the first surface, so a surface lies at the start of
        // a slice instead of anywhere in it – with fixed slices a relit skull showed bands across the light)
        const od = log(float(1).sub(alpha)).negate();
        const t = vec4(vColor.r.sub(texture(map.front, screenUV).r));
        return mrt({ output: step(t, map.b0).mul(od), slices: step(t, map.b1).mul(od) });
    }

    _vertexNode(order, light) {
        const { A, B, SH, W, K, antialias } = this._src;
        const { shRange } = this.uniforms;
        const { color: vColor, coord: vCoord, depth: vDepth } = this._vary;
        const look = this.look;
        const lit = !light && look.mode !== 'baked';
        return Fn(() => {
            const index = order ? order.element(instanceIndex) : instanceIndex;
            const a = A.element(index).toVar();
            const b = B.element(index).toVar();
            const center = vec3(uintBitsToFloat(a.x), uintBitsToFloat(a.y), uintBitsToFloat(a.z)).toVar();
            const view = modelViewMatrix.mul(vec4(center, 1)).toVar();
            const clip = cameraProjectionMatrix.mul(view).toVar();
            const out = vec4(0, 0, 2, 1).toVar();   // culled: outside the clip volume
            vColor.assign(vec4(0));
            vCoord.assign(vec2(0));
            vDepth.assign(0);
            const bound = clip.w.mul(1.2);
            let grow = float(1), pulse = float(0), scaleIn = s => s;
            if (!light) {
                // reveal: 1 inside, grows from 0 within the edge band, 0 outside. Distance by mode: 0 = to the centre
                // (sphere), 1 = height above the bottom (plane), 2 = distance from the axis camera → centre, scaled to
                // the depth of the centre (cone = circle on screen; camera at the centre → sphere)
                const { center: revealCenter, radius: revealRadius, width: revealWidth, mode: revealMode, up: revealUp, base: revealBase } = this.reveal;
                const sphereDist = length(center.sub(revealCenter));
                const planeDist = dot(center.sub(revealCenter), revealUp).add(revealBase);
                const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
                const axis = revealCenter.sub(eye).toVar();
                const axisLength = length(axis).toVar();
                const rel = center.sub(eye).toVar();
                const along = dot(rel, axis).div(max(axisLength, 1e-6)).toVar();
                const lateral = length(rel.sub(axis.mul(along.div(max(axisLength, 1e-6)))));
                const cone = select(along.greaterThan(0), lateral.mul(axisLength).div(max(along, axisLength.mul(0.05))), float(1e30));
                const screenDist = select(axisLength.greaterThan(revealWidth), cone, sphereDist);
                const revealDist = select(revealMode.lessThan(0.5), sphereDist, select(revealMode.lessThan(1.5), planeDist, screenDist));
                // grow: 0 = just reached by the reveal, 1 = through
                grow = float(1).sub(smoothstep(revealRadius.sub(revealWidth), revealRadius, revealDist)).toVar();
                pulse = float(1).sub(grow).toVar();
                // pulse: size per axis from `startSize` × own size (at least `minStart`) down to the own size
                // (shrinking from nothing made single bright pixels – sparkles)
                const { startSize, minStart } = this.reveal;
                scaleIn = s => mix(s, max(s.mul(startSize), minStart), pulse);
            }
            If(grow.greaterThan(0.002).and(clip.w.greaterThan(0)).and(clip.x.abs().lessThan(bound)).and(clip.y.abs().lessThan(bound)), () => {
                // 3D covariance = M Mᵀ with M = R·S; its columns in view space
                const s01 = unpackHalf2x16(b.x), s2 = unpackHalf2x16(b.y).x;
                const qwx = unpackHalf2x16(b.z), qyz = unpackHalf2x16(b.w);
                const w = qwx.x, x = qwx.y, y = qyz.x, z = qyz.y;
                const r0 = vec3(float(1).sub(y.mul(y).add(z.mul(z)).mul(2)), x.mul(y).add(w.mul(z)).mul(2), x.mul(z).sub(w.mul(y)).mul(2)).toVar();
                const r1 = vec3(x.mul(y).sub(w.mul(z)).mul(2), float(1).sub(x.mul(x).add(z.mul(z)).mul(2)), y.mul(z).add(w.mul(x)).mul(2)).toVar();
                const r2 = vec3(x.mul(z).add(w.mul(y)).mul(2), y.mul(z).sub(w.mul(x)).mul(2), float(1).sub(x.mul(x).add(y.mul(y)).mul(2))).toVar();
                const sx = exp(s01.x).toVar(), sy = exp(s01.y).toVar(), sz = exp(s2).toVar();
                const m0 = modelViewMatrix.mul(vec4(r0.mul(scaleIn(sx)), 0)).xyz;
                const m1 = modelViewMatrix.mul(vec4(r1.mul(scaleIn(sy)), 0)).xyz;
                const m2 = modelViewMatrix.mul(vec4(r2.mul(scaleIn(sz)), 0)).xyz;
                // Jacobian of the projection in pixels: perspective (x/z clamped like the reference), or the
                // orthographic light camera (a plain scale)
                const focal = vec2(cameraProjectionMatrix.element(0).x, cameraProjectionMatrix.element(1).y).mul(screenSize).mul(0.5);
                const depth = view.z.negate().toVar();
                let project;
                if (light) project = m => m.xy.mul(focal);
                else {
                    const limit = vec2(1.3).div(vec2(cameraProjectionMatrix.element(0).x, cameraProjectionMatrix.element(1).y));
                    const txy = view.xy.div(depth).clamp(limit.negate(), limit).mul(depth);
                    project = m => vec2(m.x.mul(depth).add(txy.x.mul(m.z)), m.y.mul(depth).add(txy.y.mul(m.z))).mul(focal).div(depth.mul(depth));
                }
                const t0 = project(m0).toVar(), t1 = project(m1).toVar(), t2 = project(m2).toVar();
                const c00 = dot(vec3(t0.x, t1.x, t2.x), vec3(t0.x, t1.x, t2.x));
                const c01 = dot(vec3(t0.x, t1.x, t2.x), vec3(t0.y, t1.y, t2.y));
                const c11 = dot(vec3(t0.y, t1.y, t2.y), vec3(t0.y, t1.y, t2.y));
                // low-pass filter (≥ ~1 px) + eigen decomposition
                const ca = c00.add(0.3).toVar(), cb = c01.toVar(), cc = c11.add(0.3).toVar();
                const detLowPass = ca.mul(cc).sub(cb.mul(cb)).toVar();
                // depth of field: every splat is blurred by its circle of confusion (thin lens like the path tracer:
                // diameter on the focus plane = aperture · |d − focus| / d, in pixels · focal / focus; Gaussian with
                // σ = radius / 2) – added to its 2D covariance, opacity lowered so the energy stays the same
                const dof = this.dof;
                const dofDist = select(dof.sphere.greaterThan(0.5), length(view.xyz), depth).toVar();
                let dofEnergy = float(1);
                if (!light) {
                    const cocRadius = dof.aperture.mul(abs(dofDist.sub(dof.focus))).div(max(dofDist, 1e-6)).mul(focal.y).div(max(dof.focus, 1e-6)).mul(0.5);
                    const cocVar = cocRadius.mul(0.5).pow(2).mul(dof.enabled).toVar();
                    ca.addAssign(cocVar);
                    cc.addAssign(cocVar);
                    dofEnergy = sqrt(detLowPass.div(ca.mul(cc).sub(cb.mul(cb))));
                }
                const mid = ca.add(cc).mul(0.5);
                const radius = length(vec2(ca.sub(cc).mul(0.5), cb));
                const l1 = mid.add(radius), l2 = max(mid.sub(radius), 0.1);
                const diag = vec2(cb, l1.sub(ca));
                const dir = select(length(diag).greaterThan(1e-12), normalize(diag), vec2(1, 0)).toVar();
                const major = dir.mul(min(sqrt(l1).mul(3), 2048));
                const minor = vec2(dir.y, dir.x.negate()).mul(min(sqrt(l2).mul(3), 2048));
                const corner = positionGeometry.xy;
                const offset = major.mul(corner.x).add(minor.mul(corner.y)).mul(2).div(screenSize);
                out.assign(vec4(clip.xy.add(offset.mul(clip.w)), clip.z, clip.w));
                vCoord.assign(corner.mul(3));
                const base = unpackUnorm4x8(a.w);
                if (light) {
                    vColor.assign(vec4(clip.z.div(clip.w), 0, 0, base.a));   // light depth 0…1 (orthographic)
                    return;
                }
                vDepth.assign(depth);
                // colour: band 0 + view-dependent bands (direction in data space)
                const color = base.rgb.toVar();
                if (SH) {
                    const d = normalize(center.sub(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz)).toVar();
                    const basis = shBasis(d);
                    const bytes = [];
                    for (let k = 0; k < W; k++) {
                        const v = unpackSnorm4x8(SH.element(index.mul(uint(W)).add(uint(k)))).toVar();
                        bytes.push(v.x, v.y, v.z, v.w);
                    }
                    let sum = vec3(0);
                    for (let j = 0; j < K; j++) sum = sum.add(vec3(bytes[j * 3], bytes[j * 3 + 1], bytes[j * 3 + 2]).mul(basis[j]));
                    color.addAssign(sum.mul(shRange));
                }
                // pulse: towards the glow colour (or the own one) and brightened, settling with the band
                const glowTarget = mix(color, this.reveal.glowColor.mul(max(max(base.r, base.g), max(base.b, 0.35))), this.reveal.glowMix);
                color.assign(mix(color, glowTarget, pulse).mul(float(1).add(this.reveal.glow.mul(pulse))));
                // focus line: splats at the focus distance turn green (~2.5 px wide band)
                const lineWidth = dofDist.mul(2.5).div(focal.y);
                color.assign(mix(color, vec3(0.2, 1, 0.3), dof.line.mul(float(1).sub(smoothstep(lineWidth.mul(0.5), lineWidth, abs(dofDist.sub(dof.focus)))))));
                let alpha = base.a.mul(grow).mul(dofEnergy);
                // Mip-Splatting style files ("antialias"): keep the energy of the low-pass filtered splat
                if (antialias) alpha = alpha.mul(sqrt(max(c00.mul(c11).sub(c01.mul(c01)), 0).div(detLowPass)));
                const shade = this._shade(center);   // shadow of models
                if (lit) {
                    // relit (setLook): radiance from the scene's lights and environment; display value through the
                    // renderer's tone curve (the composite turns it back – the splat then looks like the models)
                    const radiance = this._lighting(center, sRGBTransferEOTF(max(color, 0)), [r0, r1, r2], [sx, sy, sz], shade).toVar();
                    const curve = TONE_CURVES[look.toneMapping];
                    const shown = curve ? clamp(curve(radiance, look.exposure), 0, 1) : clamp(radiance, 0, 1);
                    vColor.assign(vec4(select(this.display.greaterThan(0.5), sRGBTransferOETF(shown), max(radiance, 0)), alpha));
                } else {
                    // baked: light × shade, applied to the display colour
                    color.mulAssign(pow(shade, 1 / 2.2));
                    vColor.assign(vec4(select(this.display.greaterThan(0.5), max(color, 0), sRGBTransferEOTF(max(color, 0))), alpha));
                }
            });
            return out;
        })();
    }

    // Relighting (setLook) at the splat centre: normal = shortest axis of the Gaussian (flat splats lie on the
    // surface), turned towards the camera; albedo = the splat's colour (its baked light stays in it) or the override
    // material's colour × the splat's relative brightness (structure). Direct light of the two directional lights
    // (main light: × shadow of models × own shadow from the opacity map), GGX highlight, environment from the HDRI
    // (PMREM: roughness 1 = irradiance). 'volume': no normal (smoke) – half the light from every side, no highlight.
    _lighting(center, base, [r0, r1, r2], [sx, sy, sz], shade) {
        const look = this.look;
        const surface = look.mode === 'surface';
        const world = modelWorldMatrix.mul(vec4(center, 1)).xyz.toVar();
        const V = normalize(cameraPosition.sub(world)).toVar();
        const axis = select(sx.lessThan(sy).and(sx.lessThan(sz)), r0, select(sy.lessThan(sz), r1, r2));
        const nWorld = normalize(modelWorldMatrix.mul(vec4(axis, 0)).xyz).toVar();
        const n = select(dot(nWorld, V).lessThan(0), nWorld.negate(), nWorld).toVar();
        let albedo = base, metal = float(0), rough = float(0.8);
        if (look.material) {
            const luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
            albedo = look.color.mul(pow(clamp(luma.div(max(look.meanLuma, 1e-4)), 0, 4), look.detail));
            metal = look.metalness;
            rough = max(look.roughness, 0.04);
        }
        albedo = albedo.toVar();
        const diffuse = albedo.mul(float(1).sub(metal)).toVar();
        const f0 = mix(vec3(0.04), albedo, metal).toVar();
        const ndv = max(dot(n, V), 1e-3).toVar();
        const result = vec3(0).toVar();
        const ownShadow = this.opacity ? this.opacity.transmittance(world, { vertex: true }) : float(1);
        look.lights.forEach((l, k) => {
            const ndl = surface ? max(dot(n, l.direction), 0) : float(0.5);
            const incoming = l.color.mul(ndl).mul(k === 0 ? shade.mul(ownShadow) : float(1)).toVar();
            result.addAssign(diffuse.mul(incoming).mul(1 / Math.PI));
            if (!surface) return;
            // GGX: D × visibility (height-correlated Smith, approximated) × Schlick Fresnel
            const h = normalize(l.direction.add(V));
            const ndh = max(dot(n, h), 0);
            const alpha = rough.mul(rough), a2 = alpha.mul(alpha);
            const dd = ndh.mul(ndh).mul(a2.sub(1)).add(1);
            const D = a2.div(dd.mul(dd).mul(Math.PI));
            const gv = ndl.mul(ndv.mul(float(1).sub(alpha)).add(alpha));
            const gl = ndv.mul(ndl.mul(float(1).sub(alpha)).add(alpha));
            const visibility = float(0.5).div(max(gv.add(gl), 1e-5));
            const F = f0.add(float(1).sub(f0).mul(pow(float(1).sub(max(dot(V, h), 0)), 5)));
            result.addAssign(F.mul(D).mul(visibility).mul(incoming));
        });
        const env = (dir, level) => this._environment(dir, level);
        const irradiance = surface ? env(n, float(1)) : env(V, float(1)).add(env(V.negate(), float(1))).mul(0.5);
        result.addAssign(diffuse.mul(irradiance).mul(look.envIntensity));
        result.addAssign(diffuse.mul(look.ambient).mul(1 / Math.PI));   // like three.js: irradiance × Lambert
        if (surface) {
            const fr = f0.add(max(vec3(float(1).sub(rough)), f0).sub(f0).mul(pow(float(1).sub(ndv), 5)));
            result.addAssign(fr.mul(env(reflect(V.negate(), n), rough)).mul(look.envIntensity));
        }
        if (look.material) result.addAssign(look.emissive);
        return result;
    }

    /**
     * Relighting / override material (properties panel). mode: 'baked' (as captured), 'surface' (normals from the
     * flattest axis), 'volume' (smoke, no normals); material: null or { color, metalness, roughness, emissive,
     * emissiveIntensity, detail } (colours as hex/CSS strings).
     */
    setLook({ mode = this.look.mode, material = this.look.material } = {}) {
        const look = this.look;
        const structure = `${mode}|${!!material}`;
        look.mode = mode;
        look.material = material;
        if (material) {
            look.color.value.set(material.color ?? '#ffffff');
            look.metalness.value = material.metalness ?? 0;
            look.roughness.value = material.roughness ?? 0.5;
            look.emissive.value.set(material.emissive ?? '#000000').multiplyScalar(material.emissiveIntensity ?? 1);
            look.detail.value = material.detail ?? 1;
        }
        if (structure !== look.structure) {
            look.structure = structure;
            this._rebuild();
        }
    }

    // the vertex logic depends on the look (JS-time branches): new nodes for every variant but the light pass
    _rebuild() {
        const { main, composite, env } = this._variants;
        this._setVertex(main, this._src.order);
        if (composite) this._setVertex(composite, this._src.order);
        if (env) this._setVertex(env, this._src.orderEnv);
    }

    /**
     * Per frame from the viewer while relit: the renderer's tone curve + exposure, environment (texture, intensity),
     * the two directional lights (world direction towards the light, colour × intensity; hidden = black), ambient light
     */
    setRenderState({ renderer, toneMapping, exposure, environment, environmentIntensity, environmentRotation, lights, ambient = null }) {
        const look = this.look;
        look.exposure.value = exposure;
        look.envIntensity.value = environment ? environmentIntensity : 0;
        const shownInScene = o => { let shown = !!o; for (; o && shown; o = o.parent) shown = o.visible; return shown; };   // also the lights folder
        if (shownInScene(ambient)) look.ambient.value.copy(ambient.color).multiplyScalar(ambient.intensity);
        else look.ambient.value.setRGB(0, 0, 0);
        lights.forEach((light, k) => {
            const u = look.lights[k];
            if (!u) return;
            if (!shownInScene(light)) { u.color.value.setRGB(0, 0, 0); return; }
            light.updateWorldMatrix(true, false);
            light.target.updateWorldMatrix(true, false);
            u.direction.value.setFromMatrixPosition(light.matrixWorld).sub(_v.setFromMatrixPosition(light.target.matrixWorld)).normalize();
            u.color.value.copy(light.color).multiplyScalar(light.intensity);
        });
        look.envTexture = environment ?? NO_ENVIRONMENT;
        if (environmentRotation) look.envRotation.value.setFromMatrix4(_m.makeRotationFromEuler(environmentRotation)).transpose();
        if (look.mode !== 'baked' && renderer) this._bakeEnvironment(renderer);
        if (look.mode !== 'baked' && look.toneMapping !== toneMapping) {
            look.toneMapping = toneMapping;
            this._rebuild();
        } else look.toneMapping = toneMapping;
    }

    // the environment's panorama per roughness level (fragment pass reading the PMREM) – again when the HDRI changes
    _envTarget() {
        if (this._envBake) return this._envBake;
        const bands = ENV_LEVELS.length;
        const target = new THREE.RenderTarget(ENV_W, ENV_H * bands, { type: THREE.HalfFloatType, depthBuffer: false });
        target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
        target.texture.wrapS = THREE.RepeatWrapping;
        const e = this._envBake = { target, quad: new THREE.QuadMesh(new THREE.NodeMaterial()), node: null, baked: null };
        e.quad.material.fragmentNode = Fn(() => {
            const p = uv();
            const band = floor(p.y.mul(bands));
            const v = fract(p.y.mul(bands));
            let rough = float(ENV_LEVELS[0]);
            for (let k = 1; k < bands; k++) rough = select(band.greaterThan(k - 0.5), float(ENV_LEVELS[k]), rough);
            const phi = p.x.sub(0.5).mul(Math.PI * 2), theta = v.mul(Math.PI);
            const dir = vec3(theta.sin().mul(phi.cos()), theta.cos(), theta.sin().mul(phi.sin()));
            e.node = pmremTexture(e.baked ?? NO_ENVIRONMENT, dir, rough);
            return vec4(e.node.rgb, 1);
        })();
        return e;
    }

    _bakeEnvironment(renderer) {
        const e = this._envTarget();
        if (e.baked === this.look.envTexture) return;
        e.baked = this.look.envTexture;
        if (e.node) e.node.value = e.baked;
        const target = renderer.getRenderTarget();
        renderer.setRenderTarget(e.target);
        e.quad.render(renderer);
        renderer.setRenderTarget(target);
    }

    // environment light from the baked panorama (vertex stage: explicit level, two roughness bands blended)
    _environment(dir, rough) {
        const look = this.look;
        const tex = this._envTarget().target.texture, bands = ENV_LEVELS.length;
        const d = look.envRotation.mul(dir).toVar();
        const u = atan(d.z, d.x).div(Math.PI * 2).add(0.5);
        const v = clamp(acos(clamp(d.y, -1, 1)).div(Math.PI), 0.5 / ENV_H, 1 - 0.5 / ENV_H);
        const f = clamp(rough.sub(ENV_LEVELS[0]).div((1 - ENV_LEVELS[0]) / (bands - 1)), 0, bands - 1).toVar();
        const i0 = floor(f).toVar(), i1 = min(i0.add(1), bands - 1);
        const at = i => texture(tex, vec2(u, i.add(v).div(bands))).level(0).rgb;
        return mix(at(i0), at(i1), f.sub(i0));
    }

    /** opacity map of the splats (splat-opacity.js): the relit splats' own shadow */
    setOpacity(opacity) {
        this.opacity = opacity;
    }

    /**
     * Sort by distance from a world point for the environment capture (after the main sort, which keeps its own
     * order buffer). Resolves true once envMaterial draws in that order (envCount splats).
     */
    async sortEnv(point) {
        while (this.sorting) await new Promise(r => setTimeout(r, 16));
        if (this.sorter.disposed || this.loading) return false;
        this.envMaterial;   // order buffer
        this.sorting = true;
        try {
            this.updateWorldMatrix(true, false);
            _inv.copy(this.matrixWorld).invert();
            const origin = point.clone().applyMatrix4(_inv);
            const box = this.fullBox;
            let far = 0;
            for (let i = 0; i < 8; i++) far = Math.max(far, _d.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).distanceTo(origin));
            const size = box.getSize(_d).length() || 1;
            const visible = await this.sorter.sort({ origin: origin.toArray(), dir: [0, 0, -1], mode: 'distance', planes: null, near: size * 1e-5, far: far * 1.01, ranges: null });
            if (this.sorter.disposed) return false;
            const order = this.attrOrderEnv;
            order.array.set(visible === this.count ? this.sorter.order : this.sorter.order.subarray(0, visible));
            order.clearUpdateRanges();
            if (visible) order.addUpdateRange(0, visible);
            order.needsUpdate = true;
            this.envCount = visible;
            return true;
        } finally {
            this.sorting = false;
        }
    }

    // 1 = lit, down to 1 − strength where a model blocks the main light (3×3 depth taps around the centre)
    _shade(center) {
        const sh = this.shadow;
        const shade = float(1).toVar();
        If(sh.enabled.greaterThan(0.5), () => {
            const lp = sh.matrix.mul(modelWorldMatrix.mul(vec4(center, 1))).toVar();
            const uv = vec2(lp.x.mul(0.5).add(0.5), lp.y.mul(-0.5).add(0.5)).toVar();
            const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1)).mul(step(lp.z, 1));
            const px = ivec2(uv.mul(sh.size)).toVar();
            const top = ivec2(sh.size.sub(1), sh.size.sub(1));
            let sum = float(0);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const tap = textureLoad(NO_SHADOW_MAP, clamp(px.add(ivec2(dx, dy)), ivec2(0, 0), top));
                    sh.nodes.push(tap);
                    sum = sum.add(step(tap.x, lp.z.sub(0.0015)));   // stored depth nearer than the splat → blocked
                }
            }
            shade.assign(float(1).sub(sum.div(9).mul(inside).mul(sh.strength)));
        });
        return shade;
    }

    /** true: display values out (drawn in a pass of their own, composited over the frame) */
    setDisplayOutput(on) {
        this.display.value = on ? 1 : 0;
    }

    /** shadow depth map of the models (splat-shadow.js) or null */
    setShadow(shadow) {
        const sh = this.shadow;
        const on = !!shadow?.active;
        sh.enabled.value = on ? 1 : 0;
        if (!on) return;
        sh.matrix.value.copy(shadow.matrix);
        sh.size.value = shadow.size;
        const tex = shadow.target.texture;
        for (const n of sh.nodes) if (n.value !== tex) n.value = tex;   // rebuilt variants add new taps
    }

    /**
     * Before rendering: start a new sort when the camera (relative to the splats) changed noticeably.
     * fisheye: sorted by distance (valid for every cube face of the raster fisheye), no frustum culling.
     */
    update(camera, { fisheye = false, dof = null, focusLine = false } = {}) {
        this._animateReveal(camera);
        const d = this.dof;
        d.enabled.value = dof?.enabled ? 1 : 0;
        d.line.value = dof?.enabled && focusLine ? 1 : 0;
        if (dof) {
            d.aperture.value = camera.getFocalLength() / Math.max(dof.fStop, 0.1);
            d.focus.value = Math.max(dof.focusDistance, 1e-3);
        }
        d.sphere.value = fisheye ? 1 : 0;
        if (this.sorting || this.sorter.disposed || !this.loaded) return;
        this.updateWorldMatrix(true, false);
        _inv.copy(this.matrixWorld).invert();
        const origin = _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
        const dir = _d.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(_inv);
        const size = this.fullBox.getSize(new THREE.Vector3()).length() || 1;
        const last = this.lastSort;
        const changed = !last || last.fisheye !== fisheye || last.loaded !== this.loaded || last.origin.distanceTo(origin) > size * 1e-4 || last.dir.dot(dir) < 0.99995 ||
            !last.matrix.equals(this.matrixWorld) || (!fisheye && !last.projection.equals(camera.projectionMatrix));
        if (!changed) return;
        let planes = null;
        if (!fisheye) {
            // side planes of the (somewhat widened) frustum in data space
            _m.multiplyMatrices(_widen, camera.projectionMatrix).multiply(camera.matrixWorldInverse).multiply(this.matrixWorld);
            _frustum.setFromProjectionMatrix(_m, camera.coordinateSystem);
            planes = _frustum.planes.slice(0, 4).flatMap(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
        }
        // key range: from very close to the farthest corner of the bounds
        let far = 0;
        for (let i = 0; i < 8; i++) {
            const c = new THREE.Vector3(i & 1 ? this.fullBox.max.x : this.fullBox.min.x, i & 2 ? this.fullBox.max.y : this.fullBox.min.y, i & 4 ? this.fullBox.max.z : this.fullBox.min.z);
            far = Math.max(far, c.distanceTo(origin));
        }
        const sorter = this.sorter;
        const state = { loaded: this.loaded, origin: origin.clone(), dir: dir.clone(), fisheye, matrix: this.matrixWorld.clone(), projection: camera.projectionMatrix.clone() };
        this.sorting = true;
        sorter.sort({ origin: origin.toArray(), dir: dir.toArray(), mode: fisheye ? 'distance' : 'depth', planes, near: size * 1e-5, far: far * 1.01,
            ranges: this.loading ? this.ranges : null })
            .then(visible => {
                this.sorting = false;
                if (sorter.disposed) return;
                const order = this.attrOrder;
                order.array.set(visible === this.count ? this.sorter.order : this.sorter.order.subarray(0, visible));
                order.clearUpdateRanges();
                if (visible) order.addUpdateRange(0, visible);
                order.needsUpdate = true;
                this.geometry.instanceCount = visible;
                this.lastSort = state;
                this.onSorted?.();
            })
            .catch(err => { this.sorting = false; console.error('[Splats] sort failed', err); });
    }

    // After the first draws the data lives on the GPU – drop the CPU copies that are not needed any more
    // (scales/rotations, SH: hundreds of MB with large scenes). Positions stay (sorting, picking).
    onAfterRender() {
        if (!this._release || this.loading || !this.geometry.instanceCount || ++this._drawn < 3) return;
        for (const attr of this._release) attr.array = new attr.array.constructor(attr.itemSize);
        this.data.b = this.data.sh = null;
        this._release = null;
    }

    /**
     * Height (world) where the splats start from below: opacity summed up from the bottom (all splats, height
     * histogram) until it is worth `opaque` fully opaque splats – a funnel's semi-transparent tip counts, single faint
     * floaters do not; null while loading
     */
    lowestVisible(opaque = 4) {
        if (this.loading) return null;
        this.updateWorldMatrix(true, false);
        const e = this.matrixWorld.elements, box = this.fullBox.clone().applyMatrix4(this.matrixWorld);
        const bins = 4096, lo = box.min.y, span = Math.max(box.max.y - lo, 1e-9);
        const hist = new Float32Array(bins);
        const pos = new Float32Array(this.data.a.buffer, this.data.a.byteOffset, this.count * 4);
        const bytes = new Uint8Array(this.data.a.buffer, this.data.a.byteOffset, this.count * 16);
        for (let i = 0; i < this.count; i++) {
            const o = i * 4;
            const y = e[1] * pos[o] + e[5] * pos[o + 1] + e[9] * pos[o + 2] + e[13];
            hist[Math.min(bins - 1, Math.max(0, Math.floor((y - lo) / span * bins)))] += bytes[i * 16 + 15] / 255;
        }
        let sum = 0;
        for (let b = 0; b < bins; b++) {
            sum += hist[b];
            if (sum >= opaque) return lo + (b + 0.5) / bins * span;
        }
        return null;
    }

    // Picking: nearest splat of the pick sample (clearly opaque splats) whose ellipsoid (2σ of the largest
    // axis) the ray passes – no BVH, ~1 M samples brute force
    raycast(raycaster, intersects) {
        if (!this.visible) return;
        _inv.copy(this.matrixWorld).invert();
        const ray = raycaster.ray.clone().applyMatrix4(_inv);
        const { pickIndex, pickRadius, a } = this.data;
        if (!pickIndex) return;   // still loading
        const pos = new Float32Array(a.buffer);
        const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z, dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
        let best = Infinity, hit = -1;
        for (let k = 0; k < pickIndex.length; k++) {
            const o = pickIndex[k] * 4;
            const x = pos[o] - ox, y = pos[o + 1] - oy, z = pos[o + 2] - oz;
            const t = x * dx + y * dy + z * dz;
            if (t <= 0 || t >= best) continue;
            const r = pickRadius[k];
            if (x * x + y * y + z * z - t * t < r * r) { best = t; hit = k; }
        }
        if (hit < 0) return;
        const point = ray.at(best, new THREE.Vector3()).applyMatrix4(this.matrixWorld);
        const distance = raycaster.ray.origin.distanceTo(point);
        if (distance < raycaster.near || distance > raycaster.far) return;
        intersects.push({ distance, point, object: this, index: pickIndex[hit] });
    }

    dispose() {
        this.sorter.dispose();
        this.geometry.dispose();
        for (const m of new Set([this.material, ...Object.values(this._variants)])) m.dispose();
        if (this._envBake) { this._envBake.target.dispose(); this._envBake.quad.material.dispose(); }
    }
}

// share of flat splats (shortest axis < 30 % of the middle one; sample of ≤ 50 000) – b: log scales as halfs
function flatShare(b, count) {
    const words = new Uint32Array(b.buffer, b.byteOffset, count * 4);
    const half = THREE.DataUtils.fromHalfFloat;
    const step = Math.max(1, Math.floor(count / 50000));
    let flat = 0, n = 0;
    for (let i = 0; i < count; i += step) {
        const s = [half(words[i * 4] & 0xffff), half(words[i * 4] >>> 16), half(words[i * 4 + 1] & 0xffff)].sort((x, y) => x - y);
        if (s[0] - s[1] < Math.log(0.3)) flat++;
        n++;
    }
    return n ? flat / n : 0;
}

// mean linear luminance of the splat colours, weighted by opacity (sample of ≤ 200 000) – the override material keeps
// the brightness relative to it (structure)
function meanLuma(a, count) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, count * 16);
    const lin = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const step = Math.max(1, Math.floor(count / 200000));
    let sum = 0, weight = 0;
    for (let i = 0; i < count; i += step) {
        const o = i * 16 + 12, w = bytes[o + 3] / 255;
        sum += w * (0.2126 * lin(bytes[o]) + 0.7152 * lin(bytes[o + 1]) + 0.0722 * lin(bytes[o + 2]));
        weight += w;
    }
    return weight > 0 ? Math.max(sum / weight, 1e-3) : 0.2;
}

// instanced quad + storage buffers (they hang on the geometry as well: geometry.dispose() frees their GPU memory)
function createGeometry(a, b, sh, count) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;   // until the first sort
    const attrs = {
        a: new THREE.StorageBufferAttribute(a, 4),
        b: new THREE.StorageBufferAttribute(b, 4),
        order: new THREE.StorageBufferAttribute(new Uint32Array(count), 1),
        sh: sh ? new THREE.StorageBufferAttribute(sh, 1) : null,
    };
    geometry.setAttribute('splatA', attrs.a);
    geometry.setAttribute('splatB', attrs.b);
    geometry.setAttribute('splatOrder', attrs.order);
    if (attrs.sh) geometry.setAttribute('splatSH', attrs.sh);
    return { geometry, attrs };
}

function createMaterial() {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
    material.premultipliedAlpha = true;
    material.allowOverride = false;   // Basic view (clay) and mask passes keep the splats as they are
    material.fog = false;
    material.name = 'Gaussian Splats';
    return material;
}
