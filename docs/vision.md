# Zukunftsvisionen

## Distributed Rendering (Rendern auf mehreren Rechnern)
**Umsetzung läuft seit Okt. 2026 – Stand in `docs/distributed.md`** (Entscheidung des Nutzers: Buckets mit Beschriftung statt Samples aufteilen; dynamische Warteschlange gleicht unterschiedlich schnelle Rechner aus, Entrauschen einmal über das ganze Bild). Die Überlegungen unten bleiben als Hintergrund.

Nur für finale Standbilder (hohe Auflösung/viele Samples) und Animationen sinnvoll – nicht für die interaktive Ansicht (jede Kamerabewegung = Neustart auf allen Knoten, Netzwerk-Latenz frisst den Gewinn). Grundlage ist der Szenen-Zustand (`scene-state.js`): Modelldatei + Zustand-JSON + HDRI legen ein Bild eindeutig fest.

**Standbild: Samples aufteilen statt Kacheln**
- Jeder Knoten rendert das *ganze* Bild mit eigenem Zufalls-Seed, Koordinator mittelt gewichtet nach Sample-Zahl (4 Knoten × 64 Samples ≈ 256 Samples in ¼ der Zeit).
- Vorteile gegenüber Kacheln: kein Lastungleichgewicht (Glas/dunkle Ecken teurer als Himmel), unterschiedlich schnelle GPUs mischbar, Ausfall eines Knotens kostet nur Samples, Bild wird progressiv besser, keine Nähte – OIDN einmal am Ende auf dem gemittelten Bild.
- Netzwerk: ein Float-Bild je Knoten und Runde (Full HD ~16–32 MB) + einmal Albedo/Normalen für den Denoiser.

**Animation: Frames aufteilen**
- Noch einfacher: jeder Knoten rendert ganze Frames (Frame-Splitting), Koordinator verteilt Frame-Nummern und sammelt die fertigen (entrauschten) Bilder ein → Video/Bildfolge.
- Dafür bräuchte es eine Animationsbeschreibung im Szenen-Zustand (Kamerapfad, Bauteil-Bewegungen als Keyframes). Eine Kamerafahrt durch die gespeicherten Ansichten + Drehteller in der Abspielleiste wurde gebaut (Okt. 2026) und auf Wunsch des Nutzers wieder entfernt (Kamera-Auswahl erschien bei jedem animierten FBX und verwirrte).

**Bausteine**
1. Render-Knoten: Viewer ohne Oberfläche (z.B. `?node`) – lädt Modell + Zustand + HDRI, rendert mit eigenem Seed bzw. zugeteilte Frames, schickt das Ergebnis zurück. Beliebiger Browser mit WebGPU oder Headless-Chrome auf einem GPU-Server.
2. Koordinator: kleiner Server (z.B. Node + WebSocket) – verteilt Aufträge, sammelt/mittelt, entrauscht, liefert aus. Der eigene Browser kann mitrendern.
3. Pathtracer: Seed je Knoten (`stableNoise = true` ist Voreinstellung → alle Knoten würden identische Samples liefern, prüfen/umbauen); Readback des aufsummierten Float-Bilds aus dem Render-Target (nicht des tonemappten Canvas).
4. Gleiche Geometrie überall: identische Tessellierung (gleiche Qualitätsstufe, STEP-Kernel deterministisch? – prüfen).

**Grenzen / offene Fragen**
- Jeder Knoten braucht das ganze Modell im GPU-Speicher – hilft nicht bei Modellen, die für eine GPU zu groß sind.
- Große STEP-Dateien müssen zu jedem Knoten → zentral ablegen statt per Browser hochladen.
- Vorgehen: erst Prototyp im lokalen Netz (2 Tabs/Rechner, Node-Koordinator, Knopf „Verteilt rendern“), dabei zuerst Seed/Readback klären; danach Robustheit (Knoten-Ausfall, Fortschritt) und Modell-Ablage.

## Licht-Passes (Light Mix) und Export mit Ebenen (EXR, PSD)
**Umgesetzt (Okt. 2026)** – Stufe 1 bis 2, Hilfs-Passes, EXR und PSD: siehe `docs/pathtracer.md` „Licht-Passes“ und `docs/export-ki.md`. Abweichungen vom Plan: Passes nur über das Render-Fenster (EXR/PSD, als Buckets, auf Wunsch verteilt), nicht in der laufenden HQ-Ansicht; das Fenster zum nachträglichen Mischen (Stärke/Farbe je Quelle) wurde gebaut und auf Wunsch des Nutzers wieder entfernt; Schatten-Pass = verdecktes direktes Licht (nicht für Alpha samt Bodenschatten in einem Durchlauf – das transparente PNG bleibt bei zwei Durchgängen). Der Plan bleibt als Hintergrund:

Heute liefert der Pathtracer nur das fertige Farbbild (Beauty); transparentes PNG entstand aus zwei Durchgängen vor Schwarz/Grau (`exportPasses`, verteilt ebenso) – seit Okt. 2026 aus einem Render mit Durchlässigkeits-Pass (docs/pathtracer.md).

**Stufe 1 – pro Lichtquelle (Light Mix):** ein Pass je Quelle – Hauptlicht, Fülllicht, Umgebungslicht, **HDRI** (Licht der Umgebung, auch indirekt: Reflexionen, Bodenschatten), **Hintergrund** getrennt vom HDRI-Licht, Eigenleuchten. Nach dem Rendern Helligkeit und Farbe/Tönung je Quelle **live in RINDR** (Regler, Bild sofort neu gemischt: Σ Gewicht · Farbe · Pass), ohne neu zu rendern. Nicht nachträglich: Drehung des HDRI, Lage der Lichter (Richtungen → neu rendern); einzelne Teile des HDRI (Sonne, Pins des HDRI-Editors) erst später denkbar (bei eigenen HDRIs sind sie bekannt).
- Kernel (`PathTracerMegaKernel.js`, per Vite-Patch wie `rindr-bucket`): alles Licht wird an fünf Stellen auf `resultColor` addiert – vorwärts getroffene Lichter (Index `li`), Eigenleuchten, direkte Beleuchtung (NEE, `lightIndex`; `== lightsCount` = Umgebung), Umgebung bei Fehltreffer nach Abprall, Hintergrund beim Kamerastrahl – an jeder ist die Quelle bekannt → Beitrag zusätzlich in den Puffer der Quelle (Speicherpuffer `array<vec4f>` je Pass statt Textur-Pingpong; Speicher je Pass bei 4K ~130 MB → ins Speicherbudget, `memory-budget.js`).
- Entrauschen: jeder Pass einzeln (Summe muss stimmen) – Zeit × Anzahl Passes; Live-Mischen auf den entrauschten Passes.
- Verteilt: Buckets liefern alle Passes (Datenmenge × Anzahl).

**Stufe 2 – nach Lichtart:** Diffus, Spiegelung, Refraktion, Eigenleuchten, Hintergrund (klassische Compositing-Ebenen, Summe = Beauty). Tieferer Umbau: Pfad am ersten Treffer nach gewähltem Material-Anteil markieren; die direkte Beleuchtung am ersten Treffer braucht die Material-Auswertung (`bsdfEvalPdf`) getrennt nach Anteilen. Danach Schatten-Pass (Licht mit/ohne Verdeckung) – damit auch Alpha samt Bodenschatten in einem Durchlauf (zweiter Pass beim transparenten PNG entfällt).

**Hilfs-Passes (günstig):** Alpha, Tiefe, Normalen, Albedo (Normalen/Albedo rechnet der Pathtracer schon für den Entrauscher), Objekt-/Material-ID-Masken.

**Ausgabe:** **EXR** mehrlagig (linear, Float – eigener Schreiber wie `png-encode.js`) als Hauptformat; **PSD** mit einer Ebene je Lichtquelle, Füllmethode Addieren, Alpha-Kanal + Gesamtbild – nur in **32 Bit** stimmt die Summe (8/16 Bit: Ebenen in sRGB, addiert zu hell/flau – dort höchstens Masken/Hilfsebenen); eigener Schreiber nach der offenen Formatbeschreibung.

**Reihenfolge (Vorschlag, vom Nutzer so besprochen):** Licht-Passes je Quelle im Kernel + Live-Regler → EXR → PSD (32 Bit) → Stufe 2.

