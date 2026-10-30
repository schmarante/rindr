// Central default settings of the viewer – adjust here.
// The values apply at startup; in the UI (Settings → Path tracing) they can be changed afterwards
// as usual, a saved scene state overrides them as well.

export const PATHTRACING = {
    enabled: false,             // path tracing on at startup (= HQ view instead of Default; WebGPU only)
    bounces: 8,                 // light paths: number of reflections (diffuse, glossy) per path (GUI: 1–20)
    refractionBounces: 4,       // scatters at glass on top of that – glass does not use up the bounces (GUI: 0–20)
    maxSamples: 128,            // samples per pixel, then stop + denoise (GUI: 1–256) – with adaptive sampling the limit
    // adaptive sampling (adaptive-sampling.js, megakernel only): pixels stop once their noise is below `threshold`
    // (standard error / √mean of the tone-compressed luminance, per 8 × 8 block incl. neighbours) – maxSamples is the
    // upper limit then; at least `minSamples` everywhere (at most half the maximum)
    adaptive: { enabled: true, threshold: 0.08, minSamples: 16 },
    renderScale: 1,           // resolution relative to the window (0.25–1); < 1 is upscaled via FSR
    hidpi: false,               // HiDPI screens: false = traced at the CSS pixel size (1/devicePixelRatio of the canvas) and
                                // upscaled, true = every device pixel (GUI "Full HiDPI resolution")
    filterGlossyFactor: 1,      // glossy filter 0–1: dampens glossy noise (fireflies), slightly softer
    denoise: true,              // OIDN denoising after maxSamples
    denoiseGuideSamples: 8,     // rays per pixel of OIDN's albedo/normal guides (antialiasing, depth of field; pt-guides.js)
    helperPassSamples: 64,      // rays per pixel of the helper passes of EXR/PSD (alpha, depth, ids – their antialiasing)
    // shadows of glass (glass-shadow.js): 'transparent' = light passes (Fresnel, colour, absorption), 'opaque' = black
    glassShadow: {
        mode: 'transparent',
        fringe: 0.3,            // colour fringe 0–1: spectrum spread (IOR ±15 % red ↔ blue at 1, pathtracer.js; 0 = off)
        range: 0.5,             // the fringe fades over this share of the scene size (behind the glass)
    },
    // first glass hit of the camera ray: reflection and refraction both traced (glass-split.js) – clean glass and
    // reflections on it after few samples, one more path where glass is seen; false = picked by chance (library,
    // cheaper per sample – the default, user Oct. 2026)
    glassSplit: false,
    upscale: true,              // FSR upscaling (only useful with renderScale < 1)
    sharpness: 1,               // FSR sharpness 0–2

    // While orbiting/zooming (HQ): keep path tracing, but heavily reduced – instead of the raster preview
    motion: {
        enabled: true,          // false = raster preview while orbiting
        renderScale: 0.35,      // resolution relative to the window (FSR upscales)
        bounces: 3,             // light paths while orbiting
        samples: 1,             // samples per pixel and frame (more = calmer, but slower)
        holdMs: 250,            // stays reduced this long after release (mouse wheel: no switching per notch)
        stillMs: 150,           // camera still this long while the mouse stays pressed: full quality already (0 = only
                                // after the release)
        // image filter while orbiting and while the image refines (until the final image), instead of showing the
        // noise: 'kuwahara' paints over it (kuwahara.js, look: PATHTRACING.kuwahara), 'denoise' smooths it edge-aware
        // (motion-denoise.js, PATHTRACING.denoiseMotion), 'off'
        filter: 'kuwahara',
        temporal: false,        // 'denoise': also blend in the previous frames (reprojected) while orbiting
        // 'denoise': upscale with history instead of FSR – each frame traced with another offset within the pixel and
        // accumulated at screen size (motion-upscale.js, PATHTRACING.motionUpscale); after the release it fades over
        // the refining image
        taau: true,
    },

    // Kuwahara look (painterly while orbiting and while the image refines) – values chosen by the user
    kuwahara: {
        radius: 4,              // brush size in pixels of the reduced image while orbiting; afterwards the same size
                                // on screen, shrinking with the samples (∝ 1/√samples, 0 at maxSamples)
        eccentricity: 2.5,      // 0 = round strokes, larger = stretched along edges
        sharpness: 0,           // 0 = all sectors equal (soft strokes); > 0 calm areas win over noisy ones
        maxRadius: 8,           // limit in pixels of the full-resolution image (cost ∝ radius²)
    },

    // soft transition between the successive images (orbit preview → first full sample → refinement stages →
    // denoised result, image-fade.js): time constant in ms (~95 % after 3×), 0 = jump as before
    fadeMs: 80,

    // Edge-aware denoiser (motion-denoise.js: à-trous wavelet + optional temporal accumulation)
    denoiseMotion: {
        iterations: 5,          // à-trous passes while orbiting (gaps 1, 2, 4, 8, 16 px); while refining fewer with
                                // the samples (iterations − log2(samples), at least 2 until the final image)
        sigmaNormal: 64,        // normal weight: cos(angle)^sigmaNormal
        sigmaPlane: 0.1,        // plane weight: how far a neighbour may leave the tangent plane (sin of the angle)
        sigmaLuminance: 4,      // luminance weight: allowed difference in units of the local noise (√variance)
        maxHistory: 8,          // temporal: at most this many frames blended (newest with ≥ 1/maxHistory)
        clampGamma: 1.5,        // temporal: history clamped to mean ± clampGamma·σ of the current neighbourhood
        firefly: 8,             // luminance limit per sample (linear) – single bright samples would become blobs
    },

    // Upscaling with history while orbiting (motion-upscale.js, motion.taau)
    motionUpscale: {
        frames: 16,             // history limit in frames (more = calmer and sharper, but slower to follow changes)
        clampGamma: 1.25,       // history clamped to mean ± clampGamma·σ of the current samples around the pixel
        seedSamples: 16,        // after the release the history counts like this many samples of the refining image
                                // (share (n / (n + samples))²: a quarter after n samples, gone after ~8 n)
    },

    // Technical (benchmark with ?bench in the URL)
    megakernel: true,           // megakernel instead of wavefront – ~4× faster on the tested GPU
    frameBudget: 1_000_000,     // upper limit of paths per pass (library: 250 000) – the actual budget follows the
                                // GPU time per frame (pathtracer.js _adapt): starts at startFrameBudget, aims at
                                // frameTargetMs. Fixed 1 M fitted one GPU at Full HD; at 4K / on slower GPUs single
                                // dispatches came close to the GPU watchdog (Windows TDR ~2 s → device lost)
    startFrameBudget: 65_536,   // the very first dispatch runs before any measurement – small, it grows within frames
    minFrameBudget: 32_768,
    frameTargetMs: 50,          // GPU time per frame the path tracer aims at (refining and orbiting)
    maxDispatchesPerFrame: 16,  // cheap dispatches (adaptive sampling, small images): up to this many per frame within frameTargetMs
    firstSampleMs: 250,         // after a restart the first sample is computed in one frame up to about this long
    countInterval: 200,         // ms between two sample counts for the status display (GPU readback)
    asyncCompileMinChars: 32_000,   // compute shaders from this WGSL size are compiled asynchronously (megakernel
                                    // ~110 KB: synchronous ~4 s without shader cache, the page froze meanwhile)
};

// Materials: editing (parameters, node editor, rename, new, copy) – false hides it:
// then only the list (scene/library), drag & drop, assign, select objects, delete and import/export remain.
// Existing node graphs (e.g. from imported materials or scenes) are still applied.
export const MATERIALS = {
    editing: true,
    importExport: false,   // JSON import/export buttons in the material panel (comes back later)
};

// Scene files: "save scene" / "open scene" buttons in the toolbar (hidden for a while – still buggy then –, back since
// the sample scene was built with them, user Oct. 2026). Dropping a scene file opens it either way.
export const SCENE = {
    saveOpen: true,
};

// Opening large models (STEP): protection against running out of memory. Before tessellating, the
// triangle count is estimated from a sample of the faces (unique triangles – instances share geometry).
export const IMPORT = {
    triangleBudget: 10_000_000,   // opening: estimate above this → quality automatically coarser (down to "coarse")
    triangleLimit: 30_000_000,    // hard limit: not started beyond it (estimate) or aborted while tessellating –
                                  // opening then retries one level coarser, a quality change keeps the old model
    instancing: true,             // identical solids that the file does not declare as reused share one geometry
                                  // (shape comparison after tessellating, shape-match.js) – saves RAM/GPU memory
    // binary FBX is read by an own lean reader (fbx/fbx-parse.js, typed arrays). Animated / skinned FBX up to this
    // size still go to three.js' FBXLoader (animation, skinning, blend shapes) – it needs roughly 6–8× the file size
    // in JS heap, and all JS heaps of a tab share one 4 GB area in Chrome (independent of the computer's RAM)
    fbxLoaderMaxBytes: 256 * 2 ** 20,
};

// Soft transition of the whole picture on changes (screen-fade.js): HDRI, lens effects, depth of field, materials,
// visibility, view mode … – the last frame fades out over the new ones (all view modes; not while dragging)
export const TRANSITION = {
    ms: 300,               // duration (smoothstep), 0 = jump as before
};

// Skeleton (skeleton-view.js, pose list): applying a pose blends the bones from the current posture into it (smoothstep,
// live on the GPU, baked at the end); 0 = jump
export const SKELETON = {
    poseBlendMs: 450,
};

// Raster view (Basic/Default): meshes with the same geometry + material are drawn as one InstancedMesh
// (render-batcher.js) – large assemblies need hundreds instead of thousands of draw calls. Test: ?batching=0
export const RASTER = {
    batching: true,
    // ambient occlusion of the raster view (ambient-occlusion.js): darkens only the indirect light in creases and
    // between parts. Radius = share of the scene size, at most `viewRadius` × distance to the orbit centre (zoomed
    // into a detail the radius follows); strength; samples per pixel; bias (cos of the ignored angle above the
    // tangent plane – tessellation); resolution share of the picture, at most `maxPixels`; zoomed out finer (up to full
    // resolution) until the radius spans `minTexels`, all AO targets within `memoryShare` of the memory budget;
    // projected radius at most `maxScreen` × picture height. The pre-pass draws the model a second time: only after a change (view, scene), then
    // at most every `costRatio` × its own CPU time (large assemblies: in between the last result is reprojected).
    // Test: ?ao=0 (not even hooked into the materials)
    ao: { enabled: true, radius: 0.08, viewRadius: 0.15, strength: 1.5, samples: 12, bias: 0.1, resolution: 0.5, maxPixels: 1_200_000, minTexels: 12, memoryShare: 0.02, maxScreen: 0.15, costRatio: 10 },
};

// Cluster LOD (lod/lod-store.js, render-batcher.js): distant instances drawn with fewer triangles in Basic/Default
// (HQ always draws the full model). Built in the background after loading. Test: ?lod=0 (off), ?lod=<px> (threshold)
export const LOD = {
    enabled: true,
    threshold: 2,              // allowed error on screen (px) – 1 looks identical, 2 still does (user, Oct. 2026)
    minTriangles: 1_000_000,   // only models drawing at least this many triangles (counted per instance)
    minPartTriangles: 512,     // smaller geometries have nothing to gain
    memoryShare: 0.25,         // share of the memory budget (memory-budget.js) the LOD data may take
    maxWorkers: 6,             // background build: at most this many workers (and half the cores)
    outsideFactor: 4,          // instances outside the view (only their shadows can be seen): coarser
};

// Gaussian splats (.ply / .sog, splat/): memory protection for the spherical harmonics (view-dependent
// colour). Degree 3 costs 48 bytes per splat on the GPU – large scenes are reduced to a lower degree so that
// the SH data stays within the budget (13 M splats: degree 2). Positions/shape/colour: 32 bytes per splat.
export const SPLATS = {
    shDegree: 3,          // highest SH degree that is kept (0 = no view-dependent colour)
    shBudgetMB: 512,      // GPU memory for the SH data
    unitScale: 1000,      // file units → mm (3DGS scenes are roughly in metres)
    // shadow of added PBR models on the splats (splat-shadow.js): 1 = black where the main light is blocked; less, as
    // the scan's own light already contains the ambient part
    shadowStrength: 0.55,
    // shadow of the splats on models and on relit splats (splat-opacity.js): opacity map size (8 depth slices)
    opacitySize: 1024,
    // ambient occlusion between scan and models (splat-composite.js): radius as a share of the models' size, strength
    ao: { radius: 0.1, strength: 1 },
    // scan as the models' environment (reflections, image-based light; splat-environment.js): cube face size, on/off
    environment: { enabled: true, size: 256 },
    // after loading the camera slowly circles the scene until the user takes over: seconds per turn
    // (object: around it, room: panning on the spot); 0 = off
    autoRotate: { object: 40, indoor: 60 },
    // reveal while loading: shape ('sphere' centre → out, 'plane' bottom → up, 'screen' circle on screen), edge band
    // (share of the robust radius), pulse in the band: glow (brightening), start size (× own size, at least
    // `minStartSize` × robust radius per axis – fine scans have tiny splats, 2× tiny stayed tiny), glow colour
    // (null = own colour)
    reveal: { mode: 'sphere', band: 0.25, glow: 0.5, startSize: 1.5, minStartSize: 0.0, glowColor: '#ffffff' },
};

// "About" in the settings menu (version comes from package.json)
export const ABOUT = {
    author: 'Marco Schrenk',                          // author name
    email: 'mail@marco-schrenk.de',
};

// AI rendering (ki-gemini.js): the browser calls Gemini directly with the user's own key (settings → AI).
// Google renames models often – see https://ai.google.dev/gemini-api/docs/image-generation;
// the model can also be changed in the settings (per browser).
export const KI = {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    model: 'gemini-nano-banana-2.1',
    size: '2K',                       // default output resolution
    sizes: ['1K', '2K', '4K'],
    keyUrl: 'https://aistudio.google.com/apikey',   // where to get a key (link in the settings)
};
