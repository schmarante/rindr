# RINDR-Player – Einbettung und Whitelabel

**Stand: Stufe 1 umgesetzt (06.11.2026)** – die App läuft als ein Player (`createPlayer` in `viewer.js`) auf einer seitenweiten Runtime (`runtime.js`); Stufen 2–4 offen. Wunsch des Nutzers: „RINDR als Whitelabel-Lösung in PIM-Systeme und Shops … eine Minimal-Konfiguration, Material-Editor, Scene Graph, Explosion, Laden/Speichern etc. sind alles Optionen, die man über Attribute aktivieren könnte … es sollte natürlich auch möglich sein, dass man in einem PIM mehrere RINDR-Player gleichzeitig anzeigen kann“. Anlass: ein Produktkonfigurator, der GLB, STEP oder gleich die RINDR-Szene ausgibt.

## Entscheidungen

- **Web Component `<rindr-player>` mit Shadow DOM** (Nutzer: „spricht natürlich für Shadow-DOMs, damit alles schön einzeln gekapselt ist“). Shadow DOM kapselt DOM + CSS; den eigenen JS-Zustand je Player bringt erst der Umbau von `viewer.js` in Instanzen (Stufe 1).
- **iframe je Player als Hauptweg verworfen:** je Player ein eigenes GPU-Gerät, eigenes three.js im Speicher, eigenes Kompilieren des Pathtracer-Kernels (6–13 s) – bei sechs Playern alles sechsfach. Bleibt als **Rückfall-Modus** mit derselben Schnittstelle (Host-Seite, deren CSP oder Framework den Player nicht zulässt).
- **Attribute ohne `data-`** (Nutzer: „können wir gerne weglassen, wenn das technisch kein Nachteil ist – sollte halt W3C-valide bleiben“): HTML erlaubt auf autonomen Custom Elements „any other attribute that has no namespace“ (HTML Living Standard 4.13.3) – Namen klein geschrieben, nicht `is`. Globale Attribute (`lang`, `hidden`, `title`, `id` …) nicht umdeuten; `lang` in seiner normalen Bedeutung lesen (Sprache des Players, sonst vom Dokument geerbt). Einziger Nachteil ohne Präfix: ein künftiges globales HTML-Attribut könnte gleich heißen → keine allzu allgemeinen Namen, Funktionen als Token-Liste in einem Attribut. Elementname: Kleinbuchstaben mit Bindestrich, schließendes Tag nötig (`<rindr-player …></rindr-player>`).
- **Hosting:** beides muss gehen – über unseren Dienst (erster Aufschlag) und beim Kunden selbst gehostet (Nutzer, 06.11.2026).
- **Die App selbst wird ein Player mit allen Funktionen** – ein Code-Weg, keine Abspaltung.

## Aufbau

| Einmal je Seite (`RindrRuntime`) | Je Player (`RindrPlayer`) |
|---|---|
| GPU-Gerät + ein `WebGPURenderer`, zeichnet per `CanvasTarget` / `renderer.setCanvasTarget` (three r187) in die Leinwand jedes Players | Szene, Kamera, Steuerung, Auswahl, Rückgängig |
| Shader-/Pipeline-Cache – Kernel nur einmal kompiliert | Shadow Root: Leinwand, Panels, eigene Ebene für Dialoge/Hinweise |
| Worker-Pool, Material-Bibliothek, HDRIs/Texturen (gleiches HDRI in zehn Playern einmal geladen) | Funktionen laut `features`, je eine nachgeladene Datei (`lazy`) |
| Speicher-Budget (`memory-budget.js`) über alle Player verteilt | Zustand, Ereignisse an das Host-System |

Viele Player (PIM-Raster mit 30 Produkten): nur sichtbare zeichnen (`IntersectionObserver`), nur einer rechnet HQ (der zuletzt bediente), die anderen zeigen ihr letztes Bild; Posterbild bis zum Aktivieren; Obergrenze gleichzeitig lebender Player – darüber gibt der älteste seinen GPU-Speicher frei und behält sein letztes Bild.

## Schnittstelle (Entwurf)

```html
<script type="module" src="…/player/1.0.0/rindr-player.js"></script>
<rindr-player src="/media/4711.glb" scene="/media/4711.json"
              features="scene-graph materials explode save"
              poster="/media/4711.jpg" activate="visible" lang="de"></rindr-player>
```

- `src` Modell oder Paket, `scene` Szenen-Datei, `features` (Token-Liste), `poster`, `activate` (`visible` | `click` | `auto`), `hq` (`auto` | `off`), `lang` (global).
- Ohne `features` = minimal: Bild, Drehen, Vorschau beim Bewegen, HQ bei Stillstand. Kandidaten: `scene-graph`, `materials` (Bibliothek, zuweisen), `material-editor` (Parameter + Nodes), `explode`, `transform`, `views`, `section`, `hdri`, `open` (Dateien/Drop), `save`, `render` (Bild-Export).
- Seitenweit einmal: `RINDR.configure({ theme, logo, maxLive, base })`.
- Methoden (Promises): `load`, `setMaterial`, `setVisible`, `setView`, `render`. Ereignisse: `rindr-ready`, `rindr-progress`, `rindr-select`, `rindr-change`, `rindr-save`, `rindr-error`. **Laden/Speichern über das Host-System:** `rindr-save` liefert die Szene, das PIM legt sie ab (kein Datei-Download).
- **Adressierung über Namen/IDs:** das Szenen-Format hängt Zuweisungen an die Mesh-Reihenfolge (`<i>/all`) und Transformationen an Knotennummern (`n<i>`) – bei Varianten eines Konfigurators zu brüchig. Schnittstelle über Namenspfade oder stabile IDs aus der Datei (glTF `extras`, STEP-Produktname); Material-IDs gibt es schon.
- Rollen: STEP importieren und Materialien setzen im PIM (alle Funktionen), der Shop lädt das fertige Ergebnis (minimal) – braucht dann weder STEP-Worker noch SharedArrayBuffer.

## Hosting – beide Wege

- Basis aller Laufzeit-Dateien aus dem Skript (`import.meta.url`), nicht aus der Seite: heute 5 Stellen mit `import.meta.env.BASE_URL` (alle in `viewer.js`); Worker laden schon über `new URL(…, import.meta.url)`.
- **Unser Dienst (fremder Ursprung):** Module brauchen CORS – GitHub Pages sendet `Access-Control-Allow-Origin: *` (geprüft 06.11.2026), eigener Server per `.htaccess`. `new Worker` mit fremdem Ursprung verbietet der Browser → Umweg über `blob:` (nur dann; gleicher Ursprung direkt). Host-Seite mit COEP `require-corp` → unsere Dateien brauchen `Cross-Origin-Resource-Policy: cross-origin`. Version fest in der URL (ein Update darf keinen Shop brechen), Chunks mit Hash + lange Cache-Zeit. Datenschutz: Laden von unserem Server überträgt die IP der Shop-Besucher – gehört in die Datenschutzerklärung des Kunden (Selbst-Hosten vermeidet das).
- **CSP der Host-Seite** muss erlauben: `script-src` (unser Ursprung), `worker-src blob:`, `'wasm-unsafe-eval'`, `connect-src`, `img-src blob: data:` → Einbau-Anleitung.
- SharedArrayBuffer nur, wenn die Host-Seite isoliert ist; sonst die vorhandenen Ausweichwege. Der coi-Service-Worker wirkt im Player nicht (er gehört zur Host-Seite).
- Die App behält ihre CSP und `frame-ancestors 'none'`; der Player ist ein eigener Build-Eintrag.

## Für Shadow DOM zu lösen

- Tailwind 4: `@property` gilt im Shadow Root nicht (Schatten, Ringe, Transforms, `backdrop-blur` = Panel-Stil) → diese Regeln einmal ins Dokument, das übrige CSS als ein gemeinsames Stylesheet (`adoptedStyleSheets`) in alle Player.
- Dialoge/Hinweise an `document.body` (10 Dateien: `notice.js`, `dialog.js`, `ui-controls.js`, `assets.js` …) → Dialog-Ebene des Players.
- Tastenkürzel an `window` → am Player, nur mit Fokus.
- `document.getElementById` / `window.innerWidth` in `viewer.js` (~30 Stellen) → Elemente und Größe des Players.
- Whitelabel: Farben als CSS-Variablen (`--rindr-*`, gehen durch die Shadow-Grenze), Logo/Preloader austauschbar, kein RINDR-Branding sichtbar.

## Stufen

1. **Instanzen:** `viewer.js` (8.000 Zeilen, 92 Imports) in Runtime + Player teilen; die App läuft als ein Player und verhält sich genau wie vorher – **umgesetzt 06.11.2026**, siehe „Stufe 1“ unten.
2. **`<rindr-player>`** mit Shadow DOM, `features`, Theming; Größe des minimalen Players messen.
3. **Mehrere Player:** gemeinsamer Renderer, Schlafen, ein HQ zur Zeit, gemeinsames Budget, Poster.
4. **Host-Schnittstelle:** Ereignisse, Laden/Speichern übers Host-System, Namens-Adressierung, Einbau-Anleitung (Hosting, CSP), iframe-Rückfall.

## Stufe 1 – umgesetzt (06.11.2026)

Die App verhält sich exakt wie vorher; nur der Aufbau ist neu (Schritte einzeln committet):

- **`src/scripts/app.js`** = Einstieg der Seite (`index.astro`). Importiert `viewer.js` zuerst – dessen erstes Modul `worker-monitor.js` ersetzt `Worker` weiter vor allem anderen (?debug), die Module laufen in derselben Reihenfolge wie vorher. Dann `applyDom()` (von viewer.js hierher), dann liest es die URL und ruft `await createPlayer({ model, sampleScene, hdr })` – **ohne catch**, damit der Start ohne Renderer ein Fehler in der Konsole bleibt (`pageerror`).
- **`viewer.js`** exportiert `createPlayer(options)`: der frühere Modul-Rumpf in einer Funktion. Optionen: `model` (Datei aus public/models), `sampleScene`, `hdr` (Datei aus public/hdr), `assetBase` (Ort von models/, hdr/, oidn/, samplescene/ – Standard `import.meta.env.BASE_URL`), `dom` (wo die festen Elemente per id gesucht werden, Standard `document`), `host` (nimmt die versteckten Datei-Eingaben, Standard `document.body`). Rückgabe = die Debug-Schnittstelle (mit ?debug weiter `globalThis.__viewer`; Keim der späteren Player-Schnittstelle). Ein zweiter Aufruf wirft, bis Stufe 3 die seitenweiten Teile (unten) trennt. Auf Modulebene bleiben nur `lazy()` und der Raycast-Patch (`THREE.Mesh.prototype.raycast`, einmal je Seite).
  - Umbau in zwei Commits: erst die Hülle ohne Einrücken (kleiner Diff, voll geprüft), dann nur Einrücken (`git diff -w` leer, gebauter Code byte-gleich bis auf die Versionsnummer; Commit in `.git-blame-ignore-revs`, GitHub liest die Datei selbst, lokal `git config blame.ignoreRevsFile .git-blame-ignore-revs`).
  - **Fallen beim Einpacken:** keine Destrukturierung der Optionen (Namen wie `dropTarget`, `root`, `base`, `signal` gibt es im Rumpf schon); Konstanten behalten ihren Namen, nur der Initialisierer kommt aus `options`.
- **`src/scripts/runtime.js`** – `getRuntime({ onWaiting, onWaitEnd })`, ein gemerktes Promise je Seite: GPU-Adapter (mit dem Warten nach einem GPU-Reset), Limits, `WebGPURenderer` (antialias, stencil) + `init()`; ohne DOM und Texte. Der Player ruft es an der alten Stelle auf und zeigt Warten (`gpu.waiting`) und Fehler (`status.noRenderer`) selbst.
- **Bewusst noch beim Player / unverändert** (erst mit Shadow DOM oder zwei Playern prüfbar – Stufe 2/3): Größe, Pixeldichte, Tonwert, Schatten des Renderers, RasterAO (`install()` legt die Werte dieser Instanz in den seitenweiten `renderer.contextNode`), BasicView, LensEffects, `setAnimationLoop`, Device-Lost-Wrapper + GPU-Hinweise, Diagnose-Intervall, DPR-Wächter; alle window/document-Listener; Body-Anhänge der anderen Module; `body.ui-hidden`; Vollbild auf `documentElement`; `viewSize()` liefert weiter die Fenstergröße.
- **Prüfweg** (`tools/player-check/`, nur lokal – README dort): Build vorher (A) und nachher (B) von einem kleinen Server mit COOP/COEP (kein Service Worker), Windows-Chrome per CDP mit echter GPU; je 15 Szenarien (leerer Start, ohne ?debug, ?lang=en, Beispielszene mit allen Raster-Modi + Schnittebene + Explosion + HQ, Tasten, STEP/GLB/Splat, ?hdr, Fenstergröße/DPR/Export 2×, Datei-Drop links/rechts, nachgeladene Fenster, verteilt mit Client-Tab, ohne Renderer, GPU-Verlust). Verglichen: Pixel-Hash der Bilder (`exportFrame`), HQ-Rohbild (`snapshotImage`, 64 Samples, ohne Entrauschen/Hochskalieren – **deterministisch**, gleiche Szene = gleiche Pixel), `captureState`, Prüfpunkte, Konsole (Vorkommen statt Anzahl), Tempo im Wechsel A/B. Was schon zwischen zwei A-Läufen abweicht, gilt als Rauschen. Ergebnis aller Schritte: Bilder pixelgleich, HQ exakt, Zustände, Prüfpunkte und Konsole gleich; fps (Drehen, ohne vsync) und HQ-Zeiten im Rauschen; Startzeit (Preloader weg) streut zwischen Läufen derselben Version ±40 % – 30 Paare im Wechsel: Median 1982 → 2086 ms (+5 %), Quartile 1586–2246 / 1788–2400 ms, nicht von Rauschen zu unterscheiden (denkbar ist nur, dass V8 die große Funktion einmal mehr vorab parst – Größenordnung Millisekunden).
  - **Fallen des Prüfstands:** die Beispielszene startet in HQ (Szenen-Datei `view.mode`) und backt ihr Boden-Material zeitversetzt → vor Raster-Bildern `setViewMode('default')` und warten, bis `graphApplier` leer ist; die Splat-Szene dreht die Kamera (immer Rauschen); Material-IDs und `savedAt` sind je Lauf anders; `[Stall]`-Meldungen und Meldungen je Bild hängen vom Takt ab; ein simulierter GPU-Verlust über `device.destroy()` meldet three nicht (Grund „destroyed“) – stattdessen `renderer.onDeviceLost({ … })` aufrufen; die Debug-Anzeige vor Screenshots ausblenden (Live-Werte).

## Seitenweite Zustände (für Stufe 3: mehrere Player)

Was heute einmal je Seite existiert und bei zwei Playern kollidieren würde (Bestandsaufnahme 06.11.2026):

- **Pathtracer-Kernel:** die Vite-Patches binden Modul-Uniforms/Storage direkt in den Kernel – `EMITTER_TABLE`/`EMITTERS` (emitters.js), `PT_MOTION`, `GLASS_SHADOW`, `GLASS_SPLIT`, `CAUSTICS` (+ Gitter), `ADAPTIVE` + `setAdaptiveHandler` (letzte Instanz gewinnt), `LIGHT_PASSES`, `BUCKET_DATA`, `kernelFeatures`, Splat (`GAUSS`, `SPLAT_*`), Gitter-Volumen (`GRID_*`), Wolke (`CLOUD_*`, Licht), Kanten (`EDGE_DATA`), Wolle (`WOOL_GEOMETRIES`), Seife (`sceneCell`), SSS-Atlas, Haar (`HAIR_LIGHT`). **Plan:** nur ein Player rechnet HQ (der zuletzt bediente) und besitzt diese Werte; beim Wechsel baut er seine Szene im Pathtracer neu auf.
- **Raster-Uniforms je Seite:** fisheye `U`, background-dome `U`, `GROUND_SURFACE`, `SHADOW_CATCHER` (ground.js), Wolken-Licht → je Player vor seinem Bild setzen oder auf `materialReference` umstellen (wie `own()` in toon.js).
- **Renderer-Wrapper und -Slots:** RasterAO (`renderer.contextNode`), BasicView (`renderObject`), RenderBatcher und override-hide (`render`), PathTracingView (Backend-Patches für asynchrones Kompilieren und Zeitmessung), `setAnimationLoop`, `onDeviceLost`, KTX2 `detectSupport` → einmal je Runtime installieren, die Player melden sich dort an.
- **Je Player eine eigene Leinwand** (`CanvasTarget`/`renderer.setCanvasTarget`, three r187): sie ist auch das Ereignisziel von Steuerung, Picking, Material-Drop, Doppelklick.
- **UI-Singletons:** notice.js-Stapel, dialog.js `open` + `dialogOpen()` (seitenweite Sperre für Esc/Klick daneben), Farbwähler (ui-controls.js), z-Stapel der freien Fenster (float-window.js); material-transfer.js (BroadcastChannel + `manager` des zuletzt angemeldeten); STEP-WorkerPool + `session` (ein STEP zur Zeit); i18n (eine Sprache je Seite, `applyDom(document)`).
- **Speicher-Schlüssel je Seite:** `rindr.setup.window`, `rindr.distributed`, `rindr.bcf.author`, `rindr.gpuIntegratedHint`, `rindr.gpuLost*`, load-guard (`rindr.loading`, `rindr.safeLoad`), Fensterpositionen der Editoren.
- Sonst: Diagnose-Intervall ohne Ende, `requestIdleCallback` für das Studio-Upgrade, `document.hidden` in `afterPaint`.

## Hinweise für Stufe 2 (Shadow DOM)

- **Größe:** Inhaltsbox von `#viewport` per ResizeObserver beobachten – nie die Leinwand und nie `device-pixel-content-box` (die gehaltene Export-Skalierung ändert nur die Pixeldichte; ein solcher Beobachter gäbe sie sofort frei und das fertige Bild würde neu gerechnet). Größen runden, unveränderte überspringen, Leinwand per CSS 100 % + `setSize(w, h, false)`. ResizeObserver feuert nach dem gezeichneten Bild – `setSize` dort leert die Leinwand (schwarzes Bild beim Ziehen): Größe nur merken, im nächsten Bild vor dem Zeichnen anwenden. Deshalb in Stufe 1 noch window-`resize`.
- **Tasten:** die Esc-Behandlung hängt an der Reihenfolge der window-Capture-Listener (`stopPropagation` in Farbwähler/Assets/Export/KI, `stopImmediatePropagation` in dialog.js); auf `document`/`body` verschoben liefen die des Viewers danach und würden abgeschnitten (Esc bei offenem Farbwähler bräche kein Rendern mehr ab). Stufe 2: ein Tasten-Router (Player mit Fokus + Esc-Stapel) statt der verstreuten Listener. Unter Shadow DOM `e.composedPath()[0]` statt `e.target` (sonst sieht `closest('input…')` nur das Host-Element).
- **Drop:** die Drop-Listener müssen auf `window` bleiben (sonst öffnet der Browser abgelegte Dateien); im Player nur die Zonen.
- **CSS:** `body.ui-hidden …` wird `:host(.ui-hidden) …`; Tailwind-`@property` einmal ins Dokument.

## Offen

- Paket „Szene + Modelle in einer Datei“ (`zip.js` gibt es; heute bewusst kein „Szene verpacken“, docs/scene-state.md).
- Elementname fürs Whitelabel frei wählbar (Unterklasse unter eigenem Namen registrieren)?
- Lizenz/Schlüssel je Kunde beim Dienst, Bindung an Domains.
- WebGL2-Rückfall: ein Kontext je Player, Browser-Grenze (~16) – mit der Obergrenze lebender Player abfangen.
