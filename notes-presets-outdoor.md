# Presets Außenbereich (`src/scripts/presets/outdoor.js`)

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

## Weggelassen
- Zäune, Maschendraht, Sichtschutz (Fences & Gates) und geflochtene Körbe (Basket.Woven) – Geometrie bzw. andere Kategorie.
- Metall-Dach-/Fassadenpaneele (Stehfalz, Wellblech, Kupfer/Patina), Composite Panels – gehören zu Metall.
- Blaue „Spanish“-Ziegel – nur Farbvariante; Farbe im Preset anpassbar.
- Split-Log-Fassade – Rundholz-Geometrie.
- Asphalt Shingles „Deep Shadow“ als eigene Variante – zu ähnlich zu den 3er-Laschen.
- Evergreen/Mulch/Seafloor-Bilder – bildhafte Motive, prozedural nicht sinnvoll.

## Hinweise
- Holz läuft im Holz-Knoten immer entlang u; senkrechte Bretter/Schindeln bekommen ihre Faser deshalb aus einem feinen Wellen-Knoten (Achse u, Verzerrung) statt aus dem Holz-Knoten.
- Vorschau-Kugel wirkt durch die bunte Umgebung heller als die Albedo; Farbwerte bewusst eher dunkel gewählt.
