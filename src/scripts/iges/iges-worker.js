// Worker: IGES → STEP text (iges-to-step.js). In: { bytes (ArrayBuffer or SharedArrayBuffer), name }. Out: progress
// messages, then { type: 'done', bytes, stats } – with cross-origin isolation the STEP text in a SharedArrayBuffer (the
// STEP workers read it without a copy), otherwise a transferred ArrayBuffer.
import { igesToStep } from './iges-to-step.js';

self.onmessage = ({ data }) => {
    try {
        const { bytes, stats } = igesToStep(new Uint8Array(data.bytes), {
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
