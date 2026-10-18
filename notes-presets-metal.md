# Bibliotheks-Materialien: Metall (presets/metal.js)

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
