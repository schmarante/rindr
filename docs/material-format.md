# Material-Format (OpenPBR, MaterialX, Material-Paket)

Ziel (Nutzer, Okt. 2026): eine Material-Bibliothek mit generierten Materialien, RINDR als Viewer dazu – die Materialien sollen in anderen Programmen (Blender, Unreal, Pathtracer mit OpenPBR) so nah wie möglich gleich aussehen. Grundlage ist **OpenPBR Surface** (Academy Software Foundation, Nachfolger von Autodesk Standard Surface / Adobe Standard Material), ausgetauscht als **MaterialX** (`.mtlx`, Node `open_pbr_surface`, MaterialX 1.39).

Grenzen (bewusst so, nicht als Versprechen „läuft überall gleich“):
- OpenPBR legt das Verhalten fest, jeder Renderer setzt es mit eigenen Näherungen um → **dasselbe Material, nicht pixelgleiche Bilder**. Echtzeit-Renderer (Unreal) weichen bei SSS, Dispersion, Volumen, Dünnfilm am meisten ab.
- Prozedurale Nodes von RINDR (Rauschen, Fliesen, Holz, Gewebe, Marmor …) gibt es anderswo nicht → im Paket als **gebackene Texturen**, dazu die reale Kachelgröße.
- Spezialmaterialien (Toon/Konturen, Wolke, Wolle, Gras, Seifenhaut, Leuchtmarmor, Kanten abrunden) sind kein OpenPBR → nur in der RINDR-Beschreibung des Pakets; die `.mtlx` trägt ihre Grundfläche.

## Parameter: RINDR ↔ OpenPBR

RINDR speichert seine Parameter unter den bisherigen Namen (`PARAMS` in `material-manager.js`, gespeicherte Szenen bleiben lesbar); Export/Import bilden sie so ab (`src/scripts/materialx.js`, `OPENPBR`):

| OpenPBR | RINDR-Parameter | Raster (three.js) | HQ (Pathtracer) |
|---|---|---|---|
| `base_weight` × `base_color` | `color` (sRGB-Hex; MaterialX linear) | ✓ | ✓ |
| `base_metalness` | `metalness` | ✓ | ✓ |
| `base_diffuse_roughness` | `diffuseRoughness` | – (Lambert) | ✓ EON (energieerhaltendes Oren-Nayar, in der Bibliothek schon da) |
| `specular_weight` | `specularIntensity` | ✓ (skaliert F0) | ✓ |
| `specular_color` | `specularColor` | ✓ nur Dielektrikum | ✓ Dielektrikum + **F82-Randtönung der Metalle** (`rindr-openpbr`) |
| `specular_roughness` | `roughness` | ✓ (α = r²) | ✓ |
| `specular_roughness_anisotropy` | `anisotropy` (+ `anisotropyRotation` °, OpenPBR: über `geometry_tangent`) | ✓ | ✓ – Richtung folgt den UVs (Box-UVs: Nähte → Mapping je Objekt „Zylinder/Kugel“) |
| `specular_ior` | `ior` | ✓ | ✓ |
| `transmission_weight` | `transmission` | ✓ | ✓ |
| `transmission_color` / `_depth` | `attenuationColor` / `attenuationDistance` (mm) | ✓ | ✓ |
| `transmission_scatter` (+ `_anisotropy`) | `transmissionScatter` (Farbe, „Trübung“) / `transmissionScatterAnisotropy` („Streurichtung“) – über dieselbe Tiefe wie die Tönung | Näherung (weniger Durchlass, gestreuter Anteil als Farbe) | ✓ Medium mit Random Walk (`rindr-medium`, siehe unten) |
| `transmission_dispersion_scale` / `_abbe_number` | `dispersion` / `dispersionAbbe` (three: 20 × scale / Abbe) | ✓ | ✓ spektral (eine Wellenlänge je Pfad) |
| `subsurface_weight` / `_color` / `_radius` | `subsurface` / `subsurfaceColor` / `subsurfaceRadius` (mm) | Näherung | Standard: Näherung (Entscheidung des Nutzers: schnell – docs/materials.md); Checkbox `subsurfaceMode` „Genau (HQ)“ (Wunsch des Nutzers: Checkbox statt Regler; `toggle: true` in `PARAMS`, gespeichert weiter als 0/1 – ebenso „Dünnwandig“ und bei Toon „Toon-Schattierung“, „Flach“, „Kontur“): Medium mit Random Walk nach OpenPBR (`rindr-medium`) |
| `subsurface_radius_scale` | fest 1 : 0,5 : 0,25 (OpenPBR-Standard, so auch exportiert) | – | ✓ (genau) |
| `subsurface_scatter_anisotropy` | `subsurfaceAnisotropy` („Streurichtung“) | – | ✓ (genau) |
| `fuzz_weight` / `_color` / `_roughness` | `sheen` / `sheenColor` / `sheenRoughness` | ✓ (Charlie-Sheen, nicht OpenPBRs LTC-Fuzz) | ✓ (ebenso) |
| `coat_weight` / `_roughness` | `clearcoat` / `clearcoatRoughness` | ✓ | ✓ |
| `coat_color` | `clearcoatColor` | ✓ Näherung (tönt die Grundfarbe) | ✓ tönt alles unter dem Lack (`rindr-openpbr`) |
| `coat_ior` | `clearcoatIor` (Standard 1,5; OpenPBR 1,6) | – (three: fest) | ✓ (`rindr-openpbr`) |
| `coat_roughness_anisotropy`, `coat_darkening` | – | – | – |
| `thin_film_weight` / `_thickness` / `_ior` | `iridescence` / `iridescenceThickness` (**nm**, OpenPBR µm) / `iridescenceIOR` | ✓ | ✓ |
| `emission_color` / `emission_luminance` | `emissive` / `emissiveIntensity` × 100 Nit (Konvention, siehe unten) | ✓ | ✓ |
| `geometry_opacity` | `opacity` (+ Alpha-Map) | ✓ | ✓ |
| `geometry_thin_walled` | `thinWalled` (setzt Dicke 0, keine Absorption) | ✓ | ✓ |
| `geometry_normal` | Normal-Map (auch aus „Relief“ gebacken) | ✓ | ✓ |
| `geometry_coat_normal`, `geometry_coat_tangent` | – | – | – |

Standardwerte der neuen Parameter wie vor ihrer Einführung (z. B. Dünnfilm 400 nm / 1,3 wie three.js, Lack-IOR 1,5) – gespeicherte Materialien sehen unverändert aus; die Datei nennt immer den tatsächlichen Wert.

Emission: three.js rechnet ohne Einheit (Leuchtkraft 1 = Farbe so hell wie angegeben). Konvention im Export: `emission_luminance = emissiveIntensity × 100` (Nit), beim Import zurück. Andere Programme belichten anders – Leuchtstärke dort ggf. nachstellen.

## Streuende Medien (`transmission_scatter`, genaues SSS)

Okt. 2026, Wunsch des Nutzers: Volumen-Streuung für Wachs, Milchglas & Co. – echtes Volumen, auch für SSS als Schalter je Material (die schnelle Näherung bleibt Standard). Ein homogenes Medium im geschlossenen Mesh hinter seiner dielektrischen Oberfläche, Koeffizienten je Welt-mm (`src/scripts/materials/medium.js`, wie in der OpenPBR-Spezifikation):
- **Trübung** (`transmission_scatter`): μt = −ln(Tönung) / Tiefe, μs = Trübung / Tiefe, μa = μt − μs (negative Kanäle angehoben – OpenPBR); Tiefe = `attenuationDistance`. Ohne Tiefe (0) kein Medium. Eine farbige Trübung bei weißer Tönung absorbiert die übrigen Kanäle (so OpenPBR: blaue Trübung → blaues Glas).
- **SSS genau**: μt = 1 / (Radius × 1 : 0,5 : 0,25) je Kanal, Einfachstreu-Albedo aus der Streufarbe über die umgekehrte van-de-Hulst-Näherung (OpenPBR); die Oberfläche ist dann ein Dielektrikum mit der eigenen Rauheit, `subsurface` = Anteil, der ins Medium geht (Rest diffus in der Grundfarbe); die Glas-Lobe tönt dabei nicht (`mediumTint`, die Farbe kommt aus dem Medium).
- Pathtracer (Vite-Plugin `rindr-medium`, `src/scripts/medium-walk.patch.wgsl`, Kernel-Funktion `medium`): Treffer auf die Rückseite eines Medium-Materials = Strecke im Medium → freie Weglänge in einem Farbkanal, gewählt nach Durchsatz × Albedo, gewichtet mit der Mischdichte aller drei (gleichverteilt gewählt wuchs der Rot-Durchsatz je Ereignis bis ×3, die Glühwürmchen-Grenze schnitt diese Pfade ab: Rot zu dunkel). Vor der Fläche: Streuung – Lichtprobe (ein Licht oder Umgebung) gerade durch die Fläche über das Glasschatten-Snippet (Fresnel, Extinktion bis zur Fläche, × cos θ außen / (η² cos θ innen): Licht kommt gebrochen nur aus dem Grenzkegel, und die Brechung der Bibliothek lässt den Strahldichte-Faktor η² weg – ohne den Faktor gut doppelt so hell), Henyey-Greenstein-Richtung, weiter ohne einen Lichtweg zu verbrauchen (höchstens 1024 Ereignisse, Russisches Roulette ab dem dritten). Sonst die Fläche wie üblich, mit der Durchlässigkeit der Strecke statt der Absorption der Bibliothek; nach einer Streuung keine Lichtprobe an der Austrittsfläche (das Licht kam schon über die Proben der Ereignisse). Gestreute Pfade, die hinausgebrochen ein Licht treffen, zählen wie andere Kaustik-Pfade nicht, solange der Glasschatten transparent ist; mit „Undurchsichtig“ keine Proben durch die Fläche, die Pfade finden das Licht selbst (erwartungstreu, rauschiger, gerichtete Lichter durch glatte Flächen fehlen dann). Streuungen nicht in `minPdf`: der Glanz-Filter machte sonst die glatte Austrittsfläche rau (weniger Totalreflexion, zu hell). Materialdaten: drei Werte Streuung, Anisotropie, Tönungs-Schalter hinten an der Material-Struktur (+ 8 Floats); die Absorption in `attenuationColor`/`attenuationDistance`. Objekte im Medium: die Strecke bis zu ihnen zählt als klar.
- Raster: Näherung – Durchlass × (1 − Trübungsanteil über die doppelte Tiefe), Farbe × Medium-Farbe = durchgelassenes Licht (Absorption über die doppelte Tiefe) und beobachtete Streufarbe (van-de-Hulst vorwärts aus μs / μt) nach dem Trübungsanteil gemischt (nur die Streufarbe machte ein leicht trübes Hefeweizen dunkelbraun); als eigener Material-Wert `_mediumColor` (der Node-Graph setzt die Materialfarbe unter einer Farb-Map auf Weiß), gewichtet mit dem Anteil der Transmission-Map (deckender Bierschaum bleibt weiß). SSS genau: im Raster die bisherige Näherung.
- Bibliothek: „Milchglas“ (`glass-milk`), „Jade“ (`sss-jade`).
- Gemessen (RTX 3080, Testkörper Kugel/Platte/Finne, 520 × 420, 128 Samples, Standardszene): Wachs schnell 8 s → genau 26 s, Gelee 3 → 7 s, Milchglas 7 s (Klarglas 3 s), Jade 4 s.

## Material-Paket (`.zip`)

Ein Material = ein Zip (`<name>.zip`, ohne Kompression – Texturen sind schon PNG):

```
<name>.mtlx              MaterialX 1.39: open_pbr_surface + surfacematerial, Texturen als <image>
<name>.rindr.json        RINDR-Beschreibung (verlustfrei: Parameter, Node-Graph, Typ, Spezialeffekte)
<name>.glb               Kugel mit dem Material als glTF (KHR-Erweiterungen) – für Programme ohne MaterialX
preview.png              Vorschau-Kugel (wie im Material-Panel)
textures/<name>_<slot>.png
```

- **Texturen**: je OpenPBR-Eingang eine eigene Datei (`base_color`, `base_metalness`, `specular_roughness`, `coat_weight`, `coat_roughness`, `transmission_weight`, `fuzz_color`, `emission_color`, `geometry_opacity`, `normal`) – Werte-Maps einkanalig als Grau (keine gepackten Kanäle wie glTF metallicRoughness: jedes Programm liest sie gleich). Farb-Maps sRGB (`colorspace="srgb_texture"`), Werte und Normalen roh. Normal-Maps im OpenGL-Format (+Y). Ursprung unten links (MaterialX-Konvention); gebackene Maps werden dafür gespiegelt geschrieben.
- **Faktoren**: Ist neben einer Map ein Wert ≠ 1 gesetzt (three.js multipliziert), steht in der `.mtlx` ein `<multiply>`.
- **Reale Größe**: bei Node-Materialien die Kachelgröße des Ausgangs-Nodes (`size`, mm je Kachel) in der RINDR-Beschreibung (`tileSize`) und als `doc`-Text am `surfacematerial` – nicht als `realworldimagesize`: das gibt es nur am `tiledimage`, und der rechnet damit die UVs um (anderswo falsche Kachelung; der MaterialX-Validator lehnte es am `image` ab). Das Zielprogramm skaliert seine UVs selbst danach. Import-Materialien (Modell-UVs) ohne Größe.
- **RINDR-Beschreibung** (`format: "rindr-material"`, `version: 1`): `material` (wie `materialManager.toJSON`: id, name, params, graph, libraryId), `maps` (Material-Slot → Datei im Paket – stellt Import-Texturen beim Wiedereinlesen her), `tileSize` (mm), `openpbr` (die exportierten Werte), `generator`.
- **Vorschau-glTF**: three.js `GLTFExporter` auf einer Kugel (10 cm) mit einer `MeshPhysicalMaterial`-Kopie. Gebackene Maps (DataTexture) erst als Canvas-Textur – der Exporter zeichnet Texturen auf ein Canvas und scheiterte an reinen Pixeldaten. Abstände mm → m (glTF), Glas mit Tönung bekommt die Volumen-Dicke der Kugel (ohne `thickness` schreibt der Exporter kein `KHR_materials_volume` – das Glas kam farblos an). glTF kennt kein F82, keine Lackfarbe/-IOR, keine diffuse Rauheit – dort fehlen sie.

## Einlesen

- Abgelegt (Fenster) oder über „Material importieren“ (Material-Panel): `.mtlx` (mit den Texturen daneben) oder ein Paket-`.zip`.
- Paket mit `.rindr.json` → daraus (verlustfrei, auch Node-Graph und Spezialeffekte); seine Texturen über `maps`.
- Fremde `.mtlx` → `open_pbr_surface` oder `standard_surface` (Autodesk) nach der Tabelle oben; Texturen über `<image>`/`<tiledimage>`, auch hinter `<multiply>`, `<normalmap>`, `<extract>`, `<convert>` und in `<nodegraph>`-Ausgängen; als Import-Material (Texturen als Nodes „Bild-Textur (aus der Datei)“).
- Das Material landet in der Szene (Material-Panel, Reiter Szene), zugewiesen wird es per Drag & Drop wie jedes andere.
- Eigene `.mtlx` ohne Beschreibung (fremder Weg): Drehung der Anisotropie aus dem `rotate3d` am `geometry_tangent`, Kachelgröße aus dem `doc`-Text („tile = … mm“ → Wiederholung `UV_TILE / Größe` wie auf RINDRs Modell-UVs).

## Blender

`tools/blender/rindr_materialx_import.py` – Add-on (Einstellungen → Add-ons → von Datei installieren; Datei → Importieren → „MaterialX (OpenPBR)“) oder direkt `blender --python rindr_materialx_import.py -- datei.mtlx|paket.zip` (weist den gewählten Objekten zu). Blender 5.2 hat keinen eigenen MaterialX-Import, aber sein Principled BSDF ist OpenPBR sehr nah: `open_pbr_surface` → Principled (Basis, diffuse Rauheit, `specular_weight` × 0,5 → „Specular IOR Level“, Spiegelfarbe = „Specular Tint“ – bei Metallen F82 wie OpenPBR, Anisotropie samt Drehung über Tangente der UVs, IOR, Transmission, SSS – Grundfarbe zur Streufarbe gemischt, Radius-Verhältnis 1 : 0,5 : 0,25, Fuzz → Sheen, Lack mit Farbe und IOR, Dünnfilm, Emission ÷ 100, Deckkraft, „Thin Wall“, Normal-Map); Tönung im Glas als „Volume Absorption“ (je Kanal σ = −ln(Farbe) / Tiefe, als Farbe × Dichte; mm → m für Dateien von RINDR); ein Mapping-Node vor allen Texturen (Kachelung an die UVs des Modells anpassen – RINDRs Kachelgröße steht in der Eigenschaft `rindr_tile_mm`); Pakete werden entpackt, die Bilder in die .blend gepackt. Medium im Glas (OpenPBR wie oben): „Volume Absorption“ (Farbe × Dichte = 1 − Farbe je Kanal) + „Volume Scatter“ (Farbe × Dichte = μs, Anisotropie) über „Add Shader“ am Volumen-Ausgang; SSS mit Radius-Verhältnis aus der Datei und „Subsurface Anisotropy“. Cycles streut in Volumen standardmäßig nur einmal (Volumen-Sprünge 0 – dichte Medien kamen schwarz heraus) → das Add-on hebt die Volumen-Sprünge der Szene auf mindestens 64 (Meldung in der Konsole). Nicht im Principled BSDF: Dispersion (Blender hält den glTF-Wert nur in einem Hilfs-Node).

Vergleich (Okt. 2026, Blender 5.2 Cycles gegen RINDR HQ – Scratchpad `blender/render_cmp.py`, `rindr-ref.js`, `feat-export.js`: gleiche Kugel, Kamera, Studio-HDRI, je einmal über das Add-on und über das `.glb`): Gold, Gold mit F82-Rand, Lack weiß/blau getönt, Lack-IOR 2,5, Ton mit EON sehen gleich aus (Form und Farbe der Lichter, F82-Rand, Lacktönung); RINDR durchgehend etwas heller – die Standardszene hat zusätzlich ein eigenes Licht (Glanzpunkt oben links), das Verhältnis ist bei allen Materialien gleich. Fallstricke beim Vergleichen: three.js' ACES rechnet die Belichtung ÷ 0,6 (+0,74 EV gegenüber Blenders ACES), Blenders „ACES 1.3“ entsättigt intensive Farben stark (Gamut-Kompression: tiefblaues Glas wirkte hellblau) – mit AgX in beiden vergleichen; Glas: RINDR zeigt durch das Glas den Bühnen-Hintergrund (gewollt), Blender mit „Is Camera Ray“ das HDRI; Texturen und Anisotropie folgen den jeweiligen UVs (RINDRs STL-Kugel: Box-UVs, Blenders UV-Kugel).

Medien (Okt. 2026, Scratchpad `medium-ab.js`/`medium-ab3.js` – RINDR mit ausgeblendeten Szenenlichtern, Glasschatten transparent/undurchsichtig, Tone Mapping wählbar –, `blender/medium_ref.py` – exakte Referenz: Glas + „Volume Absorption/Scatter“ mit RINDRs Koeffizienten, Volumen-Sprünge 1024, ohne Glühwürmchen-Grenze; Mittelwert einer Scheibe in der Bildmitte, `py/pngmean.py`): graue Medien gleich (Eichung diffus weiß RINDR +6 Stufen): niedrige Albedo 40/39, mittel 64/58, Milchglas 198/188, Wachs genau 197/187/171 gegen 193/180/166; ohne Tone Mapping auch die farbigen gleich (Gelee 245/43/60 gegen 237/45/62, farbige Absorption 236/59/50 gegen 228/62/52). Fallstrick: **AgX von three.js und Blender unterscheiden sich bei gesättigten Farben** (Gelee unter AgX in Grün/Blau +36 Stufen auseinander, ohne Tone Mapping gleich) – gesättigte Farben ohne Tone Mapping („Standard“) vergleichen. Lichtprobe durch die Fläche (transparent) gegen ohne (undurchsichtig, erwartungstreu): 2–4 % dunkler. Blenders eigenes SSS (Principled, Random Walk) liegt etwas anders als das Medium hinter Glas (eigenes Austrittsmodell) – Wachs genau 197/187/171 gegen 206/197/187.

## Prüfweg

- Ergebnisse (Okt. 2026): Rundweg über das Paket – Parameter identisch, HQ-Bild gleich (mittlere Abweichung 0–0,12 Stufen, Node-Graph samt Nodes zurück); nur `.mtlx` + Texturen – Abweichung 0,65–0,93 (Rauschniveau), alle drei `.mtlx` (Gold mit gedrehter Anisotropie, Holz mit Texturen, Glas mit Dispersion/Tönung) gültig.
- Medien (Okt. 2026): Rundweg Milchglas (Trübung, Streurichtung) und Wachs genau – Parameter identisch, Bild gleich; nur `.mtlx`: Milchglas 0,61, Wachs 2,47 (kommt schnell statt genau an, siehe Offen); beide `.mtlx` gültig.
- Gültigkeit: MaterialX 1.39.4 aus Blender 5.2 (`import MaterialX`, Standardbibliotheken unter `site-packages/MaterialX/libraries`) – Scratchpad `blender/validate_mx.py` (`doc.validate()` gegen die Standardbibliotheken, Node-Definitionen je Node); Aufruf `blender.exe -b --factory-startup --python validate_mx.py -- <Ordner>`.
- Scratchpad `openpbr-hq.js` + `openpbr-variants.json` (HQ-Bilder paarweise: F82, Lackfarbe, Lack-IOR, EON, Anisotropie, Dispersion) und `openpbr-raster.js` (Raster, Anisotropie mit Kugel-Mapping).
- Rundweg: `mtlx-roundtrip.js` – Material über den Knopf exportieren (Download abgefangen), Paket wieder ablegen, Parameter und HQ-Bild vergleichen; `mtlx-foreign.js` – nur `.mtlx` + Texturen ablegen (fremder Weg).

## Offen

- `coat_darkening`, Lack-Anisotropie, eigene Lack-Normale – brauchen eigenen Pathtracer-Code; `subsurface_radius_scale` fest (1 : 0,5 : 0,25 – ein anderer Wert aus einer fremden Datei wird nicht übernommen).
- SSS genau ist kein OpenPBR-Wert: eine fremde `.mtlx` (oder nur die `.mtlx` des Pakets) kommt mit der schnellen Näherung an – offen, ob fremde SSS-Materialien „Genau“ bekommen sollen.
- Medien: Wavefront-Kernel (`PATHTRACING.megakernel` aus) kennt sie nicht (nur Absorption); Objekte im Medium als klar.
- Raster: diffuse Rauheit, F82, Lack-IOR fehlen (Vorschau; HQ ist maßgeblich).
- Szene speichern: Texturen eines importierten MaterialX-Materials gehen dabei verloren (wie beim JSON-Export von Materialien) – das Paket selbst bleibt die Quelle.
- Node-Graph: die neuen Werte (Spiegelfarbe, Lackfarbe …) noch ohne eigene Eingänge am Ausgangs-Node.
- Unreal: nicht geprüft (Interchange liest MaterialX; Echtzeit weicht bei Glas/SSS/Dünnfilm ab) – das `.glb` ist der sichere Weg.
- Bibliothek: alle Presets als Pakete ausgeben (Stapel-Export), Vorschaubilder je Preset.
