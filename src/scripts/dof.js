// Depth of field for the path tracer + display of the focus plane in the raster preview.
//
// The camera is a PhysicalCamera from three-gpu-pathtracer: its rays start on an aperture
// and meet in the focus plane (flat, perpendicular to the view direction, at distance
// focusDistance). The shader computes the aperture in metres (bokehSize in mm · 1e-3), but the scene
// is in mm – hence fStop / 1000: this way "aperture" matches the real f-number at the current
// focal length (35 mm format, derived from the field of view). Off = aperture 0 (pinhole camera).
//
// Focus line (raster preview, not in the path traced image): where the focus plane cuts the surfaces.
// After the raster image the scene is drawn once more with an override material (same depth, LessEqual +
// polygon offset) that is green where the pixel's distance along the view direction equals the focus
// distance; the width comes from the screen-space derivative (fwidth) → about 2 px at any distance.
// A surface facing the camera exactly at the focus distance turns green as a whole (it is all sharp).
// Previously a semi-transparent plane tinted everything behind it – but what is in front is just as
// blurred, that looked odd.
// Fisheye (raster preview = 6 cube faces, fisheye.js): the line is drawn into every face right after the
// scene (that is where the depth buffer is) and then goes through the same mapping as the image; the focus
// there is a sphere around the camera (like the path tracer's fisheye rays) → distance = length of the
// view-space position instead of the depth along the view direction.
// Degree of blur (Oct. 2026, user: the line showed the focus but not how blurred the rest gets): the surfaces are
// tinted by the circle of confusion the path tracer produces there – radius in pixels = aperture radius · focal
// length in pixels · |1/focus − 1/distance| (thin lens, same as the denoiser's guides, pt-guides.js) – green up to
// half a pixel (sharp), over yellow (~3 px) to red (16 px and more), on a log scale; the line stays on top, white.
// HQ: over the path traced image (no raster depth buffer there) – depth pass of its own first (renderLine with
// ownDepth).
import * as THREE from 'three/webgpu';
import { abs, float, fwidth, length, log2, max, mix, positionView, saturate, smoothstep, uniform, vec3 } from 'three/tsl';

// colour ramp of the blur (also the legend in the camera panel, properties.js)
export const DOF_RAMP = { sharp: [0.1, 0.85, 0.25], mid: [1, 0.85, 0.1], blurred: [0.95, 0.15, 0.1] };
const RAMP_MIN_PX = 0.5, RAMP_OCTAVES = 5;   // green up to 0.5 px blur radius, red from 0.5 · 2^5 = 16 px
const TINT = 0.4;                            // opacity of the tint (the picture stays visible)

const _dir = new THREE.Vector3();
const _size = new THREE.Vector2();

export class DepthOfField {
    constructor(camera) {
        this.camera = camera;
        this.enabled = false;
        this.fStop = 2.8;            // f-number
        this.focusDistance = 1000;   // mm along the view direction
        this.blades = 0;             // aperture blades, 0 = round
        this.autoFocus = false;      // focus plane follows the orbit pivot
        this.showPlane = true;       // show the focus line in the preview (while the camera is selected)
        this.focusSet = false;       // focus already set once (otherwise set to the pivot when enabling)

        this._focus = uniform(1000);
        this._sphere = uniform(0);   // 1 = fisheye: distance to the camera
        this._cocScale = uniform(0); // aperture radius · focal length in pixels (0 = depth of field off)
        // distance along the view direction (like focusDistance), in the fisheye to the camera
        const depth = mix(positionView.z.negate(), length(positionView), this._sphere);
        const pixels = depth.sub(this._focus).abs().div(max(fwidth(depth), 1e-6));
        const line = float(1).sub(smoothstep(1.25, 2.25, pixels));
        // blur radius in pixels → 0 (sharp) … 1 (very blurred)
        const coc = this._cocScale.mul(abs(float(1).div(this._focus).sub(float(1).div(max(depth, 1e-3)))));
        const level = saturate(log2(max(coc, RAMP_MIN_PX / 2).div(RAMP_MIN_PX)).div(RAMP_OCTAVES));
        const ramp = mix(mix(vec3(...DOF_RAMP.sharp), vec3(...DOF_RAMP.mid), saturate(level.mul(2))), vec3(...DOF_RAMP.blurred), saturate(level.mul(2).sub(1)));
        this.lineMaterial = new THREE.MeshBasicNodeMaterial({
            transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide,
        });
        this.lineMaterial.colorNode = mix(ramp, vec3(1), line);
        this.lineMaterial.opacityNode = max(line, float(TINT));
        // depth only (HQ: the path traced image has no depth buffer the overlay could test against)
        this.depthMaterial = new THREE.MeshBasicNodeMaterial({ colorWrite: false, side: THREE.DoubleSide });
        this.apply();
    }

    /** Transfer the values to the camera (then call pathTracing.updateCamera()) */
    apply() {
        const c = this.camera;
        c.fStop = this.enabled ? Math.max(this.fStop, 0.1) / 1000 : Infinity;
        c.focusDistance = Math.max(this.focusDistance, 1e-3);
        c.apertureBlades = this.blades;
    }

    /** Distance of a world point to the camera along the view direction */
    depthOf(point) {
        this.camera.getWorldDirection(_dir);
        return Math.max(point.clone().sub(this.camera.position).dot(_dir), 1e-3);
    }

    /**
     * Draw the focus line and the degree of blur into the view (right after the raster image – needs its depth
     * buffer – or with ownDepth over the path traced image).
     * Everything visible gets the line material (also the ground; hidden objects stay hidden).
     * @param {THREE.Material[]} include  materials with allowOverride = false that should get the line too
     * @param {THREE.Camera} camera  fisheye: the cube face camera (focus = sphere around the camera)
     * @param {{ ownDepth?: boolean }} options  ownDepth: clear the depth and draw it first (HQ)
     */
    renderLine(renderer, scene, include = [], camera = null, { ownDepth = false } = {}) {
        this._focus.value = this.focusDistance;
        this._sphere.value = camera ? 1 : 0;
        // as the path tracer: aperture radius bokehSize · 0.5e-3 (scene in mm), focal length of the main camera in
        // pixels of the drawing buffer (the fisheye's cube faces: the same – an estimate there)
        const c = this.camera, radius = Number.isFinite(c.fStop) ? c.bokehSize * 0.5e-3 : 0;
        const height = renderer.getDrawingBufferSize(_size).y;
        this._cocScale.value = radius * height / 2 / Math.tan(c.fov * Math.PI / 360);
        const prev = {
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            autoClear: renderer.autoClear, allow: include.map(m => m.allowOverride),
        };
        // Gaussian splats keep their own material (allowOverride = false) – they would be drawn a second time
        const splats = [];
        scene.traverseVisible(o => { if (o.isSplat) splats.push(o); });
        splats.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        scene.overrideMaterial = this.lineMaterial;
        include.forEach(m => { m.allowOverride = true; });
        renderer.autoClear = false;
        if (ownDepth) {
            renderer.clearDepth();
            scene.overrideMaterial = this.depthMaterial;
            renderer.render(scene, camera || this.camera);
            scene.overrideMaterial = this.lineMaterial;
        }
        renderer.render(scene, camera || this.camera);
        renderer.autoClear = prev.autoClear;
        splats.forEach(o => { o.visible = true; });
        include.forEach((m, i) => { m.allowOverride = prev.allow[i]; });
        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
    }

    toJSON() {
        const { enabled, fStop, focusDistance, blades, autoFocus, showPlane } = this;
        return { enabled, fStop, focusDistance: +focusDistance.toFixed(3), blades, autoFocus, showPlane };
    }

    fromJSON(s) {
        if (!s) return;
        this.enabled = !!s.enabled;
        if (s.fStop != null) this.fStop = s.fStop;
        if (s.focusDistance != null) { this.focusDistance = s.focusDistance; this.focusSet = true; }
        if (s.blades != null) this.blades = s.blades;
        this.autoFocus = !!s.autoFocus;
        this.showPlane = s.showPlane ?? true;   // older scenes: shown
        this.apply();
    }
}
