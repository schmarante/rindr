// Path tracer stand-in of a material (astro.config.mjs, rindr-pt-stand-in: three-gpu-pathtracer packs its material
// data from this). userData.ptStandIn (RindrMaterial in toon.js: subsurface look, glowing marble) overrides fields
// over the material itself (prototype) – maps, flags and everything else stay the material's own.
// `ptVolume` lands in the struct's unused fogVolume field: 2 = glowing marble (megakernel, marble.js).
// Thin film: three-gpu-pathtracer ≥ 0.0.28 reads iridescenceThicknessMinimum / Maximum (three.js r187's fields) – the
// material's own come through the prototype; stand-ins that carry values in iridescenceThicknessRange (wool fibre
// length, marble intensity, soap film + swirl cell) get them as minimum / maximum.
export function ptStandIn(material) {
    const pt = material?.userData?.ptStandIn;
    if (!pt) return material;
    // own fields, not assigned: assigning would run the prototype's setters (r187: iridescenceThicknessRange warns)
    const out = Object.create(material);
    const own = (key, value) => Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    for (const key of Object.keys(pt)) own(key, pt[key]);
    const range = pt.iridescenceThicknessRange;
    if (range) {
        own('iridescenceThicknessMinimum', range[0]);
        own('iridescenceThicknessMaximum', range[1]);
    }
    return out;
}
