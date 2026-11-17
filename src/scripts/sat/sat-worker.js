// Worker: SAT (SAT/SAB) → STEP text (sat-to-step.js). In: { bytes (ArrayBuffer or SharedArrayBuffer), name }. Out: progress
// messages, then { type: 'done', bytes, stats } – the STEP text in a SharedArrayBuffer with cross-origin isolation (the
// STEP workers read it without a copy), otherwise a transferred ArrayBuffer. Like iges/iges-worker.js.
import { satToStep } from './sat-to-step.js';

self.onmessage = ({ data }) => {
    try {
        const { bytes, stats } = satToStep(new Uint8Array(data.bytes), {
            name: data.name, onProgress: fraction => self.postMessage({ type: 'progress', fraction }),
        });
        if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
            const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
            shared.set(bytes);
            self.postMessage({ type: 'done', bytes: shared.buffer, stats });
        } else {
            const own = bytes.slice();
            self.postMessage({ type: 'done', bytes: own.buffer, stats }, [own.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
