// Gaussian splats, alone or next to PBR models (a CAD model placed into a scan). The renderer tone-maps the whole
// frame in its output pass, but splat colours are trained display values that must reach the screen unchanged – and
// the models need their tone curve. And splats are blended in display space (like the reference implementation;
// blending linear values looked paler – also without models). So:
//   1. the frame (models, background, section caps …) goes into a linear HDR target instead of the canvas (this.frame,
//      or the lens-effects target when effects are on) – the splats are not in it (own layer, viewer.js)
//   2. drawSplats: the splats into their own target – first the models' depth (depth material: also their view depth
//      into the second attachment), so models cover them, then the splats (display values, blended in display space
//      like the reference; second attachment: view depth × alpha, blended alike → the expected depth of the layer)
//   3. ambient occlusion (with models): from the combined depth (models + splats) at half resolution – models are
//      darkened by everything in their hemisphere (the scan's floor and walls, themselves; normal from the depth), the
//      scan only by models near it (its own occlusion is baked into it; normals from grass/leaf depth are noise) →
//      contact shadow both ways. 12 samples on a disc, two blur passes that respect depth edges.
//   4. compose, per pixel: background → its display value (the renderer's curve + sRGB, as the output pass would show
//      it), the splats blended over it in display space, the result back through the inverse curve (tone-inverse.js:
//      table, or closed form; splats alone: no curve, only sRGB) → linear again; × AO. Pixels without splats keep the
//      frame's value (highlights above 1 stay for bloom). The output pass then shows exactly the composited display
//      values (ACES/AgX: closest reachable colour).
//   5. output: through the renderer's normal path (internal frame buffer target + tone mapping) – or the lens effects'
//      end() with the composite as input – so highlight, gizmo and contours drawn afterwards work as before.
// Drawing the splats in a second pass straight onto the canvas lost the first pass's image: the canvas is multisampled
// and its content is not kept between passes (only the splats on an empty background were left).
// Multisampling of the own targets only with models (their edges; the splats' depth pre-pass must match) – splats alone
// need none (soft edges), at 4K each 4× target would be ~265 MB.
// Cloud volumes (clouds.js) are semi-transparent and write no depth – drawn in the frame, splats behind them were painted
// over them (the cloud looked cut off). With splats they are drawn separately (drawClouds: colour over the models'
// depth + their own depth where they turn dense) and composited per pixel by distance: in front of the splats over
// them, behind them under them. In HQ (scans drawn over the path traced image, which holds the clouds) the splats are
// thinned where a cloud lies in front.
// Also used with a fixed size (fixedSize) for the environment capture (splat-environment.js) and the raster fisheye's
// cube faces (viewer.js, copyTo) – `linear`: the composite
// only back to linear (sRGB, ÷ exposure), not through the inverse curve: inverting ACES turned the bright and saturated
// colours of a scan into values up to 32 (mean 3–10 instead of ~1) – the models were flooded with green light.
import * as THREE from 'three/webgpu';
import {
    Fn, texture, texture3D, uniform, vec2, vec3, vec4, float, select, exp2, clamp, max, min, abs, sqrt, cos, sin, fract, dot, cross,
    normalize, length, mrt, positionView, sRGBTransferOETF, sRGBTransferEOTF, uv, Loop, If, smoothstep, mix,
    acesFilmicToneMapping, agxToneMapping, neutralToneMapping, cineonToneMapping, reinhardToneMapping, linearToneMapping,
} from 'three/tsl';
import { inverseToneTable, needsTable, LUT_SIZE } from './tone-inverse.js';
import { SPLATS } from '../config.js';

const CURVES = {
    [THREE.ACESFilmicToneMapping]: acesFilmicToneMapping, [THREE.AgXToneMapping]: agxToneMapping, [THREE.NeutralToneMapping]: neutralToneMapping,
    [THREE.CineonToneMapping]: cineonToneMapping, [THREE.ReinhardToneMapping]: reinhardToneMapping, [THREE.LinearToneMapping]: linearToneMapping,
};
const MODEL_SAMPLES = 4;
const AO_SAMPLES = 12;

export class SplatComposite {
    /** @param {{ size?: number, linear?: boolean }} o  fixed square size (environment capture) instead of the drawing buffer */
    constructor(renderer, { size = 0, linear = false } = {}) {
        this.renderer = renderer;
        this.fixedSize = size;
        this.linear = linear;
        this.frame = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0, stencilBuffer: true });   // frame without splats
        // splats over the models' depth; second attachment: view depth × alpha, model share, coverage (AO)
        this.splats = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0, stencilBuffer: true, count: 2 });
        this.splats.textures[0].name = 'output';
        this.splats.textures[1].name = 'splatDepth';
        this.result = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.aoTargets = [0, 1].map(() => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
        // clouds (drawClouds): premultiplied colour + alpha over the models' depth; their distance (modelSize / distance)
        this.cloudColor = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
        this.cloudDepth = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
        // blend: depth range over which a cloud goes from behind the splats to in front of them (soft – they interpenetrate)
        this.cloud = { on: uniform(0), inFrame: uniform(0), modelSize: uniform(1), projection: uniform(new THREE.Vector2(1, 1)), blend: uniform(1) };
        this.depthOnly = new THREE.MeshBasicNodeMaterial({ colorWrite: false });
        this.depthOnly.name = 'SplatCompositeCloudDepth';
        for (const t of this.aoTargets) t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
        this.exposure = uniform(1);
        this.input = texture(this.frame.texture);   // value: the frame of this call (own target or the lens target)
        this.quad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.out = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.out.material.fragmentNode = vec4(texture(this.result.texture).rgb, 1);
        // models' depth pre-pass: no colour, their view depth into the second attachment (model share 1, coverage 1)
        this.depthMaterial = new THREE.MeshBasicNodeMaterial();
        this.depthMaterial.fragmentNode = mrt({ output: vec4(0), splatDepth: vec4(positionView.z.negate(), 1, 0, 1) });
        this.depthMaterial.name = 'SplatCompositeDepth';
        // helper groups with their own masks (wool fibre shells, grass blades): their own materials, only their depth –
        // the depth material above would make the shells solid, left out they were painted over by the splats behind
        this.depthMRT = mrt({ output: vec4(0), splatDepth: vec4(positionView.z.negate(), 1, 0, 1) });
        // three.js r186 clears MRT attachments after the first to (0, 0, 0, 1): coverage 1 everywhere, background with
        // depth 0 – zeros written by a full-screen pass after the clear
        this.zero = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.zero.material.fragmentNode = mrt({ output: vec4(0), splatDepth: vec4(0) });
        this.zero.material.depthTest = this.zero.material.depthWrite = false;
        // ambient occlusion: projection of the camera (P00, P11), radius in view units, strength, on/off
        this.ao = { projection: uniform(new THREE.Vector2(1, 1)), radius: uniform(100), strength: uniform(SPLATS.ao?.strength ?? 1),
            enabled: uniform(0), texel: uniform(new THREE.Vector2(1, 1)), direction: uniform(new THREE.Vector2(1, 0)) };
        this.aoQuad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.blurQuad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.blurInput = texture(this.aoTargets[0].texture);
        this._buildAo();
        this._key = '';
        this._tables = new Map();   // tone mapping → inverse table (null while it is computed)
        this._size = new THREE.Vector2();
    }

    _fit() {
        const r = this.fixedSize ? this._size.setScalar(this.fixedSize) : this.renderer.getDrawingBufferSize(this._size);
        for (const t of [this.frame, this.splats, this.result, this.cloudColor, this.cloudDepth]) if (t.width !== r.x || t.height !== r.y) t.setSize(r.x, r.y);
        const hx = Math.max(1, Math.ceil(r.x / 2)), hy = Math.max(1, Math.ceil(r.y / 2));
        for (const t of this.aoTargets) if (t.width !== hx || t.height !== hy) t.setSize(hx, hy);
    }

    /**
     * From here on the frame goes into the own HDR target (lens effects off: called always, lens effects on: only
     * for the sample count).
     * @param {{ models: boolean, draw?: boolean }} o  models = PBR models in the scene (multisampling)
     */
    begin({ models, draw = true }) {
        const samples = models ? MODEL_SAMPLES : 0;
        for (const t of [this.frame, this.splats]) if (t.samples !== samples) { t.samples = samples; t.dispose(); }   // rebuilt on next use
        this._fit();
        if (draw) this.renderer.setRenderTarget(this.frame);
    }

    /**
     * Splats into their own target, covered by the models.
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {{ layer: number, keep: THREE.Object3D, hide?: THREE.Object3D[], extra?: THREE.Object3D[], splat: object,
     *   material?: THREE.Material, instances?: number }} o  layer = the splats' layer; keep = the scene child holding models
     *   and splats (everything else hidden); hide = objects below it to leave out (environment capture: the models);
     *   extra = scene children that cover the splats with their own materials (wool shells, grass); splat = the
     *   SplatMesh, drawn with `material` (default: its composite variant) and `instances`
     */
    drawSplats(scene, camera, { layer, keep, hide = [], extra = [], splat, material = splat.compositeMaterial, instances }) {
        this._fit();
        const r = this.renderer;
        const saved = { target: r.getRenderTarget(), autoClear: r.autoClear, clear: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(),
            override: scene.overrideMaterial, background: scene.background, backgroundNode: scene.backgroundNode, mask: camera.layers.mask };
        const hidden = [];
        for (const o of scene.children) if (o.visible && o !== keep) { o.visible = false; hidden.push(o); }
        for (const o of hide) if (o?.visible) { o.visible = false; hidden.push(o); }
        const restore = splat.useVariant(material, instances);
        try {
            r.setRenderTarget(this.splats);
            r.setClearColor(0x000000, 0);
            r.clear();
            r.autoClear = false;
            this.zero.render(r);
            scene.background = null;
            scene.backgroundNode = null;
            scene.overrideMaterial = this.depthMaterial;
            r.render(scene, camera);
            scene.overrideMaterial = null;
            const covering = extra.filter(o => hidden.includes(o));
            if (covering.length) {
                const keepVisible = keep.visible, mrtBefore = r.getMRT();
                keep.visible = false;
                for (const o of covering) o.visible = true;
                r.setMRT(this.depthMRT);
                r.render(scene, camera);
                r.setMRT(mrtBefore);
                for (const o of covering) o.visible = false;
                keep.visible = keepVisible;
            }
            camera.layers.set(layer);
            r.render(scene, camera);
        } finally {
            restore();
            camera.layers.mask = saved.mask;
            Object.assign(scene, { overrideMaterial: saved.override, background: saved.background, backgroundNode: saved.backgroundNode });
            r.setClearColor(saved.clear, saved.alpha);
            r.autoClear = saved.autoClear;
            r.setRenderTarget(saved.target);
            for (const o of hidden) o.visible = true;
        }
    }

    /**
     * Cloud volumes apart from the frame (see top): their colour over the models' depth, then their distance.
     * @param {{ clouds: object, keep: THREE.Object3D, modelSize: number, inFrame: boolean }} o  clouds = CloudSystem
     *   (its group was left out of the frame); keep = the scene child holding the models; inFrame = the frame holds the
     *   clouds already (path traced) – only the splats in front are thinned
     */
    drawClouds(scene, camera, { clouds, keep, modelSize, inFrame }) {
        this._fit();
        const r = this.renderer;
        const saved = { target: r.getRenderTarget(), autoClear: r.autoClear, clear: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(),
            override: scene.overrideMaterial, background: scene.background, backgroundNode: scene.backgroundNode, groupVisible: clouds.group.visible };
        const children = scene.children.filter(o => o.visible);
        const only = list => { for (const o of scene.children) o.visible = (list.includes(o) && children.includes(o)) || o === clouds.group; };
        try {
            scene.background = null;
            scene.backgroundNode = null;
            r.setClearColor(0x000000, 0);
            clouds.group.visible = true;
            // colour: the models' depth first (no colour), then the clouds blended over transparent black
            r.setRenderTarget(this.cloudColor);
            r.clear();
            r.autoClear = false;
            for (const o of scene.children) o.visible = o === keep && children.includes(o);
            scene.overrideMaterial = this.depthOnly;
            r.render(scene, camera);
            scene.overrideMaterial = null;
            only([]);
            r.render(scene, camera);
            // distance where each cloud turns dense (0 = none)
            r.setRenderTarget(this.cloudDepth);
            r.clear();
            clouds.beginDepth('camera', modelSize, 0.05);   // already the faint rim counts (dense only: hard edges)
            r.render(scene, camera);
            clouds.endDepth();
        } finally {
            for (const o of scene.children) o.visible = children.includes(o);
            clouds.group.visible = saved.groupVisible;
            Object.assign(scene, { overrideMaterial: saved.override, background: saved.background, backgroundNode: saved.backgroundNode });
            r.setClearColor(saved.clear, saved.alpha);
            r.autoClear = saved.autoClear;
            r.setRenderTarget(saved.target);
        }
        const e = camera.projectionMatrix.elements;
        this.cloud.projection.value.set(e[0], e[5]);
        this.cloud.modelSize.value = modelSize;
        this.cloud.blend.value = modelSize * 0.08;
        this.cloud.inFrame.value = inFrame ? 1 : 0;
        this.cloud.on.value = 1;
    }

    /** no splats this frame (the path tracer drew the image – the splats are in it as a volume): empty splat target */
    clearSplats() {
        const r = this.renderer;
        this._fit();
        const target = r.getRenderTarget(), autoClear = r.autoClear, clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
        r.setRenderTarget(this.splats);
        r.setClearColor(0x000000, 0);
        r.clear();
        r.autoClear = false;
        this.zero.render(r);
        r.autoClear = autoClear;
        r.setClearColor(clear, alpha);
        r.setRenderTarget(target);
    }

    /**
     * frame (texture) + splats → this.result.texture (linear, for the renderer's output pass)
     * @param {THREE.Texture} frameTexture
     * @param {{ camera?: THREE.PerspectiveCamera, aoRadius?: number }} o  aoRadius > 0: ambient occlusion with this
     *   radius (view units) – with models only
     */
    compose(frameTexture, { camera = null, aoRadius = 0, clouds = false } = {}) {
        const r = this.renderer;
        if (!clouds) this.cloud.on.value = 0;   // drawClouds() this frame switches them on
        this._build(r.toneMapping);
        this.exposure.value = r.toneMappingExposure;
        this.input.value = frameTexture;
        const target = r.getRenderTarget();
        const ao = aoRadius > 0 && camera?.isPerspectiveCamera && this.ao.strength.value > 0;
        this.ao.enabled.value = ao ? 1 : 0;
        if (ao) this._renderAo(camera, aoRadius);
        r.setRenderTarget(this.result);
        this.quad.render(r);
        r.setRenderTarget(target);
        return this.result.texture;
    }

    _renderAo(camera, radius) {
        const r = this.renderer, ao = this.ao;
        const e = camera.projectionMatrix.elements;
        ao.projection.value.set(e[0], e[5]);
        ao.radius.value = radius;
        const [a, b] = this.aoTargets;
        ao.texel.value.set(1 / a.width, 1 / a.height);
        r.setRenderTarget(a);
        this.aoQuad.render(r);
        // separable blur: a → b (horizontal), b → a (vertical)
        ao.direction.value.set(1, 0);
        this.blurInput.value = a.texture;
        r.setRenderTarget(b);
        this.blurQuad.render(r);
        ao.direction.value.set(0, 1);
        this.blurInput.value = b.texture;
        r.setRenderTarget(a);
        this.blurQuad.render(r);
    }

    // AO from the second attachment of the splat target (x = Σ depth·α, y = model share, w = coverage)
    _buildAo() {
        const ao = this.ao;
        const depthTex = this.splats.textures[1];
        const info = p => texture(depthTex, p);
        // view position of a pixel from its depth (perspective; uv y down)
        const viewPos = (p, d) => vec3(p.x.mul(2).sub(1).div(ao.projection.x).mul(d), float(1).sub(p.y.mul(2)).div(ao.projection.y).mul(d), d.negate());
        this.aoQuad.material.fragmentNode = Fn(() => {
            const p = uv().toVar();
            const c = info(p).toVar();
            const result = float(1).toVar();
            // pixel with a surface (model or clearly covering splats)
            If(c.w.greaterThan(0.5), () => {
                const d = c.x.div(c.w).toVar();
                const centre = viewPos(p, d).toVar();
                // normal from the neighbours (the nearer side per axis – no smearing over depth edges)
                const px = ao.texel.mul(0.5);   // full-resolution texel
                const at = o => { const q = p.add(o); const s = info(q); return viewPos(q, s.x.div(max(s.w, 1e-4))); };
                const r = at(vec2(px.x, 0)).sub(centre), l = centre.sub(at(vec2(px.x.negate(), 0)));
                const u = at(vec2(0, px.y.negate())).sub(centre), dn = centre.sub(at(vec2(0, px.y)));
                const dx = select(abs(r.z).lessThan(abs(l.z)), r, l), dy = select(abs(u.z).lessThan(abs(dn.z)), u, dn);
                const n = normalize(cross(dx, dy)).toVar();
                n.assign(select(dot(n, centre).greaterThan(0), n.negate(), n));
                // disc radius on screen (uv), at most a sixth of the image
                const rad = min(vec2(ao.radius).mul(ao.projection).mul(0.5).div(d), vec2(0.16)).toVar();
                const model = c.y.div(c.w).toVar();   // share of the pixel that is a model
                const noise = fract(fract(dot(p.div(ao.texel), vec2(0.06711056, 0.00583715))).mul(52.9829189)).mul(6.2831853).toVar();
                const sum = float(0).toVar();
                Loop(AO_SAMPLES, ({ i }) => {
                    const f = float(i).add(0.5).div(AO_SAMPLES);
                    const angle = float(i).mul(2.39996323).add(noise);
                    const q = p.add(vec2(cos(angle), sin(angle)).mul(rad).mul(sqrt(f))).toVar();
                    const s = info(q).toVar();
                    If(s.w.greaterThan(0.5), () => {
                        const v = viewPos(q, s.x.div(s.w)).sub(centre).toVar();
                        const dist = length(v);
                        const near = float(1).sub(smoothstep(ao.radius.mul(0.3), ao.radius, dist));
                        // models: occluded by everything in their hemisphere; the scan: by models near it, whatever the
                        // direction (its own occlusion is baked in; normals from the depth of grass and leaves are noise)
                        const hemisphere = max(dot(n, v).div(max(dist, 1e-4)).sub(0.15), 0).mul(near);
                        sum.addAssign(mix(near.mul(0.6).mul(s.y.div(s.w)), hemisphere, model));
                    });
                });
                result.assign(clamp(float(1).sub(sum.mul(ao.strength).mul(3 / AO_SAMPLES)), 0, 1));
            });
            return vec4(result, c.x.div(max(c.w, 1e-4)), 0, 1);   // AO + depth (blur weights)
        })();
        // blur: 9 taps along `direction`, weighted by depth similarity
        this.blurQuad.material.fragmentNode = Fn(() => {
            const p = uv().toVar();
            const centre = this.blurInput.sample(p).toVar();
            const sum = vec2(0).toVar();
            for (let k = -4; k <= 4; k++) {
                const s = this.blurInput.sample(p.add(ao.direction.mul(ao.texel).mul(k * 1.5)));
                const w = float(Math.exp(-(k * k) / 8)).mul(max(float(1).sub(abs(s.y.sub(centre.y)).div(max(centre.y.mul(0.03), 1e-3))), 0));
                sum.addAssign(vec2(s.x.mul(w), w));
            }
            return vec4(sum.x.div(max(sum.y, 1e-4)), centre.y, 0, 1);
        })();
    }

    /** the composite into a render target (a cube face of the raster fisheye) – linear, its output pass tone-maps */
    copyTo(target, face = 0) {
        const r = this.renderer;
        const autoClear = r.autoClear;
        r.autoClear = true;
        r.setRenderTarget(target, face);
        this.out.render(r);
        r.autoClear = autoClear;
    }

    /** the composite onto the canvas through the normal output path (tone mapping + sRGB) */
    output() {
        const r = this.renderer;
        const autoClear = r.autoClear;
        r.autoClear = true;   // also clears the internal framebuffer target
        r.setRenderTarget(null);
        this.out.render(r);
        r.autoClear = autoClear;
    }

    // composite shader for a tone curve – rebuilt when the curve changes and once its table is ready (until then the
    // closed form of Reinhard stands in)
    _build(mapping) {
        let tex = null;
        if (needsTable(mapping) && !this.linear) {
            if (!this._tables.has(mapping)) {
                this._tables.set(mapping, null);
                inverseToneTable(mapping).then(t => this._tables.set(mapping, t));
            }
            tex = this._tables.get(mapping);
        }
        const key = `${mapping}|${!!tex}`;
        if (key === this._key) return;
        this._key = key;
        const curve = CURVES[mapping] ?? null;
        const exposure = this.exposure, bgNode = this.input, sNode = texture(this.splats.textures[0]), aoNode = texture(this.aoTargets[0].texture);
        const aoOn = this.ao.enabled;
        const cloud = this.cloud, cloudColor = texture(this.cloudColor.texture), cloudDepth = texture(this.cloudDepth.texture), splatDepth = texture(this.splats.textures[1]);
        const N = LUT_SIZE;
        this.quad.material.fragmentNode = Fn(() => {
            const ao = select(aoOn.greaterThan(0.5), aoNode.x, float(1)).toVar();
            const frameBg = bgNode.rgb.mul(ao).toVar();
            // clouds: in front of the splats or behind them – by distance (splats: expected view depth along the ray)
            const p = uv();
            const on = cloud.on.greaterThan(0.5);
            const cc = select(on, cloudColor.sample(p), vec4(0)).toVar();
            const cInv = cloudDepth.sample(p).r;
            const cloudDist = select(cInv.greaterThan(1e-6), cloud.modelSize.div(max(cInv, 1e-6)), float(1e30));
            const sd = splatDepth.sample(p);
            const ray = length(vec3(p.x.mul(2).sub(1).div(cloud.projection.x), float(1).sub(p.y.mul(2)).div(cloud.projection.y), 1));
            const splatDist = select(sd.w.greaterThan(0.01), sd.x.div(max(sd.w, 1e-4)).mul(ray), float(1e30));
            // share of the cloud in front of the splats: soft over the blend range – both are volumes that interpenetrate
            // (a hard per-pixel decision drew jagged cut lines where the cloud reaches into the splats)
            const front = select(on.and(cc.a.greaterThan(0.002)), smoothstep(cloud.blend.negate(), cloud.blend, splatDist.sub(cloudDist)), float(0)).toVar();
            const inFrame = cloud.inFrame.greaterThan(0.5);
            // drawn apart: the share behind under the splats, the share in front over the result below; path traced: in
            // the frame already – the splats in front of it thinned by its share in front
            const behind = select(on.and(inFrame.not()), float(1).sub(front), float(0));
            const bg = cc.rgb.mul(behind).add(frameBg.mul(float(1).sub(cc.a.mul(behind)))).toVar();
            const s = sNode.mul(select(inFrame, float(1).sub(cc.a.mul(front)), float(1))).toVar();
            const a = s.a;
            // background as the output pass would show it, the splats over it in display space
            const shown = curve ? clamp(curve(bg, exposure), 0, 1) : clamp(bg, 0, 1);
            const display = s.rgb.mul(ao).add(sRGBTransferOETF(shown).mul(float(1).sub(a))).clamp(0, 1).toVar();
            const lin = sRGBTransferEOTF(display);
            let inverse;
            if (this.linear) inverse = lin.div(curve ? exposure : float(1));
            else if (tex) inverse = exp2(texture3D(tex, display.mul((N - 1) / N).add(0.5 / N), float(0)).rgb).div(exposure);
            else if (mapping === THREE.LinearToneMapping) inverse = lin.div(exposure);
            else if (curve) { const t = clamp(lin, 0, 0.97); inverse = t.div(float(1).sub(t)).div(exposure); }   // Reinhard (also the stand-in)
            else inverse = lin;
            const composed = select(a.lessThan(1 / 255), bg, max(inverse, 0));
            const over = select(inFrame, float(0), front);
            return vec4(cc.rgb.mul(over).add(composed.mul(float(1).sub(cc.a.mul(over)))), 1);
        })();
        this.quad.material.needsUpdate = true;
    }

    dispose() {
        for (const t of [this.frame, this.splats, this.result, this.cloudColor, this.cloudDepth, ...this.aoTargets]) t.dispose();
        this.depthOnly.dispose();
        for (const q of [this.quad, this.out, this.aoQuad, this.blurQuad, this.zero]) q.material.dispose();
        this.depthMaterial.dispose();
    }
}
