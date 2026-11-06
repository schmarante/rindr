# RINDR-Player – Einbettung und Whitelabel

**Stand: geplant (06.11.2026), noch kein Code.** Wunsch des Nutzers: „RINDR als Whitelabel-Lösung in PIM-Systeme und Shops … eine Minimal-Konfiguration, Material-Editor, Scene Graph, Explosion, Laden/Speichern etc. sind alles Optionen, die man über Attribute aktivieren könnte … es sollte natürlich auch möglich sein, dass man in einem PIM mehrere RINDR-Player gleichzeitig anzeigen kann“. Anlass: ein Produktkonfigurator, der GLB, STEP oder gleich die RINDR-Szene ausgibt.

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

1. **Instanzen:** `viewer.js` (8.000 Zeilen, 92 Imports) in Runtime + Player teilen; die App läuft als ein Player und verhält sich genau wie vorher (größter, riskantester Teil – schrittweise, mit den vorhandenen Prüfskripten).
2. **`<rindr-player>`** mit Shadow DOM, `features`, Theming; Größe des minimalen Players messen.
3. **Mehrere Player:** gemeinsamer Renderer, Schlafen, ein HQ zur Zeit, gemeinsames Budget, Poster.
4. **Host-Schnittstelle:** Ereignisse, Laden/Speichern übers Host-System, Namens-Adressierung, Einbau-Anleitung (Hosting, CSP), iframe-Rückfall.

## Offen

- Paket „Szene + Modelle in einer Datei“ (`zip.js` gibt es; heute bewusst kein „Szene verpacken“, docs/scene-state.md).
- Elementname fürs Whitelabel frei wählbar (Unterklasse unter eigenem Namen registrieren)?
- Lizenz/Schlüssel je Kunde beim Dienst, Bindung an Domains.
- WebGL2-Rückfall: ein Kontext je Player, Browser-Grenze (~16) – mit der Obergrenze lebender Player abfangen.
