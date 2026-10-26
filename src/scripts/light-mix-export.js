// Saving the light passes (docs/pathtracer.md "Licht-Passes"): EXR with one layer per pass (linear, half float; depth
// float) or PSD with 32-bit layers – the source passes visible and added (their sum = the picture), the kind passes, the
// shadow and the helper passes (alpha, depth, normals, albedo, object/material id) as further (hidden) layers. Loaded
// with the first layered save.
import { t } from './i18n.js';
import { PASS, SOURCE_PASSES, KIND_PASSES } from './light-passes.js';
import { readTexture, passLabel } from './light-mix.js';
import { encodeExr, exrName } from './exr-encode.js';
import { encodePsd } from './psd-encode.js';

/**
 * The layers of a mix: { key, name, read(y0, rows) → RGBA float, kind: 'light' | 'helper', visible, blend, channels }
 * helpers: guide kernel of pathtracer.helperPasses (textures position, normal, albedo, ids – layout in pt-guides.js)
 */
function layersOf(mix, helpers, renderer) {
    const { width, height } = mix;
    const light = (index, visible) => ({
        key: `p${index}`, name: passLabel(index, mix.lights), kind: 'light', visible, blend: 'add',
        read: (y0, rows) => mix.read(index, { y0, rows }),
    });
    const layers = [];
    for (const i of SOURCE_PASSES) if (mix.has(i)) layers.push(light(i, true));
    for (const i of KIND_PASSES) if (mix.has(i)) layers.push(light(i, false));
    if (mix.has(PASS.SHADOW)) layers.push(light(PASS.SHADOW, false));
    // alpha = 1 − the share of the background that comes through (transparency pass: glass, ground shadow, edges, depth of
    // field); cut out = the picture without its background (premultiplied: sum − background pass) with that alpha
    const alphaOf = t => Math.min(Math.max(1 - (t[0] + t[1] + t[2]) / 3, 0), 1);
    const transparency = (y0, rows) => mix.read(PASS.TRANSPARENCY, { y0, rows });
    layers.push({ key: 'alpha', name: t('lightMix.pass.alpha'), kind: 'helper', visible: false, blend: 'normal', read: async (y0, rows) => {
        const tr = await transparency(y0, rows);
        for (let i = 0; i < tr.length; i += 4) tr[i] = tr[i + 1] = tr[i + 2] = tr[i + 3] = alphaOf(tr.subarray(i, i + 3));
        return tr;
    } });
    layers.push({ key: 'cutout', name: t('lightMix.pass.cutout'), kind: 'helper', visible: false, blend: 'normal', read: async (y0, rows) => {
        const [sum, bg, tr] = await Promise.all([mix.read('sum', { y0, rows }), mix.read(PASS.BACKGROUND, { y0, rows }), transparency(y0, rows)]);
        for (let i = 0; i < sum.length; i += 4) {
            for (let c = 0; c < 3; c++) sum[i + c] = Math.max(sum[i + c] - bg[i + c], 0);
            sum[i + 3] = alphaOf(tr.subarray(i, i + 3));
        }
        return sum;
    } });
    if (helpers) {
        const backend = renderer.backend;
        const gpu = tex => backend.get(tex).texture;
        const position = (y0, rows) => readTexture(renderer, gpu(helpers.position), 'rgba32float', width, y0, rows);
        const map = (read, fn) => async (y0, rows) => {
            const src = await read(y0, rows);
            const out = new Float32Array(src.length);
            for (let i = 0; i < src.length; i += 4) fn(src, i, out);
            return out;
        };
        const helper = (key, read) => ({ key, name: t(`lightMix.pass.${key}`), kind: 'helper', visible: false, blend: 'normal', read });
        // depth as it is (EXR); PSD shows it normalised (below)
        layers.push({ ...helper('depth', map(position, (s, i, o) => { o[i] = o[i + 1] = o[i + 2] = s[i]; o[i + 3] = s[i + 1]; })), depth: true });
        const normal = (y0, rows) => readTexture(renderer, gpu(helpers.normal), 'rgba16float', width, y0, rows);
        layers.push(helper('normal', normal));
        layers.push(helper('albedo', (y0, rows) => readTexture(renderer, gpu(helpers.albedo), 'rgba16float', width, y0, rows)));
        // id colours averaged over the rays (antialiased): object in its own texture, material in free channels (pt-guides.js)
        layers.push(helper('objectId', map((y0, rows) => readTexture(renderer, gpu(helpers.ids), 'rgba16float', width, y0, rows), (s, i, o) => {
            o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = 1;
        })));
        layers.push(helper('materialId', async (y0, rows) => {
            const [p, n] = await Promise.all([position(y0, rows), normal(y0, rows)]);
            const out = new Float32Array(p.length);
            for (let i = 0; i < p.length; i += 4) { out[i] = p[i + 2]; out[i + 1] = p[i + 3]; out[i + 2] = n[i + 3]; out[i + 3] = 1; }
            return out;
        }));
    }
    return { width, height, layers };
}

/**
 * Save the mix as `format` ('exr' | 'psd') – returns the Blob. onProgress(0…1, step) – PSD: the layer being written
 */
export async function encodeLightMix(mix, helpers, renderer, format, onProgress) {
    const { width, height, layers } = layersOf(mix, helpers, renderer);
    const mixed = (y0 = 0, rows = height) => mix.read('sum', { y0, rows });
    if (format === 'exr') {
        const names = new Set();
        const unique = name => { let n = exrName(name), k = 2; while (names.has(n)) n = `${exrName(name)}_${k++}`; names.add(n); return n; };
        const exrLayers = [{ name: 'beauty', channels: ['R', 'G', 'B', 'A'].map((c, source) => ({ name: c, source })), read: mixed }];
        for (const l of layers) {
            if (l.key === 'depth') { exrLayers.push({ name: 'Z', channels: [{ name: 'Z', type: 'float', source: 0 }], read: l.read }); continue; }
            const base = unique(l.name);
            const components = l.key === 'alpha' ? ['A'] : l.key === 'normal' ? ['X', 'Y', 'Z'] : l.key === 'cutout' ? ['R', 'G', 'B', 'A'] : ['R', 'G', 'B'];
            exrLayers.push({ name: base, channels: components.map((c, source) => ({ name: `${base}.${c}`, source: l.key === 'alpha' ? 3 : source })), read: l.read });
        }
        return encodeExr(width, height, exrLayers, { onProgress });
    }
    // PSD: bottom first – the source layers (the first one normal, the others added), then the hidden ones
    const psdLayers = [];
    let first = true;
    for (const l of layers) {
        let read = () => l.read(0, height);
        if (l.depth) {
            // depth normalised over the covered pixels: near white, far black, background black
            read = async () => {
                const d = await l.read(0, height);
                let lo = Infinity, hi = -Infinity;
                for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
                const range = hi > lo ? hi - lo : 1;
                for (let i = 0; i < d.length; i += 4) {
                    const v = d[i + 3] > 0 ? 1 - (d[i] - lo) / range : 0;
                    d[i] = d[i + 1] = d[i + 2] = v * d[i + 3];
                    d[i + 3] = 1;
                }
                return d;
            };
        } else if (l.key === 'normal') {
            read = async () => {
                const d = await l.read(0, height);
                for (let i = 0; i < d.length; i += 4) { for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * 0.5 + 0.5; d[i + 3] = 1; }
                return d;
            };
        } else if (l.key === 'cutout') {
            // a layer with transparency: colour not premultiplied
            read = async () => {
                const d = await l.read(0, height);
                for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a > 1e-4) for (let c = 0; c < 3; c++) d[i + c] /= a; }
                return d;
            };
        } else if (l.kind === 'light' || l.key === 'albedo') {
            read = async () => { const d = await l.read(0, height); for (let i = 3; i < d.length; i += 4) d[i] = 1; return d; };
        }
        const blend = l.kind === 'light' && l.visible && !first ? 'add' : l.kind === 'light' && !l.visible ? 'add' : 'normal';
        if (l.kind === 'light' && l.visible) first = false;
        psdLayers.push({ name: l.name, blend, hidden: !l.visible, read });
    }
    return encodePsd(width, height, psdLayers, () => mixed(), { onProgress });
}
