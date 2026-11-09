// Drawing files (DXF; DWG next) on the main thread: read in a worker (cad-worker.js), ask for the space when the file has
// layouts with content (model space or a layout – chooseSpace), build there. Returns the STEP text of its ACIS bodies
// (empty without – the viewer goes the STEP way like IGES, docs/cad-drawings.md) and the extras (lines, fills, texts,
// 3D surfaces) that hang on the same nodes.
import { t } from '../i18n.js';
import { debugLog } from '../log.js';

/**
 * @param {Uint8Array} bytes the file
 * @param {{ name?: string, format?: string, space?: string|null, chooseSpace?: (spaces: object[]) => Promise<string|null>,
 *   limits?: object, onStatus?: (text: string, fraction?: number) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ content: Uint8Array, extras: object, space: string }>}
 */
export function convertCad(bytes, { name = '', format = 'dxf', space = null, chooseSpace = null, limits = {}, onStatus = () => {}, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./cad-worker.js', import.meta.url), { type: 'module', name: 'cad' });
        const t0 = performance.now();
        const end = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { end(); reject(new DOMException('Import aborted', 'AbortError')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort);
        onStatus(t('import.cad.reading'), 0);
        let chosen = space;
        worker.onmessage = async ({ data }) => {
            if (data.type === 'progress') {
                onStatus(t(data.phase === 'read' ? 'import.cad.reading' : data.phase === 'solids' ? 'import.acis.converting' : 'import.cad.building'), data.fraction);
                return;
            }
            if (data.type === 'spaces') {
                const spaces = data.spaces;
                if (!chosen || !spaces.some(s => s.id === chosen)) {
                    chosen = spaces.length > 1 && chooseSpace ? await chooseSpace(spaces) : 'model';
                    if (!chosen) { abort(); return; }
                }
                debugLog(`[CAD] ${name}: ${data.version}, ${Math.round(performance.now() - t0)} ms read; spaces:`, spaces.map(s => s.name || s.id).join(', '), '→', chosen);
                onStatus(t('import.cad.building'), 0);
                worker.postMessage({ type: 'build', space: chosen, limits });
                return;
            }
            end();
            if (data.type === 'error') { reject(new Error(data.message)); return; }
            debugLog(`[CAD] built in ${Math.round(performance.now() - t0)} ms:`, data.extras.counts, data.extras.skipped);
            resolve({ content: data.step ? new Uint8Array(data.step) : new Uint8Array(0), extras: data.extras, space: chosen });
        };
        worker.onerror = e => { end(); reject(new Error(e.message || t('import.step.workerError'))); };
        const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
        const buffer = shared || (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.slice().buffer;
        worker.postMessage({ type: 'read', bytes: buffer, format, name }, shared ? [] : [buffer]);
    });
}
