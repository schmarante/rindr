# RINDR

## Grundsätzliches ZIELE
Ein performater 3D Viewer im Browser der qualitativ mit professionellen Offline-Renderern mithalten kann.
### Anzeigemodus:
[X] Beim Drehen ist die Anzeige in einem Preview-Modus und sobald die Kamera stillsteht geht der Pathtracing Modus los

### SCENE GRAPH 
[X] In einer Scene können verschiedene Objekte enthalten sein, diese werden alle im SCENE GRAPH dargestellt
[X] im Scene Graph sind auch Lichter, HDRI und KAMERA enthalten
[X] Jedes Objekt im Scene Graph kann ausgewählt, ein- und ausgeblendet werden
[X] bei Mouse-Over im SCENE GRAPH wird das jeweilige Objekt mit einer Outline hervorgehoben

### MATERIAL-EDITOR
[X] Es gibt einen Materialeditor in dem Materialien angelegt oder aus einem Material-Pool geladen werden können
[X] Beim STEP-Import werden Farben aus dem STEP-Model erkannt und als Dummy-Materialien angezeigt die durch Materialien aus einer Material-Bibliothek ersetzt werden können. Jedes Material hat eine eigene ID und lässt sich per Drag & Drop auf ein Modell ziehen (entweder direkt oder im Objekt-Baum)
[X] Ist ein Objekt ausgewählt wird auch im Material-Editor sichtbar welches Material dem Objekt zugewiesen wurde

### MATERIALIEN und MATERIAL EDITOR
[X] Für Materialien verwenden wir three.js TSL
[X] Man sieht alle in der Szene verwendeten MAterialien und kann diese bearbeiten
[X] Die Bearbeitung der einzlenen Materialien basiert per NODES. 
[X] Materialien lassen sich exportieren oder importieren (JSON)

### HDRI-EDITOR (Okt. 2026 – Details/Checkliste: `docs/hdri-editor.md`)
Fertiges HDRI laden oder im Editor eigene Varianten der prozeduralen HDRIs anlegen (Vorlage: Studio).
[X] Export des HDRI
[X] Hintergrundverlauf
[X] Verschiebbare, interaktive Sonne & Himmel
[X] Bodenfarbe für Sonne & Himmel
[X] Parameter für Sonnengröße
[X] Abgerundete Ecken für rechteckige Pins (Pins = Licht-Marker, verschieb- und editierbar)
[X] Verlaufs-Pins (mit Verlaufs-Editor)
[–] ~~Farbanpassungen für Bild-Pins~~ – entfallen: keine Bild-Pins (Nutzer: Kreis, Rechteck, Verlauf reichen)
[X] HDRI-Editor-Arbeitsfläche abdocken

### OBJEKTE MANIPULIEREN
[X] Jedes Objekt in der Szene lässt sich verschieben (XYZ) und drehen (XYZ)

## Projektregeln

- Antworten an den Nutzer auf Deutsch; Code (Bezeichner, Kommentare, Konsolen-Ausgaben) komplett englisch.
- Konsole still (Wunsch des Nutzers): Info-Ausgaben nur über `debugLog()` aus `src/scripts/log.js` – erscheinen nur mit `?debug`; kein `console.log/info` direkt (Ausnahmen: `debug-stats.js`, `benchmark.js`, laufen nur mit `?debug`/`?bench`). `console.warn/error` bleiben.
- Oberflächentexte nur über `src/i18n/de_de.json` + `en_us.json` (`t()` aus `i18n.js`), neue Schlüssel immer in beiden Dateien – Details: `docs/i18n.md`.
- Neues Dateiformat = in allen Format-Texten nennen (Wunsch des Nutzers): `status.dropFormats` (Start-Hinweis), `page.drop.hint` (Drop-Fläche), `about.description` – de_de + en_us; neue Bibliotheken in `src/scripts/libraries.js` eintragen (+ `about.libs.<id>` in beiden Sprachdateien) – daraus entstehen „Über“ in der App und „Built with“ in der README (`scripts/sync-readme.mjs`, läuft automatisch vor jedem `npm run build`; README danach mit committen).
- Eingaben einheitlich (Wunsch des Nutzers): Zahlenfelder, Regler, Farbfelder, Auswahlen, Checkboxen immer mit den Klassen/Helfern aus `src/scripts/ui-controls.js` (`INPUT`, `SELECT`, `RANGE`, `CHECKBOX`, `draggable` – Zahlenfelder seitlich mit der Maus ziehbar, Shift schneller, Alt feiner; Farben immer `colorField` – eigener Farbwähler im Panel-Stil statt des nativen Dialogs, kein `<input type=color>`); neue Fenster im Stil der Panels (`bg-black/60` + Blur).
- Icons (Wunsch des Nutzers): je Icon eine SVG-Datei in `src/assets/icons/`, im Code nur `icon(name, klassen)` aus `src/scripts/icons.js` – keine SVG-Strings im Code (Details: `docs/ui.md`).
- Lizenz: PolyForm Noncommercial 1.0.0 (`LICENSE.md`). Fremden Code (z.B. Shader-Beispiele aus dem Netz) nur als Inspiration nehmen, Lizenz prüfen, eigene Umsetzung – keine Rechte verletzen (Wunsch des Nutzers).
- **Keine Markennamen, keine fremden Inhalte (wichtig, Wunsch des Nutzers):** Markennamen nirgends übernehmen – weder in Material-, Farb- oder Preset-Namen noch in Oberflächentexten, Doku, Kommentaren oder Commits (z.B. „MAX“ statt des Produkt-/Herstellernamens; keine Farbsystem- oder Herstellerbezeichnungen; auch keine Vergleiche „wie bei <Produkt>“). Ausnahme nur, wo technisch nötig: Erkennung des exportierenden Programms im Datei-Header samt zugehöriger Kommentare (STEP/STL/IFC), Eigenschaftsnamen eines Dateiformats, tatsächlich angebundene Dienste (KI-Anbieter), Testumgebung (Browser, Hardware). Keine Texturen, Bilder, Materialbibliotheken oder sonstigen Inhalte Dritter ausliefern – fremde Vorlagen (z.B. `tests/MatLibs`, `tests/maps`) nur als Orientierung, eigene Werte und Namen, Optik höchstens prozedural nachbauen.
- Große Modelle in `public/models/` und HDRIs in `public/hdr/` nicht committen (beide in .gitignore).
- **Dokumentation:** Diese Datei ist Übersicht, Regeln und Ziele. Die Details stehen in `docs/` (Karte unten). Vor Arbeit an einem Bereich die passende Datei lesen; nach Änderungen dort nachtragen (Verhalten, Entscheidungen des Nutzers, verworfene Wege, Fallstricke, Prüfskripte) – hier nur, wenn es übergreifend ist.

## Karte der Detail-Dokumentation

| Datei | Inhalt |
|---|---|
| `docs/i18n.md` | Sprache / i18n – Oberflächentexte, Sprachdateien, Prüfskript. |
| `docs/step-import.md` | STEP-Import – Eigener STEP-Kernel (`src/scripts/rindr.js`, `step/`, `step-importer.js`, `instancer.js`, `shape-match.js`): Struktur, Tessellierung, Orientierung, Hochachse, Speicher, Qualität, Instancing. |
| `docs/mesh-import.md` | Mesh-Import (glTF, FBX, MAX, 3MF, USD, STL, PLY) – `src/scripts/mesh-importer.js`, `usd-importer.js`, `usd-mdl.js`, `mesh-orient.js`, `fbx/`, `max/`, `3mf/`. |
| `docs/bim.md` | IFC / BIM und BCF – `src/scripts/ifc/`, `src/scripts/bcf/`. |
| `docs/splats.md` | Gaussian Splats – `src/scripts/splat/`. |
| `docs/animation.md` | Animation und Morph Targets – `src/scripts/animation.js`. |
| `docs/rendering.md` | Raster-Darstellung – Darstellungsarten, Batcher (`render-batcher.js`), Cluster-LOD großer Modelle (`lod/`), Schatten, Einblenden, Hervorhebung, Schnittebene, eigene Render-Durchgänge. |
| `docs/pathtracer.md` | Pathtracer (HQ) – `src/scripts/pathtracer.js` (three-gpu-pathtracer WebGPU, Vite-Patches in astro.config.mjs). |
| `docs/camera-lens.md` | Kamera, Tiefenschärfe, Fisheye, Objektiv-Effekte, Stil-Filter – `dof.js`, `fisheye.js`, `lens-effects.js`, `style-filters.js`, `volume-shafts.js`, Kamera-Teile von `viewer.js`/`properties.js`. |
| `docs/hdri-editor.md` | HDRI-Editor – eigene prozedurale HDRIs (`src/scripts/hdri/`): Modell, Generator, Pins, Sonne & Himmel, Export, Fenster. |
| `docs/environment.md` | Umgebung, HDRI, Boden – `environment.js`, `ground.js`, `background-dome.js`, `contact-shadow.js`, `shadow-catcher.js`. |
| `docs/materials.md` | Materialien und Node-Editor – `material-*.js`, `graph-apply.js`, `node-editor.js`, UV-Mapping je Objekt (`uv-mapping.js`); besondere Materialien in `src/scripts/materials/` (Toon/RindrMaterial, Konturen, Leuchtmarmor, Wolke, Wolle, Gras, Seifenhaut). |
| `docs/material-library.md` | Material-Bibliothek – Presets je Kategorie in `src/scripts/presets/` (aus den MAX-Bibliotheken nachgebaut), Graph-Baukasten, Prüfweg. |
| `docs/scene-state.md` | Szenen-Zustand, Speichern/Laden, Assets, Rückgängig – `scene-state.js`, `assets.js`, `history.js`, Teile von `viewer.js`. |
| `docs/ui.md` | Oberfläche und Bedienung – Scene Graph, Eigenschaften/Gizmo, Leiste, Drop-Fläche, mehrere Modelle, Menüs, Dialoge, Tasten, Auswahl. |
| `docs/export-ki.md` | Bild-Export und KI-Rendering – `image-export.js`, `png-encode.js`, `ki-render.js`, `ki-gemini.js`. |
| `docs/memory.md` | Speicher und Gerätegrenzen – `memory-budget.js` (Budget aus den Gerätedaten, Worker-Zahl, Speicher-Schranke), `load-guard.js` (Absturz erkennen, sparsamer Modus), Dialoge/Hinweise bei zu großen Modellen (`notice.js`, `choiceDialog`). |
| `docs/distributed.md` | Distributed Rendering – `src/scripts/distributed/`: Master/Render-Clients, Buckets (`pathTracing.renderRegion`), Verteilung, Ausfall, beschriftete Anzeige, Rechner im Netz (WebRTC, Kopplung per Code – `rtc.js`); Stand und nächste Stufen. |
| `docs/vision.md` | Zukunftsvisionen (Distributed Rendering – Umsetzung siehe `docs/distributed.md`) |

## Stand (2026-10-14)

**Bundle (Okt. 2026):** Start ≈ 1,67 MB JS (gzip ~509 KB) + Sprachdatei 62 KB (gzip 23 KB) – Haupt-Skript 436 KB, three.js 673 KB TSL + 276 KB Kern; vorher 1,96 MB / 595 KB (Haupt-Skript war auf 577 KB gewachsen). Erst bei Bedarf (Wunsch des Nutzers: „loading erst machen wenn wir es wirklich brauchen“): glTF/FBX-Loader (`loadLibs` in mesh-importer.js), Pathtracer + OIDN + Upscaler (~420 KB, `pathTracing.load()`: dynamischer Import, `requestIdleCallback` nach dem Start lädt vor – Erzeugen ~10 ms, kein Einfrieren; `setScene` wartet notfalls darauf; Einstellungen bis dahin in `_settings`, FSR-Schärfe über `pathTracing.sharpness`), USD-Importer, Bibliotheks-Kategorien (`loadLibraryPresets` in material-presets.js beim ersten Blick auf „Bibliothek“ – die Grund-Presets bleiben: Material-Typen nehmen dort ihre Vorlagen), Sprachdatei nur der aktiven Sprache (+ Deutsch als Rückfall; `i18n.js` mit Top-Level-Await), Node-Editor, HDRI-Editor, Asset-Fenster (+ Laden aus dem Netz), Bild-Export, KI-Rendering, Benchmark, Debug-Anzeige, Splat-Mesh/Scan-Analyse (beim ersten Splat). In viewer.js `lazy(create)` → `get()` (Promise der Instanz) / `now` (Instanz, falls schon da – für Aufrufe, die nur bei offenem Fenster zählen); das Asset-Fenster hat einen Stellvertreter mit derselben Schnittstelle. Preloader (index.astro `#preloader`, nur CSS – kein Inline-Skript wegen CSP): Logo dunkelgrau (#3a3a3a) mit weichem Schatten auf dem Hintergrund der App (#171717 – vorher heller Grau-Verlauf, beim Ausblenden sprang die Helligkeit; schwarzes Logo wäre darauf unsichtbar, Entscheidung des Nutzers), Blau füllt per kegelförmiger Maske im Uhrzeigersinn (`@property --preloader-sweep`, läuft von selbst gegen ~74 %), viewer.js `hidePreloader` vervollständigt und blendet aus, sobald Bilder wirklich zeichnen (`renderer.info.render.drawCalls` > 0 in 2 Bildern, spätestens 4 s nach dem ersten Bild; vorher sah man zwischen Preloader und Bild eine flache Fläche), bei fehlendem Renderer/GPU-Warten sofort. Weitere Hebel: Splat-Systeme (Composite/Opacity/Schatten/Volumen werden beim Start angelegt), TransformControls (22 KB), STEP-Importer (Start nutzt `buildBVHIsolated`). Analyse: `SOURCEMAP=1 npm run build` (astro.config) + Bytes je Quelle über source-map-js (Scratchpad `sizes.cjs`); Funktionstest der nachgeladenen Teile Scratchpad `lazy.js`, Preloader `preload.js` (`THROTTLE=1` drosselt das Netz).

**Stack:** Astro 7 + Tailwind 4, npm (`npm run build` → `dist/`, DDEV-Docroot `dist`). Unterverzeichnis auf dem Server: `BASE_PATH=/rindr/ npm run build` (absolute Social-Preview-Links: `SITE_URL` in `.env`, siehe `.env.example`; astro.config liest `.env` per `loadEnv`) (`base` in astro.config.mjs; Laufzeitpfade über `import.meta.env.BASE_URL` bzw. relativ; URL mit Schrägstrich am Ende aufrufen). Kein Server-Code mehr – reine statische Seite (KI läuft im Browser). **Deployment:** GitHub Pages https://schmarante.github.io/rindr/ – `.github/workflows/static.yml` baut bei Push auf `master` (`npm ci` + `npm run build`, `BASE_PATH`/`SITE_URL` aus `configure-pages`, Repo-Variable `SITE_URL` hat Vorrang) und veröffentlicht `dist/`; in den Pages-Einstellungen muss die Quelle „GitHub Actions“ sein. Pfade im HTML über `base` (auch Icons/Manifest; Manifest-Icons relativ). GitHub Pages setzt kein COOP/COEP → `public/coi-serviceworker.js` (coi-serviceworker 0.1.7, ergänzt: Sicherheits-Header, Seitenabruf bei Netzfehler einmal wiederholt statt `undefined` – sonst „Failed to convert value to 'Response'“ –, Neuladen nach einem Update erst, wenn der neue Worker aktiv ist; als erstes Skript im `<head>` von index.astro) setzt die Header per Service Worker: einmal Neuladen beim ersten Besuch, danach isoliert; ist die Seite schon isoliert (eigener Server mit `.htaccess`, `npm run dev`), registriert er sich nicht. Meldungen nur mit `?debug` (`public/coi-config.js` – Datei statt Inline-Skript wegen CSP). **Sicherheits-Header:** Content-Security-Policy als `<meta>` in index.astro (nur im Produktions-Build – der Dev-Server braucht HMR/Inline-Skripte; kein Inline-Skript, `'wasm-unsafe-eval'` für WebAssembly, `worker-src blob:` für Draco/KTX2, `connect-src` seit Okt. 2026 `https:` – KI-Dienst (`KI.endpoint`) und Texturen fremder Server, nur auf Klick im Asset-Fenster mit Fortschritt je Datei (`remote-textures.js`, docs/mesh-import.md; Entscheidung des Nutzers, vorher nur die KI-Adresse)) + Referrer-Policy als `<meta>`; nur als Header möglich (frame-ancestors, X-Frame-Options, X-Content-Type-Options, Permissions-Policy, HSTS): eigener Server `public/.htaccess`, GitHub Pages über den Service Worker (in `coi-serviceworker.js` ergänzt, `SECURITY_HEADERS` – mit .htaccess synchron halten; erst ab dem zweiten Laden, HSTS sendet GitHub selbst). Permissions-Policy nur mit Merkmalen, die Chrome kennt (`bluetooth` erzeugte eine Konsolen-Warnung). Geprüft headless: alle Formate + HQ ohne CSP-Verletzung, Header im Dokument (GitHub-ähnlich über Service Worker, eigener Server direkt). Ohne Isolation (z.B. Privatmodus ohne Service Worker) greifen die Ausweichwege: STEP-Worker mit Kopien (Anzahl nach Dateigröße), Splats ohne geteilten Speicher. Geprüft headless: Server ohne Header → 2 Navigationen, isoliert, große STEP-Baugruppe (294 MB) mit 12 Workern + SharedArrayBuffer; Server mit Headern → kein Service Worker. three ^0.186 (WebGPU), three-mesh-bvh, three-gpu-pathtracer 0.0.26 (WebGPU), oidn-web, @pmndrs/upscaler ^0.2 (gepinnt), earcut (lil-gui steht noch in package.json, wird nicht mehr benutzt).

**Zentrale Dateien**
- `src/scripts/viewer.js` – Szene, WebGPURenderer (fordert Adapter-Maximum für Puffergrößen und Texturen je Shader an), GUI, Render-Loop, Statusanzeige. Start mit leerer Szene; Datei per Drag & Drop ins Fenster öffnen (auch mehrere Dateien/Ordner: Hauptdatei STEP > GLB/glTF > FBX/STL > PLY/SOG, Rest = Texturen/.bin; Gaussian Splats siehe unten). `loadModel()` ist gemeinsam für alle Formate, `runLoad()` serialisiert Laden/Neu-Tessellieren. Neues Modell während eines Imports (`openModel`): laufender Import wird abgebrochen (`loadAbort` = AbortController fürs Dateilesen/fetch, `abortStepImport()` beendet den Worker-Pool, offene Worker-Anfragen enden mit AbortError → `loadModel` räumt still auf). `model` wird erst in `runLoad` übernommen (`nextModel`), nie während ein Ladevorgang läuft – vorher las der alte Import ab dem Ablegen die Daten des neuen Modells. `?debug` → `globalThis.__viewer` (u.a. `openModel`, `isLoading`), außerdem Debug-Anzeige rechts unten (`debug-stats.js`: fps + CPU-ms/Bild, GPU belegt laut `renderer.info.memory` – Gesamt-VRAM gibt WebGPU nicht heraus –, JS-Heap/Seite inkl. Worker/`deviceMemory`, Modell-Dreiecke gesamt/sichtbar/eindeutig, Dreiecke + Draw-Calls des letzten Bilds; Worker-Übersicht wie ein Task-Manager – `worker-monitor.js`, Details `docs/memory.md`), `?model=<datei>` lädt `public/models/<datei>` (auch .glb/.fbx). Startet weder WebGPU noch WebGL2, zeigt die Statuszeile `status.noRenderer` statt einer leeren Seite (geprüft headless mit `--disable-webgl` + ohne `navigator.gpu`).
- `src/scripts/config.js` – zentrale Voreinstellungen (`PATHTRACING`: Bounces, Max. Samples, Auflösung, Glossy-Filter, Denoise, FSR, Megakernel, frameBudget); `MATERIALS.editing` (seit Okt. 2026 wieder an, Material-Editor in Arbeit – `docs/materials.md`) = false blendet die Material-Bearbeitung aus: Parameter, Node-Editor, Umbenennen, „+ Neu“, „Kopie“. Liste, Bibliothek, Drag & Drop, Zuweisen und Löschen bleiben; `MATERIALS.importExport` = false blendet Import/Export (JSON) aus (kommt später); vorhandene Graphen wirken weiter. Kommt später separat wieder. Hier anpassen statt in `pathtracer.js`. `IMPORT` (Speicherschutz STEP): `triangleBudget` 10 Mio., `triangleLimit` 30 Mio. (eindeutige Dreiecke).

**Übergreifende Fallstricke**
- three.js r186 `renderer.compileAsync`: baut die Nodes erst später zwischen den Bildern und liest dabei den dann aktuellen Renderer-Zustand (Render-Ziel, MRT, Tone Mapping) → aus Pass-Setups heraus falsche Shader. Immer `compileAsync` aus `src/scripts/shader-compile.js` nehmen (bzw. `batcher.compileAsync`). Compute-Pipelines legt three synchron an (blockiert den GPU-Prozess) – große Kernel async über `pathtracer.js` (`_installAsyncCompile`). Details: `docs/rendering.md`, `docs/pathtracer.md`.
- three.js r186-Bug (#34608, Fix erst r187): `FramebufferTexture.clone()` teilt das Bild mit dem Original → OIDN-Hilfspuffer (kleinere Auflösung) „schrumpfte“ die Transmission-Textur des Canvas → Neuanlage im offenen Render-Pass → „Destroyed texture used in a submit“ bei Glas. Workaround ganz oben in `viewer.js` (Klone bekommen eigene `TextureSource`). Beim Update auf r187 prüfen/entfernen.
- three.js r186 `Renderer._getShadowNodes`: Wird `material.map` entfernt, behält das gemeinsame Schatten-Material den alten Farb-Node (`if (colorNode !== null)`) → Schatten-Pass liest `null.matrix`, Render-Schleife bricht ab (Viewport nicht mehr drehbar). Workaround in `graph-apply.js` (`setMap`): Farb-Map statt `null` eine weiße 1×1-Textur. Beim three-Update prüfen.
- Grenzen nie auf den Entwicklungsrechner abstimmen (Wunsch des Nutzers): Budgets aus den Gerätedaten (`memory-budget.js`), fehlendes Feature / zu schwache Hardware = Hinweis im Panel-Stil (`notice.js`, `choiceDialog`) statt stillem Fehler oder Absturz. Details: `docs/memory.md`.
- `renderer.contextNode` ist global belegt (Raster-Umgebungsverdeckung, `ambient-occlusion.js`: `getAO` für alle Materialien, einmal beim Start – Teil des Shader-Cache-Schlüssels). Nicht überschreiben; eigene Kontexte nur zusätzlich (z.B. `pass.contextNode`, three.js führt beide zusammen). Details: `docs/rendering.md`.
- Speicher-Leck (behoben): three.js (WebGPU) hält Render-Objekte in `renderer._objects._renderObjects` (Set), bis am Mesh selbst `dispatchEvent({ type: 'dispose' })` kommt – `geometry.dispose()` reicht nicht. `disposeRoot` macht das; vorher blieb bei jedem Neu-Tessellieren/Modellwechsel das ganze alte Modell im Speicher (Hunderte MB je Durchgang bei großen Modellen). Beim Entfernen von Meshes immer so freigeben.

**Tests**
- Echte GPU (Okt. 2026): Claude läuft außerhalb des Containers (WSL2, RTX 3080); Befehle im Container per `ddev exec` (z.B. `ddev exec npm run build`), Seite unter https://rindr.dev.dasachtegebot.local/ (liefert `dist/`). WSL hat keinen Vulkan-Treiber für die GPU → Windows-Chrome fernsteuern: `"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" --headless=new --remote-debugging-port=9333 --user-data-dir='C:\Users\schrenk\AppData\Local\Temp\rindr-cdp-<name>' --ignore-certificate-errors --enable-unsafe-webgpu --window-size=1600,900` (WSL im Mirrored-Netzwerk → `puppeteer-core@21` mit `browserURL: http://127.0.0.1:9333`; Node auf dem Host ist v16). Neuer Profilname = kalter Shader-Cache (Erstbesuch); beenden per CDP `browser.close()` (nie per Prozessname – der Nutzer-Chrome läuft mit). fps ohne 60-Hz-Grenze: zusätzlich `--disable-gpu-vsync --disable-frame-rate-limit`; Vergleiche als A/B auf derselben Seite (Laufzeit-Schalter), getrennte Ladevorgänge streuen ±20 %. Hänger messen: `longtask`-PerformanceObserver (Haupt-Thread) + rAF-Lücken (GPU-Prozess blockiert, z.B. synchrone Pipelines) + `[Stall]`-Meldungen mit `?debug`; Ursachen per CPU-Profil (`Profiler` über CDP; für lesbare Namen vorübergehend `vite.build.minify: false`) und Chrome-Trace (Kategorien `gpu`, `disabled-by-default-gpu.dawn`: `CompileShaderDXC` auf `CrGpuMain` = blockierend).
- Browser: Headless-Chrome mit WebGPU über SwiftShader (puppeteer im Scratchpad, fehlende Libs per `apt-get download` + `dpkg -x`, `LD_LIBRARY_PATH`; Flags `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader --no-sandbox`). lil-gui `setValue()` löst kein `onFinishChange` aus.
- Test-Falle (Okt. 2026): Bricht ein puppeteer-Skript ab (Timeout), bleibt sein Tab offen und rendert im Hintergrund weiter – mehrere solche Tabs teilen sich die GPU (falsche Hänger, zu niedrige fps). Vor Messungen offene Tabs der Seite per CDP schließen (`browser.pages()` → `page.close()`).
- Headless-Test: Screenshot bei eingeschalteter Bodenprojektion (Software-GPU, ~4 fps) → „Target closed“ – Testumgebung, nicht die App (kleineres Fenster oder Status statt Bild prüfen).
- Logik ohne Browser: Node-Skripte im Scratchpad (Beispiele in den docs-Dateien).

## Offen
- **Geplant (Nutzer, Okt. 2026):**
  - HDRI per Drag & Drop: `.hdr`/`.exr` ins Fenster ziehen → wird geladen und sofort als Umgebung gewählt (heute nur `public/hdr/` per Build-Liste bzw. `?hdr=`; Laden über `environment.selectFile` gibt es schon – beim Relink genutzt). Drop-Logik: HDRI-Datei allein = Umgebung, kein Modell-Ersetzen/Hinzufügen; Szenen-Zustand/Asset-Fenster müssen die Datei als Asset führen. Format-Texte ergänzen.
  - Decals/Aufkleber: nur über das Material (Bild-Node, Kacheln aus → UV-Modus); Drag & Drop aufs Teil mit Bearbeiten auf dem Objekt verworfen (Nutzer: zu langsam, stört die UI – Details `docs/materials.md`). Projektion (Variante 3) zurückgestellt.
- Import-Materialien: Texturen gehen beim JSON-Export verloren (Graph verweist nur auf den Map-Schlüssel); Mischen von Materialien per Maske geplant; Vertex-Farben, Lichter/Kameras aus glTF/FBX werden ignoriert; FBX-Phong → Rauheit aus Shininess geschätzt. glTF/FBX nur mit selbst erzeugten Testdateien geprüft (Scratchpad `gen.py`).
- Node-Editor: kein Zoom; Box-UVs haben auf gekrümmten Flächen gerade Nähte (seit Okt. 2026 je Dreieck – vorher Zickzack-Streifen; nahtlos über das Mapping je Objekt: Zylinder/Kugel); importierte Materialien landen in der Szene, nicht dauerhaft in der Bibliothek.
- Ungenutzte STEP-Dummy-Materialien werden beim Neu-Tessellieren entfernt.
- Sehr große STEP-Dateien (~400 MB, ~6 Mio. Dreiecke) laden im Headless-Chrome in ~30 s; Dateien ≥ 1 GB kaum getestet. Weitere Hebel: Worker-Zahl an Dateigröße koppeln, Tangenten nur bei Normal-Maps, CPU-Kopien nach GPU-Upload freigeben.
- Nicht unterstützt: Nähte in u *und* v, OFFSET_CURVE, COMPOSITE_CURVE; Längeneinheit ignoriert.
- Echte GPU / echter Browser nur vom Nutzer getestet.

## Umgesetzte Wünsche

### Neue Objektmodification:
[X] Skalierung, analog zu verschieben/drehen

### QUAD-Menü
[X] wenn man ein OBjekt ausgewählt hat soll sich bei der rechten maustaste ein Quad-Menü öffnen wie bei MAX. Erstmal nur mit zwei Panels
[X] Quadmenü Panel 1: Alles einblenden, Nicht ausgewählte Objekte ausbleden, Auswahl ausblenden
[X] Quadmenü Panel 2: Verschieben, Drehen, Skalieren

### EXPLODE
[X] wir brauchen ein Toggle um das Objekt explodieren zu lassen damit man schnelle eine Explosionsdarstellung visualisieren kann. Im Idealfall fliegen die einzelnen Objekte dann smooth auseinander und wieder zusammen.

### STIL-MATERIALIEN
[X] Toon (farbig), „Weiß, Kontur schwarz“, „Schwarz, Kontur weiß“ (flache Fläche ohne Abstufung + Gegenkontur, 2 px, Konturen auch über HQ) und Neon-Grün leuchtend in der Bibliothek (Details: `docs/materials.md`, `docs/rendering.md`)
[X] Gelee, Wachs und Schleim mit Subsurface Scattering (schnelle Näherung nach Barré-Brisebois, Raster + HQ; Details: `docs/materials.md`)
[X] Leuchtmarmor (grün, blau, bernstein): leuchtende Fraktal-Adern in der Tiefe, Raster + HQ gleich (eigene Umsetzung, fremder Shader nur als Inspiration)

### SPEZIAL-MATERIALIEN
[X] Wolke: das Objekt als fluffige Wolke – quillt über die Form, Raster per Raymarching, HQ als echtes Volumen (Details: `docs/materials.md`)
[X] Wolle: flauschige Fasern – Raster als Fell-Schichten, HQ mit echten Fasern im Strahltest (Details: `docs/materials.md`)
[X] Gras: echte Halm-Geometrie (Worker samt BVH, nach Speicher-Budget), Raster und HQ gleich, blendet ein, Fortschritt unten links (Details: `docs/materials.md`)
[X] Seifenblase: dünne Seifenhaut mit Schillerfarben und Schlieren (Dünnschicht-Interferenz, Licht geht gerade durch), Raster und HQ (Details: `docs/materials.md`)

### BODEN
[X] Bodenspiegelung (Stärke, Unschärfe) und Regenwetter mit prozeduralen Pfützen – nur in HQ (Details: `docs/environment.md`)

### VIEW-CUBE
[X] Perspektiven-Würfel wie in gängigen 3D-Programmen, floatet unten rechts; Flächen (oben, links, hinten …), Kanten und Ecken anklickbar → Kamera fliegt in diese Ansicht; Ziehen dreht (Details: `docs/ui.md`)

### STIL-FILTER
[X] Looks über das fertige Bild: Retro-Handheld (4 Grüntöne), Pixel/8-Bit, LCD, Scanlines (Röhre), Skizze, ASCII-Art, Code-Regen – alle Darstellungsarten, auch Export und KI-Bild (Details: `docs/camera-lens.md`)

### UV-MAPPING
[X] Mapping je Objekt wie ein UVW-Modifier, aber einfach: Standard/Box/Planar/Zylinder/Kugel, Achse, Drehung, Maßstab (Faktor auf die Kachelgröße des Materials), vererbt über den Scene Graph; Zylinder/Kugel rundherum nahtlos (Details: `docs/materials.md`)

### DISTRIBUTED RENDERING (in Arbeit – `docs/distributed.md`)
[X] Stufe 1: Master + Render-Clients (Tabs, `?render-client`), Buckets aus einer Warteschlange, Ausfall → Neuverteilung, beschriftete Buckets je Client, „Dieser Rechner rendert mit“; Einstellungsfenster verschieb- und skalierbar
[X] Ergebnis entrauschen/exportieren (Render-Knopf), Zwischenstände je Bucket
[X] Stufe 2: Rechner im lokalen Netz per WebRTC, Kopplung per Link + Antwort-Code (ohne Vermittlungsskript), Szene samt Modelldateien über den Kanal
[ ] Szenen-Übertragung aufbereiteter Daten, Transparenz verteilt, QR-Code für den Link

### KI RENDERING
[X] Neben dem HQ-Button soll noch ein KI-Button rein der das aktuelle HQ-Bild an eine Bildgenerierung-KI schickt.
[X] Der große Vorteil ist dass wir nicht nur das aktuelle Bild an die KI senden können sondern im Prompt gleich alle verwendeten Materialien beschreiben können, wir geben also direkt unsere Materialnamen mit statt nur der Farbinformation
[X] Wir brauchen also noch eine API die (openapi) die den vermittler zwischen unserem Viewer und dem externen KI Anbieter macht. So kann auch keiner die KI-API Informationen bekommen und wir können zwischenspeichern was wir an die KI senden
