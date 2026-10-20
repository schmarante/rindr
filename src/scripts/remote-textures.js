// Missing textures that a model references on another server (absolute https addresses – USD scenes from DCC pipelines
// point to the vendor's content server): loaded only when the user asks for it (asset window / notice), never on its
// own; can be cancelled. Loaded with fetch (CSP: connect-src https: – the stream gives each file's progress),
// decoded, scaled down right away to the size the import would use anyway (memory-budget.js textureMaxSide – a single
// image is often 4K and ~20 MB) and handed back as small files; the viewer links them like dropped files (in place
// where the slots are known, otherwise by reopening the scene; matched by file name).
import { textureMaxSide } from './memory-budget.js';

const PARALLEL = 4;

/** absolute address on another server? (the files the asset window can offer to load from the net) */
export function isRemoteTexture(url) {
    if (!/^https:\/\//i.test(url)) return false;
    try { return new URL(url).origin !== location.origin; } catch { return false; }
}

// the file with progress: onBytes(loaded, total) – total 0 when the server does not say
async function fetchBlob(url, signal, onBytes) {
    const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return res.blob();
    const reader = res.body.getReader(), chunks = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onBytes(loaded, total);
    }
    return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

// image → file at most maxSide px, raw pixel values (no colour management: normal and roughness maps stay data)
async function shrink(blob, name, maxSide) {
    const full = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const s = Math.min(1, maxSide / Math.max(full.width, full.height));
    const w = Math.max(1, Math.round(full.width * s)), h = Math.max(1, Math.round(full.height * s));
    const bitmap = s < 1 ? await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none' }) : full;
    if (bitmap !== full) full.close();
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = /\.png$/i.test(name);
    const out = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 });
    return new File([out], name, { type: out.type });
}

/**
 * @param {string[]} urls  absolute addresses
 * @param {{ onFile?: (url: string, state: { status: 'loading'|'done'|'failed', loaded?: number, total?: number }) => void,
 *           onProgress?: (p: { done: number, total: number, current: string }) => void, signal?: AbortSignal }} options
 *   onFile: per file (bytes while loading); current: the file that started last (several load at once)
 * @returns {Promise<{ files: { path: string, file: File, url: string }[], failed: string[], aborted: boolean }>}
 *   on abort: the files finished so far
 */
export async function downloadTextures(urls, { onFile = () => {}, onProgress = () => {}, signal } = {}) {
    const maxSide = textureMaxSide(urls.length);
    const files = [], failed = [];
    let next = 0, done = 0, current = '';
    const worker = async () => {
        while (next < urls.length && !signal?.aborted) {
            const url = urls[next++];
            const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'texture');
            current = name;
            onProgress({ done, total: urls.length, current });
            onFile(url, { status: 'loading', loaded: 0, total: 0 });
            try {
                const blob = await fetchBlob(url, signal, (loaded, total) => onFile(url, { status: 'loading', loaded, total }));
                files.push({ path: name, file: await shrink(blob, name, maxSide), url });
                onFile(url, { status: 'done' });
            } catch (err) {
                if (err?.name === 'AbortError') { onFile(url, { status: 'aborted' }); return; }
                failed.push(url);
                onFile(url, { status: 'failed' });
            }
            onProgress({ done: ++done, total: urls.length, current });
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, urls.length) }, worker));
    return { files, failed, aborted: !!signal?.aborted };
}
