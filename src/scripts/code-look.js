// Code look ("Code in space", style mode `codeSpace` – style-filters.js keeps its settings with the other looks, the
// camera panel shows them): the scene turns into code, anchored in the world – not a pattern over the screen.
//   - surfaces (CodePass): a pass over the finished picture with its depth – per pixel the point in the world (and the
//     surface's orientation from the neighbours' depth) → a raster of glyphs fixed in the world (walls: columns along
//     the wall, floors x/z cells), rain falling down the columns. The scene itself stays as it is: splats keep their
//     kept picture (splat-composite.js – drawn again only when the camera moves); in the splats' own shader the code
//     had them all redrawn every frame for the animation (a church of 10 million splats: the GPU fully busy)
//   - background (HDRI, gradient, colour): glyph rain by direction (CodeBackground, the scene's background node)
// Both share the settings here: mix (the scene ↔ code), tint colour + amount (tints the scene itself, too), brightness
// away from the rain, speed of the rain, glyph changes per second, randomness of the glyphs' size and place (0 = a
// regular raster). Live raster view only (the path tracer shows the scene as it is).
import * as THREE from 'three/webgpu';
import {
    Fn, uniform, texture, vec2, vec3, vec4, float, uint, int, floor, fract, sin, cos, max, clamp, mix, dot, select, smoothstep, step,
    log2, time, atan, asin, abs, cross, normalize, normalWorldGeometry, equirectUV, backgroundRotation, screenUV, sRGBTransferOETF,
    sRGBTransferEOTF,
} from 'three/tsl';
import { playerUniforms } from './player-slots.js';
import { codeAtlas, ATLAS_CELL } from './code-glyphs.js';

export const CODE_DEFAULTS = { mix: 1, color: '#40f2ff', tint: 1, size: 1, speed: 1, trail: 1, rate: 3, base: 0.3, background: 1, random: 0 };

// shared by the splats and the background; each player keeps its own values (player-slots.js)
export const CODE = {
    mix: uniform(1), tint: uniform(new THREE.Color()), tintAmount: uniform(1), base: uniform(0.3), speed: uniform(1), rate: uniform(3),
    background: uniform(1), trail: uniform(1), random: uniform(0),
};
playerUniforms(CODE);

/** settings of the look (CODE_DEFAULTS keys) into the shared uniforms */
export function applyCode(s) {
    const v = { ...CODE_DEFAULTS, ...(s || {}) };
    CODE.mix.value = v.mix;
    CODE.tint.value.set(v.color);   // linear (working space)
    CODE.tintAmount.value = v.tint;
    CODE.base.value = v.base;
    CODE.speed.value = v.speed;
    CODE.rate.value = v.rate;
    CODE.background.value = v.background;
    CODE.trail.value = v.trail;
    CODE.random.value = v.random;
}

export const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** integer hash of a uint → float 0…1 (indices reach millions: a sine hash of floats repeats there) */
export function hashU(u) {
    const x = uint(u).toVar();
    x.assign(x.bitXor(x.shiftRight(uint(16))).mul(uint(0x7feb352d)));
    x.assign(x.bitXor(x.shiftRight(uint(15))).mul(uint(0x846ca68b)));
    x.assign(x.bitXor(x.shiftRight(uint(16))));
    return float(x.bitAnd(uint(0xffffff))).div(16777216);
}
// sine hash of small values (cells, ticks)
const hash2 = p => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

/**
 * Rain of one column (seeds s1, s2): drops one after the other, every 30–70 glyph heights, falling 8–16 glyphs per
 * second (× speed), each with a trail above its head that ends after 12 glyphs (× trail × (seed + ½), quadratic
 * falloff) – two such streams per column, each running in 55 % of the columns (in the reference the streams stand out
 * because most of the surface between them stays dark). In glyph units, not the scene's height: a large outdoor scene
 * rains as densely as a room. y = height of the point (world, or latitude for the background).
 * → [trail 0…1, head 0…1 (within a glyph above the head)]
 */
export function codeRain(s1, s2, y, glyph) {
    const t = time.mul(CODE.speed);
    const trail = glyph.mul(CODE.trail).mul(12);
    const stream = (sd, k) => {
        const spacing = glyph.mul(sd.mul(40).add(30));
        const w = y.add(t.mul(glyph.mul(sd.mul(8).add(8)))).div(spacing).add(sd.mul(k));
        const d = fract(w).mul(spacing);   // height above the head that passed last
        const on = step(fract(sd.mul(13.7)), 0.55);
        const fade = clamp(float(1).sub(d.div(trail.mul(sd.add(0.5)))), 0, 1);
        return [fade.mul(fade).mul(on), float(1).sub(smoothstep(0, glyph.mul(1.2), d)).mul(on)];
    };
    const [ta, ha] = stream(s1, 7.13);
    const [tb, hb] = stream(s2, 3.71);
    return [max(ta, tb), max(ha, hb)];
}

/**
 * A glyph cell of a raster (g: the point, id: an integer cell, both in cell units) with the randomness CODE.random: its
 * glyph moved within the cell (up to ± 0.35) and scaled (0.5…1.5) – it may reach into the neighbouring cells, so the
 * callers look at the 2 × 2 cells nearest to the point (codeCells). → { local (0…1 inside the glyph), scale, center
 * (raster units), inside (1 / 0) }
 */
export function codeCell(g, id) {
    const k = id.mod(4096);   // small arguments for the sine hash
    const r = CODE.random;
    const jitter = vec2(hash2(k.add(vec2(0.37, 4.1))), hash2(k.add(vec2(7.3, 1.9)))).sub(0.5).mul(r.mul(0.7));
    const scale = mix(float(1), hash2(k.add(vec2(2.9, 8.3))).add(0.5), r);
    const center = id.add(0.5).add(jitter);
    const local = g.sub(center).div(scale).add(0.5).toVar();
    const inside = step(0, local.x).mul(step(local.x, 1)).mul(step(0, local.y)).mul(step(local.y, 1));
    return { local, scale, center, inside };
}
/** the 2 × 2 cells nearest to g: fn(id, first) for each (first = the cell of g itself) */
export function codeCells(g, fn) {
    const base = floor(g).toVar(), f = fract(g);
    const dir = vec2(select(f.x.lessThan(0.5), float(-1), float(1)), select(f.y.lessThan(0.5), float(-1), float(1))).toVar();
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) fn(base.add(dir.mul(vec2(dx, dy))), dx === 0 && dy === 0);
}

/**
 * A colour tinted (CODE.tintAmount): its brightness kept, the hue the tint's – the splats themselves and the background,
 * not only the glyphs (HDR values stay HDR). tint in the same space as color.
 */
export function codeTint(color, tint) {
    const toned = tint.mul(dot(color, LUMA).div(max(dot(tint, LUMA), 0.05)));
    return mix(color, toned, CODE.tintAmount);
}

/**
 * Colour of a point in the code look: own colour `color` (lum = its brightness 0…1) lit by the rain – tinted (dim away
 * from the rain, bright in its trail, heads almost white) or in its own colour (tintAmount 0). tint in the same space
 * as color.
 */
export function codeColor(color, lum, rain, head, tint) {
    const energy = lum.add(0.25).mul(CODE.base).add(rain.mul(lum.add(0.7)));
    const hot = mix(tint, vec3(1), 0.75).mul(lum.mul(0.5).add(0.7));
    const tinted = mix(tint.mul(energy), hot, head.mul(0.9));
    const own = color.mul(rain.mul(0.9).add(0.55)).add(head.mul(0.4));
    return mix(own, tinted, CODE.tintAmount);
}

/** glyph `index` (0…63) of the code atlas at f (0…1 in the cell, y down), at height px on screen → coverage 0…1 */
export function codeGlyph(index, f, px) {
    const atlas = codeAtlas();
    const cell = vec2(index.mod(atlas.columns), floor(index.div(atlas.columns)));
    const lod = max(log2(float(ATLAS_CELL[1]).div(max(px, 1))), 0);
    return texture(atlas.tex, cell.add(f).div(vec2(atlas.columns, atlas.rows))).level(lod).r;
}

// the background as glyph rain by direction: cells of `cell` radians in latitude (× glyph aspect in longitude), every
// cell a glyph that changes at its own pace, as bright as the background is there (blurred), lit by drops falling
// down the columns of longitude; between the glyphs black. mix × background: share of the code over the background.
export class CodeBackground {
    constructor() {
        this.map = texture(new THREE.Texture());   // the scene's background (equirect)
        this.useMap = uniform(0);
        this.flat = uniform(new THREE.Color());    // colour background (no texture)
        this.cell = uniform(0.02);                 // glyph height (rad)
        this.pxPerRad = uniform(800);              // screen pixels per radian
        this.node = Fn(() => {
            const dir = backgroundRotation.mul(vec4(normalWorldGeometry.normalize(), 0)).xyz.normalize().toVar();
            const sample = (d, level) => select(this.useMap.greaterThan(0.5), this.map.sample(equirectUV(d)).level(level).rgb, this.flat);
            const orig = codeTint(sample(dir, 0), CODE.tint).toVar();
            const lat = asin(clamp(dir.y, -1, 1)), lon = atan(dir.x, dir.z);
            const cw = this.cell.mul(ATLAS_CELL[0] / ATLAS_CELL[1]);
            const g = vec2(lon.div(cw), lat.div(this.cell)).toVar();
            const code = vec3(0).toVar();
            codeCells(g, id => {
                const { local, scale, center, inside } = codeCell(g, id);
                // brightness of the background around the glyph (compressed: an HDRI's sun is huge); rain of its column
                const latC = center.y.mul(this.cell), lonC = center.x.mul(cw);
                const around = codeTint(sample(vec3(cos(latC).mul(sin(lonC)), sin(latC), cos(latC).mul(cos(lonC))), 5), CODE.tint).toVar();
                const L = dot(around, LUMA);
                const lum = L.div(L.add(1)).mul(1.6).clamp(0, 1);
                const s1 = hash2(vec2(id.x.mod(4096), 1.7)), s2 = hash2(vec2(id.x.mod(4096), 9.1));
                const [rain, head] = codeRain(s1, s2, latC, this.cell);
                const h = hash2(id.mod(4096).add(3.3));
                const tick = floor(time.mul(CODE.rate).mul(h.mul(1.5).add(0.25)).add(h.mul(17)));
                const index = floor(hash2(id.mod(4096).mul(vec2(1, 1.37)).add(tick.mul(0.131))).mul(64));
                const mask = codeGlyph(index, vec2(local.x, float(1).sub(local.y)), this.cell.mul(this.pxPerRad).mul(scale)).mul(inside);
                code.assign(max(code, codeColor(around, lum, rain, head, CODE.tint).mul(mask)));
            });
            return vec4(mix(orig, code, CODE.mix.mul(CODE.background)), 1);
        })();
    }

    /**
     * Every frame: on → the scene's background node is the code (its source: the scene's background texture or colour;
     * glyph height `size` × 1.1°); off → back to `fallback` (the dome's node or none) if the code was set
     */
    sync(scene, camera, renderer, { on, size = 1, fallback = null }) {
        if (!on) {
            if (scene.backgroundNode === this.node) scene.backgroundNode = fallback;
            return;
        }
        const bg = scene.background;
        if (bg?.isTexture) {
            if (this.map.value !== bg) this.map.value = bg;
            this.useMap.value = 1;
        } else {
            this.useMap.value = 0;
            if (bg?.isColor) this.flat.value.copy(bg); else this.flat.value.setRGB(0, 0, 0);
        }
        const h = renderer.getDrawingBufferSize(_size).y;
        this.pxPerRad.value = camera.isPerspectiveCamera ? h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) : h;
        this.cell.value = THREE.MathUtils.degToRad(1.1) * size;
        if (scene.backgroundNode !== this.node) scene.backgroundNode = this.node;
    }
}

/**
 * The code on a surface (display values): `own` its colour (tinted already), `world` the point, `normal` the surface's
 * orientation (world), `glyph` the glyph height (world), `px` that height on screen. Raster of the 2 × 2 nearest cells
 * (randomness moves and scales the glyphs into their neighbours); rain column = the cell of the glyph centre's
 * horizontal position (noisy orientations – bark, plants – flip between neighbouring pixels and scrambled the rain when
 * it chose the column), on walls at the glyph's height. Between the glyphs the cell's colour, faint.
 */
export function codeSurface(own, world, normal, glyph, px, tint) {
    const a = abs(normal).toVar();
    const floorLike = a.y.greaterThan(max(a.x, a.z));
    const alongX = a.z.greaterThanEqual(a.x);   // a wall facing ±z runs along x
    const ch = glyph, cw = ch.mul(ATLAS_CELL[0] / ATLAS_CELL[1] * 1.15);
    const g = vec2(select(floorLike.or(alongX), world.x, world.z).div(cw), select(floorLike, world.z, world.y).div(ch)).toVar();
    const lum = clamp(dot(own, LUMA), 0, 1).toVar();
    const glyphs = vec3(0).toVar(), surface = vec3(0).toVar();
    codeCells(g, (id, first) => {
        const { local, scale, center, inside } = codeCell(g, id);
        const u = center.x.mul(cw), v = center.y.mul(ch);
        const cx = select(floorLike.or(alongX), u, world.x), cz = select(floorLike, v, select(alongX, world.z, u));
        const col = floor(vec2(cx, cz).div(cw)).add(65536);
        const cid = uint(int(col.x)).mul(uint(73856093)).bitXor(uint(int(col.y)).mul(uint(19349663))).toVar();
        const s1 = hashU(cid), s2 = hashU(cid.add(uint(0x5bd1e995)));
        const [rain, head] = codeRain(s1, s2, select(floorLike, world.y, v), ch);
        // the glyph of the cell, changing at its own pace
        const h = hashU(cid.bitXor(uint(int(id.y.add(65536))).mul(uint(2654435761))));
        const tick = floor(time.mul(CODE.rate).mul(h.mul(1.5).add(0.25)).add(h.mul(17)));
        const index = floor(fract(sin(tick.mul(12.9898).add(h.mul(78.233))).mul(43758.5453)).mul(64));
        const mask = codeGlyph(index, vec2(local.x, float(1).sub(local.y)), px.mul(scale)).mul(inside);
        const lit = codeColor(own, lum, rain, head, tint).toVar();
        glyphs.assign(max(glyphs, lit.mul(mask)));
        if (first) surface.assign(lit);
    });
    return glyphs.mul(0.88).add(surface.mul(0.12));
}

// The surfaces as code, over the finished picture (linear) with the depth of the splat pass (splat-composite.js second
// attachment: Σ depth·α, model share, –, coverage – the models' depth is in it too): the expected depth, smoothed at
// about a glyph's scale (_smooth: depth-aware blur at half resolution, only when the picture changed – kept splats keep
// it too) → the point in the world (camera matrices passed in – the pass draws with its own camera) and the surface's
// orientation from the smoothed depth half a glyph to each side. Per pixel, a rough surface's blended depth (bark)
// flipped the orientation between "wall along x" and "along z" and moved the points sideways – the raster was shredded.
// Pixels the splats or models do not cover keep the picture (the background is code already). Colours through display
// values (sRGB) – the tint and the glyphs are meant as seen; splats alone have no tone curve.
export class CodePass {
    constructor(renderer) {
        this.renderer = renderer;
        this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.target.texture.name = 'CodePass';
        // smoothed depth (x) + coverage (w), half resolution, float (depths in mm pass the half-float range far out)
        this.smooth = [0, 1].map(() => new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false }));
        for (const t of this.smooth) t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
        this.color = texture(new THREE.Texture());
        this.depth = texture(new THREE.Texture());
        this.smoothed = texture(this.smooth[1].texture);
        this.blurSource = texture(new THREE.Texture());
        this.u = {
            projectionInverse: uniform(new THREE.Matrix4()), cameraWorld: uniform(new THREE.Matrix4()), focal: uniform(1),
            size: uniform(new THREE.Vector2(1, 1)), glyph: uniform(10), blurDir: uniform(new THREE.Vector2(1, 0)), blurRaw: uniform(1),
        };
        this._version = undefined;
        const u = this.u;
        // depth-aware blur, 9 taps 3 texels apart: raw = the splat pass's attachment (Σ depth·α / coverage), else smoothed
        this.blur = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.blur.name = 'CodePassSmooth';
        this.blur.material.fragmentNode = Fn(() => {
            const read = q => {
                const v = this.blurSource.sample(q);
                return vec2(select(u.blurRaw.greaterThan(0.5), v.x.div(max(v.w, 1e-4)), v.x), v.w);
            };
            const c = read(screenUV).toVar();
            const sum = float(0).toVar(), weights = float(0).toVar();
            for (let i = -4; i <= 4; i++) {
                const s = read(screenUV.add(u.blurDir.mul(i * 3))).toVar();
                const w = float(Math.exp(-(i * i) / 8)).mul(step(0.02, s.y)).mul(step(abs(s.x.sub(c.x)), c.x.mul(0.1)));
                sum.addAssign(s.x.mul(w));
                weights.addAssign(w);
            }
            return vec4(select(weights.greaterThan(0), sum.div(max(weights, 1e-6)), c.x), 0, 0, c.y);
        })();
        this.quad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.quad.name = 'CodePass';
        this.quad.material.fragmentNode = Fn(() => {
            const at = screenUV.toVar();
            const c = this.color.sample(at).rgb.toVar();
            const cover = this.depth.sample(at).w.toVar();
            const depthAt = q => this.smoothed.sample(q).x;
            const view = (q, d) => {
                const far = u.projectionInverse.mul(vec4(q.x.mul(2).sub(1), float(1).sub(q.y.mul(2)), 1, 1));
                const ray = far.xyz.div(far.w);
                return ray.mul(d.div(max(ray.z.negate(), 1e-6)));
            };
            const D = depthAt(at).toVar();
            const px = u.glyph.mul(u.focal).div(max(D, 1e-6)).toVar();
            const reach = clamp(px.mul(0.5), 2, 48);
            const dx = vec2(reach.div(u.size.x), 0), dy = vec2(0, reach.div(u.size.y));
            // a neighbour far off (another object behind or in front) does not count
            const near = d => select(abs(d.sub(D)).lessThan(D.mul(0.08).add(u.glyph)), d, D);
            const p = view(at, D).toVar();
            const tx = view(at.add(dx), near(depthAt(at.add(dx)))).sub(view(at.sub(dx), near(depthAt(at.sub(dx)))));
            const ty = view(at.add(dy), near(depthAt(at.add(dy)))).sub(view(at.sub(dy), near(depthAt(at.sub(dy)))));
            const nView = normalize(cross(tx, ty));
            const world = u.cameraWorld.mul(vec4(p, 1)).xyz;
            const normal = u.cameraWorld.mul(vec4(nView, 0)).xyz;
            const tint = sRGBTransferOETF(CODE.tint).toVar();
            const own = codeTint(sRGBTransferOETF(clamp(c, 0, 1)), tint).toVar();
            const coded = codeSurface(own, world, normal, u.glyph, px, tint);
            const shown = sRGBTransferEOTF(max(mix(own, coded, CODE.mix), 0));
            return vec4(mix(c, shown, smoothstep(0.02, 0.4, cover)), 1);
        })();
    }

    // the smoothed depth: depth attachment → horizontal → vertical (half resolution)
    _smooth(depthTexture, size) {
        const r = this.renderer, [a, b] = this.smooth;
        const hx = Math.max(1, Math.ceil(size.x / 2)), hy = Math.max(1, Math.ceil(size.y / 2));
        for (const t of this.smooth) if (t.width !== hx || t.height !== hy) t.setSize(hx, hy);
        const u = this.u;
        this.blurSource.value = depthTexture;
        u.blurRaw.value = 1;
        u.blurDir.value.set(1 / hx, 0);
        r.setRenderTarget(a);
        this.blur.render(r);
        this.blurSource.value = a.texture;
        u.blurRaw.value = 0;
        u.blurDir.value.set(0, 1 / hy);
        r.setRenderTarget(b);
        this.blur.render(r);
    }

    /**
     * picture (linear texture) + depth (the splat pass's second attachment) → this.target.texture. glyph: glyph height
     * in the world; size: the picture's (default: the drawing buffer – fisheye faces have their own); version: changes
     * when the depth changed (the kept splat picture keeps the smoothed depth too; null = smooth every time)
     */
    render(colorTexture, depthTexture, camera, glyph, { size = null, version = null } = {}) {
        const r = this.renderer;
        size = size ? _size.copy(size) : r.getDrawingBufferSize(_size);
        const target = r.getRenderTarget(), face = r.getActiveCubeFace?.() ?? 0;
        if (this.target.width !== size.x || this.target.height !== size.y) { this.target.setSize(size.x, size.y); this._version = undefined; }
        if (version === null || version !== this._version || this.smooth[0].width !== Math.max(1, Math.ceil(size.x / 2))) this._smooth(depthTexture, size);
        this._version = version;
        this.color.value = colorTexture;
        this.depth.value = depthTexture;
        const u = this.u;
        u.projectionInverse.value.copy(camera.projectionMatrixInverse);
        u.cameraWorld.value.copy(camera.matrixWorld);
        u.focal.value = camera.projectionMatrix.elements[5] * size.y / 2;
        u.size.value.copy(size);
        u.glyph.value = glyph;
        r.setRenderTarget(this.target);
        this.quad.render(r);
        r.setRenderTarget(target, face);
        return this.target.texture;
    }
}
const _size = new THREE.Vector2();
