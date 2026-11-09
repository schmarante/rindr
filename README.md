<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rindr-white.svg">
    <img width="38" align="top" src="public/rindr.svg" alt="">
  </picture>
  <b>RINDR</b>
</h1>

Your local 3D file viewer – with real-time path tracing, right in the browser.

**STEP · IGES · DXF · SAT/SAB · glTF/GLB · FBX · MAX · C4D · Blender · OBJ · 3MF · USD · STL · PLY · pbrt · IFC · BCF · Gaussian splats (PLY/SOG) · MaterialX · HDRI (HDR/EXR)**

<a href="https://schmarante.github.io/rindr/"><img src="https://img.shields.io/badge/%E2%96%B6%20Live%20demo-schmarante.github.io%2Frindr-2ea44f?style=for-the-badge" alt="Live demo"></a>

Drop a CAD model, a mesh, a BIM file or a Gaussian splat into the window and get a studio-quality render in seconds. Everything runs locally on your GPU – **no upload, no server, no install.**

## Highlights

- **Path tracing in real time (WebGPU)** – fast preview while you orbit, physically based rendering with AI denoising as soon as the camera stands still.
- **Opens almost anything**
  - **STEP** via a custom CAD kernel: assemblies, colours, instancing, adjustable tessellation quality – **IGES** goes the same way (converted on load)
  - **DXF** drawings via an own reader (ASCII and binary, R12 to current): layers in the scene graph, blocks, line types and weights, hatches, texts, 3D faces and meshes; model space or a layout with its viewports – lines and texts stay sharp over the path-traced image; solid bodies inside go the STEP way
  - **SAT/SAB** solids and sheets (analytic and spline surfaces) converted to STEP on load
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
- **Special materials** – toon and contour styles, subsurface scattering (jelly, wax), glowing marble, a **cloud** as real volume, **wool** with fibres, **grass** with real blades, **hair and bristles** as real fibres (shaving brush, fur), **soap bubbles** with thin-film colours; scattering media for cloudy liquids – juice, milk, honey, beer and more in the library.
- **Studio tools** – scene graph with hover outlines, move/rotate/scale gizmo, MAX-style quad menu, view cube, animated **exploded view**, section plane, animations with skeleton view.
- **Lighting** – HDRI environments (drop your own .hdr/.exr into the window) with a flattened ground dome, shadow catcher and contact shadows, ground reflections and rain puddles; an **HDRI editor** for your own procedural environments with sun & sky and movable light pins.
- **Camera like a real lens** – depth of field with bokeh blades, fisheye up to 240°, bloom, glare, lens flare and **volumetric god rays**; style filters from pixel art and scanlines to sketch and ASCII.
- **Distributed rendering** – other computers in your local network render along (paired via link and code, peer-to-peer), buckets labelled per computer.
- **Output** – image export (incl. transparent PNG), **light passes** per light source and light type plus helper passes (alpha, depth, normals, albedo, IDs) as layered **EXR** or **PSD**, save/load whole scenes, the scene as **GLB** (models with materials and textures in one glTF file), and **AI rendering**: send the frame plus your material names to an image model for a photoreal take.
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
| `background` | what is shown behind the model: `hdri`, a colour (`#ffffff`), `linear(top, bottom)`, `radial(centre, edge)`, `default` (the dark gradient) – wins over the scene's background; shown from the first moment, while the player still loads |
| `mode` | `default` (raster) or `hq` (path tracing as soon as the camera stands still); also `basic`, `uv`, `wire` |
| `features` | interface parts, separated by spaces or commas: `scene-graph`, `properties`, `materials`, `material-editor`, `explode`, `transform`, `section`, `views`, `view-cube`, `view-modes`, `open`, `save`, `export`, `render`, `ki`, `animation`, `setup`, `fullscreen` – `all` = everything. Without `features`: the 3D view only (orbit, zoom, key 3 for path tracing) |
| `activate` | `auto` (at once, default), `visible` (when the player comes near the visible part of the page), `click` (a start button) |
| `poster` | picture shown until the player shows its model |
| `frame` | run the player in an iframe (see below) |

`src`, `scene`, `hdr`, `mode` and `background` may change after the start (the player loads or switches), the others count from the
start. All names are plain HTML attributes (valid, no `data-` prefix).

### Methods

Every method returns a promise. A player still waiting for its activation (`activate="click"` / `"visible"`) starts on the
first call; methods that look at parts wait until the model is loaded.

| Method | |
|---|---|
| `load(url)` / `load({ src, scene, hdr, files, package })` | load a model or a scene; `scene` as URL or as data (`getScene()`), `files` = `{ fileName: URL or Blob }` for the files the scene names, `package` = zip from `getPackage()`. Resolves to `{ models, missing, parts }` |
| `getParts(pattern?)` | parts: `[{ path, name, model, visible, materials }]` |
| `setMaterial(parts, material)` | assign a material to parts or surfaces (one undo step) – resolves to the material id; see [Materials](#materials) |
| `updateMaterial(material, params)` | change parameters of a scene material (id or name) – every part with it follows |
| `getMaterials()` / `getLibrary()` | materials of the scene / of the library |
| `setVisible(parts, visible)` | show or hide |
| `select(parts \| null)` | select, as a click does |
| `frame(parts?)` | fly the camera to the parts (or everything) |
| `getViews()` / `setView(name \| { position, target, fov })` | saved views / set the camera |
| `setMode(mode)` / `getMode()` | view mode |
| `setBackground(background)` | as the attribute, or `{ type: 'radial' \| 'linear' \| 'solid', colors }` |
| `render({ width, scale, transparent, samples, hq, type, quality })` | an image as Blob: path traced (default) or the raster view (`hq: false`); `type` `image/png` (default) or `image/jpeg` |
| `getScene()` | the scene as data (the same JSON as "Save scene") |
| `getPackage()` | the scene with its model files (and HDRI) as a zip |
| `save()` | what the save button does (fires `rindr-save`) |
| `exportGlb({ camera })` | the visible models with their materials as one GLB file: `{ file, warnings }` – see [GLB export](#glb-export) |
| `start()` | start a waiting player |

**Parts by name.** A path is the chain of node names from the file, joined with `/`:

- `'Housing/Lid'` – the node Lid below Housing
- `'Wheel'` – every node of that name on this level; `'Wheel[2]'` only the second one (in file order)
- `'Housing/*'` – every child; `*` inside a name matches any characters (`'Screw*'`)
- `'**/Screw*'` – at any depth
- `'Housing/Lid#1'` – the second surface of Lid (its own meshes, e.g. the colour groups of a STEP part; 0-based, listed in
  `getParts()` as `surfaces`) – for materials, selection and framing; hiding works on whole parts
- Names containing `/ [ ] * # \` get a backslash in front of that character. Several patterns as a list: `['Lid', 'Base']`.

Saved scenes remember these names: when a configurator exports a variant of the model (nodes added or reordered),
materials, hidden parts and transforms still find their parts.

Errors carry a `code`: `no-part`, `no-material`, `no-view`, `bad-argument`, `load-failed`, `render-failed`.

### Materials

Every part and surface has a material. The materials of the scene come from the model file (its colours and materials)
or were added later; `getMaterials()` lists them (`{ id, name, library, source }`). The library holds about 250 ready
materials (`getLibrary()` → `{ library, name, category }`).

**Assigning** – `setMaterial(parts, material)`: `parts` is a path pattern or a list of them (see "Parts by name" – a part
gives the material to everything below it, `'Path#k'` to one surface). `material` is one of:

| `material` | |
|---|---|
| `'metal-chrome'` | a library material by its id – added to the scene the first time it is used |
| `'mat-…'` | a material of the scene by its id (`getMaterials()`, or the id `setMaterial` returned) |
| `'Lacquer'` | a material of the scene by its name |
| `{ library: 'metal-chrome' }`, `{ id: 'mat-…' }`, `{ name: 'Lacquer' }` | the same, explicitly |
| `{ name: 'Lacquer', params: { … } }` | a new material from parameters (below) |
| an entry of a material export | `{ name, params, graph }` from RINDR's material export (JSON) – node graph included |

It resolves to the material's id. Assign that id to more parts to share the material; `updateMaterial(id or name,
params)` then changes all of them at once – for a configurator: create the material once, then change its colour.

```js
const lacquer = await p.setMaterial('Housing', { name: 'Lacquer', params: { color: '#e30613', roughness: 0.3, clearcoat: 1 } });
await p.setMaterial(['Lid', 'Door*'], lacquer);           // the same material on more parts
colour.oninput = () => p.updateMaterial(lacquer, { color: colour.value });
await p.setMaterial('Housing/Lid#1', 'metal-alu-brushed'); // one surface of a part
```

**Parameters** (physically based, after OpenPBR; colours as hex, sRGB; lengths in scene units – millimetres for CAD
files). The common ones:

| Parameter | Range (default) | |
|---|---|---|
| `color` | hex (`#808080`) | base colour |
| `metalness` | 0–1 (0) | 0 = dielectric (plastic, paint), 1 = metal |
| `roughness` | 0–1 (0.5) | 0 = mirror-like, 1 = matte |
| `specularIntensity`, `specularColor` | 0–1 (1), hex (`#ffffff`) | strength and tint of the reflection (metals: edge tint) |
| `anisotropy`, `anisotropyRotation` | 0–1 (0), −180–180° (0) | brushed metal |
| `clearcoat`, `clearcoatRoughness` | 0–1 (0), 0–1 (0) | lacquer layer on top (car paint) |
| `clearcoatColor`, `clearcoatIor` | hex (`#ffffff`), 1–3 (1.5) | tint and index of the lacquer |
| `transmission`, `ior` | 0–1 (0), 1–3.5 (1.5) | glass and clear plastics, index of refraction |
| `thickness`, `thinWalled` | 0–50 (0), 0/1 (0) | glass thickness; thin-walled = a sheet without inside |
| `attenuationColor`, `attenuationDistance` | hex (`#ffffff`), 0.1–100 (100) | tinted glass: colour reached after that distance |
| `dispersion`, `dispersionAbbe` | 0–1 (0), 2–91 (20) | rainbow fringes in glass |
| `sheen`, `sheenColor`, `sheenRoughness` | 0–1 (0), hex, 0–1 (1) | velvet, fabric |
| `subsurface`, `subsurfaceColor`, `subsurfaceRadius` | 0–1 (0), hex, 0.05–50 (2) | wax, skin, jelly – light scattering inside |
| `iridescence`, `iridescenceThickness`, `iridescenceIOR` | 0–1 (0), 50–1200 nm (400), 1–2.5 (1.3) | thin-film colours (soap, oil) |
| `emissive`, `emissiveIntensity` | hex (`#000000`), 0–20 (1) | self-illumination |
| `opacity` | 0–1 (1) | cut-out transparency |
| `edgeRadius` | 0–20 (0) | rounded edges in the shading (scene units) |

**Hair and bristles** – real fibres, traced as such in path tracing (hair scattering model) and drawn as lines in the
raster view. Assign the material to a part: by default its shape is *filled* with fibres running upwards from where the
shape begins to its surface – the part itself is only the outline (a shaving brush: model the knot as a bulb; a cylinder
becomes a bundle of hair). `hairAxis` sets the direction the fibres run when filling (roots → tips): `up` (default), `down`, `x`, `-x`, `z`, `-z` (the
scene's axes as seen, Y up) or `long` (the shape's longest extent – a cylinder lying on its side). `hairGrow: 1` lets them
*grow* from the surface instead (fur). Library: `hair-badger`,
`bristles-white` (fill), `fur-grey`, `hair-brown-long` (grow). Parameters: `color` (at the root), `hairTipColor`,
`hairThickness` (mm, 0.12), `hairDensity` (share of the area the fibres cover, 0.35), `hairLength` (mm, growing),
`hairSpread` (fill: the roots drawn towards the middle – fanning out), `hairTaper`, `hairCurl`, `hairClump`,
`hairVariation` (shorter fibres at random), `hairDroop` (growing: tips bend down), `roughness` (the fibres' sheen). The
number of fibres follows the device's memory – above it fewer, thicker ones.

```js
await p.setMaterial('Brush/Knot', 'hair-badger');
await p.setMaterial('Brush/Knot', { name: 'Knot', params: { hair: 1, color: '#2b211b', hairTipColor: '#f2ede4', hairThickness: 0.08, hairSpread: 0.4 } });
```

Missing parameters take their defaults. Special materials (toon, cloud, wool, grass, hair, soap film, glowing marble) come
from the library; their parameters and the full list are in `src/scripts/material-manager.js` (`PARAMS`) and
`src/scripts/material-types.js`. The scene keeps every assignment by part names (`getScene()`), together with the materials
themselves.

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
| `rindr-export` | `{ file, name, format: 'glb', warnings }` – the export button (`features="export"`); **cancelable** |

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

### GLB export

`exportGlb()` (and the export button, feature `export`) writes the visible models as one glTF binary: node tree and
names, materials as glTF PBR with their extensions (clearcoat, transmission, volume, IOR, specular, sheen, iridescence,
anisotropy, dispersion, emissive strength), textures – node-graph materials as baked maps –, repeated parts as GPU
instances, in metres. `camera: true` adds the current camera. Hidden parts stay out; lights, the environment and render
settings are no part of the file (a glTF viewer lights the model itself).

What glTF cannot hold comes back in `warnings` as `[{ code, names }]`: `special` (cloud, wool, grass, hair, soap film,
marble, toon – written as plain materials), `subsurface`, `edges` (rounded edges), `hair` (the fibres – the shape is
included), `splats`, `volumes`, `animation` (the current pose is written), `texture` (compressed or floating-point
maps left out).

```js
p.addEventListener('rindr-export', async e => {   // the export button: keep the file instead of downloading it
  e.preventDefault();
  await fetch('/pim/glb/4711', { method: 'PUT', body: e.detail.file });
});
const { file, warnings } = await p.exportGlb();     // or from your own button
```

### Colours

On the element (or an ancestor) – or for every player of the page with `RINDR.configure`:

```css
rindr-player {
  --rindr-accent: #e30613;      /* accent (buttons, selection, sliders) – lighter and darker shades are mixed from it */
  --rindr-panel: #001a33;       /* base tone of panels and windows (shown at their opacity) */
  --rindr-background: #202020;  /* behind the canvas, while the player starts (the 3D background: attribute background) */
  --rindr-font: system-ui, sans-serif;
}
```

```js
RINDR.configure({ theme: { accent: '#e30613' } });   // null removes a value; a rule of the page on the element wins
```

`--rindr-background` is the page colour behind the player's canvas (seen while it starts); the 3D background is the `background` attribute. Its colours look exactly as picked with the exposure and tone curve of that moment; afterwards they are part of the scene – another exposure or tone curve changes them like the model. The RINDR logo always stays visible. `RINDR.configure({ base })` – where the player's files lie (default: the script's
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
