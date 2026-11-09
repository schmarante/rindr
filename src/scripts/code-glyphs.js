// Glyph atlases (canvas 2D, the system's monospace font): the ASCII ramp of the style filter and the code characters –
// digits and half-width katakana – of the code rain (style-filters.js, screen) and the code look in the scene
// (code-look.js). White glyphs on black, mipmapped; read the red channel.
import * as THREE from 'three/webgpu';

export const ATLAS_CELL = [40, 64];   // glyph cell in the atlas (monospace aspect)

// code: digits and half-width katakana (fall back to whatever the system font has)
export const RAIN_CHARS = (() => {
    let s = '0123456789';
    for (let c = 0xff66; s.length < 64; c++) s += String.fromCharCode(c);
    return s;
})();

/** @returns {{ tex: THREE.CanvasTexture, columns: number, rows: number }} */
export function glyphAtlas(chars, columns) {
    const [w, h] = ATLAS_CELL;
    const rows = Math.ceil(chars.length / columns);
    const canvas = document.createElement('canvas');
    canvas.width = w * columns;
    canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(h * 0.78)}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    [...chars].forEach((ch, i) => g.fillText(ch, (i % columns + 0.5) * w, (Math.floor(i / columns) + 0.53) * h, w));
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { tex, columns, rows };
}

let code = null;
/** the code characters (64, 8 per row) – one atlas for the whole page */
export const codeAtlas = () => (code ??= glyphAtlas(RAIN_CHARS, 8));
