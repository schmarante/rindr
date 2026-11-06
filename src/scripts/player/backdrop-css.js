// The player's background as CSS (docs/environment.md "Hintergrund wählen"): before the viewer has drawn anything (script
// loading, GPU start, the import's first parts) the element shows the background the page asked for instead of the dark
// default – the same look the 3D background has (environment.js VignetteBackground: linear top → bottom, radial with a
// smoothstep falloff to the far corner), and the start text in a colour that reads on it. Small – part of the element's
// script, no three.js.

/** 'hdri' | 'default' | a CSS colour | 'linear(a, b)' | 'radial(a, b)' | { type, colors } → { type, colors } (colours as
 *  given), 'hdri', 'default' – or null when not understood */
export function splitBackground(spec) {
    const valid = c => typeof c === 'string' && c.trim() !== '' && (typeof CSS === 'undefined' || CSS.supports('color', c.trim()));
    if (spec && typeof spec === 'object') {
        if (spec.type === 'hdri') return 'hdri';
        if (!['radial', 'linear', 'solid'].includes(spec.type) || !Array.isArray(spec.colors) || !spec.colors.length) return null;
        return spec.colors.every(valid) ? { type: spec.type, colors: spec.colors.map(c => c.trim()) } : null;
    }
    const text = String(spec ?? '').trim();
    if (/^hdri$/i.test(text)) return 'hdri';
    if (!text || /^default$/i.test(text)) return 'default';
    const m = /^(linear|radial)\s*\((.*)\)$/i.exec(text);
    if (!m) return valid(text) ? { type: 'solid', colors: [text] } : null;
    // colours separated by commas outside parentheses (rgb(…) has commas of its own)
    const colors = [];
    let depth = 0, cur = '';
    for (const ch of m[2]) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && !depth) { colors.push(cur.trim()); cur = ''; } else cur += ch;
    }
    colors.push(cur.trim());
    const list = colors.filter(Boolean);
    if (!list.length || !list.every(valid)) return null;
    return { type: m[1].toLowerCase(), colors: list.length > 1 ? list.slice(0, 2) : [list[0], list[0]] };
}

// relative luminance (0…1) of a CSS colour – the browser normalizes it (canvas fillStyle → #rrggbb or rgba(…))
let probe = null;
function luminance(color) {
    probe ??= document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    const v = probe.fillStyle;
    const rgb = v.startsWith('#') ? [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255) : (v.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(x => +x / 255);
    const lin = rgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** light behind the start text (the middle of the view)? – then the text is written dark */
export function lightBehindText(bg) {
    if (!bg || typeof bg !== 'object') return false;
    const [a, b = a] = bg.colors;
    const middle = bg.type === 'linear' ? (luminance(a) + luminance(b)) / 2 : luminance(a);   // radial/solid: the centre colour
    return middle > 0.4;
}

/** the background as a CSS image/colour (null: the default – the element's own dark background) */
export function backgroundCss(bg) {
    if (!bg || typeof bg !== 'object') return null;
    const [a, b = a] = bg.colors;
    if (bg.type === 'solid') return a;
    if (bg.type === 'linear') return `linear-gradient(to bottom, ${a}, ${b})`;
    // the vignette's falloff: smoothstep(r / 1.25), r = distance from the centre over the distance to the corner
    const mix = share => `color-mix(in srgb, ${b} ${share}%, ${a})`;
    return `radial-gradient(circle farthest-corner at 50% 50%, ${a} 0%, ${mix(10.4)} 25%, ${mix(35.2)} 50%, ${mix(64.8)} 75%, ${mix(89.6)} 100%)`;
}
