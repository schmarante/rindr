// Glass split in the path tracer (Vite plugin rindr-glass-split in astro.config.mjs, docs/pathtracer.md).
//
// Where a camera ray meets glass (any transmissive surface: glass, soap film, frosted glass, stand-ins), the library
// picks reflection or refraction by chance – the reflection (~4 % head-on, up to 100 % at grazing angles) shows up in
// few samples only: glass looks grainy, its reflections sparkle for many samples. Instead both halves are traced: the
// refraction continues the path, the reflection goes onto a small stack and runs as a path of its own afterwards
// (same pixel, same sample). Unbiased: the random number that picks the lobe is stratified at the point where the
// reflection side ends (clearcoat + specular + the reflected share of the glass lobe at the sampled microfacet) – each
// half is the library's own sample restricted to its stratum, weighted by the stratum's width. Only along the camera
// ray's chain of refractions, at most twice per sample (entry and exit face – GLASS_SPLIT_MAX in astro.config.mjs);
// each split costs one more path where glass is seen.
//
//   mode  private, set by the megakernel around bsdfSample: 0 = as the library, 1 = reflection stratum,
//         2 = refraction stratum, 3 = only compute the split point (share) and return
//   share private, written by bsdfSample: width of the reflection stratum (0–1)
//   enabled uniform: 0 = library behaviour (PATHTRACING.glassSplit, pathtracer.js)
import { uniform, uint, float } from 'three/tsl';

export const GLASS_SPLIT = {
    mode: uint(0).toVar('rsLobeMode'),
    share: float(0).toVar('rsLobeShare'),
    enabled: uniform(1, 'uint'),
};
