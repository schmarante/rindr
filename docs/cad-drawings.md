# Zeichnungen: DXF, DWG und Volumenkörper (ACIS)

Nutzer (09.11.2026): „können wir auch dwg/dxf anzeigen? das sind ja nur 2D zeichnungen oder?“. Nach der Erklärung kam „gerne alle drei“, also drei Stufen:
1. DXF
2. Volumenkörper (ACIS → STEP)
3. DWG

**Entscheidungen des Nutzers:**
- Linien und Texte liegen im HQ-Modus **über dem Bild**, wie die Toon-Konturen. Gewählt statt dünner Körper im Pathtracer oder „nur in der Vorschau“.
- **Modellbereich und Layouts sind beim Öffnen wählbar**, statt nur den Modellbereich zu zeigen.

## Weg durch den Viewer

**Zeichnungen gehen den STEP-Weg wie IGES** (`docs/step-import.md`):
- `CAD_EXTENSIONS` (viewer.js) gehört zu `STEP_EXTENSIONS`.
- `readCadContent` übersetzt im Worker (`cad/cad-import.js` `convertCad` → `cad/cad-worker.js`).

**Ergebnis der Übersetzung:**
- **STEP-Text der Volumenkörper:** leer ohne Körper; mit Körpern ab Stufe 2. Er ist `model.content`.
- **`model.extras`:** Linien, Füllungen, Texte und 3D-Flächen als Szenen-Daten (`cad/drawing-build.js`).
- **`model.cadSpace`:** das gewählte Blatt (`'model'` oder `'layout:<Blockname>'`).

**Viewer-Hilfen:**
- **`tessellateCad`:** ersetzt die drei `tessellateStep`-Aufrufe (Hauptmodell, Bauteil-Qualität, weitere Modelle). Ohne STEP-Text liefert es ein leeres Ergebnis.
- **`mergeCadExtras`:**
  - hängt die Knoten der Beigaben **über ihren Schlüssel** (`L:<LAYER>`, `S:SHEET`) an die des STEP-Teils; neue werden angefügt;
  - nimmt die 3D-Flächen als Meshes auf (BVH über `buildGeometryBVHs`, `countId` je Mesh – sonst zählte der Scene Graph sie als einen Körper).
- **`addCadAnnotations`:**
  - legt Linien, Füllungen und Texte in die Layer-Gruppen;
  - zählt sie als Teile, denn der Scene Graph blendet Knoten ohne Teile aus.
- **`cadLoaded`:**
  - Layer, die in der Datei aus oder gefroren sind, werden ausgeblendet (`setHiddenModel`);
  - ein Hinweis zählt auf, was nicht dargestellt ist.
- **Ohne Körper:** Die Qualitätswahl ist aus (`!!currentPlan`). Als `model.size` gilt die Dateigröße, nicht die Länge des STEP-Texts.

**Reine 2D-Zeichnung** (`extras.is2D`: keine 3D-Flächen, alle Punkte in einer waagerechten Ebene):
- Start in der Draufsicht, dann fast-orthografisch (`flyToDirection` nach oben).
- Der Boden bleibt, wie er ist: Der Durchgang der Annotationen blendet ihn bei der Tiefe aus, Linien liegen also immer obenauf.

**Szenen-Zustand:** Das Modell speichert `file.space`, wenn es ein Layout zeigt. Beim Öffnen setzt `withCadSpace` es, dann kommt keine Rückfrage. Ein schon geladenes Modell mit anderem Blatt wird neu gelesen.

## Leser und Modell (`src/scripts/cad/`)

### `drawing.js`
Das gemeinsame Modell für DXF und DWG:
- Kopf: Einheiten `$INSUNITS` → `UNIT_MM`, `$LTSCALE`, `$LWDISPLAY`, `$PDMODE`/`$PDSIZE`, `$FILLMODE`.
- Tabellen: Layer, Linientypen, Textstile, Bemaßungsstile, Blöcke, Layouts.
- Objekte des Modellbereichs und der Papierbereiche als flache Datensätze (Felder im Kopfkommentar).
- Die ACI-Farbtabelle wird erzeugt: 24 Farbtöne × 5 Stufen × voll/halb gesättigt, dazu Grautöne.
- Das Objekt-Koordinatensystem (OCS) nach dem Arbitrary-Axis-Algorithmus.

### `dxf-reader.js`
- **Paare lesen:** ASCII von R12 bis aktuell, binäres DXF mit Codes zu 1 und 2 Byte. Die Gruppenpaare werden direkt aus den Bytes gelesen; nur Text-Werte werden dekodiert.
- **Kodierung:** ab 2007 UTF-8, davor die Codepage aus `$DWGCODEPAGE`; dazu `\U+XXXX`.
- **Objekte:** Jedes Objekt wird als Liste von Paaren gesammelt, dann je Typ umgesetzt.
  - Objekte mit Folge-Datensätzen: POLYLINE mit VERTEX/SEQEND, INSERT mit ATTRIB/SEQEND.
  - Layouts aus den LAYOUT-Objekten. Ihr Name ist die Gruppe 1 **nach** `AcDbLayout`, die erste 1 ist der Name der Seiteneinrichtung.
- **ACIS-Daten:**
  - bis 2010: SAT-Text in den Gruppen 1/3, verschlüsselt mit 159 − c; nach einem kodierten „A“ (0x5E) folgt ein zusätzliches Leerzeichen.
  - ab 2013: SAB im Abschnitt ACDSDATA, nach Handle.
- **Falle:** `TextDecoder` nimmt keine Sichten auf geteilten Speicher. Der Worker kopiert die Datei, wenn sie als SharedArrayBuffer kommt.

### `drawing-build.js`
**Knoten:** Ein Knoten je Layer; die Blockstruktur wird nicht abgebildet, weil Tausende Einfügungen tausende Draw-Calls wären.
- Objekte auf Layer „0“ in Blöcken erben den Layer der Einfügung.
- BYBLOCK nimmt Farbe, Linienstärke und Linientyp der Einfügung.
- Eine Einfügung auf einem gefrorenen Layer bringt ihren ganzen Inhalt in diesen Knoten, damit Ausblenden alles ausblendet.

**Annotationen** (nur im Bild-Durchgang, nicht im Pathtracer):
- Linien je Layer und Breite, mit Farbe je Punkt.
- Flache Füllungen: Schraffur flächig und als Verlauf, SOLID/TRACE, Polylinien mit Breite, WIPEOUT.
- Texte.

**3D-Flächen:** echte Meshes mit Farb-Material (`forStepColor`, wie STEP-Farben). Dazu gehören:
- 3DFACE, Polyface- und Polygon-Mesh, MESH
- Wände von Objekten mit Dicke
- SOLID mit Dicke als Prisma

**Ausrichtung der 3D-Flächen** (`orientFaces`):
- Zeichnungen behalten die Wicklung der Datei. Eine Polyface-Datei hatte 43 von 67 Hüllen innen nach außen und 10 % uneinheitliche Kanten. Die Vorschau zeichnet beide Seiten, der Pathtracer zeigte sie schwarz.
- Deshalb je zusammenhängendem Stück:
  1. Wicklung einheitlich machen, in Breitensuche über Kanten mit genau zwei Flächen.
  2. Nach außen drehen:
     - geschlossen (höchstens 2 % offene Kanten): nach dem Vorzeichen des Volumens;
     - sonst nach der Mehrheit der ursprünglichen Wicklung.
- **Falle:** Erst entschied das Verhältnis |Volumen| / Summe > 0,5 über „geschlossen“. Ein dünnes Uhrenband lag weit darunter und blieb schwarz.
- Danach Knicknormalen (30°, `crease-normals.js`) und Box-UVs.

**Koordinaten:** Millimeter, +Y oben (die +Z der Zeichnung), relativ zu `origin`. Float32 behält so auch bei Vermessungskoordinaten seine Genauigkeit; die Matrix trägt den Ursprung.

**Kurven** (`curves.js`):
- Bogenteilung nach Sehnenfehler: max(Zeichnungsgröße · 1e-5, r · 4e-4), mindestens 8 Teile je Vollkreis.
- NURBS nach de Boor, rational.
- Splines nur aus Fit-Punkten als zentripetales Catmull-Rom.

**Linientypen:**
- Muster laufen durchgehend über die Ecken.
- Wiederholt es sich mehr als 2000-mal, wird durchgezogen gezeichnet (wie im CAD-Programm).

**Linienstärke:** Breiten gibt es nur bei `$LWDISPLAY`. Bis 0,25 mm sind es 1 px, darüber mm · 3,78 px, auf 0,5 px gerundet.

**Schraffuren** (`hatch.js`):
- Grenzen aus Polylinien mit Wölbung oder aus Kanten: Linie, Bogen, elliptischer Bogen, Spline.
  - Bögen im Uhrzeigersinn speichert DXF mit den Ergänzungswinkeln 360 − a.
  - Ellipsen-Kanten tragen Winkel, keine Parameter.
- Inseln über die Schachtelungstiefe, Stile normal/außen/ignorieren.
- Fläche mit earcut.
- Muster: die Musterlinien der Datei (dort schon skaliert und gedreht), gerade-ungerade gegen die Grenzen geschnitten, mit Strichen.
- Zu dicht (Schätzung über dem Budget): nur der Rand, im Hinweis gezählt.

**Texte** (`text-layout.js`, `text-atlas.js`):
- TEXT/ATTRIB mit Ausrichtung (links, Mitte, rechts, ausgerichtet, eingepasst, Mitte-Mitte), Breitenfaktor, Neigung, Spiegelung, Sonderzeichen %%c/%%d/%%p.
- MTEXT mit Formatcodes: Absatz, Schrift, Höhe, Breite, Farbe (`\c` in BGR), Neigung, gestapelte Brüche als a/b. Umbruch an der Rahmenbreite, Bezugspunkt 1–9, Zeilenabstand 5/3 · Höhe.
- **Schrift:**
  - Die Browser-Schrift; wir liefern keine Schriftdateien aus. SHX-Schriften werden durch eine serifenlose ersetzt.
  - Die Texthöhe ist die Höhe eines Großbuchstabens.
- **Glyphen-Atlas:**
  - je Zeichen einmal, per OffscreenCanvas im Worker;
  - als Abstandsfeld mit eigener exakter Distanztransformation; Mipmaps, damit kleine Texte (verkleinerte Ansichtsfenster) nicht verschwinden.

**Blöcke:** INSERT/MINSERT bis 16 Ebenen tief, ohne Selbstbezug. Externe Referenzen werden im Hinweis gezählt.

**Bemaßungen und Tabellen:** über ihren anonymen Block.

**Weitere Objekte:**
- LEADER mit gefüllter Pfeilspitze (Größe aus dem Bemaßungsstil).
- MLINE über die Gehrungsrichtungen.
- POINT nach `$PDMODE`.
- XLINE/RAY auf die doppelte Zeichnungsgröße begrenzt.

**Layouts:**
- Das Blatt kommt aus den Grenzen des Layouts (sonst Papiergröße und Ränder). Es ist eine weiße Füllung, die immer zuerst gezeichnet wird (`renderOrder` −1).
- Auf Papier wird Farbe 7 zu Schwarz.
- **Ansichtsfenster:** Der Modellbereich wird in die Ansicht gerechnet (Ansichtsrichtung über das OCS der Richtung, Ziel, Maßstab Höhe/Ansichtshöhe, Drehung, Mitte) und flach gemacht. Danach zugeschnitten: Linien nach Liang-Barsky, Dreiecke und Glyphen nach Sutherland-Hodgman am Rechteck; die Farben werden dabei nicht interpoliert. Gefrorene Layer des Fensters fehlen.
- 3D-Flächen erscheinen als Kanten (sichtbare Polygonkanten); 2D-Füllungen bleiben gefüllt wie im CAD-Programm.

**Grenzen:**
- Linien, Glyphen und Dreiecke aus dem Speicher-Budget (`cadLimits`).
- Darüber: abgeschnitten, mit Hinweis „Zeichnung gekürzt“.

**Nicht dargestellt** (im Hinweis gezählt): IMAGE/Unterlagen, Proxy-Objekte, MLEADER, SHAPE, OLE, Lichter. Volumenkörper in Layout-Ansichtsfenstern (dort fehlt noch das Kantenbild).

## Volumenkörper: ACIS → STEP (`src/scripts/acis/`, Stufe 2)

**Woher die Daten kommen:**
- 3DSOLID, REGION, BODY und SURFACE einer Zeichnung: `cad/drawing-solids.js` im CAD-Worker.
- Einzelne `.sat`/`.sab`-Dateien: `ACIS_EXTENSIONS` in `STEP_EXTENSIONS`; `readCadContent` → `acis/acis-import.js` → `acis-worker.js`, dann wie IGES.

### `acis-file.js`
**SAT (Text):**
- Drei Kopfzeilen: Version, Produkt, mm je Einheit.
- Datensätze bis `#`; die Satzanfänge werden einmal indiziert, Tokens erst bei Bedarf gelesen (424 MB, 2,7 Mio. Sätze).
- Ab 7.0 stehen im Datensatz eine ID und ein Muster-Zeiger, außer bei Attributen; Zeichenketten sind `@n text`. Vor 7.0 stehen Zeichenketten als `n text`, ohne `@`.
- Unter-Daten in `{ }` werden in Dateireihenfolge nummeriert, `ref n` zeigt darauf zurück. Auch Flächen werden so geteilt.

**SAB (binär):**
- Kennung „ACIS BinaryFile“ oder die der Kernel-Abspaltung, dann gekennzeichnete Werte.
- Alles wird auf dieselben Tokens wie SAT abgebildet: Zeiger `$n`, Wahrheitswerte `T`/`F`, Vektoren als drei Zahlen.
- **Fallen:**
  - Vertex und Coedge haben in SAB eine zusätzliche Zahl vor dem nächsten Zeiger (`nextPtr`).
  - Die Körper-Transformation steht als **eine Zeichenkette in SAT-Form** da. Sie wird zerlegt; vorher fehlte der Versatz, und ein Zylinder stand im Würfel.

**Feldfolgen:** nach der öffentlichen SAT-Beschreibung 7.0 (Kegel-Beispiel: Grundellipse, Kurvenintervall, Sinus, Kosinus, u-Maßstab, Umkehr, Flächenintervalle) und an einer öffentlichen Beispieldatei geprüft.

### `acis-to-step.js`
**Topologie:**
- body → lumps.
- Geschlossene Schalen (jede Coedge hat einen Partner) → `MANIFOLD_SOLID_BREP`/`BREP_WITH_VOIDS`.
- Offene Schalen je Farbe in ein `SHELL_BASED_SURFACE_MODEL`.
- face → `ADVANCED_FACE`, loop → `FACE_BOUND`/`EDGE_LOOP`, coedge → `ORIENTED_EDGE`, edge → `EDGE_CURVE`. Kanten ohne Kurve (Pole, Spitzen) fehlen in der Schleife.

**Flächen:**
- plane → `PLANE`.
- cone:
  - Sinus 0 → `CYLINDRICAL_SURFACE`, sonst `CONICAL_SURFACE`.
  - Der Radius wächst um Sinus/Kosinus entlang der Normalen.
  - Ein negativer Kosinus heißt: die Normale zeigt nach innen, die Fläche wird umgedreht.
  - Elliptische Kegel werden gezählt und weggelassen.
- sphere, torus: ein negativer Radius heißt nach innen.
- spline → B-Spline aus der bs3-Fläche der Unterdaten:
  - exakt: direkt nach dem Namen, „full“ vorweg;
  - prozedural: die erste B-Spline-Fläche auf oberster Ebene.
  - ACIS speichert die Kontrollpunkte **u-schnell** (an einer Datei über Parameterkurven geprüft). Die Endvielfachheit ist dort = Grad, in STEP Grad + 1.

**Kurven:**
- straight → `LINE`, ellipse → `CIRCLE`/`ELLIPSE`.
- intcurve → B-Spline der bs3-Kurve; nur angenommen, wenn ihre Enden auf den Eckpunkten liegen.
- Sonst die Parameterkurve der Coedge (exppc) als `PCURVE` auf der B-Spline-Fläche, in eine zusammengesetzte Kurve gewickelt wie beim IGES-Weg.

**Farben:** `rgb_color`-, `colour`- (ACI) und `truecolor`-Attribute von Fläche, Lump und Körper; bei Zeichnungen die Objektfarbe als Vorgabe.

**Offene Kanten verschweißen:**
- Ein Konverter schrieb jede der 114 000 Flächen eines Fahrzeugs als eigenen Lump, ohne gemeinsame Kante.
- Gleiche Endpunkte (0,1 µm) und gleiche Kurve (Typ, Zahl der Kontrollpunkte, mittlerer Kontrollpunkt) ergeben ein gemeinsames `EDGE_CURVE`; die zweite Fläche nutzt es umgekehrt. Eckpunkte werden über die Position geteilt.
- Ergebnis: 167 805 verschweißte Kanten, STEP 261 → 168 MB, dazu rissfrei.

**Seiten der Flächenmodelle** (`keepSkins`, step-importer.js):
- Der Kern dreht offene Häute so, dass sie von der Körpermitte wegzeigen.
- Bei Blechen, deren Außenseite zur Mitte zeigt (Rückwand eines Fahrerhauses, Kotflügel), war das falsch. Sie waren einseitig unsichtbar; 25 214 Flächen wurden gedreht.
- ACIS-Flächen haben eine eigene Außenseite. Bei Text vom eigenen Konverter (Kopf: Präprozessor „rindr ACIS converter“) entfällt diese Regel. Die Vereinheitlichung entlang der Kanten bleibt; jetzt 1 264 Flächen.

**Hochachse:**
- Einzelne SAT/SAB entscheiden wie STEP über das Programm im Kopf, unbekannte sind +Y. Eine Konverter-SAT eines Fahrzeugs stand auf y 0 … 170 Zoll; als Z-oben gedreht lag sie auf dem Kopf.
- Körper in Zeichnungen sind immer +Z oben: Systemname „… +Z UP“, `Z_UP_SYSTEMS`.

**Zeichnungen:**
- Ein Produkt je Layer mit der Produkt-ID = Knoten-Schlüssel (`L:<LAYER>`). Der STEP-Kern gibt die Produkt-ID jetzt als `key` am Knoten weiter (`step/structure.js`).
- Darüber ein Wurzelprodukt mit dem Namen der Zeichnung. Layer ohne Körper hängt `mergeCadExtras` unter diese Wurzel, dann zeigt der Scene Graph alle Layer auf einer Ebene.
- Einfügungen werden in die Koordinaten gerechnet; Kopien findet der Kern selbst (B-Rep-Kopien).

**Gemeinsamer STEP-Schreiber:** `step-text.js`, vom IGES-Übersetzer übernommen. Dessen Ausgabe ist byte-gleich (MD5 von drei Testdateien vorher/nachher).

**Prüfung:**
- **Öffentliche Beispieldatei** (ACIS 7.0, Würfel mit Kugelmulden, Kantenrundungen): richtig in Raster und HQ, Farben aus Attributen.
- **Fahrzeug-SAT** (ACIS 5.0, 424 MB, 114 040 Spline-Flächen):
  - Umwandlung 12 s in Node, im Browser 7 s, Laden gesamt ≈ 21 s, 476 000 Dreiecke („mittel“).
  - Maße 6 344 × 4 340 × 2 981 mm gegen FBX 6 344 × 4 368 × 2 982 mm; das Bild entspricht der FBX.
- **DXF mit 3DSOLID:** R2000 (SAT-Text) und R2018 (SAB in ACDSDATA) ergeben dieselben 4 Körper und 44 Flächen. Würfel, Zylinder (mit Körper-Transformation), Block gedreht und skaliert liegen richtig, neben Linie und Text.
- **Noch nicht an echten Daten geprüft:** Kegel mit Öffnungswinkel, Torus, prozedurale Spline-Flächen, Parameterkurven als Ersatz.

## Zeichnen (`cad/annotations.js`)

**Ebene und Ausschlüsse:**
- Linien, Füllungen und Texte liegen nur auf Ebene 28 (`ANNOTATION_LAYER`). Raster-Kamera, Schatten, Picking, Batcher und alle anderen Durchgänge lassen sie aus.
- Der Pathtracer lässt sie über `ptHidden` aus.
- Ausgeschlossen sind sie auch bei Hervorhebung (`highlight.js`), Flächen-Untergruppen im Scene Graph, Schnitt-Deckeln, UV-Mapping (kein `userData.key`) und GLB-Export (Warnung `drawing`).

**`AnnotationPass`** nach dem Muster der Konturen, nach ihnen im Bild, auch im Fisheye-Weg:
1. Tiefe der sichtbaren Modell-Meshes in ein eigenes Ziel mit 4× MSAA, etwas nach hinten versetzt. Ohne Meshes entfällt das.
2. Annotationen: Füllungen, dann Linien (three `LineSegments2`, Breite in CSS-px), dann Texte.
3. Vormultipliziert über das Bild.

**Falle Tiefe in einer Ebene:**
- Füllungen und Linien in derselben Ebene schrieben Tiefe. Linien und Texte wurden gestrichelt, Schraffuren in Ansichtsfenstern verschwanden.
- Jetzt schreiben Annotationen keine Tiefe; sie testen nur gegen die Körper, in Zeichenreihenfolge.

**Text-Material:** Abdeckung = smoothstep um 0,5 mit `fwidth`.

## Prüfung (Scratchpad)

**Testdateien:**
- Synthetisch (`cad/t/gen.py` mit einem freien Python-DXF-Werkzeug, nur lokal): jede Objektart, Blöcke (gedreht, gespiegelt, verschachtelt, MINSERT, Attribute), zwei Layouts (eins mit gedrehtem Ansichtsfenster). Als R2018, R2004, R2000 und binär.
- Groß (`big.py`): 3 600 Räume, 26 400 Objekte.
- Referenzbilder desselben Werkzeugs: `ref.py`.

**Skripte:**
- `cad/t/read.mjs` und `build.mjs` (Node): Objektzahlen.
- `orient.mjs`/`orient2.mjs`: Wicklung vorher/nachher.
- `textdbg.mjs`: Lage der Texte.
- `harness/cadtest.js` (Browser): Laden, Layout-Knopf, Bilder Default/HQ/oben/Zoom.
- `harness/cadscene.js`: Szene speichern/öffnen.

**Ergebnisse (Windows-Chrome, RTX 3080):**
- **Synthetische Datei:** deckungsgleich mit dem Referenzbild – Lage, Bögen (auch Extrusion −Z), Ellipsen, Splines, Blöcke, Schraffur mit Insel, Muster mit Bogenkante, Linientypen, Linienstärke, Texte samt Umbruch, ⌀/°/±, gedrehter Text.
- **Formate:** ASCII und binär ergeben dieselben Zahlen; R2000 weicht nur dort ab, wo das Format Objekte anders speichert.
- **Layouts:** Blatt, Rahmen, Ansichtsfenster mit Maßstab und Zuschnitt.
- **Polyface-Datei R12** (67 Netze, 113 000 Dreiecke): 1,5 s, Raster und HQ richtig beleuchtet.
- **Große Zeichnung:** 330 000 Segmente, 1,1 s, Draufsicht von selbst, 60 fps.
- **Szene mit Layout:** Wieder geöffnet zeigt sie dasselbe Blatt, ohne Rückfrage.

**Regression** (`run.js`/`compare.js`, alt gegen neu): Abweichungen nur im Starttext (DXF genannt) und im bekannten Rauschen.
- Ein Schnittbild wich stabil ab (7,9 % der Pixel, Innenseite einer Kugel hinter dem Schnitt).
- Eingegrenzt bis auf **eine Zeile im GLB-Export**, ein Modul, das erst beim Export geladen wird und im Szenario gar nicht läuft. Allein in den alten Stand gebaut, erzeugt sie dieselbe Abweichung: Bündel-Rauschen wie bei der Wolke (`docs/player.md`), keine echte Änderung.
