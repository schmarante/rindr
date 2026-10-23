// Distributed rendering between computers (docs/distributed.md): WebRTC data channels without a server (user's
// decision: no signalling script). Pairing by codes: the master makes an offer and shows it as a link
// (…?render-client#pair=<code>), the render computer opens it and shows its answer code, which goes back into the
// master. Only the local network – no STUN server, the browsers offer their own addresses (host candidates, usually as
// mDNS names). Lost connections need a new pairing (no rendezvous to reconnect through).
//
// Code (base64url): the compact form – type, ICE user name/password, DTLS fingerprint (SHA-256) and the UDP addresses
// of the computer packed into bytes (~140 characters instead of ~560 for the deflated description); the receiving side
// writes the session description (SDP) from it. A description that does not fit this form goes as deflated SDP.
//
// Messages on the channel (channelTransport): the same objects as between tabs. Binary parts (typed arrays such as
// bucket pixels, Blobs/Files such as model files) are cut out: first a text frame with the JSON (binary parts replaced
// by { $bin: index }) and their sizes, then their bytes as binary frames of ≤ 64 KB (the browsers' message limit is
// larger, but small frames keep the channel fair and the memory flat). One message after another, the channel is
// ordered and reliable; the sender waits while more than BUFFER_HIGH bytes are queued.

const ICE_TIMEOUT = 4000;            // ms to gather the own addresses
const CONNECT_TIMEOUT = 20000;       // ms from the answer to an open channel
const FRAME = 64 * 1024;
const READ = 4 * 1024 * 1024;        // a Blob is read in pieces of this size
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 1024 * 1024;
const TYPED = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array };
const CONFIG = { iceServers: [] };

// --- pairing codes ---

const toBase64Url = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = text => {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const SETUP = ['actpass', 'active', 'passive'];
const COMPACT = 0x10, DEFLATED = 0x00;

/** compact bytes of a data-channel description, or null when it does not fit the form */
function compact(type, sdp) {
    const get = re => sdp.match(re)?.[1];
    const ufrag = get(/^a=ice-ufrag:(\S+)/m), pwd = get(/^a=ice-pwd:(\S+)/m), fp = get(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/m);
    const setup = SETUP.indexOf(get(/^a=setup:(\S+)/m));
    if (!ufrag || !pwd || !fp || setup < 0 || get(/^a=mid:(\S+)/m) !== '0' || get(/^a=sctp-port:(\d+)/m) !== '5000'
        || (sdp.match(/^m=/gm) || []).length !== 1) return null;
    const fpBytes = fp.split(':').map(h => parseInt(h, 16));
    const candidates = [...sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gmi)].slice(0, 255);
    if (fpBytes.length !== 32 || !candidates.length) return null;
    const out = [COMPACT | (type === 'offer' ? 0 : 1), setup];
    const text = value => { const b = new TextEncoder().encode(value); out.push(Math.min(b.length, 255), ...b.subarray(0, 255)); };
    text(ufrag);
    text(pwd);
    out.push(...fpBytes, candidates.length);
    for (const [, address, port] of candidates) {
        const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        const mdns = address.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i);
        if (v4) out.push(0, ...v4.slice(1).map(Number));
        else if (mdns) out.push(1, ...mdns.slice(1).join('').match(/../g).map(h => parseInt(h, 16)));
        else { out.push(2); text(address); }   // IPv6, other names
        out.push(+port >> 8, +port & 255);
    }
    return new Uint8Array(out);
}

/** session description from the compact bytes */
function expand(bytes) {
    let o = 0;
    const type = bytes[o++] & 1 ? 'answer' : 'offer';
    const setup = SETUP[bytes[o++]];
    const text = () => { const n = bytes[o++]; const v = new TextDecoder().decode(bytes.subarray(o, o + n)); o += n; return v; };
    const ufrag = text(), pwd = text();
    const fp = hex(bytes.subarray(o, o + 32)).toUpperCase().match(/../g).join(':');
    o += 32;
    const lines = [];
    for (let i = 0, n = bytes[o++]; i < n; i++) {
        const kind = bytes[o++];
        let address;
        if (kind === 0) { address = [...bytes.subarray(o, o + 4)].join('.'); o += 4; }
        else if (kind === 1) {
            const h = hex(bytes.subarray(o, o + 16));
            o += 16;
            address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
        } else address = text();
        const port = (bytes[o] << 8) | bytes[o + 1];
        o += 2;
        lines.push(`a=candidate:${i + 1} 1 udp ${2113937151 - i} ${address} ${port} typ host generation 0`);
    }
    if (o > bytes.length || !setup || !ufrag || !pwd || !lines.length) throw new Error('invalid code');
    const sdp = ['v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...lines, `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
        'a=ice-options:trickle', `a=fingerprint:sha-256 ${fp}`, `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144'];
    return { type, sdp: `${sdp.join('\r\n')}\r\n` };
}

/** session description → code */
export async function packDescription({ type, sdp }) {
    const small = compact(type, sdp);
    if (small) return toBase64Url(small);
    const lines = sdp.split(/\r?\n/).filter(l => l && !(l.startsWith('a=candidate:') && / tcp /i.test(l)));
    const deflated = await pipe(new TextEncoder().encode(`${type === 'offer' ? 'o' : 'a'}${lines.join('\n')}`), new CompressionStream('deflate-raw'));
    return toBase64Url(new Uint8Array([DEFLATED, ...deflated]));
}

/** code (or the whole pairing link) → session description; throws 'invalid code' on a broken one */
export async function unpackDescription(code) {
    try {
        const bytes = fromBase64Url(String(code).trim().replace(/^.*#pair=/, '').replace(/\s+/g, ''));
        if ((bytes[0] & 0xf0) === COMPACT) return expand(bytes);
        if (bytes[0] !== DEFLATED) throw new Error('invalid code');
        const text = new TextDecoder().decode(await pipe(bytes.subarray(1), new DecompressionStream('deflate-raw')));
        const type = { o: 'offer', a: 'answer' }[text[0]];
        if (!type || !text.includes('m=application')) throw new Error('invalid code');
        return { type, sdp: `${text.slice(1).split('\n').join('\r\n')}\r\n` };
    } catch {
        throw new Error('invalid code');
    }
}

async function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
        const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, ICE_TIMEOUT);
    });
}

function opened(pc, channel) {
    // a closed tab ends its connection without a word – the other side would notice only after ~30 s (consent check):
    // close the channel when the page goes (the other side sees it at once), and close it when the connection fails
    addEventListener('pagehide', () => channel.close());
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') channel.close(); });
    return new Promise((resolve, reject) => {
        if (channel.readyState === 'open') { resolve(channel); return; }
        const timer = setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT);
        channel.addEventListener('open', () => { clearTimeout(timer); resolve(channel); }, { once: true });
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed') { clearTimeout(timer); reject(new Error('timeout')); }
        });
    });
}

/** WebRTC with data channels and deflate streams available */
export const rtcSupported = () => typeof RTCPeerConnection === 'function' && typeof CompressionStream === 'function';

/**
 * Master side: offer as code. accept(answerCode) resolves with the open channel (rejects: 'invalid code', 'timeout').
 */
export async function createOffer() {
    const pc = new RTCPeerConnection(CONFIG);
    const channel = pc.createDataChannel('rindr-render', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const code = await packDescription(pc.localDescription);
    return {
        code,
        async accept(answerCode) {
            await pc.setRemoteDescription(await unpackDescription(answerCode));
            return opened(pc, channel);
        },
        close: () => pc.close(),
    };
}

/** Render client side: answer to the master's code; `channel` resolves when the connection is open */
export async function answerOffer(offerCode) {
    const pc = new RTCPeerConnection(CONFIG);
    const incoming = new Promise(resolve => pc.addEventListener('datachannel', e => resolve(e.channel), { once: true }));
    await pc.setRemoteDescription(await unpackDescription(offerCode));
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const code = await packDescription(pc.localDescription);
    const channel = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 10 * 60 * 1000);   // the user brings the code across
        incoming.then(c => opened(pc, c)).then(c => { clearTimeout(timer); resolve(c); }, reject);
    });
    return { code, channel, close: () => pc.close() };
}

// --- messages over a data channel ---

/**
 * Transport over an open data channel: send(msg), onmessage(msg), onclose(), onprogress(received, total) while a
 * large message comes in, close().
 */
export function channelTransport(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    let queue = Promise.resolve();
    let incoming = null;   // { header, index, parts, got, bins, received, total }
    const transport = {
        onmessage: null, onclose: null, onprogress: null,
        send(msg) {
            queue = queue.then(() => sendMessage(msg)).catch(err => console.warn('[Distributed] send:', err?.message || err));
        },
        close: () => channel.close(),
    };

    const drain = async () => {
        while (channel.readyState === 'open' && channel.bufferedAmount > BUFFER_HIGH) {
            await new Promise(resolve => channel.addEventListener('bufferedamountlow', resolve, { once: true }));
        }
    };
    const sendBytes = async bytes => {
        for (let o = 0; o < bytes.byteLength; o += FRAME) {
            if (channel.readyState !== 'open') return;
            channel.send(bytes.subarray(o, o + FRAME));
            if (channel.bufferedAmount > BUFFER_HIGH) await drain();
        }
    };
    async function sendMessage(msg) {
        if (channel.readyState !== 'open') return;
        const bins = [];
        const json = JSON.stringify(msg, (key, value) => {
            if (ArrayBuffer.isView(value)) {
                bins.push(value);
                return { $bin: bins.length - 1, type: value.constructor.name };
            }
            if (value instanceof Blob) {
                bins.push(value);
                return { $bin: bins.length - 1, blob: true, name: value.name, type: value.type, lastModified: value.lastModified };
            }
            return value;
        });
        channel.send(JSON.stringify({ m: json, sizes: bins.map(b => (b instanceof Blob ? b.size : b.byteLength)) }));
        for (const b of bins) {
            if (b instanceof Blob) {
                for (let o = 0; o < b.size; o += READ) await sendBytes(new Uint8Array(await b.slice(o, o + READ).arrayBuffer()));
            } else {
                await sendBytes(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
            }
        }
    }

    function finishBin() {
        const m = incoming;
        m.bins.push(m.parts);
        m.parts = [];
        m.got = 0;
        m.index++;
    }
    function complete() {
        const m = incoming;
        while (m.index < m.header.sizes.length && m.header.sizes[m.index] === 0) finishBin();
        if (m.index < m.header.sizes.length) return;
        incoming = null;
        const msg = JSON.parse(m.header.m, (key, value) => {
            if (!value || typeof value !== 'object' || !('$bin' in value)) return value;
            const parts = m.bins[value.$bin] || [];
            if (value.blob) return value.name != null ? new File(parts, value.name, { type: value.type, lastModified: value.lastModified }) : new Blob(parts, { type: value.type });
            const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
            let o = 0;
            for (const p of parts) { bytes.set(new Uint8Array(p), o); o += p.byteLength; }
            const Type = TYPED[value.type] || Uint8Array;
            return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
        });
        transport.onmessage?.(msg);
    }
    channel.addEventListener('message', e => {
        if (typeof e.data === 'string') {
            let header;
            try { header = JSON.parse(e.data); } catch { return; }
            if (typeof header?.m !== 'string' || !Array.isArray(header.sizes)) return;
            incoming = { header, index: 0, parts: [], got: 0, bins: [], received: 0, total: header.sizes.reduce((a, b) => a + b, 0) };
            complete();
            return;
        }
        const m = incoming;
        if (!m) return;
        m.parts.push(e.data);
        m.got += e.data.byteLength;
        m.received += e.data.byteLength;
        if (m.total > 8 * FRAME) transport.onprogress?.(m.received, m.total);
        if (m.got >= m.header.sizes[m.index]) { finishBin(); complete(); }
    });
    channel.addEventListener('close', () => transport.onclose?.());
    return transport;
}

/**
 * Master: one transport over several links (tabs of this browser, data channels to other computers). Messages to one
 * peer go over the link it last spoke on; messages to all (or to a peer not heard yet) over every link.
 * onpeerclosed(id) when the link of a peer closes.
 */
export function hubTransport() {
    const links = new Set();
    const route = new Map();   // peer id → link
    const hub = {
        onmessage: null, onpeerclosed: null,
        add(link) {
            links.add(link);
            link.onmessage = msg => {
                if (msg?.from) route.set(msg.from, link);
                hub.onmessage?.(msg);
            };
            link.onclose = () => {
                links.delete(link);
                for (const [id, l] of route) if (l === link) { route.delete(id); hub.onpeerclosed?.(id); }
            };
            return link;
        },
        send(msg) {
            const link = msg.to && route.get(msg.to);
            if (link) link.send(msg);
            else for (const l of links) l.send(msg);
        },
        close() {
            for (const l of links) l.close();
        },
    };
    return hub;
}
