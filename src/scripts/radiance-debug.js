// Radiance cache cells over the picture (user: "im Debugger eine Visualisierung – alle Punkte des Radiance-Caches rot,
// so dass ich sehe, welche neu hinzukommen"; later also as "Zellen anzeigen" in the path tracing settings, like the
// calculation phase display of offline renderers). createRadianceCells() is the overlay, attachRadianceDebug() adds its
// line + switch to the debug display (?debug) – both switches drive the same overlay. Shown, it reads the cache back about once a
// second (radiance-cache.js RADIANCE_GRID, ~36 MB) and draws every taken cell as a point at its centre (its level gives
// its size), all in one red at 4 px (user: "lassen wir als Indikator einfach rot, aber die Punkte sollten größer sein" –
// dark red for collecting and pale for new cells read as grey). Line: cells taken / usable / new in the last 3 s / share
// of the table.
// Only what the camera sees (user: "nicht durchscheinen lassen"): render() first draws the models' meshes into the depth
// buffer alone (stand-ins sharing their geometry and placement, depth only – drawing the whole scene with an override
// material turned the sample scene's picture grey: background, dome and ground helpers wrote their colours), then the
// points with a depth test – moved one cell towards the camera (a cell's centre lies up to half a cell
// behind the surface it belongs to; at the centre they flickered in and out of it).
import * as THREE from 'three/webgpu';
import { t } from './i18n.js';
import { CHECKBOX } from './ui-controls.js';
import { RADIANCE_CACHE, RADIANCE_GRID, RADIANCE_SLOTS, RADIANCE_STRIDE, clearRadianceCache, readRadianceOccupancy } from './radiance-cache.js';

const READ_MS = 1000;
let lastSync = 0;
// shown with all its parents
const isShown = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
const FRESH_MS = 3000;   // a new cell stays marked this long

/** The overlay. @param {{ renderer, camera, meshes: () => THREE.Mesh[], requestRender }} ctx */
export function createRadianceCells({ renderer, camera, meshes = () => [], requestRender = () => {} }) {
    let shown = false;
    const listeners = new Set();   // (stats line, shown) – the debug display's line and switch
    const text = { set textContent(v) { line = v; listeners.forEach(f => f(line, shown)); } };
    let line = t('debugStats.radiance.off');

    const points = new THREE.Scene();
    const depthScene = new THREE.Scene();
    const depthOnly = new THREE.MeshBasicNodeMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const stand = new Map();   // model mesh → its depth stand-in
    const syncStandIns = () => {
        const live = new Set();
        for (const m of meshes()) {
            if (!m.isMesh || m.isBatchedMesh || !m.geometry) continue;
            live.add(m);
            let s = stand.get(m);
            if (!s || s.geometry !== m.geometry) {
                if (s) depthScene.remove(s);
                s = m.isInstancedMesh ? new THREE.InstancedMesh(m.geometry, depthOnly, m.count) : new THREE.Mesh(m.geometry, depthOnly);
                if (m.isInstancedMesh) s.instanceMatrix = m.instanceMatrix;
                s.matrixAutoUpdate = false;
                s.frustumCulled = false;
                stand.set(m, s);
                depthScene.add(s);
            }
        }
        for (const [m, s] of stand) if (!live.has(m)) { depthScene.remove(s); stand.delete(m); }
    };
    const material = (color, size) => new THREE.PointsNodeMaterial({ color, size, sizeAttenuation: false, depthTest: true, depthWrite: false });
    const make = (color, size) => {
        const p = new THREE.Points(new THREE.BufferGeometry(), material(color, size));
        p.frustumCulled = false;
        p.visible = false;
        points.add(p);
        return p;
    };
    const cellsLayer = make(0xff2020, 4);
    const layers = [cellsLayer];
    let seen = new Float64Array(RADIANCE_SLOTS), first = true, clears = -1, busy = false, last = 0;   // seen: when a slot was first found taken

    const setPoints = (points, list) => {
        points.geometry.dispose();
        points.geometry = new THREE.BufferGeometry();
        points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    };

    async function read() {
        busy = true;
        try {
            if (!RADIANCE_CACHE.on.value) { text.textContent = t('debugStats.radiance.off'); for (const l of layers) l.visible = false; return; }
            const data = new Uint32Array(await renderer.getArrayBufferAsync(RADIANCE_GRID));
            const i32 = new Int32Array(data.buffer, data.byteOffset, data.length);
            const cell = RADIANCE_CACHE.cell.value, min = RADIANCE_CACHE.minCount.value;
            const eye = camera.getWorldPosition(new THREE.Vector3());
            if (clearRadianceCache.count !== clears) { clears = clearRadianceCache.count; seen.fill(0); first = true; }
            const a = [], b = [], f = [], t0 = performance.now();
            let all = 0;   // every taken slot (light and distance cells) – the share the automatic clearing looks at
            for (let s = 0; s < RADIANCE_SLOTS; s++) {
                const e = s * RADIANCE_STRIDE;
                if (!data[e] || !data[e + 4]) continue;
                const meta = data[e + 8];
                all++;
                if ((meta >>> 16) & 0xf) continue;   // distance cells (where corners make the light cells finer) are not drawn
                // (glossy cells: one per direction bucket – drawn at the same place)
                const side = 2 ** ((meta & 0xffff) - 128);
                let x = cell.x + (i32[e + 5] + 0.5) * side, y = cell.y + (i32[e + 6] + 0.5) * side, z = cell.z + (i32[e + 7] + 0.5) * side;
                const dx = eye.x - x, dy = eye.y - y, dz = eye.z - z, d = Math.hypot(dx, dy, dz) || 1, k = Math.min(side, d * 0.5) / d;
                x += dx * k; y += dy * k; z += dz * k;
                (data[e + 4] >= min ? a : b).push(x, y, z);
                if (!seen[s]) seen[s] = first ? -1 : t0;   // the first read after a clear: no "new" marks for everything
                if (seen[s] > 0 && t0 - seen[s] < FRESH_MS) f.push(x, y, z);
            }
            first = false;
            setPoints(cellsLayer, a.concat(b));
            for (const l of layers) l.visible = shown && l.geometry.getAttribute('position').count > 0;   // no empty draws
            const taken = (a.length + b.length) / 3;
            const counter = await readRadianceOccupancy(renderer);   // what the automatic clearing reads
            text.textContent = t('debugStats.radiance.stats', { taken: taken.toLocaleString(), usable: (a.length / 3).toLocaleString(), fresh: (f.length / 3).toLocaleString(), share: (all / RADIANCE_SLOTS * 100).toFixed(1) }) + (counter != null ? ` (${t('debugStats.radiance.counter', { counter: counter.toLocaleString() })})` : '');
            requestRender();
        } catch (err) {
            text.textContent = t('debugStats.radiance.off');
            console.warn('[Radiance cache debug]', err?.message || err);
        } finally {
            busy = false;
        }
    }

    return {
        /** draw the points this frame? Set: show / hide them */
        get visible() { return shown; },
        set visible(v) {
            if (shown === !!v) return;
            shown = !!v;
            for (const l of layers) l.visible = shown && l.geometry.getAttribute('position')?.count > 0;
            if (shown && !busy) { last = performance.now(); read(); }
            listeners.forEach(f => f(line, shown));
            requestRender();
        },
        /** f(stats line, shown) on every change; returns the current state at once */
        listen(f) { listeners.add(f); f(line, shown); },
        /** the points over the picture, hidden where the scene is in front: the scene into the depth buffer, then them */
        render() {
            if (!stand.size || performance.now() - lastSync > READ_MS) { lastSync = performance.now(); syncStandIns(); }
            for (const [m, s] of stand) { s.matrix.copy(m.matrixWorld); s.matrixWorld.copy(m.matrixWorld); s.visible = isShown(m); }
            const autoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(depthScene, camera);
            renderer.render(points, camera);
            renderer.autoClear = autoClear;
        },
        /** call every frame: reads the cache about once a second while shown */
        update() {
            if (!shown || busy) return;
            const now = performance.now();
            if (now - last < READ_MS) return;
            last = now;
            read();
        },
    };
}

/** The debug display's section (?debug): the stats line and a switch for the same overlay */
export function attachRadianceDebug(root, cells) {
    const box = document.createElement('div');
    box.className = 'mt-1 border-t border-white/15 pt-1';
    const text = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'mt-1 flex items-center gap-2';
    const show = Object.assign(document.createElement('input'), { type: 'checkbox', className: CHECKBOX });
    label.append(show, t('debugStats.radiance.show'));
    box.append(text, label);
    root.append(box);
    show.addEventListener('change', () => { cells.visible = show.checked; });
    cells.listen((line, shown) => { text.textContent = line; show.checked = shown; });
}
