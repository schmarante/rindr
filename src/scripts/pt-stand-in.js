// Path tracer stand-in of a material (astro.config.mjs, rindr-pt-stand-in: three-gpu-pathtracer packs its material
// data from this). userData.ptStandIn (RindrMaterial in toon.js: subsurface look, glowing marble) overrides fields
// over the material itself (prototype) – maps, flags and everything else stay the material's own.
// `ptVolume` lands in the struct's unused fogVolume field: 2 = glowing marble (megakernel, marble.js).
// The thin film's thickness as the range three-gpu-pathtracer reads: three.js r187 replaced iridescenceThicknessRange
// by a minimum and maximum (reading the old name warns in the console).
export function ptStandIn(material) {
    const pt = material?.userData?.ptStandIn;
    const film = material && 'iridescenceThicknessMinimum' in material
        ? { iridescenceThicknessRange: [material.iridescenceThicknessMinimum, material.iridescenceThicknessMaximum] } : null;
    if (!pt && !film) return material;
    // own fields, not assigned: assigning would run the prototype's setters (r187: iridescenceThicknessRange warns)
    const out = Object.create(material);
    for (const fields of [film, pt]) {
        for (const key of Object.keys(fields ?? {})) Object.defineProperty(out, key, { value: fields[key], writable: true, enumerable: true, configurable: true });
    }
    return out;
}
