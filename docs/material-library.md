# Material-Bibliothek (Presets aus den MAX-Bibliotheken)

Okt. 2026, Wunsch des Nutzers: die besten Materialien aus `tests/MatLibs` (615 MAX-Materialien) in die eigene Bibliothek übernehmen – **ähnliche nur einmal**, **keine Texturen** (Optik prozedural mit den Nodes nachgebaut, MAX-Werte nur Orientierung, eigene Werte und Namen), **keine Markennamen**. Weggelassen: gedruckte Motive (Blumenteppiche, Mustertapeten, Läufer), Geometrie-Dinge (Zäune, Maschendraht, Reifenprofile, Glasbausteine).

- Aufbau: je Kategorie eine Datei `src/scripts/presets/<bereich>.js` (Default-Export = Preset-Array, per `import.meta.glob` in `material-presets.js` angehängt), Graphen mit dem Baukasten `presets/graph.js` (`graph({ size, relief })`, `node`, `link`, `out`, `done`). Namen in `materials.presets.<id>` (beide Sprachen). Insgesamt 239 Presets (vorher 41; seit Okt. 2026 dazu „Milchglas“ und „Jade“ mit Trübung – docs/material-format.md „Streuende Medien“ – und 22 Flüssigkeiten, unten). Erstellt je Bereich von einem Agenten in eigenem Worktree, vom Hauptagent geprüft (Vorschaukugeln + gebackene Maps) und zusammengeführt.
- `presets/palette.js` (ohne Graph): Glas blau/bronze/Flaschengrün, Sonnenschutzglas verspiegelt, rückseitig lackiertes Glas, Spiegel, Klavierlack schwarz/weiß, Alu eloxiert blau/rot, Neon-Rot.
- Prüfen: Scratchpad `tools/preset-tests.mjs <presets/x.js> <tests.json> [ids]` → `tools/bake.js` (Kugel = Bibliotheks-Vorschau, gebackene Maps 2 × 2 Kacheln; Aufwärm-Kugel vorweg – die erste Kugel eines Laufs kam schwarz). Vorschaukugel: eine Kachel über die sichtbare Hälfte, unabhängig von `size`; helles Prüfmuster lässt Farben heller wirken als in der Szene.
- Fallstrick (Okt. 2026): Gewebe-Node addierte in `imod` ½, obwohl `wrap()` (node-lib) inzwischen selbst am Zellmittelpunkt rundet → Leinwand nur Kette, Köper 3/1; behoben (vom Stoff-Agenten gefunden).


## Holz-Presets (`src/scripts/presets/wood.js`, Kategorie `wood`)

21 Presets, alle prozedural (Holz-, Fliesen-, Sprenkel-, Rauschen-Node). Oberfläche: geölt = ohne Klarlack, Rauheit
aus den Poren (offene Poren rauer); lackiert = Klarlack über glatterer Basis. Maße aus der Realität (Kachelgröße 300–2400 mm).

| Preset | Aufbau | deckt aus den MAX-Bibliotheken ab |
|---|---|---|
| Eiche geölt (`wood-oak`) | Fladerschnitt, ringporig | Wood_Oak, Oakgrtrt, Finish Carpentry Red/White Oak, Roble |
| Räuchereiche (`wood-oak-smoked`) | dunkle Eiche | EnglishOak, Goncalo |
| Nussbaum (`wood-walnut`) | geölt | Wood_Walnut, Finish Carpentry Walnut |
| Ahorn lackiert (`wood-maple`) | hell, fast porenfrei, Seidenlack | Maple, Poplar, Wood Stairs Ash (hell) |
| Kirsche lackiert (`wood-cherry`) | rötlich, Seidenlack | Cherry, Cherry.2, Red Birch, Lacquer |
| Kiefer / Fichte (`wood-pine`) | Nadelholz, kräftige Jahresringe, keine Poren | Pine, Spruce |
| Teak (`wood-teak`) | geölt | Teak, Ironwood |
| Esche (`wood-ash`) | grobe Poren | Ash, Ashen, White Ash, Hickory, Wood Doors.Ash |
| Buche (`wood-beech`) | schlicht, rötlich | Beech, Bubing |
| Mahagoni Hochglanz (`wood-mahogany`) | Riftschnitt, Hochglanzlack | Mahogany, Andiroba, Redwood, Shellac, Urethane |
| Wenge (`wood-wenge`) | dunkles Edelholz, Riftschnitt | Bocote, Cocobolo |
| Bambus (`wood-bamboo`) | Lamellen 20 mm mit versetzten Stößen | Flooring.Bamboo |
| Altholz grau (`wood-weathered`) | verwittert, starkes Relief, matt | Wood_Old, Driftwood, Grey_Plank |
| Sperrholz Birke (`wood-plywood`) | Schälfurnier, breite Flader | Laminate.Plywood, Paneling |
| OSB-Platte (`wood-osb`) | 5 Lagen gestreckter Strands (Rauschen mit Schwelle) | – (neu) |
| Spanplatte roh (`wood-chipboard`) | 2 Sprenkel-Lagen | Cardboard.Chipboard, Pressboard.Paneling |
| MDF roh (`wood-mdf`) | feines Rauschen | Masonite.Paneling |
| Kork (`wood-cork`) | Granulat, 2 Sprenkel-Lagen | Flooring.Cork |
| Dielenboden Eiche (`wood-floor-planks`) | Dielen 200 × ~1200 mm, Tönung je Diele, Seidenlack | Flooring.Wood.Plank, Plank.Beech, Hardwood, Hardwood.1, White_Plank, Wood.Boards |
| Fischgrätparkett (`wood-floor-herringbone`) | Stäbe ~70 × 420 mm, geölt | Flooring.Wood.Parquet, Parquet.1 |
| Flechtparkett Nussbaum (`wood-floor-basket`) | Würfel 240 mm aus 4 Stäben, lackiert | Flooring.Wood.Inlay |

Ähnliches zusammengefasst (Kirsche 2×, Eiche rot/weiß, mehrere Dielen-/Hardwood-Varianten, Lack/Schellack/Urethan als Oberfläche statt eigener Materialien).

### Ausgelassen
- Wurzelholz (BurrElm, Burloak): zwei Versuche (Turbulenz-Rauschen + Sprenkel-Augen; Holz-Node mit maximaler Unregelmäßigkeit) sahen nach Leder/Stein bzw. normaler Maserung aus – bräuchte einen eigenen Maser-Node (Wirbel um Augen).
- RoseMyrtle (Flammen-/Wolkenfigur): wie Wurzelholz.
- Rinde (Bark, Bark2, Treebark), Zäune (Fences & Gates), Pegboard (Lochmuster → eher Metall/Platten-Agent), Schindeln (Wood_Shingle), Fassadenschalung/Siding: Geometrie bzw. Bereich Außen.
- Kunststoff-Laminate (Plastic Laminates), Wachs-Farben (Wax.Black/Red), Pappe: Kunststoff-/Sonstiges.
- Schalungsbeton mit Brett-/Sperrholz-Abdruck: Beton-Bereich.

## Presets Naturstein & Mauerwerk (`src/scripts/presets/stone.js`)

28 Materialien, alles prozedural (Marmor-, Speckle-, Kachel-, Zellen-, Rauschen-, Wellen-Node). Poliert = flach (kein Relief) + Klarlack; geschliffen/gespalten = matt mit Relief und Rauheit aus den Masken.

### Naturstein (`stone`)
| ID | deckt ab (MAX-Vorlagen, nur Orientierung) |
|---|---|
| stone-marble-white | Marble White, White-Black, White-Black Large Veins, White-Brown(-Black), Finishes Flooring Marble White |
| stone-marble-black | Masonry Flooring Marble (dunkel), Onyx Black |
| stone-marble-green | Marble Green, Deep Green, Green Offset Squares, White & Green |
| stone-marble-beige | Marble Beige-Grid, Brown, Rose/Rose.1 (Farbe im Node anpassbar) |
| stone-granite-grey | Granite Grey, Grey Speckled, Stacked Polished 4, Black-White, Stones White Granite |
| stone-granite-black | Granite Mauve-Black(1), Brown-Black, Mauve-Grey (dunkle Sorten) |
| stone-granite-red | Granite Multi-colored, Copper-Black, Pink-Black-Grey, Brown Mauve-Black |
| stone-onyx-honey | Onyx Blue/Rose (gebändert, poliert) |
| stone-travertine | Travertine Cream/DarkBrown/DarkRed, Flooring Travertine Mauve, Stones Travertine |
| stone-limestone | Stones Limestone(_3), Limestone (Fläche) |
| stone-sandstone | Sandstein (gebändert) – ergänzt |
| stone-slate | Slate, Slate Green/Mottled/Red, Flooring Slate(.1/.Red) |
| stone-soapstone | Soapstone BlueGreen, DarkGrey |

### Mauerwerk (`masonry`)
| ID | deckt ab |
|---|---|
| brick-running-red | Brick Modular Running (Red, Brown, Grey), Common, Bricks_1/2, Face, Press, Cored, Header, Rowlock, Sailor, Soldier, Shiner |
| brick-clinker-dark | Brick Clinker, Fire |
| brick-english-red | English, English Cross, Garden Wall |
| brick-flemish-yellow | Flemish, Flemish Cross/Diagonal, Bricks_Yellow, Norman Soldier (hell) |
| brick-glazed-white | Brick Glazed, Running Glazed Blue (Farbe anpassbar), Stack, Stacked Grey |
| brick-herringbone | Herringbone, Herringbone.1 |
| brick-basket-weave | Basket Weave |
| masonry-block-grey | CMU Stretcher Running/Stacked, Retaining Wall, Sailor, Shadow, Sound Absorbing, Scored (Fugenraster ähnlich), Sandblasted, Exposed Aggregate, Efflorescence, Glazed Blue |
| masonry-block-split-face | CMU Split-Face |
| masonry-block-ribbed | CMU Ribbed Stacked |
| masonry-ashlar | Ashlar Broken Coursed (Grouted), Ashlar Patterned, Limestone Ashlar Coursed |
| masonry-rustication | Limestone Rustication, Rustic Joint Pink |
| masonry-dry-stone | Limestone Rubble (lagenhaft), geschichtete Bruchsteinwände |
| masonry-rubble | Fieldstone Uncoursed Loose/Tight/Weathered |
| masonry-river-stone | Flusssteinmauer (Rundsteine in Mörtel) |

### Ausgelassen
- Glass Block, CMU Screen, Brick Screen: Geometrie (Durchbrüche/Glas), nicht als Oberfläche sinnvoll.
- Lehmziegel, Norman One-Third Running: zu ähnlich zu den vorhandenen Ziegeln (Läuferverband, Farbe/Verband im Node umstellbar).
- Terrazzo (Finishes): nicht mein Bereich; Flagstone, Cobble Stone, Riverstone-Pflaster, Pavers (SiteWork): Außenbereich.
- Amethyst/Edelsteine: kein Naturstein-Belag.
- Control Joints Black: reine Fugenfarbe.

### Hinweise
- Größen real: NF-Ziegel 240 × 71 mm + 10 mm Fuge (4 × 12 je 1 m), Betonstein 390 × 190 mm (3 × 6 je 1,2 m), Pflaster/Flechtziegel 200 × 100 mm, Quader 600–1200 mm.
- Granit: zwei verkettete Speckle-Nodes (dunkle Glimmer + helle Quarze); Ziegel/Quader: Kachel-`uv` → Rauschen für Flecken je Stein.

## Presets Beton & Putz / Fliesen & Böden (`src/scripts/presets/concrete.js`)

Alle Looks prozedural (Node-Graph, auf der GPU gebacken), eigene Werte und Namen; MAX-Bibliotheken nur zur Orientierung.

### Beton & Putz (`concrete`)
| Preset | Aufbau | deckt ab (MAX) |
|---|---|---|
| concrete-smooth – Sichtbeton glatt | Rauschen (Wolken) + Dellen (Luftporen, abgedunkelt), 1000 mm | Concrete.Cast-In-Place.Flat.Grey.1/2/3, Precast.Smooth, Concrete_Grey/Grey2/Cement, Concrete.mat |
| concrete-tie-holes – Sichtbeton mit Ankerlöchern | Schaltafeln 2400×1200 (Fliesen, Raster) + Ankerlöcher alle 600 mm (Lochmuster) | Formwork.Holes, Formwork.Holes.Staggered, Formwork.Wood.Plywood |
| concrete-board-formed – Beton Brettschalung | Dielen-Muster (~120 mm Bretter) + Maserungsabdruck je Brett (Rauschen über `uv` des Fliesen-Knotens) | Formwork.Wood.Boards |
| concrete-broom – Beton Besenstrich | gestrecktes Rauschen (feine Linien) | Flat.Broom.Grey |
| concrete-polished – Beton geschliffen | Wolken + zwei Sprenkel (dunkler/heller Zuschlag), Klarlack 0,5 | Flat.Polished.Grey, Exposed Aggregate.Fine |
| concrete-exposed-aggregate – Waschbeton | Zellen „Kiesel“ (Fraktal 2) | Exposed Aggregate.Coarse/Medium/Recessed |
| concrete-sandblasted – Beton sandgestrahlt | Sprenkel (Zuschlag) + dichte Dellen | SandBlasted, Efflorescence (ähnlich) |
| concrete-ribbed – Rippenbeton | Wellen Trapez, 150 mm Raster, + Poren | Ribbed.Vertical.1/2 |
| concrete-precast-panels – Betonfertigteile mit Fugen | Raster 1500×750, 20-mm-Fasenfuge, hell sandfarben | Panels.Reveal.1/2/3/Smooth/Speckled, Panels.Square |
| plaster-fine – Putz fein | geschwelltes Rauschen → Höhe | Stucco.Fine.1/White/Brown/Mauve, Stucco.Medium.White |
| plaster-coarse – Putz grob | Sprenkel als Körnung | Stucco.Coarse.White |
| plaster-troweled – Spachtelputz | großes, eng geschwelltes Rauschen → flache Kellenflächen mit Graten | Stucco.Troweled.Grey/White/Light Yellow |
| plaster-wet-dash – Spritzputz | weiche runde Sprenkel → Klumpen | Stucco.Wet-Dash.Grey |
| plaster-venetian – Venezianischer Putz weiß | Wolken + Turbulenz-Schlieren, Rauheit nach Schlieren, Klarlack | Venetian.Smooth |
| plaster-venetian-terracotta – Venezianischer Putz terrakotta | dasselbe, fleckig, seidenmatt | Venetian.Rough |
| wallpaint-flat – Wandfarbe matt | nur Rollerstruktur (Höhe), Farbe frei wählbar | Gypsum Board.Painted.White, Painting.Paint/White/Black, Fireproofing |
| wallpaint-eggshell – Wandfarbe seidenmatt | wie oben, Rauheit 0,5 | Painting.Eggshell.White, LightGloss.White |
| paint-flaking – Farbe abblätternd | geschwelltes Rauschen = Farbinseln über grauem Grund, feines Craquelé (Zellen „Platten“) in der Farbe | Paint.White.Flaking, Paint.Black.Flaking |

### Fliesen & Böden (`tiles`)
| Preset | Aufbau | deckt ab (MAX) |
|---|---|---|
| tiles-white-15 – Wandfliese weiß 15×15 | Raster 4×4 / 600 mm, Klarlack nur auf der Fliese (Maske) | weiße glasierte Wandfliesen (Tiling.Ceramic) |
| tiles-grey-60 – Feinsteinzeug grau 60×60 | Raster 2×2 / 1200 mm, Wolken je Kachel, matt | Flooring.Tile.Square.Grey.Dark |
| tiles-terracotta – Terrakottafliese | 30×30, unglasiert, Kanten abgenutzt, Farbmischung | Tile.Square.Terra Cotta/Brown/Tan |
| tiles-blue-10 – Fliese blau glasiert 10×10 | 4×4 / 400 mm, glasiert | Tile.Square.Blue/Blue.1 |
| tiles-diagonal – Bodenfliese diagonal | Muster „Diagonal“ | Tile.Diamond.Red, VCT.Diamonds |
| tiles-mosaic-blue – Mosaik blau | 25 mm, 12×12 / 300 mm, Farbmischung zweier Blautöne | Ceramic.Mosaic.Blue/Grey/Yellow-Grid, Circular Mosaic |
| tiles-checker – Schachbrett schwarz/weiß | Schachbrett-Knoten → Fliesenfarbe (gleiche Teilung) | Vinyl.Checker.Black-White, Ceramic.Checker |
| terrazzo-white / -black / -red | zwei Sprenkel-Knoten hintereinander, poliert (Klarlack) | Terrazzo.White/White.1/Tan/Brown/Green, Black/Black.1, Black-Red/Tan.1/Brown.1 |
| tiles-vinyl – Vinylplatten | gestrecktes Rauschen (Schlieren) + längliche Sprenkel, 30×30, gewachst | Flooring.VCT.* (Grid, Squares, Dots, Mosaic), Woods&Plastics.Plastics.Vinyl |
| ceiling-acoustic – Akustikdecke 60×60 | Raster 2×2 mit gefaster Kante, Turbulenz-Risse | Acoustical Tile 2x2/2x4 Fissured + Pebble |
| ceiling-perforated – Lochdecke Metall | Raster + Lochmuster (48 Löcher je 1200 mm), schwarzes Vlies dahinter | Acoustical Tile.Perforated.2x2, Ceilings.Linear (ähnlich) |

### Weggelassen
- Bedruckte Motive: Ceramic.Mosaic.Floral.Rose & Green, VCT.Diamond.Rosette (Rosettenmuster) – nicht sinnvoll prozedural.
- Doppelte/ähnliche Varianten zusammengefasst (siehe Tabellen): mehrere Grautöne Sichtbeton, Stucco-Farben (Farbe im Material frei änderbar), Terrazzo-Farbvarianten, Fliesenfarben.
- Concrete_Asphalt (Außenbereich), Concrete_Blue/Brown_Stucco (Farbvarianten von Putz), Control Joints.Black (nur schwarze Farbe), Concrete_Tiles (Gehwegplatten → Außenbereich), Lack/Wachs-Finishes (Painting.HighGloss/Lacquer, Wax.*: einfache Lack-Parameter, Kategorie Lack), Metall-Ständerwerk (Furring/Stud – Geometrie), Gummiboden mit Noppen (Stoff-Agent).
- Holzböden/Parkett und Natursteinplatten gehören zu Holz bzw. Naturstein.

### Prüfung
Gebacken mit `bake.js` (echte GPU), Kontaktbögen im Scratchpad `tools/work-p-concrete/final-*.jpg`.

## Bibliotheks-Materialien: Metall (presets/metal.js)

Ergänzt die schlichten Parameter-Metalle (Chrom, Alu, Stahl, Gold, Kupfer, Messing, Titan …) um strukturierte
Varianten mit Node-Graph. Regel: Farben a/b nah beieinander – die Schattierung kommt aus Normalen und Rauheit.

| Preset | Aufbau | MAX-Vorlagen (nur Orientierung) |
|---|---|---|
| Edelstahl gebürstet | Noise gestreckt (feine Schliffspuren) → Farbe, Höhe, Rauheit | Ornamental Metals Stainless (Satin, Patterned), Chrome Satin, Stainless Curtain Wall, Metal_Brushed |
| Aluminium gebürstet, Schliff | wie oben, heller, gröber | Aluminum Brushed (auch Random, Blue-Silver), RayTraced BrushedMetal |
| Messing gebürstet | wie oben, Messingtöne | Brass Satin, Gold Satin, Metal_Dark_Gold |
| Bronze satiniert | feines ungerichtetes Korn + Wolken → Farbe, Rauheit | Bronze Satin, Pewter |
| Aluminium eloxiert dunkelbronze | gebürstet, dunkel | Anodized Dark Bronze (+ Satin), Doors&Windows Aluminum Frame Anodized |
| Stahl feuerverzinkt | Cellular „chips“ = Zinkblumen, Rauheit je Zelle | Galvanized (Ornamental, Doors&Windows, Metal Stairs), Metal_Galvanized |
| Kupfer mit Patina | Noise-Maske mischt Kupfer/Grünspan, Patina nicht metallisch + rau | Copper Patina (Standing Seam, Roofing), Metal_PlateOX |
| Stahl rostig | Noise-Maske Rost/Stahl, Grübchen (Dent) nur im Rost, Metalness/Rauheit gemischt | Rust 1–3, Weathered, Metal_Rust |
| Wetterfester Baustahl | ganz verrostet, stabil braun, nicht metallisch | Weathered, Muddy, Sandy |
| Metall alt, fettig | Flecken mit wechselnder Rauheit, leichter Schliff | Greasy, Dusty, Metal_OldMetal, Metal_Black_Plain/Grey_Plain |
| Metall gehämmert / Kupfer gehämmert | Dent (Facetten) → Höhe, Rauheit | (Ausbau; kein direktes Vorbild) |
| Blattgold | Tiles (Blätter mit Versatz, unruhige Kanten) × Knitter-Noise | Leaf Gold (Silber-/Kupferblatt = gleiche Struktur, anderer Farbton → weggelassen) |
| Lochblech Rund / Quadrat / Langloch | Dots → Alpha-Ausschnitt + Höhe | Plate Perforated (+ .1), Acoustical Tile Perforated |
| Streckmetall | Dots „expanded“ → Alpha + verdrehte Stege | Plate Mesh (.1, .2) |
| Riffelblech Aluminium | Dots „bars“ (5er-Riffel, 90° wechselnd) → Höhe | Checker Plate Parquet, Metal_Plate |
| Tränenblech Stahl | Dots „tread“ (Tränen, versetzt) → Höhe | Checker Plate 45deg |
| Wellblech verzinkt | Waves Sinus → Höhe, Noise-Ton → Farbe/Rauheit | Corrugated Steel |
| Trapezblech anthrazit | Waves Trapez → Höhe; bandbeschichtet = Lack (Metalness 0) | Metal Ribbed, Metal_Wall |
| Stehfalzdach Kupfer | Waves „seam“ → Höhe, Noise-Ton | Standing Seam Copper (.3), Corrugated StandingSeam Zinc/Aluminum Coated |
| Stahlblech genietet | Dots „dots“ (gewölbte Niete) + Noise-Zunder | Plate Riveted (Flat Grey, .2) |

**Weggelassen:** Chrom/Chrom-Varianten der Raytrace-Bibliotheken (farbige Chrome, Reflection_*: vorhandenes Chrom
reicht, farbiges Chrom = Parameter), Zinn/Silber/Titan/Tin einfach (Parameter-Metalle, ähnlich vorhandenen),
Silber-/Kupferblatt (wie Blattgold), lackierte Türen/Geländer weiß (= Lack, keine Metall-Struktur), Metallständer/
Profile (Furring, Stud, Joists, Structural Framing: einfarbig), Tinfoil (zerknitterte Folie – kein passender Node),
Maschendrahtzaun (Geometrie), Stainless Patterned (geprägte Motive aus Bildern).

## Presets Stoff & Teppich / Kunststoff (`src/scripts/presets/fabric.js`)

29 Presets, alle prozedural (Gewebe, Wellen, Zellen, Sprenkel, Dellen, Lochmuster, Rauschen). Größen real (mm je Kachel).

### Wichtig: Fehler im Gewebe-Node (`nodes/weave.js`)
`imod` addiert ½ doppelt (`wrap` rundet schon am Zellmittelpunkt) → `imod(1, 2)` = −1 statt 1. Folge: Leinwandbindung zeigt nur Kettfäden,
Denim (3/1) nur Kette, Köper ist 3/1 statt 2/2, Satin 3/5. Korrektur: `const imod = (i, period) => wrap(i, period);` – lokal geprüft
(Rot/Blau-Testbild: Leinwand, Köper, Fischgrat korrekt). Die Presets sind **auf den korrigierten Node abgestimmt** (ohne Korrektur: Denim
fast schwarzblau, Leinen/Canvas ohne Schuss, Streifen zu kräftig). Nicht in diesem Zweig geändert (fremde Datei).

### Stoff & Teppich (`fabric`)
| ID | Aufbau | MAX-Vorlagen (nur Orientierung) |
|---|---|---|
| fabric-linen | Leinwand, Slubs, Fasern | Fabrics.Linen.Beige/White |
| fabric-canvas | dichte Leinwand, gleichmäßig grau | Fabrics.Canvas.Gray/Tan/White, Bandage |
| fabric-denim | Köper 3/1, Indigo/Weiß | Fabrics.Denim.Blue/Black |
| fabric-wool-twill | Köper 2/2, Glanz (Sheen) | Wollstoffe allgemein |
| fabric-herringbone | Fischgrat | Carpet.Saxony.Herringbone (Muster) |
| fabric-tweed | Köper, Kette aus zwei Sprenkel-Knoten (orange/petrol) | Fabrics.Linen.Tweed |
| fabric-satin | Satin, glatt, niedrige Rauheit | – |
| fabric-velvet | feiner Schnittflor + Sheen | Fabrics.Velvet.Red/Black, Velour.Black/Blue |
| fabric-corduroy | Wellen (Rippen) × Schnittflor, dunkle Rillen, Sheen | Fabrics.Corduroy.Black/Blue |
| fabric-chenille | grobe, sehr flauschige Leinwand + Sheen | Fabrics.Chenille.Blue/Red |
| fabric-burlap | offene Leinwand, unregelmäßiges Garn | Fabrics.Burlap |
| fabric-plaid | Kette/Schuss je aus 3 verketteten Wellen (Blöcke, rote Linie, gelbe Linie), Köper | Fabrics.Plaid, Plaid.1/3/4 |
| fabric-stripes | Kette aus Rechteck-Wellen (blau/weiß), weißer Schuss | Fabrics.Stripes.1–7, Wall Covering.Stripes.* |
| fabric-netting | Lochmuster versetzt → Alpha (Tüll) | Fabrics.Mesh, Netting, Lace |
| fabric-cane | offene Leinwand, Öffnungen über max(Welle u, Welle v) → Alpha | Fabrics.Caning.Tan |
| leather-smooth | feine Zellen (Narbung), Rauschen-Fleckung, Rauheit aus Höhe | Leather.Black/Brown/Tan |
| leather-pebbled | grobe Zellen, Fraktal 2 | Leather.Pebble.Light Brown/Mauve, Leather.Black.1 |
| leather-patent | Klarlack, leichte Welligkeit | – |
| carpet-berber | Schlingenflor | Carpet.Berber.Pattern.1–3, Loop.1–7, Fabric_Tan_Carpet |
| carpet-velour | Schnittflor + Sheen | Carpet.Saxony.*, Fabric_Blue/Grey_Carpet |
| carpet-needle-punch | Turbulenz-Rauschen + gestreckte Sprenkel | Carpet.NeedlePunch.Black/Tan/White, Carpet.Pad.Foam |
| carpet-sisal | Panama 2×2, Naturfaser | Carpet.Sisal.Pattern.1–3 |

### Kunststoff (`plastic`)
| ID | Aufbau | MAX-Vorlagen |
|---|---|---|
| plastic-carbon | Köper 2/2, Rauheit Kette/Schuss verschieden, Klarlack | Laminate.CarbonFiber |
| plastic-grained | feine Zellen-Narbung (Armaturenbrett, Gehäuse) | Plastics.Vinyl (Struktur) |
| plastic-laminate | zweifarbiger Sprenkel, leichte Orangenhaut | Plastic Laminates.* (6 Farben → eins) |
| rubber-neoprene | feine Poren (Dellen), matt | Rubber.Neoprene, Rubber.Black.Textured1 |
| rubber-studded | Noppen auf Raster | RubberBlack (Raytrace) |
| foam-polystyrene | verschmolzene Perlen (Zellen) | Plastics.PolyStyrene, Rigid Insulation |
| foam-rubber | dichte offene Poren (Dellen) | Plastics.Foam.Rubber, Carpet.Pad.Waffled |

### Zusammengelegt / weggelassen
- Dubletten: PVC weiß (= vorhandenes „Kunststoff weiß glänzend“), Latex (= „Kunststoff schwarz glänzend“/„Gummi schwarz“), Rubber.Black/Pink
  (= „Gummi schwarz“), Velour vs. Samt (ein Samt), Leinen weiß/beige (eins), Laminat-Farben (eins).
- Nicht prozedural sinnvoll: bedruckte Motive (Carpet.Floral, Saxony.FlowerPattern.*, Saxony.Squares, Wall Covering.Floral/Pattern1–5/Tan),
  Spitze mit Motiv (nur als Tüll/Netz), Reifenprofile (TireTread.* – Geometrie), Folie/Acryl/Polyethylen (Glas-Kategorie: plastic-clear).
- Wiener Geflecht ohne Diagonalstränge (achteckige Öffnungen bräuchten gedrehte Muster) – quadratische Öffnungen.

Prüfbilder: Scratchpad `tools/work-p-fabric/final-spheres.jpg`, `final-colors.jpg` (mit korrigiertem Gewebe-Node), `nofix-spheres.jpg` (ohne).

## Presets Außenbereich (`src/scripts/presets/outdoor.js`)

25 Presets, Kategorie `outdoor`, alle prozedural (Node-Graph, gebacken). Größen aus realen Maßen (`size` = mm je Kachel).

| Preset | Aufbau | Deckt aus den MAX-Bibliotheken ab |
|---|---|---|
| `outdoor-asphalt-fine` | 2× Sprenkel (Bindemittel + helle Splitt-Körner), 300 mm | Paving Asphalt / Asphalt.1, Concrete_Asphalt |
| `outdoor-asphalt-coarse` | wie oben, gröber, abgefahren heller, 400 mm | Asphalt (helle Variante) |
| `outdoor-gravel-round` | Zellen „Kiesel“, Fraktal 3, 500 mm | Gravel.Loose, Gravel.Mixed |
| `outdoor-gravel-crushed` | Sprenkel, kantige Splitter in 3 Körnungen, 400 mm | Gravel.Crushed |
| `outdoor-gravel-path` | Rauschen (Sand) + feine Sprenkel, 400 mm | Gravel.Compact |
| `outdoor-sand` | Sprenkel-Körnung + Windrippel (Wellen, verzerrt) als Relief | Planting.Sand, Ground_Sand/SandShore |
| `outdoor-soil` | Dellen (Schollen) + Sprenkel | Planting.Soil, Ground_Grey_Dirt |
| `outdoor-mud` | Rauschen, Pfützen-Maske → Klarlack + glatte Rauheit, Dellen nur im Trockenen | (neu, Wunsch) |
| `outdoor-leaves` | 3× Sprenkel (gestreckte Blätter, Brauntöne) | Ground_Leaves, Ground_Foliage |
| `outdoor-lawn-texture` | Rauschen + feine gestreckte Sprenkel (Halme), Sheen | Grass.Bermuda/Bluegrass/StAugustine/Short/Thick, Ground_Grass (flache Textur, getrennt vom Gras-Material mit echter Geometrie) |
| `outdoor-pavers-square` | Fliesen Raster 200×200, Fase, Körnung | Pavers.1/.4/.Square |
| `outdoor-pavers-running` | Fliesen Läuferverband 200×100 anthrazit | Pavers.2/.3 |
| `outdoor-pavers-herringbone` | Fliesen Fischgrät 200×100 rotbraun | Pavers.Interlocking, Cobble Stone.Heringbone, Cobble Stone.Glazed.Multi-color |
| `outdoor-setts-granite` | Fliesen „Dielen“ (zufällige Längen) ~100 mm, Granit-Sprenkel, ausgebrochene Kanten | Cobble Stone.1 |
| `outdoor-riverstone-mortared` | Zellen „Kiesel“ in hellem Mörtel | Riverstone, Riverstone.Mortared |
| `outdoor-flagstone` | Zellen „Platten“ (Polygonalplatten), 1500 mm | Stones / Bruchstein-Pflaster |
| `outdoor-terracotta-pavers` | Fliesen Raster 300×300, Farbmischung | Pavers.Terra Cotta |
| `outdoor-roof-barrel` | Wellen Sinus (Mönch/Nonne) + Sägezahn (Reihen-Überdeckung), Ziegel-Farbe je Stück, AO | Roof Tiles.Spanish.Red/.Red.1/.Red.2 (Blau-Varianten weggelassen) |
| `outdoor-roof-flat-tiles` | Fliesen Läuferverband + Sägezahn-Überdeckung, AO | Shingles.Even/Uneven (Ton), Wood_Shingle-Raster |
| `outdoor-shingles-asphalt` | Fliesen Läuferverband (3er-Laschen) mit Granulat-Sprenkel + Sägezahn | Shingles.Asphalt Roofing, 3-Tab Black/Grey, Deep Shadow |
| `outdoor-shakes-wood` | Fliesen „Dielen“ (zufällige Breiten) + feine Längsfasern (Wellen über `uv`) + Reihen-Überdeckung | Shakes.Weathered, Wood_Shingle |
| `outdoor-siding-lap` | Wellen Sägezahn (Stülpschalung) + Holz je Brett über `uv`, AO | Siding.Bevel/ShipLap/Tongue & Groove, Wood.Horizontal(.Cedar) |
| `outdoor-siding-board-batten` | Wellen Rechteck (Deckleisten) + feine senkrechte Faser unter roter Farbe | Siding.Board & Batten, Wood Batten.New, Wood.Vertical.White |
| `outdoor-decking` | Fliesen „Dielen“ + Holz je Diele + Riffelung (Wellen) | (Terrassendielen, neu) |
| `outdoor-water` | Wellen „Wasserringe“, glatt, IOR 1,33 | Ground_Water |

### Weggelassen
- Zäune, Maschendraht, Sichtschutz (Fences & Gates) und geflochtene Körbe (Basket.Woven) – Geometrie bzw. andere Kategorie.
- Metall-Dach-/Fassadenpaneele (Stehfalz, Wellblech, Kupfer/Patina), Composite Panels – gehören zu Metall.
- Blaue „Spanish“-Ziegel – nur Farbvariante; Farbe im Preset anpassbar.
- Split-Log-Fassade – Rundholz-Geometrie.
- Asphalt Shingles „Deep Shadow“ als eigene Variante – zu ähnlich zu den 3er-Laschen.
- Evergreen/Mulch/Seafloor-Bilder – bildhafte Motive, prozedural nicht sinnvoll.

### Hinweise
- Holz läuft im Holz-Knoten immer entlang u; senkrechte Bretter/Schindeln bekommen ihre Faser deshalb aus einem feinen Wellen-Knoten (Achse u, Verzerrung) statt aus dem Holz-Knoten.
- Vorschau-Kugel wirkt durch die bunte Umgebung heller als die Albedo; Farbwerte bewusst eher dunkel gewählt.

## Natur (`src/scripts/presets/nature.js`, Kategorie `nature`)

Okt. 2026, Wunsch des Nutzers „realistisches Kürbis-Material“. Neue Kategorie „Natur“ (für Obst, Gemüse u.ä.).

| Preset | Aufbau |
|---|---|
| Kürbis (`nature-pumpkin`) | Kachel 300 mm. Tiefes Orange mit breiten, schwachen Streifen entlang v (Rauschen, Streckung 6, um 90° gedreht – auf den Seiten der Box-UVs senkrecht, also entlang der Rippen eines stehenden Kürbisses), weiche hellere Flecken Richtung Gelb (zweites Rauschen über `mix`), wenige kleine helle Poren (Sprenkel); wachsartig halbglänzend (Rauheit 0,40–0,62, in hellen Flecken und Poren matter, Klarlack 0,2 / 0,35). Die Rippen kommen aus der Geometrie. |

Verlauf: erste Fassung (feine Streifen, Streckung 16, kräftiger Kontrast, Relief) sah nach gebürstetem Holz aus, Poren erhaben wie Wassertropfen → breiter, kontrastärmer, satter, Poren flach. Kein Relief: die Normal-Map zeigte die Box-UV-Nähte auf dem runden Körper als Treppen; dünne Linien an den Nähten blieben auch ohne Relief – das waren Dreiecke mit Ecken aus zwei Projektionen; seit der Box-Projektion je Dreieck (docs/step-import.md) nur noch eine leichte Farbstufe an geraden Nähten. Kein Sheen (machte die Farbe pastellig). Geprüft an einem erzeugten Test-Kürbis (STL, 10 Rippen, `public/models/pumpkin-test.stl`, nicht im Repo) in Default und HQ (Scratchpad `pumpkin.js`).


## Flüssigkeiten (`src/scripts/presets/liquids.js`, Kategorie `liquid`)

Okt. 2026, Wunsch des Nutzers: Orangensaft mit und ohne Stücke, Milch, Honig (normal und Raps), Marmelade (Erdbeer, Kirsch, Quitte) „und was dir noch einfällt“. Klare und trübe Flüssigkeiten = Glas mit OpenPBR-Medium (Tönung über ihre Tiefe, Trübung = `transmission_scatter`, in HQ Random Walk), deckende (Milch, Joghurt, Rapshonig cremig) SSS, Schokolade und Ketchup schlicht glänzend (als SSS machte die Raster-Näherung sie beige bzw. rosa). Stücke (Fruchtfleisch, Marmeladen-Stücke, Erdbeerkerne) als Sprenkel in der Farb-Map – sie tönt das Licht an der Oberfläche, das Medium selbst ist gleichmäßig.

| Preset | Aufbau |
|---|---|
| Wasser (`liquid-water`) | IOR 1,333, leicht blaugrün über 100 mm |
| Orangensaft (`liquid-orange-juice`), mit Fruchtfleisch (`-pulp`) | Farbe nur aus der Trübung (Tönung weiß) über 3 bzw. 2 mm; mit Fruchtfleisch längliche helle Sprenkel |
| Apfelsaft klar / naturtrüb (`liquid-apple-juice`, `-cloudy`) | klar: Tönung über 60 mm; trüb: Trübung über 12 mm |
| Milch, Joghurt (`liquid-milk`, `liquid-yoghurt`) | SSS, Joghurt matter |
| Honig, Rapshonig cremig (`liquid-honey`, `-rapeseed`) | Honig klar bernstein über 25 mm, kaum Trübung; Rapshonig SSS hell |
| Ahornsirup (`liquid-maple-syrup`) | Tönung über 25 mm |
| Erdbeer-, Kirsch-, Quittenmarmelade (`liquid-jam-*`) | dicht, halb glänzend; Erdbeere mit Stücken + Kernen, Kirsche mit Stücken, Quitte Farbe aus der Trübung |
| Rotwein, Weißwein, Bier hell, Kaffee, Tee, Olivenöl | Tönung über 15–120 mm (Bier golden über 90 mm) |
| Hefeweizen mit Schaumkrone (`liquid-wheat-beer`) | Nutzer: ein klares Helles mit Krone wirkte unter dem Schaum wässrig – lieber ein Hefeweizen; Referenzfoto des Nutzers (kräftiges Goldorange, lichtdurchlässig, weiße Krone mit sehr feinen Bläschen und harter Kante; nicht im Repo): kräftige Hefetrübung (μs 0,2/mm: Trübung weiß über 5 mm), die Absorption aus der Zielfarbe des Fotos rückwärts gerechnet (Streu-Albedo je Kanal per van de Hulst: Rot ~0,995, Grün ~0,835, Blau fast 0 → Tönung `#a39508` über 5 mm) – dünne Wände gelb-trüb, dicke goldorange. Vorher leichte Trübung mit Farbe aus der Absorption über 30 mm: auf dem Zylinder wie im Foto (G/R 0,70), auf einem kleinen Modell mit 1–2-mm-Wänden (Nutzer: „auf 3dbenchy noch zu transparent“) fast klar; mehr Absorption allein machte dicke Stellen rotbraun, dünne nicht deckender. Jetzt Zylinder-Mitte G/R 0,62 (etwas oranger als das Foto). Krone: Verlauf „Objekt (einmal)“ entlang V mit harter Kante bei 78,5–79 % der Höhe, fast weiß, Transmission 0, rau, sehr feine Zellen als Relief; erste Fassung mit aufsteigenden Bläschen darunter wieder entfernt |
| Schokolade geschmolzen, Ketchup | glänzend, deckend |

Fallstricke: kräftig gesättigte Tönung färbt dicke Körper rot (über lange Wege bleibt nur Rot) – Säfte bekommen ihre Farbe deshalb aus der Trübung (Tönung weiß; OpenPBR absorbiert, was der Trübungsfarbe fehlt; Streu-Albedo aus der gewünschten Farbe über die van-de-Hulst-Formel gerechnet). Klare Flüssigkeiten sind im Raster dunkel wie Glas vor dunklem Hintergrund. Schaumkrone: braucht UVs, deren V am Modell nach oben läuft (Box-UVs der Seiten, Mapping je Objekt „Zylinder“); der Deckel hat flach projizierte UVs und bleibt klar. Prüfen: Scratchpad `liquids.js <bild> <ids>` (Testkörper Kugel/Platten, HQ oder `RASTER=1`), `beer.js` (Zylinder `mkcyl.js` → `public/models/test-cylinder.stl`, nicht committen; Box- und Zylinder-Mapping, HQ).

## Alte Bibliothek → RINDR-Materialien (Okt. 2026, `tools/matlib/` – nur lokal, nicht in git)

Nutzer: „parallel zum Viewer, der super kompakt sein soll, eine Materiallibrary aufbauen“ – Grundlage ist seine frühere Online-Bibliothek (`tests/alte_Materials/`, außerhalb von git): 2.517 Ordner mit 2.562 `.mat`-Dateien (MAX-Materialbibliotheken; 90 % Material eines Render-Plugins, dazu Standard, Blend, Multi/Sub, Licht-, SSS-Materialien; Bitmaps in 2/3 der Dateien, prozedurale Maps: Falloff, Mix, Noise, Cellular, Tiles, Speckle, Gradient, Checker, Dent …), je Ordner meist ein altes Vorschaubild (Demo-Kugel ~20 cm).

**Entscheidungen des Nutzers:** je Ordner ein Material, **im Ordner selbst** abgelegt (Ordner ohne `.mat`/`.max` ignoriert); nur mit unseren **bestehenden** Parametern und Nodes nachgebaut; Texturen **nie übernommen**, nur zur Analyse gelesen (Farben, Kontrast, Richtung) und prozedural nachgestellt; **neutrale Namen** de/en (die alten enthalten Benutzernamen der Community, Marken, Filmtitel); fast gleiche zusammenfassen; erst Pilot, dann in Etappen. Ablage nach dem Pilot: nur `<name>.rindr.json` (Parameter + Node-Graph – vollständig ohne Texturen, als einzelne Datei importierbar, docs/material-format.md) + `<name>_preview.png`; ein MaterialX-Paket entsteht bei Bedarf in RINDR (Material-Panel → MaterialX exportieren) – Nutzer: „die sind schön klein … das mtlx zieht man sich über unseren Konverter“.

**MAX-Leser** (`max-parse.js`, für die Bibliothek erweitert, nützt auch dem MAX-Import): Strom `MatLib` statt `Scene` (gleiche Objektliste; Bibliotheksmaterialien = Materialobjekte, auf die kein anderes verweist → `described.library`, dazu jede Bitmap-Datei aufgelöst), Parameterblock-Einträge `0x000a` mit 11 Byte Kopf (ältere Dateien), Farben Typ 2, `FileAssetMetaData2` (GUID, Typ, Pfad – ohne zweiten Pfad), gzip-Ströme. Material des Render-Plugins (Klasse 37bf3f2f:7034695c/c00) – Parameterblock in Slot 1: 0x01 Diffusfarbe, 0x02 Spiegelfarbe, 0x03 Spiegel-Glanz, 0x3e Glanzlicht-Glanz, 0x08 Fresnel, 0x3f Fresnel-IOR, 0x40/0x41 Kopplungen, 0x05 Brechungsfarbe, 0x06 Brechungs-Glanz, 0x09 Brechungs-IOR, 0x17/0x18 Nebelfarbe/-stärke, 0x42 Nebel-Bias, 0x19 Transluzenz-Art, 0x1a Dicke, 0x25 Transluzenzfarbe; Slot 2: 0x0a BRDF, 0x36/0x3a Anisotropie/Drehung; Maps als eigene Verweise am Material in **Slot 7 + Index** (Diffus, Spiegelung, Brechung, Relief, Spiegel-Glanz, Brechungs-Glanz, Brechungs-IOR, Verschiebung, Transluzenz, Umgebung, Glanzlicht-Glanz, Spiegel-IOR, Deckkraft …), im Map-Block (Slot 4) je Map 0x64 + Index Map, 0x96 + Index an/aus, 0xc8 + Index Stärke (Relief 30 vorbelegt). Abgeleitet am Vergleich Aluminium ↔ Glas ↔ Betonwand (Farb-, Normal-, Glanz-Map).

**Ablauf** (`tools/matlib/README.md`): `classes.mjs` (Klassen je Datei) → `pick.mjs N` (nächste N offene Ordner) → `extract.mjs` (Quellbeschreibung: Materialbaum, entschlüsselte Werte, Maps, Texturdateien, Vorschaubild = Bild, auf das kein Bitmap verweist) → `texstats.js` (Textur-Kennwerte im Browser) → `derive.mjs` (Steckbrief + erste Übersetzung in RINDR-Parameter) → Agenten je ~10 Ordner nach `AGENT.md` (schreiben `out/<folder>.json`, prüfen mit `validate.js`: Graph gegen NODE_TYPES, Material im Viewer, Kugel-Vorschau zum Vergleich mit dem alten Render) → `export.js` (in die Ordner + Vergleichsseite `<Bibliothek>/_review.html`). Node-Katalog `catalog.js` aus dem gebauten Viewer (`__viewer.materialGraph()`, nur mit `?debug`).

**Pilot** (53 Ordner quer durch alle Arten, 5 Agenten): alle gültig, keine Bild-Nodes, keine alten Namen; nah dran: Ziegel, Schiefer, Parkett, Leder, Tarnmuster, Lack, Mayonnaise; schwächer: freie Motive (Goldranken, unregelmäßige Ringe, geschlungene Kordeln, Augen, Glasrisse). 22 Ordner ohne altes Vorschaubild. Aufwand: ~740 000 Agenten-Tokens (~14 000 je Material); hochgerechnet ~35 Mio. für den Rest – Nutzer-Abo: in Etappen, Agenten mit einem günstigeren Modell, eigene Sitzung.

**Gelernt / für den Rest:**
- Größen in **realen Maßen** (Ziegel ~25 × 8 cm, Parkettstab ~7 cm). Auf abgerollten Objekten wirkten sie zu groß – Datei-UVs legen ein Objekt auf 0..1, RINDR nahm eine UV-Einheit als 100 mm (Kugel der Sample-Szene: 340 mm → 3,4×) → Option **„Realer Maßstab“** im Objekt-Mapping (docs/materials.md); die Kugel-Vorschau zeigt den Maßstab nicht (eine Kachel einmal herum).
- Hauptmaterial: manche Bibliotheksdateien enthalten Nebenmaterialien der alten Demo-Szene (Logo, innere Kugel) – `extract.mjs` nimmt das erste Bibliotheksmaterial; besser erkennen (offen).
- Glas/Flüssigkeiten: die Raster-Vorschau zeigt Tönung kaum – nach Zahlen oder HQ-Vorschau (offen).
- Dubletten auch gegen die bestehende Bibliothek prüfen: seit Etappe 1 umgesetzt – vor den Agenten `existing-library.md` im Arbeitsordner erzeugen (Presets mit Parametern + bisher Nachgebautes als `old:<Ordner>`), `duplicateOf` = Preset-Id oder `old:<Ordner>`.
- Lose `.mat` direkt im Bibliotheksordner (ohne Ordner) werden übersprungen.
**Etappe 1** (Okt. 2026, 100 Ordner `002_wood` … `architectural_…` (Acrylglas), 10 Agenten mit dem günstigeren Modell à 10 Ordner, alphabetisch – ähnliche Varianten landen beim selben Agenten): alle gültig, keine Bild-Nodes, keine alten Namen; 79 neue Materialien, 21 Dubletten (viel Aluminium, Gold, Kupfer, mattes Weiß). Aufwand ~786 000 Agenten-Tokens (~7 900 je Material, Pilot ~14 000), ~3–4 min Laufzeit je Agent; hochgerechnet ~19 Mio. für die übrigen ~2 400 Ordner. Schwächen: die Agenten sahen sich meist nur 2–3 Vorschauen je 10 an (AGENT.md verlangt jetzt jede mit altem Render); Ornamente bleiben grob (Arabeske, Sternrelief, Figuren-Relief, Tapetenmuster); „render“ als Kunststoff gedeutet statt als Putz (nachgebessert); Kachelmosaik zweifarbig ging erst mit Stufe aus `random` → `math` (sub/mul/mul/add) → `ramp` (klemmt auf 0..1) – Muster für „jede Zelle eine von zwei Farben“. Hilfsskripte der Agenten kollidierten im gemeinsamen Scratchpad (jetzt je Agent `WORK/tmp/<Ordner>/`). Etwa die Hälfte der Ordner hat kein altes Vorschaubild – dort nur nach Zahlen.

**Etappe 2** (Okt. 2026, 200 Ordner `architectural_porcelain` … `brushed_aluminio_champagne`, 20 Agenten in zwei Wellen à 10 – mehr gleichzeitig überlastet den gemeinsamen Test-Chrome, schon bei 10 einzelne Timeouts von validate.js, die beim zweiten Lauf durchgehen): alle gültig; 183 neue Materialien, 17 Dubletten. ~1,69 Mio. Agenten-Tokens (~8 400 je Material – etwas mehr, weil die Agenten jetzt die Vorschauen mit altem Render ansehen). Neu: `library.mjs` erzeugt `existing-library.md` (vorher fehlten Presets mit anderem Baustein-Namen – Flüssigkeiten, Asphalt, Kies –, Bier und Asphalt wurden deshalb erst im Gesamtcheck als Dubletten erkannt). Gesamtcheck nach jeder Etappe: Ordner = Dateiname, keine Bild-Nodes, Namen/Notizen gegen Marken- und Benutzernamen, Kategorie gültig, fehlende Vorschauen nachziehen (validate.js), Dubletten-Ketten (`old:` auf eine Dublette) auf das Endziel setzen, Dubletten-Ziele vorhanden, Stichproben ähnlicher Materialien (gleiche Kategorie, Farbe/Rauheit nah) gegen Presets. Schwäche von `extract.mjs`: das „alte Vorschaubild“ ist ein Bild, auf das keine Map verweist – manchmal nur eine unbenutzte Textur (Foto, Kratzer); die Agenten merken es meist und gehen nach den Zahlen.

**Etappe 3** (Okt. 2026, der ganze Rest: 2 078 Ordner `brushed_aluminium` … `zomby_skin`, 208 Agenten à 10, fortlaufend statt in Wellen – je fertigem Agent startet der nächste): alle gültig, keine Bild-Nodes; 1 918 neue Materialien, 160 Dubletten. ~19,2 Mio. Agenten-Tokens (~9 200 je Material – mehr als in Etappe 2, weil die Agenten im überlasteten Test-Chrome Prüfläufe wiederholten). Erfahrungen: (1) **Nebenläufigkeit:** mehr als ~10 Agenten oder parallele/hintergründige validate-Läufe je Agent machen den gemeinsamen Chrome so langsam (zeitweise 5 min je Datei), dass Prüfläufe abbrechen; abgebrochene Läufe ließen ihre Tabs offen und rendern weiter (validate.js/export.js schließen ihren Tab jetzt auch bei Abbruch, AGENT.md verlangt einen Prüflauf nach dem anderen). Den Export nicht neben laufenden Agenten – er kam dort nur auf ~1 Material/min; danach allein ~1/s. Agenten, die nach ihrem Bericht „auf Hintergrundarbeit warten“, belegen weiter einen Platz – beenden. (2) **Marken/Handelsnamen:** die Agenten übernehmen Handelsnamen von Werkstoffen als Gattungsbegriff (Mikrofaser-Velours, Polystyrol-Hartschaum, Acrylglas, Klettband …) – in AGENT.md als Regel ergänzt, im Auftrag je Gruppe genannt, wenn der Ordnername eine Marke/Firma/Person/einen Film enthält; `check.mjs` (neu) sucht Marken- und Ordnernamen-Wörter in Namen und Notizen. (3) **Dubletten:** die Agenten markieren zu großzügig (andere Farbe/Oberfläche als „fast gleich“) – AGENT.md: Dublette = austauschbar, im Zweifel keine; von Hand ~15 zurückgenommen. Sondermaterialien von RINDR (Seifenblase, Leuchtmarmor …) als Ziel nutzen. (4) **Glatte Metalle** wirken in der Raster-Vorschau dunkel – nicht durch weniger Metallic „ausgleichen“ (AGENT.md). Gesamtcheck: `node tools/matlib/check.mjs [--fix] [Ordner …]` (fehlende Dateien/Vorschauen, Bild-Nodes, Kategorie, Namen, Dubletten-Ziele und -Ketten, Reste im Arbeitsordner).

**Flake-Lacke nachgebessert** (29.10.2026, Hinweis des Nutzers am tiefblauen Flake-Lack): die Agenten hatten Flakes als Sprenkel → Höhe (Relief) gebaut – dunkle Ringe um Glanzpunkte, in HQ zusätzlich ein Fehler des Pathtracers (Lack bekam das Relief ab, behoben – docs/pathtracer.md). Die 9 Metallic-/Flake-Lacke (Ordnerliste `_work/flake-paints.list` – Ordnernamen enthalten Marken, darum nicht hier; beim Graphit-Lack Grund/Flake-Farbe getauscht, Flakes grün) per Skript auf den neuen Ausgang Flake-Normale umgebaut (+ Metall/Rauheit je Flake, Auflösung 2048) und neu exportiert; die übrigen 13 Materialien mit Sprenkel-Relief unter Lack (Granit, Terrazzo, Asphalt, Erdbeere …) behalten ihr Relief – dort sind es echte Erhebungen. Originale im Scratchpad `flake-backup/`. Achtung: `export.js` überschreibt `_review.html` mit den exportierten Ordnern – bei Nach-Exporten vorher sichern.

**Glitzer statt Flecken** (29.10.2026, Wunsch des Nutzers nach den Beispielbildern von `flake_paints_1915`: „eher wie Glitzer unter dem Klarlack“): Rezept „K“ für die 9 Flake-Lacke – Grund = Lackfarbe, metallisch 0,6, Rauheit 0,4; Sprenkel als feine Splitter (`scale` 200, `size` 0,75, `density` 0,8, `layers` 1, `roundness` 0, `softness` 0, `tone` 0,6–0,8, Flake-Neigung 0,3–0,45), Flake-Farbe = aufgehellte Lackfarbe (Faktor ≤ 2 bis max. 230, damit helle Lacke nicht grell werden), im Flake Metall 1 / Rauheit 0,12; Flake-Größe über die Kachel (fein ~0,12 mm, mittel ~0,19 mm, grob ~0,35 mm). Erkenntnis aus den Proben: einzelne helle Flakes auf rauem Grund wirken wie „Schnee“ (jeder spiegelt irgendwo ein Fenster) – der Schimmer muss aus den vielen Flakes selbst entstehen, dann funkelt es nur zum Licht hin. `car_paint_metallic_blue_27` und `car_paint_black_metallic_812` hatten Grund- und Sprenkelfarbe vertauscht (hell mit dunklen Sprenkeln) – mit dem Rezept neu gebaut. Weitere Metallic-Autolacke (Sprenkel → Metall, ohne Flake-Normale) könnten das Rezept ebenfalls bekommen – offen.

**Varianten „… mit Wirbelkratzern“** (29.10.2026, Wunsch des Nutzers): für 39 glänzende Autolacke (Klarlack ≥ 0,8, ohne matt/seidenmatt/Streifen/Schlamm/Felgen) – Kratzer-Node im Klarlack (Rezept in docs/materials.md). Als zweite `.rindr.json` im Ordner des Originals; Arbeitsdatei `out/<ordner>__swirl.json` mit `variantOf: "old:<ordner>"`; `export.js` nimmt Varianten über den Dateinamen (`node export.js <ordner>__swirl`), `validate.js` benennt die Vorschau nach dem Dateinamen, `check.mjs` akzeptiert `__`-Varianten. Liste: `_work/swirl-variants.list`. Noch mit dem ersten Rezept (gerade Kratzer, Anisotropie 0,95, Länge 1,8, 2048) – das endgültige steht im Preset `paint-car-swirl-black` (docs/materials.md); Varianten neu bauen, wenn gewünscht.

**In RINDRs Bibliothek** (29.10.2026, Wunsch des Nutzers): `presets/car-paint.js` – `paint-car-swirl-black` „Autolack schwarz mit Wirbelkratzern“ und `paint-car-flakes-blue` „Autolack tiefblau metallic mit Flakes“ (Glitzer-Rezept K).
- Einzelne Dateien liefern keine Materialklassen (z.B. ein Holz-Ordner, dessen Klassenverzeichnis anders aufgebaut ist – `classes.json` mit leerer Liste, Quelle `?`): ansehen, wenn sie im Durchlauf gehäuft auftreten.
