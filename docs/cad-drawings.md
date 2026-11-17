# Zeichnungen: DXF, DWG und Volumenkörper (SAT)

Nutzer (09.11.2026): „können wir auch dwg/dxf anzeigen? das sind ja nur 2D zeichnungen oder?“. Nach der Erklärung kam „gerne alle drei“, also drei Stufen:
1. DXF
2. Volumenkörper (SAT → STEP)
3. DWG

**Entscheidungen des Nutzers:**
- Linien und Texte liegen im HQ-Modus **über dem Bild**, wie die Toon-Konturen. Gewählt statt dünner Körper im Pathtracer oder „nur in der Vorschau“.
- **Modellbereich und Layouts sind beim Öffnen wählbar**, statt nur den Modellbereich zu zeigen.

## Weg durch den Viewer

**Zeichnungen gehen den STEP-Weg wie IGES** (`docs/step-import.md`):
- `CAD_EXTENSIONS` (viewer.js: `dxf`, `dwg`) gehört zu `STEP_EXTENSIONS`.
- `readCadContent` übersetzt im Worker (`cad/cad-import.js` `convertCad` → `cad/cad-worker.js`). Der DWG-Leser wird dort erst bei einer `.dwg` nachgeladen (dynamischer Import).

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
- **Ohne Einheit** (`$INSUNITS` 0): Zoll, wenn die Zeichnung imperial ist (`$MEASUREMENT` 0, so wie das CAD-Programm es dann annimmt), sonst Millimeter. Vorher immer Millimeter: ein imperialer Grundriss von 480 Einheiten wurde ein 48-cm-Haus. Metrische ohne Einheit bleiben Millimeter – ob mm oder m gemeint ist, steht nirgends (ein Bett von 2 Einheiten ist dann 2 mm groß).
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
- **SAT-Daten:**
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
- **Speicher** (`meshGeometry`, `orientFaces`): Verschweißen über eine Hash-Tabelle auf den Float32-Bits, Kanten als Halbkanten nach unterer Ecke sortiert (CSR), Ecken je (Punkt, Normale) über die Ecken je Punkt – alles in typisierten Arrays. Vorher Text-Schlüssel und ein Array je Kante: 1,25 Mio. Dreiecke brauchten 3,2 GB und 7,9 s, jetzt 1,1 s. Ergebnis gleich (Fläche, Volumen, Zahlen der Testdateien).

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

**Bemaßungen:** über ihren anonymen Block, eingefügt am Punkt „12“ (OCS; in DWG dazu Maßstab und Drehung der Einfügung). Liegt eine Bemaßung in einem Block, steht ihre Geometrie in Weltkoordinaten und „12“ ist minus die Einfügung – ohne ihn lagen solche Bemaßungen doppelt verschoben neben dem Blatt (Ziegel-Zeichnung eines Nutzers, DXF).

**Tabellen** (ACAD_TABLE): ebenfalls ein anonymer Block (`*T…`), aber relativ zum Einfügepunkt – also wie eine Einfügung (Punkt, Drehung aus der waagerechten Richtung). Bis zur DWG-Stufe lief die Tabelle wie eine Bemaßung und stand am Ursprung; DWG bis 2007, DXF 2007 und DXF 2018 ergeben jetzt dieselben Linien.

**Weitere Objekte:**
- LEADER mit gefüllter Pfeilspitze (Größe aus dem Bemaßungsstil).
- **MULTILEADER** (Multi-Führungslinie: Linien mit Pfeil, Knick/Landung, dazu ein Text oder ein Block, z. B. eine Positionsnummer im Kreis):
  - DXF: der Kontext `300 CONTEXT_DATA{ … 301 }` mit den Wurzeln `302 LEADER{` (Anschlusspunkt 10, Richtung 11, Landung 40) und ihren Linien `304 LEADER_LINE{` (Punkte ab der Pfeilspitze); Text 304 im Kontext (Ort 12, Richtung 13, Höhe 41, Breite 43, Ausrichtung 171 = obere Ankerpunkte 1–3), Block 341/15/16/46; danach die eigenen Werte (Linientyp 170, Farbe 91, Stärke 171, Pfeil 342, Beschriftungen 330/302).
  - Gezeichnet: Linie Pfeilspitze → Punkte → Anschlusspunkt, Landung um die Länge in Knick-Richtung, Text als MTEXT, Block wie eine Einfügung; Spline-Linien laufen tangential in die Landung. Pfeilformen nach dem Namen des Pfeil-Blocks (`_NONE`, `_DOT…`, `_OPEN…`, `_ARCHTICK`/`_OBLIQUE`, sonst gefüllt).
  - Farben „von Block“ = die Farbe des Multileaders selbst. Die Beschriftungen eines Blocks ersetzen den Text seiner Attributdefinitionen (`ctx.labels`, nach Handle).
  - Noch nicht: Textrahmen (292), Linientyp der Führungslinie, eigene Pfeil-Blöcke werden als gefüllter Pfeil gezeichnet.
- MLINE über die Gehrungsrichtungen.
- POINT nach `$PDMODE`.
- XLINE/RAY: nur über die Ausdehnung der Zeichnung gezogen (Kopf `$EXTMIN/$EXTMAX`, sonst geschätzt; Liang-Barsky im Grundriss, 2 % Rand). Wie „Alles zeigen“ im CAD-Programm, das Konstruktionslinien auslässt – vorher machte die doppelte Zeichnungsgröße die Ansicht viermal so weit wie die Zeichnung. Trifft die Linie die Ausdehnung nicht: die halbe Zeichnungsgröße um ihren Punkt.

**Layouts:**
- Das Blatt kommt aus den Grenzen des Layouts (sonst Papiergröße und Ränder). Es ist eine weiße Füllung, die immer zuerst gezeichnet wird (`renderOrder` −1).
- Auf Papier wird Farbe 7 zu Schwarz.
- **Ansichtsfenster:** Der Modellbereich wird in die Ansicht gerechnet (Ansichtsrichtung über das OCS der Richtung, Ziel, Maßstab Höhe/Ansichtshöhe, Drehung, Mitte) und flach gemacht. Danach zugeschnitten: Linien nach Liang-Barsky, Dreiecke und Glyphen nach Sutherland-Hodgman am Rechteck; die Farben werden dabei nicht interpoliert. Gefrorene Layer des Fensters fehlen.
- 3D-Flächen erscheinen als Kanten (sichtbare Polygonkanten); 2D-Füllungen bleiben gefüllt wie im CAD-Programm.
- **Volumenkörper** (SAT) erscheinen dort ebenfalls als Kanten (`SatStep.wire`, je Objekt einmal berechnet – mehrere Fenster zeigen dasselbe): Geraden, Bögen in Schritten ≤ 5° (Richtung aus dem Sinn der Kante, Bögen laufen gegen den Uhrzeiger um ihre Normale), Schnittkurven in 32 Stücken ihrer Näherung; Kanten ohne Kurve (Pole, Spitzen) fehlen. Kein verdecktes Kantenbild – alle Kanten sichtbar wie die Drahtansicht im CAD-Programm. Vorher fehlten die Körper in Ansichtsfenstern ganz (ein Blatt einer Visualisierungsszene war leer, jetzt 25 000 Segmente, 0,2 s).

**Grenzen:**
- Linien, Glyphen und Dreiecke aus dem Speicher-Budget (`cadLimits`).
- Darüber: abgeschnitten, mit Hinweis „Zeichnung gekürzt“.

**Lichter** (LIGHT, DXF und DWG) werden Szenen-Lichter des Viewers – derselbe Weg wie bei glTF/.fbx/… (`docs/mesh-import.md` „Lichter aus Dateien“): `drawing-build.js` liefert `lights` in der Form von `importedLight` (mm, +Y oben, absolut), `mergeCadExtras` hängt sie an das Ergebnis, `addImportedLights` legt sie an und skaliert alle zusammen auf die Helligkeit der Standardlichter (Haupt- und Fülllicht gehen aus).
- Art: entfernt → Richtung, Punkt → Punkt, Spot → Spot (Hotspot/Abfall sind volle Kegelwinkel: halber Winkel = Abfall/2, Rand = 1 − Hotspot/Abfall), **Web-Licht** (Art 10 – photometrisch mit Verteilungsdatei, meist Downlights) → breiter Spot (70°, Rand 0,7).
- Stärke: der Faktor der Datei, Einheit `relative` (die Verhältnisse der Lichter bleiben). Die photometrischen Werte (Candela, Farbtemperatur, Verteilungsdatei) stehen in einem Erweiterungs-Wörterbuch des Lichts – nicht gelesen.
- Farbe: die eigene Lichtfarbe (DWG: CMC im Objekt; DXF: 421/63), nicht die Objektfarbe (die färbt nur das Symbol).
- Ausgeschaltete Lichter und Lichter auf ausgeblendeten Layern fehlen; nur im Modellbereich (nicht durch Ansichtsfenster eines Layouts).
- DXF-Winkel in Grad, DWG in Radiant. Die Sonne einer Szene (SUN-Objekt am Ansichtsfenster, Richtung aus Datum, Uhrzeit und Ort) ist nicht dabei.
- Geprüft: zwei Visualisierungsszenen (10 Spots/Web-Lichter, 18 Punktlichter, auch in Blöcken), selbst erzeugte DXF (Spot, Richtung, ausgeschaltetes Licht).

**Nicht dargestellt** (im Hinweis gezählt, bei DWG mit dem Objektnamen): IMAGE/Unterlagen, Proxy-Objekte, SHAPE, OLE, Toleranzen (Form- und Lagetoleranzen), Schnittobjekte.

## Volumenkörper: SAT → STEP (`src/scripts/sat/`, Stufe 2)

**Woher die Daten kommen:**
- 3DSOLID, REGION, BODY und SURFACE einer Zeichnung: `cad/drawing-solids.js` im CAD-Worker.
- Einzelne `.sat`/`.sab`-Dateien: `SAT_EXTENSIONS` in `STEP_EXTENSIONS`; `readCadContent` → `sat/sat-import.js` → `sat-worker.js`, dann wie IGES.

### `sat-file.js`
**SAT (Text):**
- Drei Kopfzeilen: Version, Produkt, mm je Einheit. **Vor Version 2.0 nur die erste** (DWG R14 schreibt SAT 1.06) – drei überlesen hieß: der Körper-Datensatz fehlte, nichts wurde übersetzt.
- Datensätze bis `#`; die Satzanfänge werden einmal indiziert, Tokens erst bei Bedarf gelesen (424 MB, 2,7 Mio. Sätze).
- Ab 7.0 stehen im Datensatz eine ID und ein Muster-Zeiger, außer bei Attributen; Zeichenketten sind `@n text`. Vor 7.0 stehen Zeichenketten als `n text`, ohne `@`.
- Unter-Daten in `{ }` werden in Dateireihenfolge nummeriert, `ref n` zeigt darauf zurück. Auch Flächen werden so geteilt.

**SAB (binär):**
- Kennung „SAT BinaryFile“ oder die der Kernel-Abspaltung, dann gekennzeichnete Werte.
- Alles wird auf dieselben Tokens wie SAT abgebildet: Zeiger `$n`, Wahrheitswerte `T`/`F`, Vektoren als drei Zahlen.
- **Fallen:**
  - Vertex und Coedge haben in SAB eine zusätzliche Zahl vor dem nächsten Zeiger (`nextPtr`).
  - Die Körper-Transformation steht als **eine Zeichenkette in SAT-Form** da. Sie wird zerlegt; vorher fehlte der Versatz, und ein Zylinder stand im Würfel.
  - **Intervallgrenzen** sind ein Wahrheitswert „endlich“: `T` und der Wert, `F` allein = unendlich. In SAT heißt es `F Wert` bzw. `I` – nach SAT-Art gelesen verschob ein SAB-`F` alle folgenden Zahlen, jeder Zylinder wurde zum Kegel (Bleche einer DWG sahen zerknittert aus). `Cursor.bound()` unterscheidet nach `binary`.

**Feldfolgen:** nach der öffentlichen SAT-Beschreibung 7.0 (Kegel-Beispiel: Grundellipse, Kurvenintervall, Sinus, Kosinus, u-Maßstab, Umkehr, Flächenintervalle) und an einer öffentlichen Beispieldatei geprüft.

### `sat-to-step.js`
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
  - Elliptische Zylinder (Sinus 0, Verhältnis ≠ 1) → `SURFACE_OF_LINEAR_EXTRUSION` der Grundellipse entlang der Achse; ihre Normale (Tangente × Achse) zeigt wie beim Zylinder von der Achse weg. Elliptische Kegel werden gezählt und weggelassen (keine Testdatei).
- sphere, torus: ein negativer Radius heißt nach innen.
- spline → B-Spline aus der bs3-Fläche der Unterdaten:
  - exakt: direkt nach dem Namen, „full“ vorweg;
  - prozedural: die erste B-Spline-Fläche auf oberster Ebene (verschachtelte Unterdaten – Stützflächen, Profilkurven – zählen nicht). Geprüft an Loft (`skin_spl_sur`), Versatz (`off_spl_sur`), Rundung (`rb_blend_spl_sur`, auch mit einer Rundung als Stützfläche), Rotation (`rot_spl_sur`), Sweep (`sum_spl_sur`).
  - SAT speichert die Kontrollpunkte **u-schnell** (an einer Datei über Parameterkurven geprüft). Die Endvielfachheit ist dort = Grad, in STEP Grad + 1.
  - **Gewichtete Splines** (`nurbs`) haben nach den Graden ein Wort für die gewichtete Richtung (`both`, `u`, `v`), erst dann Schluss und Singularität. Ohne das Wort verschob sich alles, die Fläche galt als unlesbar – jede gewichtete Fläche fehlte (eine Szene: 10 Rotationsflächen). Kurven ebenso (`skipRationalWord`).
  - **Prozedural ohne Näherung** (Eckübergang `VBL_SURF` in neueren Dateien): `fillFace` baut einen Ersatz aus dem Rand der Fläche – Ecken, Bögen (8 Punkte) und Schnittkurven (8 Punkte ihrer Näherung); liegt er in einer Ebene → `PLANE`, sonst die quadratische Höhenfläche über der Ebene des Rands (Newell-Normale der Schleife = Außenseite, kleinste Quadrate; eine Kugelkappe ist genau so eine) als Bézier-Fläche 3 × 3 über dem Rand-Rechteck + 5 %. Das Netz behält die exakten Kanten (der Kern teilt ihre Punkte mit den Nachbarflächen), nur das Innere ist geschätzt. Passt keine Höhenfläche (Abweichung > ½ Höhe), fehlt die Fläche weiter. Zählt als `filled`, nicht im Hinweis. Vorher fehlten die Flächen, die Körper hatten Löcher (eine Szene: 2 Kappen, 160 offene Kanten).

**Kurven:**
- straight → `LINE`, ellipse → `CIRCLE`/`ELLIPSE`.
- intcurve → B-Spline der bs3-Kurve; angenommen, wenn die Eckpunkte der Kante **auf** ihr liegen (2 % ihrer Größe; prozedurale Unterdaten enthalten auch andere Splines). Vorher mussten die Kurvenenden auf den Eckpunkten liegen: Teilstücke geschlossener Kurven und Näherungen, die 0,04–0,15 mm vor der Ecke enden, fielen durch – 21 Kanten in zwei Szenen fehlten, die Flächen daneben bekamen Risse.
- Sonst die Parameterkurve der Coedge (exppc) als `PCURVE` auf der B-Spline-Fläche, in eine zusammengesetzte Kurve gewickelt wie beim IGES-Weg.

**Farben:** `rgb_color`-, `colour`- (ACI) und `truecolor`-Attribute von Fläche, Lump und Körper; bei Zeichnungen die Objektfarbe als Vorgabe.

**Offene Kanten verschweißen:**
- Ein Konverter schrieb jede der 114 000 Flächen eines Fahrzeugs als eigenen Lump, ohne gemeinsame Kante.
- Gleiche Endpunkte (0,1 µm) und gleiche Kurve (Typ, Zahl der Kontrollpunkte, mittlerer Kontrollpunkt) ergeben ein gemeinsames `EDGE_CURVE`; die zweite Fläche nutzt es umgekehrt. Eckpunkte werden über die Position geteilt.
- Ergebnis: 167 805 verschweißte Kanten, STEP 261 → 168 MB, dazu rissfrei.

**Seiten der Flächenmodelle** (`keepSkins`, step-importer.js):
- Der Kern dreht offene Häute so, dass sie von der Körpermitte wegzeigen.
- Bei Blechen, deren Außenseite zur Mitte zeigt (Rückwand eines Fahrerhauses, Kotflügel), war das falsch. Sie waren einseitig unsichtbar; 25 214 Flächen wurden gedreht.
- SAT-Flächen haben eine eigene Außenseite. Bei Text vom eigenen Konverter (Kopf: Präprozessor „rindr SAT converter“) entfällt diese Regel. Die Vereinheitlichung entlang der Kanten bleibt; jetzt 1 264 Flächen.

**Hochachse:**
- Einzelne SAT/SAB entscheiden wie STEP über das Programm im Kopf, unbekannte sind +Y. Eine Konverter-SAT eines Fahrzeugs stand auf y 0 … 170 Zoll; als Z-oben gedreht lag sie auf dem Kopf.
- Körper in Zeichnungen sind immer +Z oben: Systemname „… +Z UP“, `Z_UP_SYSTEMS`.

**Zeichnungen:**
- Ein Produkt je Layer mit der Produkt-ID = Knoten-Schlüssel (`L:<LAYER>`). Der STEP-Kern gibt die Produkt-ID jetzt als `key` am Knoten weiter (`step/structure.js`).
- Darüber ein Wurzelprodukt mit dem Namen der Zeichnung. Layer ohne Körper hängt `mergeCadExtras` unter diese Wurzel, dann zeigt der Scene Graph alle Layer auf einer Ebene.
- Einfügungen werden in die Koordinaten gerechnet; Kopien findet der Kern selbst (B-Rep-Kopien).

**Gemeinsamer STEP-Schreiber:** `step-text.js`, vom IGES-Übersetzer übernommen. Dessen Ausgabe ist byte-gleich (MD5 von drei Testdateien vorher/nachher).

**Prüfung:**
- **Öffentliche Beispieldatei** (SAT 7.0, Würfel mit Kugelmulden, Kantenrundungen): richtig in Raster und HQ, Farben aus Attributen.
- **Fahrzeug-SAT** (SAT 5.0, 424 MB, 114 040 Spline-Flächen):
  - Umwandlung 12 s in Node, im Browser 7 s, Laden gesamt ≈ 21 s, 476 000 Dreiecke („mittel“).
  - Maße 6 344 × 4 340 × 2 981 mm gegen .fbx 6 344 × 4 368 × 2 982 mm; das Bild entspricht der .fbx.
- **DXF mit 3DSOLID:** R2000 (SAT-Text) und R2018 (SAB in ACDSDATA) ergeben dieselben 4 Körper und 44 Flächen. Würfel, Zylinder (mit Körper-Transformation), Block gedreht und skaliert liegen richtig, neben Linie und Text.
- **DWG-Beispiele:** dieselbe Zeichnung in R14 … 2018 (SAT 1.06, SAT 4.0, SAB im Objekt, SAB im Datenspeicher) ergibt in jeder Version dieselben 3 Körper, 10 Flächen und Punkte. Eine 2007er Baugruppe aus 58 Blechteilen (Zylinder, Tori, ein elliptischer Zylinder) und eine Flächen-Datei (Extrusion, Loft, Rotation, Ellipsen-Scheibe) richtig in Raster und HQ.
- **Visualisierungsszenen** (DWG 2010, 50 und 76 Körper, Prüfwerkzeug `tools/stepcheck` auf der Übersetzung, Stufe Mittel, vorher → nachher): offene Kanten 814 → 0 und 45 → 9, geflippte Normalen 3 209 → 78 und 13 → 3, umgeklappte Dreiecke 1 806 → 36, Flächenfehler 3 → 0; keine Fläche mehr ausgelassen. Ursachen: gewichtete Splines, Schnittkurven-Prüfung, Ersatzflächen (oben) und zwei Fehler im STEP-Kern (`docs/step-import.md` „Geschlossene B-Spline-Kurven, Nahtprüfung“).
- **Noch nicht an echten Daten geprüft:** Kegel mit Öffnungswinkel, elliptische Kegel, Parameterkurven als Ersatz.
- **STEP-Kern** (`step/structure.js`, Größe eines Körpers): Ellipsen zählen jetzt wie Kreise. Eine ebene Scheibe mit nur einer geschlossenen Ellipse als Rand hatte als Körpergröße ihren einzigen Eckpunkt – „larger than its solid“, die Fläche fehlte. Trifft auch gewöhnliche STEP-Dateien.

## DWG (`src/scripts/cad/dwg/`, Stufe 3)

Eigener Leser nach der öffentlichen Formatbeschreibung der DWG-Datei. Ein freies Vergleichswerkzeug (GPL) lief nur lokal im Scratchpad, um Ausgaben zu vergleichen – kein Code daraus. Er schreibt in dasselbe Zeichnungsmodell wie der DXF-Leser; Aufbau, Annotationen und Körper sind gemeinsam.

**`container.js`** – Datei → Abschnitte (Details im Kopfkommentar):
- R13–R2000: Abschnitts-Locator, keine Kompression.
- R2004/2010/2013/2018: verschleierter Dateikopf, Seiten- und Abschnittskarte, LZ77-Variante je Seite.
- R2007: Reed-Solomon verschachtelt (Fehlerkorrektur übersprungen, nur die Daten-Bytes), eigene LZ77-Variante.

**`bits.js`** – Bit-Leser: B, BB, 3B, BS, BL, BLL, BD, DD, RC/RS/RL/RD, MC/MS, H (auch relativ zum eigenen Handle), TV/TU (ab 2007 aus dem String-Strom), CMC/ENC, BE, BT, OT.

**`dwg-reader.js`:**
- Klassen, Objekt-Karte (Handle → Position), Kopfvariablen bis zu den Einheiten, dann jedes Objekt.
- Objekt: MS-Größe, (2010+) Größe des Handle-Stroms in Bits als MC (nicht in der Größe enthalten), Typ (OT), (2000–2007) Datengröße in Bits, Handle, erweiterte Daten, gemeinsame Objektdaten, eigene Daten; am Datenende der Handle-Strom; ab 2007 die Texte in einem String-Strom, gefunden über das letzte Datenbit.
- Tabellen: LAYER, LTYPE, STYLE, BLOCK_HEADER, LAYOUT; Objektarten wie beim DXF-Leser; Volumenkörper als SAT (Version 1, 159 − c), SAB (Version 2) oder ab 2013 im Datenspeicher `AcDb:AcDsPrototype_1b`.
- Speicher: Nach dem Lesen eines Objekts fallen Bit-Leser und Rohdaten weg, nur das Ergebnis bleibt. MESH-Punkte und -Flächen in typisierten Arrays (flache Flächenliste: Eckenzahl, Indizes …) – auch im DXF-Leser.

**Abweichungen von der Beschreibung bzw. Fallen** (alle an Dateien belegt):
- **Tabelleneinträge ab 2007 ohne „xrefindex+1“ (BS)**: Name, 64-Bit, Xref-Abhängigkeit – die Bits der Layer und Block-Köpfe von 2004 und 2007 derselben Zeichnung zeigen es (2004: `1 10 0 …`, 2007: `1 0 …`). Vorher war alles danach verschoben: Layer galten als „aus“, ein Block-Kopf besaß „Millionen“ Objekte – 3 GB Speicher und 4,6 s beim Lesen statt 0,44 GB und 0,9 s.
- **Ab 2004 kein „nolinks“-Bit** in den gemeinsamen Objektdaten.
- **ENC** (Farbe der Objekte): Flags = Wert & 0xE000, Index = Wert & 0x1FFF – sonst wurde 256 (VONLAYER) zu 0.
- **BLL** im Kopf ab 2013: Länge in 3 festen Bits.
- **Kopf ab 2007**: die Größe in Bits (RL) steht in jeder Fassung ab 2007, nicht erst ab 2010.
- **Layer aus**: Flag-Bit 2 (ab 2000), R14 ein eigenes Bit; ein negativer Farbindex heißt ebenfalls aus.
- **Blocknamen** sind nicht eindeutig (anonyme heißen alle `*D`, `*U` …): Schlüssel `Name#HANDLE`.
- **Bemaßungen**: Der Block ist der letzte Block-Kopf unter den bis zu 16 Handles am Ende (Bogen- und Radiusbemaßungen haben mehr Handles).
- **SAT Version 2** liegt mitten im Bit-Strom, nicht auf einer Byte-Grenze (`bitBytes`) – ab dem abgerundeten Byte gelesen war die Datei Datenmüll, die Körper fehlten.
- **Datenspeicher** (2013+): Die Kopf-Einträge der Datensätze (Größe, 1, Handle, Versatz) stehen nach dem 48-Byte-Segmentkopf, die Daten direkt dahinter.
- **Tabellen** (ACAD_TABLE): die Daten beginnen wie eine Einfügung (Punkt, Maßstab, Drehung, Extrusion, Attribute), der erste eigene Handle ist der Block – auch ab 2010 (dort wanderte nur der Zellinhalt in ein eigenes Objekt). Gezeichnet wird der Block `*T…`; 2007, 2010, 2013 und 2018 derselben Zeichnung gleich und wie die DXF.
- **Einfügungen: Zahl der eigenen Objekte nur mit Attributen.** Die Formatbeschreibung führt das BL ab 2004 immer auf; tatsächlich steht es nur, wenn das Attribut-Bit gesetzt ist. Belegt an der Tabelle: ohne das BL lesen sich die Flags als 0x16 („hat Block“ + „nach unten“) und die Richtung als (1, 0, 0) – wie in der DXF. Bei einer Einfügung ohne Attribute folgt nichts mehr (der Fehler blieb unbemerkt), bei MINSERT wären Spalten und Zeilen verschoben gewesen. 61 Beispiel-DWGs: alle Einfügungen unverändert.
- **LIGHT**: Version (BL), Name, Art (BL: 1 entfernt, 2 Punkt, 3 Spot, 10 Web), an (B), eigene Farbe (CMC), Symbol (B), Stärke, Position, Ziel (BD/3BD), Abschwächung (BL, B, BD, BD), Hotspot und Abfall (BD, Radiant), Schatten (B, BL, BS, RC); danach der Name noch einmal als UTF-16 im Datenstrom (Länge BS, 16 Bit je Zeichen) – an 17 Lichtern ging die Bitzahl damit genau auf.
- **Splines** nur mit Fit-Punkten: das CAD-Programm schreibt in DXF zusätzlich berechnete Kontrollpunkte, in DWG nicht; wir zeichnen durch die Fit-Punkte.
- **Klassennamen** sind die DXF-Namen: die Multi-Führungslinie heißt „MULTILEADER“, nicht „MLEADER“. Unter dem falschen Namen galt sie als Nicht-Objekt und fehlte still, ohne Hinweis. Sie steckt auch in Dateien im 2000er/2004er Format (als Klassenobjekt, gleiche Feldfolge).
- **MULTILEADER** (Beschreibung: MLEADER + eingebetteter MLeaderAnnotContext): Der Kontext beginnt direkt mit der Zahl der Wurzeln (keine eigenen Kopf-Felder). Bruchinfos je Linie: Anzahl, dann je Info Segment-Index und Punktpaare. Bis 2007 eine Liste von Pfeilspitzen vor den Beschriftungen. Handle-Strom: je Linie (2010+) Linientyp und Pfeil, Textstil bzw. Block, dann Stil, Linientyp, Pfeil, Textstil, Block, Pfeilspitzen, Attributdefinitionen. Geprüft: dieselbe Hinweislinie in 2000/2004/2007/2010/2013/2018 gleich, DWG und DXF derselben Zeichnungen (zwei Dateien) gleich bis auf die letzte Stelle; Block-Inhalt in DWG nur nach Beschreibung (keine Datei damit).
- **Bemaßungen**: die gemeinsamen Bemaßungsdaten bis zum Punkt „12“ (Textmitte, Höhe, Flags, Text, Drehungen, Maßstab und Drehung der Block-Einfügung, 2000+ Ausrichtung und Messwert, 2007+ drei Bits).
- **Maßsystem** (`$MEASUREMENT`): im Abschnitt `AcDb:Template` – Länge der Beschreibung, Beschreibung (ab 2007 UTF-16, also 2 Bytes je Zeichen), dann der Wert.

**Testdatei-Erkenntnis:** Eine DWG 2004 desselben Fahrzeugs wie die DWG 2018 zeigte nur Teile. Grund: die vier größten Teile (je über 32 767 Punkte, 241 000 Punkte) fehlen in der Datei – Polyface-Netze des alten Formats fassen nicht mehr; der Exporter ließ sie weg. Kein Lesefehler (keine ungültigen Verweise, alle 94 Netze vollständig).

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
- DWG: `cad/t/dwg.mjs` (lesen + bauen, Zahlen, Zeiten), `ml.mjs` (Multileader beider Formate), `dwgcmp.mjs` (DWG gegen die DXF derselben Zeichnung: Layer, Objekte, Blöcke), `dwgsolids.mjs` (Körper → STEP; mit Ausgabedatei für das Prüfwerkzeug), `mem.mjs` (Speicher je Stufe), `satdump.mjs`/`bodies.mjs` (SAT-Datensätze einer DWG), `inscmp.mjs` (Einfügungen alter gegen neuen Leser).
- SAT: `cad/t/survey.mjs` (ausgelassene Flächen/Kurven über alle Beispiele), `icfail2.mjs` (warum eine Schnittkurve abgelehnt wird: Abstand der Ecken zur Kurve), `facemap.mjs` (STEP-Fläche → SAT-Fläche und Unterart), `rec.mjs`/`procdump.mjs` (Datensätze roh), `faceloop.mjs` (Schleifen einer Fläche). Prüfwerkzeug auf der Übersetzung: `tools/stepcheck/check.mjs` (`dwgsolids.mjs <dwg> tools/stepcheck/cad/x.stp`), Vergleich mit dem alten Stand über `--src` (Quellbaum per `git archive`).

**Ergebnisse (Windows-Chrome, RTX 3080):**
- **Synthetische Datei:** deckungsgleich mit dem Referenzbild – Lage, Bögen (auch Extrusion −Z), Ellipsen, Splines, Blöcke, Schraffur mit Insel, Muster mit Bogenkante, Linientypen, Linienstärke, Texte samt Umbruch, ⌀/°/±, gedrehter Text.
- **Formate:** ASCII und binär ergeben dieselben Zahlen; R2000 weicht nur dort ab, wo das Format Objekte anders speichert.
- **Layouts:** Blatt, Rahmen, Ansichtsfenster mit Maßstab und Zuschnitt.
- **Polyface-Datei R12** (67 Netze, 113 000 Dreiecke): 1,5 s, Raster und HQ richtig beleuchtet.
- **Große Zeichnung:** 330 000 Segmente, 1,1 s, Draufsicht von selbst, 60 fps.
- **Szene mit Layout:** Wieder geöffnet zeigt sie dasselbe Blatt, ohne Rückfrage.
- **DWG, öffentliche Beispiele** (47 Dateien R13–2018, darunter R2007): alle lesen und bauen ohne Fehler. Dieselbe Zeichnung in sieben Versionen gegen ihre DXF: Layer, Layouts, Blöcke und Objekte gleich bis auf Splines (s. o.) und Tabellen ab 2010.
- **DWG 2018, Flächen-Baugruppe** (48 MB, 101 MESH, 1,25 Mio. Dreiecke – dieselbe Zahl wie die .fbx): lesen 0,9 s, aufbauen 1,1 s (Node), im Browser 4,8 s bis zum Bild, Raster und HQ richtig.
- **DWG 2004** (23 MB, 94 Polyface-Netze, 619 000 Dreiecke): 4,6 s im Browser.
- **Weitere Nutzer-Dateien** (lokal unter `tests/dwg/`, nicht im Repo): Dachziegel-Zeichnung als DWG und DXF (2 Multileader, Bemaßungen in Blöcken), 3D-Bett aus Polyface-Netzen, imperiale Beispiele (Grundriss, Maschinenbau, Tablett mit 3D-Flächen), Visualisierungsszenen mit 15–76 Volumenkörpern: alle lesen in < 0,1 s und öffnen in 1–2 s; seit der zweiten Runde ohne ausgelassene Flächen und Kanten, mit ihren Lichtern, und die Blätter zeigen die Körper als Kanten. Offen: die Sonne einer Szene. Eine `.dwf` (Plot-/Ansichtsformat, kein DWG) wird nicht gelesen.
- **Multileader-Testdatei** (`cad/t/mlgen.py` mit dem Python-DXF-Werkzeug, Referenzbild per `ref.py`): Text mit Landung, zwei Wurzeln mit Spline-Linien und Punkt-Pfeilen, Positionsnummer als Block mit Attribut – deckungsgleich bis auf die Rundung der Splines.

**Regression** (`run.js`/`compare.js`, alt gegen neu): Abweichungen nur im Starttext (DXF genannt) und im bekannten Rauschen.
- Ein Schnittbild wich stabil ab (7,9 % der Pixel, Innenseite einer Kugel hinter dem Schnitt).
- Eingegrenzt bis auf **eine Zeile im GLB-Export**, ein Modul, das erst beim Export geladen wird und im Szenario gar nicht läuft. Allein in den alten Stand gebaut, erzeugt sie dieselbe Abweichung: Bündel-Rauschen wie bei der Wolke (`docs/player.md`), keine echte Änderung.
- **DWG-Stufe** (gegen den Stand von Stufe 1+2): wieder nur Starttext (DWG genannt; auch unscharf hinter dem Setup-Fenster) und Rauschen – Schnittbild 7,9 %, Splat-Kamera, Gras-IDs, Wolke. Eine Kernel-Übersetzung von 7,5 s statt 0,1 s kam vom neuen Port des Prüfservers: Chromes Shader-Cache gilt je Origin, ein neuer Port ist ein kalter Cache.
