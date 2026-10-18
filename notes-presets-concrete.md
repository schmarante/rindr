# Presets Beton & Putz / Fliesen & Böden (`src/scripts/presets/concrete.js`)

Alle Looks prozedural (Node-Graph, auf der GPU gebacken), eigene Werte und Namen; MAX-Bibliotheken nur zur Orientierung.

## Beton & Putz (`concrete`)
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

## Fliesen & Böden (`tiles`)
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

## Weggelassen
- Bedruckte Motive: Ceramic.Mosaic.Floral.Rose & Green, VCT.Diamond.Rosette (Rosettenmuster) – nicht sinnvoll prozedural.
- Doppelte/ähnliche Varianten zusammengefasst (siehe Tabellen): mehrere Grautöne Sichtbeton, Stucco-Farben (Farbe im Material frei änderbar), Terrazzo-Farbvarianten, Fliesenfarben.
- Concrete_Asphalt (Außenbereich), Concrete_Blue/Brown_Stucco (Farbvarianten von Putz), Control Joints.Black (nur schwarze Farbe), Concrete_Tiles (Gehwegplatten → Außenbereich), Lack/Wachs-Finishes (Painting.HighGloss/Lacquer, Wax.*: einfache Lack-Parameter, Kategorie Lack), Metall-Ständerwerk (Furring/Stud – Geometrie), Gummiboden mit Noppen (Stoff-Agent).
- Holzböden/Parkett und Natursteinplatten gehören zu Holz bzw. Naturstein.

## Prüfung
Gebacken mit `bake.js` (echte GPU), Kontaktbögen im Scratchpad `tools/work-p-concrete/final-*.jpg`.
