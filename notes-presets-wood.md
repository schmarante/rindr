# Holz-Presets (`src/scripts/presets/wood.js`, Kategorie `wood`)

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

## Ausgelassen
- Wurzelholz (BurrElm, Burloak): zwei Versuche (Turbulenz-Rauschen + Sprenkel-Augen; Holz-Node mit maximaler Unregelmäßigkeit) sahen nach Leder/Stein bzw. normaler Maserung aus – bräuchte einen eigenen Maser-Node (Wirbel um Augen).
- RoseMyrtle (Flammen-/Wolkenfigur): wie Wurzelholz.
- Rinde (Bark, Bark2, Treebark), Zäune (Fences & Gates), Pegboard (Lochmuster → eher Metall/Platten-Agent), Schindeln (Wood_Shingle), Fassadenschalung/Siding: Geometrie bzw. Bereich Außen.
- Kunststoff-Laminate (Plastic Laminates), Wachs-Farben (Wax.Black/Red), Pappe: Kunststoff-/Sonstiges.
- Schalungsbeton mit Brett-/Sperrholz-Abdruck: Beton-Bereich.
