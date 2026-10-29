// Materials between RINDR tabs and windows (docs/ui.md, "Materialien zwischen Tabs"): a dragged scene material carries
// its full description – parameters and node graph, the pictures of image nodes are in it as data URLs – and the tab it
// comes from; dropped in another tab it is created from that description. Textures of imported models (render.maps:
// the model's own pictures, only their names travel with the drag – drag data must be set at once) are fetched from
// the source tab over a BroadcastChannel – PNG blobs plus their texture settings – and linked in like textures dropped
// later (materialManager.linkImportMaps). Same origin only (BroadcastChannel, custom drag data). Library materials
// travel as their libraryId plus the preset (the other tab may not have loaded its category yet).
import * as THREE from 'three/webgpu';
import { debugLog } from './log.js';
import { MATERIAL_PRESETS } from './material-presets.js';

/** this tab (drag data names its source) */
export const TAB_ID = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('rindr-material-transfer') : null;
const received = new Map();   // `${tab}/${id}` → local material id: a second drop of the same material reuses it
const pending = new Map();    // request id → local material id (textures on their way)
const REQUEST_TIMEOUT = 20000;
// render values of an imported material besides its textures (material-manager.js applyRender)
const RENDER_KEYS = ['side', 'alphaTest', 'transparent', 'normalScale', 'bumpScale', 'aoMapIntensity'];
// texture settings that travel with a picture
const TEXTURE_KEYS = ['colorSpace', 'flipY', 'wrapS', 'wrapT', 'channel', 'rotation', 'anisotropy', 'name'];
let manager = null;

/** answer requests of other tabs and take their textures (once, with the scene's material manager) */
export function initMaterialTransfer(materialManager) {
    manager = materialManager;
    if (channel) channel.onmessage = e => onMessage(e.data).catch(err => console.warn('[materials] transfer:', err?.message || err));
}

/** drag data of a scene material: { id, tab, def } – def without textures (render.maps: key → name) */
export function materialDragData(id) {
    const entry = manager?.get(id);
    if (!entry) return { id };
    const def = manager.toJSON([id]).materials[0];
    const r = entry.def.render;
    if (r) {
        def.render = Object.fromEntries(RENDER_KEYS.filter(k => r[k] !== undefined).map(k => [k, r[k]]));
        def.render.maps = Object.fromEntries(Object.entries(r.maps || {}).map(([k, tex]) => [k, tex?.name || k]));
        def.render.missing = structuredClone(r.missing || {});
    }
    return { id, tab: TAB_ID, def };
}

/**
 * drag data of a library preset: { libraryId, preset } – the preset's parameters and graph along: the other tab may not
 * have loaded that category yet (presets load when the library is first shown – material-presets.js)
 */
export function libraryDragData(libraryId) {
    const p = MATERIAL_PRESETS.find(x => x.libraryId === libraryId);
    return p ? { libraryId, preset: { params: p.params, graph: p.graph } } : { libraryId };
}

/** a material dropped from another tab: created from its description (null: from this tab or no description) */
export function materialFromTransfer(data) {
    if (!manager || !data?.def || !data.tab || data.tab === TAB_ID) return null;
    const key = `${data.tab}/${data.id}`;
    const known = manager.get(received.get(key));
    if (known) return known;
    const { render, id: _id, ...rest } = data.def;
    const def = { ...rest, source: rest.source === 'step' || (rest.source === 'import' && !render) ? 'custom' : rest.source || 'custom' };
    const names = render?.maps || {};
    if (render) {
        // the model's textures follow: missing until they arrive (the material panel names them meanwhile)
        const missing = { ...(render.missing || {}) };
        for (const [k, name] of Object.entries(names)) missing[k] = { url: name };
        def.render = { ...render, maps: {}, missing };
    }
    const entry = manager.create(def);   // an undo step like any new material
    received.set(key, entry.def.id);
    if (Object.keys(names).length) requestTextures(data.tab, data.id, entry.def.id);
    return entry;
}

function requestTextures(tab, id, localId) {
    if (!channel) return;
    const req = `${TAB_ID}/${Date.now()}/${Math.random().toString(36).slice(2)}`;
    pending.set(req, localId);
    channel.postMessage({ type: 'textures?', to: tab, from: TAB_ID, id, req });
    setTimeout(() => {
        if (pending.delete(req)) debugLog('[materials] no textures from the source tab (closed?) for', localId);
    }, REQUEST_TIMEOUT);
}

async function onMessage(m) {
    if (!m || m.to !== TAB_ID) return;
    if (m.type === 'textures?') {
        const maps = manager?.get(m.id)?.def.render?.maps || {};
        const out = {};
        for (const [key, tex] of Object.entries(maps)) {
            const blob = await textureBlob(tex);
            if (blob) out[key] = { blob, settings: textureSettings(tex) };
        }
        channel.postMessage({ type: 'textures', to: m.from, req: m.req, maps: out });
        return;
    }
    if (m.type === 'textures') {
        const localId = pending.get(m.req);
        if (!localId || !manager.get(localId)) return;
        pending.delete(m.req);
        const maps = {};
        for (const [key, { blob, settings }] of Object.entries(m.maps || {})) {
            const tex = await textureFrom(blob, settings).catch(() => null);
            if (tex) maps[key] = tex;
        }
        if (Object.keys(maps).length) manager.linkImportMaps(localId, maps);
        debugLog('[materials] textures from another tab:', Object.keys(maps).join(', ') || 'none');
    }
}

// a texture's picture as PNG (as loaded – its settings, flipY included, travel along); null: not readable here
// (compressed textures, placeholders)
async function textureBlob(tex) {
    const img = tex?.image;
    if (!img || tex.isCompressedTexture || typeof OffscreenCanvas === 'undefined') return null;
    const w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
    if (!(w > 1 && h > 1)) return null;
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
    if (img.data) {
        if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length < w * h * 4) return null;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, w * h * 4), w, h), 0, 0);
    } else {
        try { ctx.drawImage(img, 0, 0); } catch { return null; }
    }
    try { return await canvas.convertToBlob({ type: 'image/png' }); } catch { return null; }
}

function textureSettings(tex) {
    const s = Object.fromEntries(TEXTURE_KEYS.map(k => [k, tex[k]]));
    s.repeat = tex.repeat.toArray();
    s.offset = tex.offset.toArray();
    s.center = tex.center.toArray();
    s.isDataTexture = !!tex.image?.data;
    s.userData = { flippedImage: tex.userData?.flippedImage };
    return s;
}

async function textureFrom(blob, s) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const tex = new THREE.Texture(img);
        for (const k of TEXTURE_KEYS) if (s[k] !== undefined) tex[k] = s[k];
        // a data texture's first row is its v 0 – drawn as a picture it must not be flipped again
        if (s.isDataTexture) tex.flipY = false;
        tex.repeat.fromArray(s.repeat);
        tex.offset.fromArray(s.offset);
        tex.center.fromArray(s.center);
        if (s.userData?.flippedImage) tex.userData.flippedImage = true;
        tex.needsUpdate = true;
        return tex;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
