// Debug helpers for material node graphs (only with ?debug, globalThis.__viewer): bake one input of a graph into
// a PNG and render a material description on the thumbnail sphere – for checking node types without the UI.
import { evaluateGraph } from './material-graph.js';
import { buildMaterial } from './material-manager.js';
import { thumbKey } from './material-thumbs.js';

/**
 * Bake input `input` of the output node into a PNG data URL (tiles × tiles copies side by side – shows the seams).
 * @returns {Promise<string|null>} null if the input is not connected or constant
 */
export async function bakeGraphImage(applier, graph, { input = 'color', size = 512, tiles = 1 } = {}) {
    const images = await applier._imageTextures(graph);
    const result = evaluateGraph(graph, images);
    const r = result[input];
    if (!r || r.kind !== 'tsl') return null;
    const tex = input === 'height'
        ? await applier.baker.bakeNormal(r.node, result.reliefStrength, size)
        : await applier.baker.bake(r.node, r.type, { srgb: r.type === 'color', size });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size * tiles;
    const ctx = canvas.getContext('2d');
    const img = new ImageData(new Uint8ClampedArray(tex.image.data), size, size);
    for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) ctx.putImageData(img, x * size, y * size);
    tex.dispose();
    return canvas.toDataURL('image/png');
}

/** Render { params, graph } on the thumbnail sphere (like a library preset); resolves with a data URL (webp) */
export function previewMaterial(applier, thumbs, { params = {}, graph = null }) {
    const key = thumbKey({ debug: Date.now() + Math.random(), params, graph });
    return new Promise(resolve => {
        const onReady = e => {
            if (e.detail.key !== key) return;
            thumbs.removeEventListener('ready', onReady);
            if (!e.detail.url) { resolve(null); return; }
            fetch(e.detail.url).then(r => r.blob()).then(b => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.readAsDataURL(b);
            });
        };
        thumbs.addEventListener('ready', onReady);
        thumbs.request(key, `debug:${key}`, async () => {
            const material = buildMaterial(params);
            if (graph) await applier.applyNow({ material, preview: true, def: { id: key, params, graph } });
            return material;
        }, { key, group: `debug:${key}`, persist: false, dispose: true, release: m => applier.release(m) });
    });
}
