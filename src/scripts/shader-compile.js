// renderer.compileAsync() that compiles for the renderer state at the time of the call.
//
// three.js r186 collected the objects synchronously, then built their nodes one by one between frames – reading the
// renderer's state at that later moment (render target → MRT/output branch, getMRT(), tone mapping): called inside a
// pass setup (denoiser albedo/normal MRT, lens target, material thumbnails) and restored right after, the later builds
// saw another state – wrong shaders for the context ("Color target has no corresponding fragment stage output"). This
// module recorded the state per render context and built such objects under it.
// three.js r187 does the same itself (Renderer.compileAsync: a state snapshot per queued item, reapplied whenever
// precompilation continues; pipelines compile in parallel) – what is left is the one place to call it from.

/** renderer.compileAsync(scene, camera) for the current renderer state (target, MRT) */
export function compileAsync(renderer, scene, camera) {
    return renderer.compileAsync(scene, camera);
}
