// Glass tints, mirror, gloss lacquer, coloured anodised aluminium, neon – plain parameter presets (no graph)
export default [
    // --- glass: tinted by absorption over the thickness (attenuation) ---
    { libraryId: 'glass-blue', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, ior: 1.52, thickness: 4, attenuationColor: '#5f86b8', attenuationDistance: 10 } },
    { libraryId: 'glass-bronze', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, ior: 1.52, thickness: 4, attenuationColor: '#8a6a4a', attenuationDistance: 10 } },
    { libraryId: 'glass-bottle-green', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, ior: 1.52, thickness: 4, attenuationColor: '#2f7a3a', attenuationDistance: 6 } },
    // solar control glazing: tinted, a little metallic (strong reflection), slightly bluish
    { libraryId: 'glass-reflective', category: 'glass', params: { color: '#b9c6d2', metalness: 0.35, roughness: 0.02, transmission: 0.7, ior: 1.52, thickness: 4, attenuationColor: '#6f8796', attenuationDistance: 12 } },
    // painted back glass (opaque, glassy top layer)
    { libraryId: 'glass-painted-dark', category: 'glass', params: { color: '#1d2329', metalness: 0, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0 } },
    { libraryId: 'mirror', category: 'glass', params: { color: '#f4f5f6', metalness: 1, roughness: 0 } },

    // --- paint: piano lacquer (deep gloss) ---
    { libraryId: 'paint-lacquer-black', category: 'paint', params: { color: '#0d0e10', metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.01 } },
    { libraryId: 'paint-lacquer-white', category: 'paint', params: { color: '#f3f3f1', metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.01 } },

    // --- coloured anodised aluminium ---
    { libraryId: 'metal-alu-anodized-blue', category: 'metal', params: { color: '#3b6cc4', metalness: 1, roughness: 0.3 } },
    { libraryId: 'metal-alu-anodized-red', category: 'metal', params: { color: '#b8323a', metalness: 1, roughness: 0.3 } },

    // --- glowing ---
    { libraryId: 'emissive-neon-red', category: 'other', params: { color: '#ff1408', metalness: 0, roughness: 0.5, emissive: '#ff1408', emissiveIntensity: 2.5 } },   // at 5 the tone mapping washed it out to pink
];
