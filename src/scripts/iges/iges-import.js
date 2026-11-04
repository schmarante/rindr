// IGES models: converted to STEP text in a worker (iges-to-step.js), then imported the STEP way (step-importer.js) –
// structure, workers, qualities, copies, streaming, colours. The viewer treats them as STEP models whose content is the
// converted text (re-tessellation and part qualities use it; after releasing it, the file is read and converted again).
import { t } from '../i18n.js';
import { debugLog } from '../log.js';

/**
 * @param {Uint8Array} bytes the IGES file (shared or not – it is not changed)
 * @param {{ name?: string, onStatus?: (text: string, fraction?: number) => void, signal?: AbortSignal }} options
 * @returns {Promise<Uint8Array>} STEP text
 */
export function convertIges(bytes, { name = '', onStatus = () => {}, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./iges-worker.js', import.meta.url), { type: 'module', name: 'iges' });
        const t0 = performance.now();
        const end = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { end(); reject(new DOMException('Import aborted', 'AbortError')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort);
        onStatus(t('import.iges.converting'), 0);
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.iges.converting'), data.fraction); return; }
            end();
            if (data.type === 'error') { reject(new Error(data.message)); return; }
            debugLog(`[IGES] converted to STEP in ${Math.round(performance.now() - t0)} ms:`, data.stats);
            resolve(new Uint8Array(data.bytes));
        };
        worker.onerror = e => { end(); reject(new Error(e.message || t('import.step.workerError'))); };
        const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
        // the file goes over without a copy: shared, or the bytes' own buffer transferred (the caller does not keep it)
        const buffer = shared || (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.slice().buffer;
        worker.postMessage({ bytes: buffer, name: name.replace(/\.[^.]+$/, '') }, shared ? [] : [buffer]);
    });
}
