// ACIS models (.sat/.sab): converted to STEP text in a worker (acis-to-step.js), then imported the STEP way like IGES
// (iges/iges-import.js) – structure, workers, qualities, copies, streaming, colours.
import { t } from '../i18n.js';
import { debugLog } from '../log.js';

/**
 * @param {Uint8Array} bytes the SAT/SAB file (shared or not – it is not changed)
 * @param {{ name?: string, onStatus?: (text: string, fraction?: number) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ bytes: Uint8Array, stats: object }>} STEP text
 */
export function convertAcis(bytes, { name = '', onStatus = () => {}, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./acis-worker.js', import.meta.url), { type: 'module', name: 'acis' });
        const t0 = performance.now();
        const end = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { end(); reject(new DOMException('Import aborted', 'AbortError')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort);
        onStatus(t('import.acis.converting'), 0);
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.acis.converting'), data.fraction); return; }
            end();
            if (data.type === 'error') { reject(new Error(data.message)); return; }
            debugLog(`[ACIS] converted to STEP in ${Math.round(performance.now() - t0)} ms:`, data.stats);
            resolve({ bytes: new Uint8Array(data.bytes), stats: data.stats });
        };
        worker.onerror = e => { end(); reject(new Error(e.message || t('import.step.workerError'))); };
        const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
        const buffer = shared || (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.slice().buffer;
        worker.postMessage({ bytes: buffer, name: name.replace(/\.[^.]+$/, '') }, shared ? [] : [buffer]);
    });
}
