// Features of the path tracer's kernel (megakernel and ray test) – built with the ones the scene's materials need.
// The patches in astro.config.mjs mark their WGSL /*@if:feature*/ … /*@else*/ … /*@endif*/ (several features: any of
// them, /*@if:glass,volume*/); featureTag() drops what is off before the code becomes a shader. All features: ~171 KB,
// ~13 s to compile without the browser's shader cache (RTX 3080) – a plain model without them ~105 KB, ~3–4 s
// (user: "only build the kernel with what the scene needs"). Each combination is a shader of its own: the browser's
// cache keeps every one compiled, a new combination (glass dropped on a part) compiles once.
// Collected while the library packs the material data (PathtracerBVHComputeData.updateMaterials → begin()/see(), the
// stand-in of each material) – right before the ray test and the kernel are built from it. The tag itself is in
// kernel-feature-tag.js (with the WGSL helpers – only the path tracer's modules import it).

import { glows } from './emitters.js';

// mirroring metal that sends caustics (caustics.js): the material's values – before maps and the glossy filter
export const MIRROR = { metalness: 0.9, roughness: 0.2 };
export const isMirror = m => !m.matte && (m.transmission ?? 0) <= 0.5 && (m.metalness ?? 0) >= MIRROR.metalness && (m.roughness ?? 1) <= MIRROR.roughness;

export const KERNEL_FEATURES = [
    'volume',   // cloud volumes and the splat volume (ptVolume 3, 6): volume walk, media in shadow rays
    'gaussians',   // traced Gaussian splats (ptVolume 6 with ptGaussians – baked look; gaussian-pt.js)
    'glass',    // transmission: glass shadows (shadow rays through glass), glass split
    'medium',   // scattering media inside glass / accurate subsurface (mediumScatter): the random walk (medium-walk.patch.wgsl)
    'wool',     // wool fibres (ptVolume 4): fibre hits in the ray test, their shading
    'soap',     // soap film (ptVolume 5)
    'marble',   // glowing marble (ptVolume 2)
    'edges',    // rounded edges (edge radius in anisotropyRotation, anisotropy 0)
    'ground',   // shadow catcher (matte ground)
    'caustics', // glass or mirroring metal with the glass shadows set to caustics (caustics.js): photon grid lookup
    'emitters', // glowing meshes (emitters.js): next event estimation towards their triangles, MIS on hits
    'curves',   // hair and fur (curves/: meshes with userData.ptCurves): cylinder pieces in the ray test, hits on them
];
const CURVES = { curves: true };   // stands for "a hair mesh is shown" in the set of shown materials

// ?kernel=all: every feature, whatever the scene (comparison, debugging)
const ALL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('kernel') === 'all';

export const kernelFeatures = {
    current: new Set(KERNEL_FEATURES),   // until the first material data: everything
    caustics: false,                     // glass shadows set to caustics (pathtracer.js setGlassShadow)
    shown: new Set(),                    // materials of visible objects (the library packs every object's material –
                                         // the hidden proxies of the cloud slots would always count as volumes)
    /** the library collects the scene's materials: an object of the scene */
    object(o) {
        let shown = true;
        for (let p = o; p && shown; p = p.parent) shown = p.visible;
        if (!shown) return;
        if (o.userData?.ptCurves) this.shown.add(CURVES);
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.shown.add(m);
    },
    /** the library starts packing the material data */
    begin() {
        this.current = new Set(ALL ? KERNEL_FEATURES : []);
        if (this.shown.has(CURVES)) this.current.add('curves');
    },
    /** a material as the kernel sees it (m: its stand-in, material: itself) – returns m */
    see(m, material) {
        if (!this.shown.has(material)) return m;
        const add = f => this.current.add(f);
        const volume = m.ptVolume ?? 0;
        if (volume === 6 && m.ptGaussians) add('gaussians');
        else if (volume === 3 || volume === 6) add('volume');
        else if (volume === 4) add('wool');
        else if (volume === 5) add('soap');
        else if (volume === 2) add('marble');
        if ((m.transmission ?? 0) > 0) add('glass');
        if (this.caustics && ((m.transmission ?? 0) > 0.5 || isMirror(m))) add('caustics');
        const scatter = m.mediumScatter;
        if ((m.transmission ?? 0) > 0 && scatter && scatter.r + scatter.g + scatter.b > 0) add('medium');
        if (m.anisotropyRotation && !m.anisotropy) add('edges');
        if (m.matte) add('ground');
        if (glows(m)) add('emitters');
        return m;
    },
    /** the features as a key (sorted) – one kernel per key */
    key(features = this.current) {
        return [...features].sort().join(',') || '-';
    },
};
