# RINDR-Player einbauen – Anleitung für Kunden-Seiten

Der RINDR-Player ist ein HTML-Element (`<rindr-player>`), das ein 3D-Modell oder eine RINDR-Szene im Browser zeigt – vom
schnellen Raster-Bild bis zum Pathtracing (HQ). Diese Anleitung beschreibt den Einbau in eigene Seiten (Shop, PIM,
Konfigurator): Skript, Attribute, Methoden, Ereignisse, Farben, Hosting und Sicherheits-Einstellungen. Technischer
Hintergrund und Stand: `docs/player.md`.

## Kurz

```html
<script type="module" src="https://<dienst>/player/0.1.0/rindr-player.js"></script>

<rindr-player src="/media/4711.glb" style="height:480px"></rindr-player>
```

- Ein Skript je Seite (beliebig viele Player). Es ist klein (≈ 130 KB); der eigentliche Viewer (≈ 4 MB) lädt erst, wenn der
  erste Player startet.
- Die Version steht im Pfad (`0.1.0`): eine neue Version ändert nie, was eine Seite schon einbindet.
- Ohne Höhe von der Seite ist der Player 480 px hoch, die Breite wie ein Block-Element.
- Browser mit WebGPU (Chrome/Edge aktuell): alles inklusive HQ. Ohne WebGPU zeigt nur der erste Player einer Seite ein Bild
  (Raster, ohne HQ), die weiteren einen Hinweis.

## Attribute

| Attribut | Bedeutung |
|---|---|
| `src` | Modell-URL (STEP, IGES, glTF/GLB, FBX, OBJ, STL, PLY, 3MF, USD, IFC, Gaussian Splats …) |
| `scene` | RINDR-Szene (JSON aus „Szene speichern“ bzw. `getScene()`); ihre Modelle liegen daneben oder kommen über `resolveAsset` |
| `hdr` | HDRI-URL (.hdr/.exr) – gewinnt gegen das HDRI der Szene |
| `mode` | `default` (Raster, Standard) oder `hq` (Pathtracing, sobald die Kamera stillsteht); dazu `basic`, `uv`, `wire` |
| `features` | eingeschaltete Oberfläche, Liste mit Leerzeichen oder Komma: `scene-graph`, `properties`, `materials`, `material-editor`, `explode`, `transform`, `section`, `views`, `view-cube`, `view-modes`, `open`, `save`, `render`, `ki`, `animation`, `setup`, `fullscreen` – `all` = alles. Ohne `features`: nur das Bild (drehen, zoomen, HQ per Taste 3) |
| `activate` | `auto` (sofort, Standard), `visible` (sobald der Player in die Nähe des sichtbaren Bereichs kommt), `click` (Start-Knopf) |
| `poster` | Bild, bis der Player sein Modell zeigt |
| `frame` | den Player in einem iframe starten (siehe „iframe“) |
| `lang` | Sprache (sonst die der Seite) – wie bei jedem HTML-Element |

`src`, `scene`, `hdr` und `mode` dürfen sich nach dem Start ändern (der Player lädt bzw. wechselt), die übrigen gelten ab
dem Start. Alle Namen sind normale HTML-Attribute (W3C-valide, kein `data-`).

## Methoden

Alle Methoden geben ein Promise zurück. Ein Player, der noch auf seine Aktivierung wartet (`activate="click"` /
`"visible"`), startet beim ersten Aufruf; Methoden, die Teile ansehen, warten, bis das Modell geladen ist.

| Methode | |
|---|---|
| `load(url)` / `load({ src, scene, hdr, files, package })` | Modell oder Szene laden; `scene` als URL oder als Daten (`getScene()`), `files` = `{ Dateiname: URL oder Blob }` für die Dateien, die die Szene nennt, `package` = Zip aus `getPackage()`. Ergebnis `{ models, missing, parts }` |
| `getParts(muster?)` | Teile: `[{ path, name, model, visible, materials }]` |
| `setMaterial(teile, material)` | Material zuweisen (ein Rückgängig-Schritt); `material` = ID eines Szenen-Materials, ID aus der Bibliothek (z. B. `'metal-chrome'`), Name, oder `{ library }`, `{ id }`, `{ name }`, `{ name, params }` (neues Material) – Ergebnis: Material-ID |
| `getMaterials()` / `getLibrary()` | Materialien der Szene / der Bibliothek |
| `setVisible(teile, sichtbar)` | ein-/ausblenden |
| `select(teile \| null)` | auswählen wie per Klick |
| `frame(teile?)` | Kamera auf die Teile (oder alles) |
| `getViews()` / `setView(name \| { position, target, fov })` | gespeicherte Ansichten / Kamera setzen |
| `setMode(mode)` / `getMode()` | Darstellungsart |
| `render({ width, scale, transparent, samples, hq, type, quality })` | Bild als Blob: Pathtracing (Standard) oder das Raster-Bild (`hq: false`); `type` `image/png` (Standard) oder `image/jpeg` |
| `getScene()` | die Szene als Daten (dasselbe JSON wie „Szene speichern“) |
| `getPackage()` | die Szene mit Modell-Dateien (und HDRI) als Zip |
| `save()` | wie der Speichern-Knopf (löst `rindr-save` aus) |
| `start()` | einen wartenden Player starten |

**Teile per Name.** Ein Pfad ist die Kette der Knoten-Namen aus der Datei, mit `/` getrennt:

- `'Gehäuse/Deckel'` – der Knoten Deckel unter Gehäuse
- `'Rad'` – alle gleichnamigen Knoten dieser Ebene; `'Rad[2]'` nur der zweite (in Datei-Reihenfolge)
- `'Gehäuse/*'` – alle Kinder; `*` im Namen: beliebige Zeichen (`'Schraube*'`)
- `'**/Schraube*'` – in jeder Tiefe
- Namen mit `/ [ ] * \` schreiben einen Backslash davor. Mehrere Muster als Liste: `['Deckel', 'Boden']`.

Gespeicherte Szenen merken sich diese Namen: exportiert ein Konfigurator eine Variante (Knoten hinzugekommen oder
umsortiert), finden Materialien, Ausblendungen und Verschiebungen ihre Teile wieder.

**Fehler** haben einen `code`: `no-part` (kein Teil passt), `no-material`, `no-view`, `bad-argument`, `load-failed`,
`render-failed`.

## Ereignisse

Am Element, sie steigen auf und gehen durch Shadow DOM (`addEventListener` am Element oder am Dokument):

| Ereignis | `detail` |
|---|---|
| `rindr-ready` | – (Player läuft) |
| `rindr-progress` | `{ active, text, fraction }` (Laden, Aufbereiten …) |
| `rindr-load` | `{ models, missing, parts }` – Modell oder Szene fertig |
| `rindr-select` | `{ kind, name, path }` (`kind`: `part`, `surface`, `parts` mit `paths`, `light`, `view` …) oder `null` |
| `rindr-change` | `{ action, label }` – eine Änderung, die man rückgängig machen kann (`record`), oder Rückgängig/Wiederholen |
| `rindr-mode` | `{ mode }` |
| `rindr-error` | `{ message, name, title }` (`start: true`: der Player konnte nicht starten) |
| `rindr-save` | `{ scene, json, name, package() }` – **abbrechbar** |

**Speichern über das eigene System:** ruft die Seite in `rindr-save` `preventDefault()` auf, übernimmt sie die Szene
(z. B. ins PIM), es gibt keinen Datei-Dialog. Ohne Abbrechen speichert der Player wie gewohnt als Datei.

```js
const p = document.querySelector('rindr-player');
p.addEventListener('rindr-save', async e => {
  e.preventDefault();
  await fetch('/pim/scene/4711', { method: 'PUT', body: e.detail.json });
});
// später wieder öffnen – die Modell-Dateien kennt das PIM:
p.resolveAsset = (name, kind) => kind === 'model' ? `/pim/files/${encodeURIComponent(name)}` : null;
await p.load({ scene: await (await fetch('/pim/scene/4711')).json() });
```

`element.resolveAsset = (name, kind) => URL | Blob | null` (`kind`: `model`, `hdri`) sagt dem Player, wo eine Datei liegt,
die eine Szene beim Namen nennt.

## Beispiel: Konfigurator

```html
<rindr-player id="p" src="/media/4711.glb" features="materials save"></rindr-player>
<select id="farbe"><option value="metal-chrome">Chrom</option><option value="paint-car-red">Rot</option></select>
<script type="module">
  const p = document.getElementById('p');
  farbe.onchange = () => p.setMaterial('Gehäuse/Deckel', farbe.value);
  p.addEventListener('rindr-select', e => e.detail?.path && zeigeInfo(e.detail.path));
  bildKnopf.onclick = async () => upload(await p.render({ width: 2000, transparent: true }));
</script>
```

## Farben (Whitelabel)

Am Element (oder einem Vorfahren) per CSS – oder für alle Player der Seite per `RINDR.configure`:

```css
rindr-player {
  --rindr-accent: #e30613;      /* Akzentfarbe (Knöpfe, Auswahl, Regler); hellere/dunklere Töne werden daraus gemischt */
  --rindr-panel: #001a33;       /* Grundton der Panels und Fenster (mit ihrer Deckkraft) */
  --rindr-background: #202020;  /* hinter dem 3D-Bild */
  --rindr-font: system-ui, sans-serif;
}
```

```js
RINDR.configure({ theme: { accent: '#e30613', font: 'system-ui, sans-serif' } });
```

Eine Regel der Seite am Element gewinnt gegen `configure`. Das RINDR-Logo bleibt immer sichtbar.

`RINDR.configure({ base })` – wo die Dateien des Players liegen (Standard: der Ordner des Skripts). `RINDR.version` – die
genaue Version.

## Hosting

**Über unseren Dienst:** Skript-URL wie oben. Der Server sendet `Access-Control-Allow-Origin: *` und
`Cross-Origin-Resource-Policy: cross-origin` (GitHub Pages: CORS von sich aus; eigener Server: `public/.htaccess`).
Hinweis für die Datenschutzerklärung des Kunden: beim Laden des Players überträgt der Browser die IP-Adresse der Besucher
an unseren Server (Selbst-Hosten vermeidet das).

**Selbst hosten:** den Ordner `player/<version>/` aus dem Build (`npm run build` → `dist/player/<version>/`) unverändert
auf den eigenen Server kopieren und das Skript von dort laden. Alle Pfade darin sind relativ – jeder Ordner geht. Zum
Behalten älterer Versionen die alten Ordner liegen lassen.

**Modelle** lädt der Player per `fetch` von der angegebenen URL: liegen sie auf einem anderen Server als die Seite, muss
dieser CORS erlauben.

## Sicherheits-Einstellungen der Seite (CSP)

Hat die Seite eine Content-Security-Policy, braucht der Player:

```
script-src   'self' https://<dienst>;      (bzw. der eigene Server)
worker-src   blob:;                         (Worker aus einem anderen Ursprung starten über blob:)
script-src   'wasm-unsafe-eval';            (WebAssembly: Entrauscher, Importer)
connect-src  https://<dienst> <Modell-Server>;
img-src      blob: data:;
```

**Isolierte Seiten** (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`): der Player
läuft, große STEP-Dateien laden dann schneller (SharedArrayBuffer, mehrere Kerne). Ohne Isolation nimmt er die
Ausweichwege – alles funktioniert, nur langsamer bei großen Dateien.

## iframe

Lässt die Seite den Player nicht zu (strenge CSP, Framework), läuft er in einem iframe – mit derselben Schnittstelle:

```html
<rindr-player frame src="/media/4711.glb" features="materials"></rindr-player>
```

Methoden, Ereignisse, `resolveAsset` und `--rindr-*`-Farben gehen über `postMessage` in den Rahmen und zurück. Nachteil:
jeder Rahmen braucht eigenen Grafikspeicher und kompiliert das HQ selbst – für einzelne Player gedacht, nicht für Raster
mit vielen.

Ganz ohne unser Skript auf der Seite: `<iframe src="https://<dienst>/player/0.1.0/frame.html#src=<URL>&features=…">` und
das Protokoll aus `src/scripts/player/frame.js` direkt sprechen (`{ rindr: 1, id, call, args }` → `{ rindr: 1, id, result }`,
Ereignisse als `{ rindr: 1, event, detail }`; zuerst `{ rindr: 1, id, call: 'hello', args: [{ saves: true }] }` schicken,
sobald der Rahmen `{ rindr: 1, event: 'frame-ready' }` meldet).

## Mehrere Player auf einer Seite

Alle Player einer Seite teilen sich Grafikkarte und Renderer. Nur einer rechnet HQ (der zuletzt bediente; mehrere
`mode="hq"` der Reihe nach), die anderen frieren auf ihrem letzten Bild ein; unsichtbare Player schlafen. Für Raster mit
vielen Produkten: `activate="visible"` + `poster` – dann lädt auch das große Skript erst beim ersten sichtbaren Player.
