// Which graphics chip WebGPU renders on – shown on the About page and in the debug overlay, and a notice at the start
// when it looks like the processor's integrated graphics (a second, dedicated card then idles: on Windows the browser
// is often given the integrated chip whatever the page asks for – viewer.js already requests 'high-performance').
//
// WebGPU has no "integrated" flag: adapter.info gives vendor and architecture (lower case, e.g. "intel" / "gen-12lp",
// "nvidia" / "ampere", "amd" / "rdna-3"); description and type ("integrated GPU" / "discrete GPU") only with the
// browser's developer features. So a guess: true / false / null (unknown – no notice).

/** short name of the adapter: its description when the browser gives one, otherwise vendor + architecture */
export function gpuLabel(info) {
    if (!info) return '';
    return info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') || 'WebGPU';
}

/** @returns {boolean|null} */
export function looksIntegrated(info) {
    if (!info || info.isFallbackAdapter) return null;
    const type = String(info.type || '').toLowerCase();
    if (type.includes('integrated')) return true;
    if (type.includes('discrete')) return false;
    const vendor = String(info.vendor || '').toLowerCase(), arch = String(info.architecture || '').toLowerCase();
    const desc = String(info.description || '').toLowerCase();
    if (vendor === 'nvidia') return false;
    if (vendor === 'intel') {
        // dedicated cards are the "HP" architectures (gen-12hp, xe-2hpg …), the integrated ones "LP" (gen-12lp, xe-lpg …)
        if (!arch) return null;
        return !arch.includes('hp');
    }
    if (vendor === 'amd') {
        // both kinds share the architectures (rdna-2, rdna-3 …) – only the description tells them apart
        if (/\brx\b|radeon pro/.test(desc)) return false;
        if (/radeon(\(tm\))? graphics|vega \d+ graphics|radeon \d{3,4}m\b/.test(desc)) return true;
        return null;
    }
    // unified chips (the only GPU of the device) or unknown: nothing to switch to
    return null;
}
