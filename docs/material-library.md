# Material-Bibliothek (Presets aus den MAX-Bibliotheken)

Okt. 2026, Wunsch des Nutzers: die besten Materialien aus `tests/MatLibs` (615 MAX-Materialien) in die eigene Bibliothek übernehmen – **ähnliche nur einmal**, **keine Texturen** (Optik prozedural mit den Nodes nachgebaut, MAX-Werte nur Orientierung, eigene Werte und Namen), **keine Markennamen**. Weggelassen: gedruckte Motive (Blumenteppiche, Mustertapeten, Läufer), Geometrie-Dinge (Zäune, Maschendraht, Reifenprofile, Glasbausteine).

- Aufbau: je Kategorie eine Datei `src/scripts/presets/<bereich>.js` (Default-Export = Preset-Array, per `import.meta.glob` in `material-presets.js` angehängt), Graphen mit dem Baukasten `presets/graph.js` (`graph({ size, relief })`, `node`, `link`, `out`, `done`). Namen in `materials.presets.<id>` (beide Sprachen). Insgesamt 217 Presets (vorher 41; seit Okt. 2026 dazu „Milchglas“ und „Jade“ mit Trübung – docs/material-format.md „Streuende Medien“). Erstellt je Bereich von einem Agenten in eigenem Worktree, vom Hauptagent geprüft (Vorschaukugeln + gebackene Maps) und zusammengeführt.
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
