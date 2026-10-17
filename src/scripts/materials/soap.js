// Soap film material (wish of the user: a single soap bubble – later bubbles filling an object, like the cloud). A
// plain surface material, no extra geometry or volume:
//  - the film is matched to air on both sides (ior 1 – light passes straight, nothing refracts: the skin is a few
//    hundred nanometres thick), all its reflection comes from thin-film interference (iridescence, film ior 1.33):
//    colours shift with the viewing angle and the film thickness, reflection is weak in the middle, stronger at
//    grazing angles; what is not reflected passes (complementary colours seen through)
//  - film thickness varies over the surface: swirls (domain-warped value noise in world space, cell = share of the
//    scene size) and drainage (thinner where the surface faces up, thicker below) – the bands of a real bubble
//  - both sides of the skin count (double sided): a closed object shows its front and back film
// Raster: three.js' iridescence and transmission with the thickness as a node; path tracer: the same physics is in
// three-gpu-pathtracer (matched IOR + thin film, GltfCompliantMaterial), only the thickness comes from the same noise
// (soap-pt.js, rindr-soap in astro.config.mjs; ptVolume 5).
import { Fn, uniform, float, clamp, positionWorld, normalWorldGeometry } from 'three/tsl';
import { woolNoise } from './wool.js';

export const SOAP_IOR = 1.33;                 // the film (water + soap)
export const SOAP_CELL = 0.12;                // swirl cell size as share of the scene size (× soapScale)
export const SOAP_LIMITS = { min: 10, max: 1500 };   // film thickness range in nm (below ~30 nm a film looks black)
// how the thickness varies: swirl amplitude at swirl 1, warp of the swirls, drainage (top thinner, bottom thicker)
export const SOAP_SHAPE = { amplitude: 0.75, warp: 2.2, drain: 0.4 };

// swirl cell size in world units: scene size × SOAP_CELL × the material's scale; per object override
// userData.soapCell (material thumbnails: the preview sphere)
const sceneCell = { value: 1 };
const cellNode = uniform(1).onObjectUpdate(({ object }) => object.userData.soapCell ?? sceneCell.value);

/**
 * Film thickness in nm at a world position with its (unflipped) world normal – the same as rindrSoapThickness in
 * soap-pt.js. film = mean thickness (nm), swirl 0…1, cell = swirl size (world units)
 */
export const soapThickness = Fn(([p, n, film, swirl, cell]) => {
    const q = p.div(cell);
    const w = woolNoise(q.mul(0.45));
    const v = woolNoise(q.add(w.mul(SOAP_SHAPE.warp)));
    const fine = woolNoise(q.mul(2.6).add(w.mul(1.3)));
    const bands = v.x.mul(0.65).add(fine.y.mul(0.35));
    const drain = float(1).sub(n.y.mul(SOAP_SHAPE.drain));
    return clamp(film.mul(drain).mul(swirl.mul(SOAP_SHAPE.amplitude).mul(bands).add(1)), SOAP_LIMITS.min, SOAP_LIMITS.max);
});

/** Raster thickness node of a soap material (uniforms film/swirl/scale – no rebuild on edits) */
export function soapThicknessNode(u) {
    return soapThickness(positionWorld, normalWorldGeometry, u.film, u.swirl, cellNode.mul(u.scale));
}

/**
 * Scene size changed (viewer.js) – the swirls follow it. Returns true when the path tracer's materials need packing
 * anew (the cell size is in their stand-in fields, RindrMaterial.setSoap)
 */
export function setSoapSceneSize(size) {
    const cell = Math.max(size, 1e-6) * SOAP_CELL;
    if (cell === sceneCell.value) return false;
    sceneCell.value = cell;
    return true;
}

/** Swirl cell size in world units of the scene (path tracer stand-in) */
export function soapSceneCell() {
    return sceneCell.value;
}
