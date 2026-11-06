<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rindr-white.svg">
    <img width="38" align="top" src="public/rindr.svg" alt="">
  </picture>
  <b>RINDR</b>
</h1>

Your local 3D file viewer – with real-time path tracing, right in the browser.

**STEP · IGES · glTF/GLB · FBX · MAX · C4D · Blender · OBJ · 3MF · USD · STL · PLY · pbrt · IFC · BCF · Gaussian splats (PLY/SOG) · MaterialX · HDRI (HDR/EXR)**

<a href="https://schmarante.github.io/rindr/"><img src="https://img.shields.io/badge/%E2%96%B6%20Live%20demo-schmarante.github.io%2Frindr-2ea44f?style=for-the-badge" alt="Live demo"></a>

Drop a CAD model, a mesh, a BIM file or a Gaussian splat into the window and get a studio-quality render in seconds. Everything runs locally on your GPU – **no upload, no server, no install.**

## Highlights

- **Path tracing in real time (WebGPU)** – fast preview while you orbit, physically based rendering with AI denoising as soon as the camera stands still.
- **Opens almost anything**
  - **STEP** via a custom CAD kernel: assemblies, colours, instancing, adjustable tessellation quality – **IGES** goes the same way (converted on load)
  - **glTF/GLB, FBX, PLY**, **OBJ** (own reader for files of hundreds of MB, MTL materials)
  - **STL** split into its parts on all CPU cores: identical parts instanced, facet colours as materials
  - **MAX (.max)** via an own reader: Editable Mesh/Poly, primitives, text and splines, common modifiers (Extrude, Shell, Bend, FFD, TurboSmooth …), instances, Physical Materials
  - **C4D (.c4d)** via an own reader: polygon objects with UVs and phong smoothing, joints and weights (skinning), keyframe animation, materials with colour and normal maps
  - **Blender (.blend)** via an own reader on the file's self-description: meshes, Principled BSDF materials with packed textures, cameras (modifiers not evaluated)
  - **3MF** via an own reader: assemblies and instances, multi-part slicer projects, colours and textures
  - **USD** (.usd/.usda/.usdc/.usdz): multi-file scenes with references, payloads and sublayers, shared geometry for referenced assets
  - **pbrt-v4 scenes** (.pbrt) via an own reader: shapes, object instances, materials and textures (measured materials approximated), area lights as real rectangle/disc lights in absolute units, the scene's environment map and camera with its exposure
  - **IFC** (BIM) incl. properties, **BCF** issues
  - **MaterialX (.mtlx)** with OpenPBR: materials in and out – a material as a package with textures, glTF sphere and preview
  - **Gaussian splats** (PLY, SOG)
- **Node-based materials** (three.js TSL) and a material library – drag & drop onto parts in the viewport or the scene graph; UV mapping per object (box, planar, cylinder, sphere).
- **Special materials** – toon and contour styles, subsurface scattering (jelly, wax), glowing marble, a **cloud** as real volume, **wool** with fibres, **grass** with real blades, **soap bubbles** with thin-film colours; scattering media for cloudy liquids – juice, milk, honey, beer and more in the library.
- **Studio tools** – scene graph with hover outlines, move/rotate/scale gizmo, MAX-style quad menu, view cube, animated **exploded view**, section plane, animations with skeleton view.
- **Lighting** – HDRI environments (drop your own .hdr/.exr into the window) with a flattened ground dome, shadow catcher and contact shadows, ground reflections and rain puddles; an **HDRI editor** for your own procedural environments with sun & sky and movable light pins.
- **Camera like a real lens** – depth of field with bokeh blades, fisheye up to 240°, bloom, glare, lens flare and **volumetric god rays**; style filters from pixel art and scanlines to sketch and ASCII.
- **Distributed rendering** – other computers in your local network render along (paired via link and code, peer-to-peer), buckets labelled per computer.
- **Output** – image export (incl. transparent PNG), **light passes** per light source and light type plus helper passes (alpha, depth, normals, albedo, IDs) as layered **EXR** or **PSD**, save/load whole scenes, and **AI rendering**: send the frame plus your material names to an image model for a photoreal take.
- **Embeddable** – as `<rindr-player>` in your own pages: attributes, methods and events, several players per page ([Embedding](#embedding-the-rindr-player)).
- English and German UI.

**Browser:** needs WebGPU – current Chrome or Edge recommended. Large models load in parallel with shared memory (cross-origin isolation): via COOP/COEP headers on your own server (`public/.htaccess`), on static hosting like GitHub Pages a small service worker takes care of it.

## Embedding the RINDR player

RINDR also runs as an HTML element, `<rindr-player>`, inside your own pages – a product page, a PIM, a configurator. One
script per page, as many players as you like:

```html
<script type="module" src="https://<host>/player/0.1.0/rindr-player.js"></script>

<rindr-player src="/media/4711.glb" style="height:480px"></rindr-player>
```

- The script is small (≈ 80 KB); the viewer itself (≈ 4 MB) loads when the first player starts.
- The version is part of the path – a new version never changes what a page already embeds.
- Without a height from the page, a player is 480 px high and as wide as a block element.
- Needs WebGPU (current Chrome or Edge) for everything including path tracing. Without WebGPU only the first player of a
  page shows a picture (raster, no path tracing), the others show a notice.
- The interface language follows the visitor's browser (English or German).

### Attributes

| Attribute | |
|---|---|
| `src` | model URL (any format RINDR opens) |
| `scene` | RINDR scene (JSON from "Save scene" or `getScene()`); its models lie next to it or come from `resolveAsset` |
| `hdr` | HDRI URL (.hdr/.exr) – wins over the scene's HDRI |
| `mode` | `default` (raster) or `hq` (path tracing as soon as the camera stands still); also `basic`, `uv`, `wire` |
| `features` | interface parts, separated by spaces or commas: `scene-graph`, `properties`, `materials`, `material-editor`, `explode`, `transform`, `section`, `views`, `view-cube`, `view-modes`, `open`, `save`, `render`, `ki`, `animation`, `setup`, `fullscreen` – `all` = everything. Without `features`: the 3D view only (orbit, zoom, key 3 for path tracing) |
| `activate` | `auto` (at once, default), `visible` (when the player comes near the visible part of the page), `click` (a start button) |
| `poster` | picture shown until the player shows its model |
| `frame` | run the player in an iframe (see below) |

`src`, `scene`, `hdr` and `mode` may change after the start (the player loads or switches), the others count from the
start. All names are plain HTML attributes (valid, no `data-` prefix).

### Methods

Every method returns a promise. A player still waiting for its activation (`activate="click"` / `"visible"`) starts on the
first call; methods that look at parts wait until the model is loaded.

| Method | |
|---|---|
| `load(url)` / `load({ src, scene, hdr, files, package })` | load a model or a scene; `scene` as URL or as data (`getScene()`), `files` = `{ fileName: URL or Blob }` for the files the scene names, `package` = zip from `getPackage()`. Resolves to `{ models, missing, parts }` |
| `getParts(pattern?)` | parts: `[{ path, name, model, visible, materials }]` |
| `setMaterial(parts, material)` | assign a material (one undo step); `material` = id of a scene material, library id (e.g. `'metal-chrome'`), name, or `{ library }`, `{ id }`, `{ name }`, `{ name, params }` (new material) – resolves to the material id |
| `getMaterials()` / `getLibrary()` | materials of the scene / of the library |
| `setVisible(parts, visible)` | show or hide |
| `select(parts \| null)` | select, as a click does |
| `frame(parts?)` | fly the camera to the parts (or everything) |
| `getViews()` / `setView(name \| { position, target, fov })` | saved views / set the camera |
| `setMode(mode)` / `getMode()` | view mode |
| `render({ width, scale, transparent, samples, hq, type, quality })` | an image as Blob: path traced (default) or the raster view (`hq: false`); `type` `image/png` (default) or `image/jpeg` |
| `getScene()` | the scene as data (the same JSON as "Save scene") |
| `getPackage()` | the scene with its model files (and HDRI) as a zip |
| `save()` | what the save button does (fires `rindr-save`) |
| `start()` | start a waiting player |

**Parts by name.** A path is the chain of node names from the file, joined with `/`:

- `'Housing/Lid'` – the node Lid below Housing
- `'Wheel'` – every node of that name on this level; `'Wheel[2]'` only the second one (in file order)
- `'Housing/*'` – every child; `*` inside a name matches any characters (`'Screw*'`)
- `'**/Screw*'` – at any depth
- Names containing `/ [ ] * \` get a backslash in front of that character. Several patterns as a list: `['Lid', 'Base']`.

Saved scenes remember these names: when a configurator exports a variant of the model (nodes added or reordered),
materials, hidden parts and transforms still find their parts.

Errors carry a `code`: `no-part`, `no-material`, `no-view`, `bad-argument`, `load-failed`, `render-failed`.

### Events

On the element; they bubble and cross the shadow DOM:

| Event | `detail` |
|---|---|
| `rindr-ready` | – (the player runs) |
| `rindr-progress` | `{ active, text, fraction }` |
| `rindr-load` | `{ models, missing, parts }` – a model or scene is complete |
| `rindr-select` | `{ kind, name, path }` (`kind`: `part`, `surface`, `parts` with `paths`, `light`, `view` …) or `null` |
| `rindr-change` | `{ action, label }` – a change that can be undone (`record`), or undo/redo |
| `rindr-mode` | `{ mode }` |
| `rindr-error` | `{ message, name, title }` (`start: true`: the player could not start) |
| `rindr-save` | `{ scene, json, name, package() }` – **cancelable** |

**Saving into your own system:** call `preventDefault()` in `rindr-save` and the page keeps the scene (no file dialog).
Not cancelled, the player saves a file as usual. `element.resolveAsset = (name, kind) => URL | Blob | null` (`kind`:
`model`, `hdri`) tells the player where a file lies that a scene names.

```js
const p = document.querySelector('rindr-player');
p.addEventListener('rindr-save', async e => {
  e.preventDefault();
  await fetch('/pim/scene/4711', { method: 'PUT', body: e.detail.json });
});
// open it again later – the PIM knows the model files:
p.resolveAsset = (name, kind) => kind === 'model' ? `/pim/files/${encodeURIComponent(name)}` : null;
await p.load({ scene: await (await fetch('/pim/scene/4711')).json() });
```

**Example – a configurator:**

```html
<rindr-player id="p" src="/media/4711.glb" features="materials save"></rindr-player>
<select id="colour"><option value="metal-chrome">Chrome</option><option value="paint-car-red">Red</option></select>
<script type="module">
  const p = document.getElementById('p');
  colour.onchange = () => p.setMaterial('Housing/Lid', colour.value);
  p.addEventListener('rindr-select', e => e.detail?.path && showInfo(e.detail.path));
  imageButton.onclick = async () => upload(await p.render({ width: 2000, transparent: true }));
</script>
```

### Colours

On the element (or an ancestor) – or for every player of the page with `RINDR.configure`:

```css
rindr-player {
  --rindr-accent: #e30613;      /* accent (buttons, selection, sliders) – lighter and darker shades are mixed from it */
  --rindr-panel: #001a33;       /* base tone of panels and windows (shown at their opacity) */
  --rindr-background: #202020;  /* behind the 3D view */
  --rindr-font: system-ui, sans-serif;
}
```

```js
RINDR.configure({ theme: { accent: '#e30613' } });   // null removes a value; a rule of the page on the element wins
```

The RINDR logo always stays visible. `RINDR.configure({ base })` – where the player's files lie (default: the script's
folder); `RINDR.version` – the exact version.

### Hosting

- **From a RINDR deployment:** `npm run build` writes the player to `dist/player/<version>/`; a deployment serves it at
  `<site>/player/<version>/rindr-player.js`. Pages on other origins need CORS (`Access-Control-Allow-Origin: *`) and
  `Cross-Origin-Resource-Policy: cross-origin` – GitHub Pages sends CORS by itself, an own Apache server gets both from
  `public/.htaccess`. Loading the player from another server transfers the visitors' IP address to it (worth a line in the
  embedding site's privacy policy; hosting it yourself avoids that).
- **Self-hosted:** copy the folder `dist/player/<version>/` as it is to your server and load the script from there – all
  paths inside are relative, any folder works. Keep the folders of versions your pages use.
- **Models** are fetched from the URL you give: on another server than the page, that server must allow CORS.

**Content Security Policy** of the page, if it has one: `script-src` for the player's origin and `'wasm-unsafe-eval'`
(WebAssembly), `worker-src blob:` (workers of another origin start through a blob), `connect-src` for the player's and
the models' origins, `img-src blob: data:`.

**Isolated pages** (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`): large STEP
files load faster (shared memory, all CPU cores). Without isolation everything works too, large files just take longer.

### iframe

If a page does not let the player in (strict CSP, framework), it runs in an iframe with the same interface:

```html
<rindr-player frame src="/media/4711.glb" features="materials"></rindr-player>
```

Methods, events, `resolveAsset` and the `--rindr-*` colours travel through `postMessage`. Each frame needs its own GPU
memory and compiles path tracing itself – meant for single players, not for grids of many. Without the player's script
on the page: `<iframe src="https://<host>/player/0.1.0/frame.html#src=<URL>&features=…">` and the protocol described at
the top of `src/scripts/player/frame.js`.

### Several players on a page

All players of a page share the GPU and one renderer. Only one path traces at a time (the one used last; several
`mode="hq"` one after the other), the others keep their last picture; players out of sight sleep. For grids of many
products: `activate="visible"` + `poster` – then even the big script loads only with the first visible player.

## License

Free for **non-commercial use** – private, education, research, non-profit – under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): use, change and share it.

RINDR stands on the shoulders of open-source projects. That's why commercial use needs a license: whatever it brings in goes back to open-source projects.

The open-source libraries below keep their own licenses.

## Built with

<!-- libraries:start – generated by scripts/sync-readme.mjs from src/scripts/libraries.js, do not edit -->
RINDR is built on great open-source projects. Thanks to everyone who contributes to them!

### In the viewer

| Project | Used for | License |
|---|---|---|
| [three.js](https://threejs.org) | 3D engine, WebGPU renderer, glTF/FBX/STL loaders | MIT |
| [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | GPU path tracing (HQ) | MIT |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Acceleration structures for raycasting and path tracing | MIT |
| [Intel Open Image Denoise](https://github.com/RenderKit/oidn) | AI denoising (weights) | Apache-2.0 |
| [oidn-web](https://github.com/pissang/oidn-web) | Open Image Denoise in the browser | MIT |
| [@pmndrs/upscaler](https://github.com/pmndrs/upscaler) | Upscaling (AMD FSR) | MIT |
| [earcut](https://github.com/mapbox/earcut) | Triangulation of STEP faces | ISC |
| [cdt2d](https://github.com/mikolalysenko/cdt2d) | Delaunay triangulation (fallback) | MIT |
| [polygon-clipping](https://github.com/mfogel/polygon-clipping) | Repair of crossing face boundaries | MIT |
| [robust-predicates](https://github.com/mourner/robust-predicates) | Exact geometric predicates | Unlicense |
| [robust-orientation, robust-in-sphere, binary-search-bounds](https://github.com/mikolalysenko) | Exact geometric predicates for cdt2d | MIT |
| [splaytree](https://github.com/w8r/splay-tree) | Data structure for polygon-clipping | MIT |
| [@petamoriken/float16](https://github.com/petamoriken/float16) | Half-float data for the denoiser | MIT |
| [Draco](https://github.com/google/draco) | Draco mesh decompression (glTF) | Apache-2.0 |
| [Basis Universal](https://github.com/BinomialLLC/basis_universal) | KTX2/Basis textures (glTF) | Apache-2.0 |
| [ktx-parse, zstddec](https://github.com/donmccurdy/KTX-Parse) | KTX2 container and Zstandard (glTF) | MIT |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) | Meshopt compression (glTF) | MIT |
| [fflate](https://github.com/101arrowz/fflate) | Decompression of FBX data | MIT |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | IFC import (BIM): geometry and properties | MPL-2.0 |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | Cross-origin isolation on GitHub Pages (fast loading of large files) | MIT |
| [MaterialX, ltc-sheen (fuzz fits)](https://github.com/tizian/ltc-sheen) | Fitted formulas for the OpenPBR fuzz sheen (Zeltner et al. 2022) | Apache-2.0 |

### HDRI environments

| Project | Used for | License |
|---|---|---|
| [Open HDRI](https://openhdri.org/) | HDRI maps for lighting and background | CC0 |

### For building

| Project | Used for | License |
|---|---|---|
| [Astro](https://astro.build) | Web framework | MIT |
| [Vite](https://vite.dev) | Build tool | MIT |
| [Tailwind CSS](https://tailwindcss.com) | CSS framework | MIT |

---

<p align="center">Designed with ❤️. Powered by Claude.</p>
<!-- libraries:end -->
