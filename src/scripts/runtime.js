// What exists once per page, shared by every player (docs/player.md): the GPU adapter and the WebGPU renderer with its
// device. No DOM and no texts here – a player shows the waiting/failure itself (onWaiting/onWaitEnd, rejected promise).
// Stage 1: the player still sets everything else on the renderer (size, tone mapping, shadows, hooks – listed in
// docs/player.md "Seitenweite Zustände").
import * as THREE from 'three/webgpu';

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
