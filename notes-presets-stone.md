# Presets Naturstein & Mauerwerk (`src/scripts/presets/stone.js`)

28 Materialien, alles prozedural (Marmor-, Speckle-, Kachel-, Zellen-, Rauschen-, Wellen-Node). Poliert = flach (kein Relief) + Klarlack; geschliffen/gespalten = matt mit Relief und Rauheit aus den Masken.

## Naturstein (`stone`)
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

## Mauerwerk (`masonry`)
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

## Ausgelassen
- Glass Block, CMU Screen, Brick Screen: Geometrie (Durchbrüche/Glas), nicht als Oberfläche sinnvoll.
- Adobe, Norman One-Third Running: zu ähnlich zu den vorhandenen Ziegeln (Läuferverband, Farbe/Verband im Node umstellbar).
- Terrazzo (Finishes): nicht mein Bereich; Flagstone, Cobble Stone, Riverstone-Pflaster, Pavers (SiteWork): Außenbereich.
- Amethyst/Edelsteine: kein Naturstein-Belag.
- Control Joints Black: reine Fugenfarbe.

## Hinweise
- Größen real: NF-Ziegel 240 × 71 mm + 10 mm Fuge (4 × 12 je 1 m), Betonstein 390 × 190 mm (3 × 6 je 1,2 m), Pflaster/Flechtziegel 200 × 100 mm, Quader 600–1200 mm.
- Granit: zwei verkettete Speckle-Nodes (dunkle Glimmer + helle Quarze); Ziegel/Quader: Kachel-`uv` → Rauschen für Flecken je Stein.
