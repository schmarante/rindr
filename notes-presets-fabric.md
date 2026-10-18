# Presets Stoff & Teppich / Kunststoff (`src/scripts/presets/fabric.js`)

29 Presets, alle prozedural (Gewebe, Wellen, Zellen, Sprenkel, Dellen, Lochmuster, Rauschen). Größen real (mm je Kachel).

## Wichtig: Fehler im Gewebe-Node (`nodes/weave.js`)
`imod` addiert ½ doppelt (`wrap` rundet schon am Zellmittelpunkt) → `imod(1, 2)` = −1 statt 1. Folge: Leinwandbindung zeigt nur Kettfäden,
Denim (3/1) nur Kette, Köper ist 3/1 statt 2/2, Satin 3/5. Korrektur: `const imod = (i, period) => wrap(i, period);` – lokal geprüft
(Rot/Blau-Testbild: Leinwand, Köper, Fischgrat korrekt). Die Presets sind **auf den korrigierten Node abgestimmt** (ohne Korrektur: Denim
fast schwarzblau, Leinen/Canvas ohne Schuss, Streifen zu kräftig). Nicht in diesem Zweig geändert (fremde Datei).

## Stoff & Teppich (`fabric`)
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

## Kunststoff (`plastic`)
| ID | Aufbau | MAX-Vorlagen |
|---|---|---|
| plastic-carbon | Köper 2/2, Rauheit Kette/Schuss verschieden, Klarlack | Laminate.CarbonFiber |
| plastic-grained | feine Zellen-Narbung (Armaturenbrett, Gehäuse) | Plastics.Vinyl (Struktur) |
| plastic-laminate | zweifarbiger Sprenkel, leichte Orangenhaut | Plastic Laminates.* (6 Farben → eins) |
| rubber-neoprene | feine Poren (Dellen), matt | Rubber.Neoprene, Rubber.Black.Textured1 |
| rubber-studded | Noppen auf Raster | RubberBlack (Raytrace) |
| foam-polystyrene | verschmolzene Perlen (Zellen) | Plastics.PolyStyrene, Rigid Insulation |
| foam-rubber | dichte offene Poren (Dellen) | Plastics.Foam.Rubber, Carpet.Pad.Waffled |

## Zusammengelegt / weggelassen
- Dubletten: PVC weiß (= vorhandenes „Kunststoff weiß glänzend“), Latex (= „Kunststoff schwarz glänzend“/„Gummi schwarz“), Rubber.Black/Pink
  (= „Gummi schwarz“), Velour vs. Samt (ein Samt), Leinen weiß/beige (eins), Laminat-Farben (eins).
- Nicht prozedural sinnvoll: bedruckte Motive (Carpet.Floral, Saxony.FlowerPattern.*, Saxony.Squares, Wall Covering.Floral/Pattern1–5/Tan),
  Spitze mit Motiv (nur als Tüll/Netz), Reifenprofile (TireTread.* – Geometrie), Folie/Acryl/Polyethylen (Glas-Kategorie: plastic-clear).
- Wiener Geflecht ohne Diagonalstränge (achteckige Öffnungen bräuchten gedrehte Muster) – quadratische Öffnungen.

Prüfbilder: Scratchpad `tools/work-p-fabric/final-spheres.jpg`, `final-colors.jpg` (mit korrigiertem Gewebe-Node), `nofix-spheres.jpg` (ohne).
