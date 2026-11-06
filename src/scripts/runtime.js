// What exists once per page, shared by every player (docs/player.md): the GPU adapter and the WebGPU renderer with its
// device. No DOM and no texts here – a player shows the waiting/failure itself (onWaiting/onWaitEnd, rejected promise).
// Stage 1: the player still sets everything else on the renderer (size, tone mapping, shadows, hooks – listed in
// docs/player.md "Seitenweite Zustände").
import * as THREE from 'three/webgpu';
import { captureSlots, restoreSlots, playerSwitched } from './player-slots.js';

// WebGPU renderer (falls back to WebGL2 without WebGPU – then without path tracing).
// Without an explicit request the device only gets the WebGPU default limits (128 MB per storage
// buffer) – for fine tessellations the path tracer's geometry buffers are larger. So request the
// limits the hardware actually supports.
const GPU_OPTIONS = { powerPreference: 'high-performance' };

// After a GPU reset (see renderer.onDeviceLost in viewer.js) Chrome restarts its GPU process: for a few seconds
// requestAdapter() yields nothing and the page fell back to WebGL ("no WebGPU", a second reload was needed). After a
// reset in this tab wait for the adapter (up to ~10 s); otherwise no waiting (browsers without a usable WebGPU adapter
// start at once).
async function acquireAdapter(gpuRecovering, onWaiting, onWaitEnd) {
    if (!navigator.gpu) return null;
    let a = await navigator.gpu.requestAdapter(GPU_OPTIONS).catch(() => null);
    for (let i = 0; !a && gpuRecovering && i < 20; i++) {
        if (i === 0) onWaiting?.();
        await new Promise(r => setTimeout(r, 500));
        a = await navigator.gpu.requestAdapter(GPU_OPTIONS).catch(() => null);
    }
    if (gpuRecovering) onWaitEnd?.();
    return a;
}

async function createRuntime({ onWaiting, onWaitEnd } = {}) {
    const gpuRecovering = (() => { try { return sessionStorage.getItem('rindr.gpuLost') === '1'; } catch { return false; } })();
    const adapter = await acquireAdapter(gpuRecovering, onWaiting, onWaitEnd);
    // WebGPU present but no adapter: usually the browser withholds the GPU after a reset (until it is restarted
    // completely), otherwise graphics card/driver are not supported – the notice says what to do instead of "unsupported"
    const webgpuBlocked = !!navigator.gpu && !adapter;
    const requiredLimits = adapter ? {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        // the raster ambient occlusion adds one texture to every lit material (ambient-occlusion.js) – heavily textured
        // imports stay below the limit
        maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
        // the path tracer's kernel with many features at once (rounded edges, traced Gaussians, volumes, buckets …) binds
        // more than the default 8 storage buffers (9 with every feature, ?kernel=all)
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
        // the canvas of a tall embedded player (or a large screen): textures up to what the card can (default 8192;
        // viewer.js keeps the drawing buffer inside it – bufferRatio)
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
    } : undefined;
    // stencil: closed cut surfaces of the section plane (slicer.js)
    const renderer = new THREE.WebGPURenderer({ antialias: true, stencil: true, ...GPU_OPTIONS, requiredLimits });
    // throws without WebGPU and WebGL2 (e.g. no GPU and no software renderer in the browser) – the player says so
    await renderer.init();
    return { adapter, renderer, webgpuBlocked, gpuRecovering };
}

let runtime = null;

/**
 * The page's runtime, created on the first call (later calls get the same one; their callbacks are not used).
 * @param {{ onWaiting?: () => void, onWaitEnd?: () => void }} [hooks]  waiting for the GPU after a reset: start / end
 * @returns {Promise<{ adapter: GPUAdapter|null, renderer: THREE.WebGPURenderer, webgpuBlocked: boolean, gpuRecovering: boolean }>}
 */
export function getRuntime(hooks) {
    return (runtime ??= createRuntime(hooks));
}

// --- Players on the page (docs/player.md, stage 3) ---
// One animation loop for the shared renderer; each player draws into its own canvas (a CanvasTarget – the first player
// takes the renderer's own, so a single player – the app – draws exactly as before). usePlayer(p) makes p the current
// player: its canvas, its renderer state (p.enter: tone mapping, exposure …).
const players = [];
let current = null;
let defaultTargetClaimed = false;
let loopRenderer = null;

/** The renderer's own canvas target for the first player on the page, null for every later one (an own CanvasTarget) */
export function claimCanvasTarget(renderer) {
    if (defaultTargetClaimed) return null;
    defaultTargetClaimed = true;
    return renderer.getCanvasTarget();
}

/** Make p the renderer's current player (nothing to do when it already is) */
export function usePlayer(p) {
    if (current === p) return;
    const renderer = p.renderer, prev = current;
    if (renderer.getCanvasTarget() !== p.ct) renderer.setCanvasTarget(p.ct);
    if (prev) {
        // nothing of the previous one carries over: its render target, its values in the shared uniforms (player-slots.js)
        renderer.setRenderTarget(null);
        renderer.setMRT?.(null);
        prev.slots = captureSlots();
    }
    current = p;
    if (prev || p.slots) restoreSlots(p.slots ?? null);
    if (prev) playerSwitched();
    p.enter?.();
}
export const currentPlayer = () => current;
export const playerCount = () => players.length;

/** A player joins the loop (p.frame(time) draws one picture into its canvas) */
export function addPlayer(p) {
    players.push(p);
    if (loopRenderer) return;
    loopRenderer = p.renderer;
    loopRenderer.setAnimationLoop(tick);
}

export function removePlayer(p) {
    const i = players.indexOf(p);
    if (i >= 0) players.splice(i, 1);
    if (current === p) current = null;
}

function tick(time) {
    // a single player (the app): exactly the earlier loop – errors stay uncaught (console, test harness)
    if (players.length === 1) {
        const p = players[0];
        usePlayer(p);
        p.frame(time);
        return;
    }
    for (const p of players) {
        if (p.awake && !p.awake()) continue;
        usePlayer(p);
        try { p.frame(time); } catch (err) { reportError(err); }   // one player's error does not stop the others
    }
}

// GPU errors and a lost device concern the renderer, not one player: the handlers are installed once and every player
// gets the message (each decides whether it is meant – e.g. its path tracer's buffers)
const errorHandlers = new Set();
const lostHandlers = new Set();
let hooked = null;
function hookRenderer(renderer) {
    if (hooked === renderer) return;
    hooked = renderer;
    renderer.onError = info => { for (const fn of errorHandlers) fn(info); };
    const threeDeviceLost = renderer.onDeviceLost.bind(renderer);   // marks the renderer as lost (stops rendering)
    renderer.onDeviceLost = info => {
        threeDeviceLost(info);
        for (const fn of lostHandlers) fn(info);
    };
}

/** fn(info) for every GPU error of the renderer (returns the remover) */
export function onRendererError(renderer, fn) {
    hookRenderer(renderer);
    errorHandlers.add(fn);
    return () => errorHandlers.delete(fn);
}

/** fn(info) when the renderer's device is lost (after three marked the renderer as lost; returns the remover) */
export function onDeviceLost(renderer, fn) {
    hookRenderer(renderer);
    lostHandlers.add(fn);
    return () => lostHandlers.delete(fn);
}

// One import at a time for the page (docs/player.md, stage 3): the STEP workers and their session are the page's, and
// two large models loading at once would share one memory budget. A player waits for its turn; aborting a load ends the
// workers only while that player's import is the running one (importRunning).
let importChain = Promise.resolve();
let importer = null;

/** Wait for the page's import turn of `owner` – resolves with release() (call it when the import is done) */
export function importTurn(owner) {
    let release;
    const done = new Promise(resolve => { release = resolve; });
    const turn = importChain.then(() => { importer = owner; });
    importChain = turn.then(() => done);
    return turn.then(() => () => { if (importer === owner) importer = null; release(); });
}

/** `owner`'s import is the one running now */
export const importRunning = owner => importer === owner;
