// Distributed rendering (docs/distributed.md): messages between the master (the user's browser) and render clients.
// Transport: one object with send(msg) and an onmessage callback – a BroadcastChannel between tabs of this browser
// (clients opened with ?render-client) or WebRTC data channels to other computers (rtc.js, pairing by code; the master
// joins both in a hub). Every message carries `from`; messages to one peer carry `to`.
//
//   client → master  hello        { name, gpu, sceneId, sceneFrom, master }   every second (heartbeat; master = bound
//                                 master, sceneFrom = the master whose scene it holds – kept after a release: the
//                                 second pass of a transparent image reuses it)
//   master → client  scene        { sceneId, state, files }       scene state + model files ({ path, file }); the master
//                                 follows the bytes sent per client (transport send option onProgress, rtc.js)
//   client → master  scene-ready  { sceneId } / scene-error { sceneId, message }
//   master → client  job          { jobId, sceneId, bucket: { id, x, y, w, h }, fullW, fullH, samples, matte }
//                                 matte: grey value of a plain background (transparent image passes) or null
//   client → master  progress     { jobId, bucketId, p }  ·  result { jobId, bucketId, data: Float32Array }
//                                 partial { jobId, bucketId, data, samples }   intermediate state at 1, 2, 4 … samples
//                                 job-error { jobId, bucketId, message }
//   master → client  cancel       { jobId }                       stop the bucket, forget the job
//   master → all     release      {}                              master gone / job over: clients become free

export const CHANNEL = 'rindr-render';
export const HEARTBEAT_MS = 1000;
export const LOST_MS = 5000;   // no hello for this long = client lost (its bucket goes back into the queue)

export const newId = () => (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).slice(0, 8);

/** tabs of this browser (same origin) – a message is there at once (files go by reference): no send progress */
export function localTransport() {
    const channel = new BroadcastChannel(CHANNEL);
    const transport = {
        onmessage: null,
        send: msg => channel.postMessage(msg),
        close: () => channel.close(),
    };
    channel.onmessage = e => transport.onmessage?.(e.data);
    return transport;
}

/** short GPU name of this device (WebGPU adapter info) */
export function gpuName(renderer) {
    const info = renderer?.backend?.adapter?.info || renderer?.backend?.device?.adapterInfo;
    if (!info) return '';
    return info.description || [info.vendor, info.architecture].filter(Boolean).join(' ');
}

/** data size for the transfer display ("8.4 MB", "157 MB", "1.2 GB") */
export function formatSize(bytes, locale) {
    const mb = bytes / 2 ** 20;
    if (mb >= 1024) return `${(mb / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} GB`;
    return `${mb.toLocaleString(locale, { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}
