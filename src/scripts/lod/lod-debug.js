// Debug display (?debug): cluster LOD section below the stats – state of the background build, cuts, time of the
// choice per frame; LOD on/off, error threshold (px), colours. "Share per part" tints what is really drawn
// (render-batcher.js, lod.tint): each part by the share of triangles its current cut keeps, red = all … blue = 1/128
// or less, grey = no LOD. (The earlier separate view through a vertex-pulling mesh showed the cluster hierarchy, not
// what the real drawing does – dropped, user's choice.)
import { t } from '../i18n.js';
import { RANGE, SELECT, CHECKBOX } from '../ui-controls.js';
import { LOD } from '../config.js';

/** @param {HTMLElement} root debug display @param {{ batcher }} ctx */
export function attachLodDebug(root, { batcher }) {
    const lods = batcher.lods, lod = batcher.lod;
    const box = document.createElement('div');
    box.className = 'mt-1 border-t border-white/15 pt-1';
    const text = document.createElement('div');
    // the controls only while the model is large enough for LOD (below LOD.minTriangles just the note)
    const controls = document.createElement('div');
    const row = () => { const d = document.createElement('label'); d.className = 'mt-1 flex items-center gap-2'; controls.append(d); return d; };
    box.append(text, controls);

    const onRow = row();
    const on = Object.assign(document.createElement('input'), { type: 'checkbox', checked: lod.enabled, className: CHECKBOX });
    onRow.append(on, t('debugStats.lod.enabled'));

    const thrRow = row();
    const thr = Object.assign(document.createElement('input'), { type: 'range', min: -1, max: 4, step: 0.25, value: Math.log2(lod.threshold), className: RANGE });
    const thrOut = document.createElement('span');
    thrOut.className = 'w-8 text-right';
    thrRow.append(t('debugStats.lod.threshold'), thr, thrOut);

    const colRow = row();
    const col = Object.assign(document.createElement('select'), { className: SELECT });
    for (const k of ['material', 'share']) col.append(new Option(t(`debugStats.lod.color.${k}`), k));
    colRow.append(t('debugStats.lod.colors'), col);
    // legend: one colour per halving of the triangles (same ramp as render-batcher.js)
    const legend = document.createElement('div');
    legend.className = 'mt-1 flex items-center gap-1';
    legend.hidden = true;
    const ramp = document.createElement('span');
    ramp.className = 'h-2 w-24 rounded-sm';
    ramp.style.background = 'linear-gradient(90deg, hsl(0 85% 50%), hsl(60 85% 50%), hsl(120 85% 50%), hsl(180 85% 50%), hsl(240 85% 50%))';
    legend.append(t('debugStats.lod.legendFull'), ramp, t('debugStats.lod.legendCoarse'));
    // switching on compiles the debug shaders first (render-batcher.js setTint – no freeze, takes a while)
    const preparing = document.createElement('div');
    preparing.className = 'mt-1 text-white/60';
    preparing.textContent = t('debugStats.lod.preparing');
    preparing.hidden = true;
    controls.append(legend, preparing);
    root.append(box);

    const setThr = () => {
        lod.threshold = 2 ** Number(thr.value);
        thrOut.textContent = lod.threshold.toFixed(2);
    };
    thr.addEventListener('input', setThr);
    setThr();
    on.addEventListener('change', () => { lod.enabled = on.checked; });
    col.addEventListener('change', () => {
        const share = col.value === 'share';
        legend.hidden = !share;
        preparing.hidden = !share;
        batcher.setTint(share);
    });

    const tick = () => {
        if (!box.isConnected) return;
        const s = lods.stats;
        const lines = [];
        if (!lod.model) lines.push(t('debugStats.lod.inactive', { min: (LOD.minTriangles / 1e6).toFixed(1) }));
        else {
            lines.push(t('debugStats.lod.status', { built: s.built, total: s.built + lods.queued.size + s.failed, triangles: (s.triangles / 1e6).toFixed(2), seconds: (s.buildMs / 1000).toFixed(1) })
                + (lods.busy ? t('debugStats.lod.building') : ''));
            lines.push(t('debugStats.lod.select', { cuts: s.cuts, ms: lod.selectMs.toFixed(2) }));
        }
        text.textContent = lines.join('\n');
        controls.hidden = !lod.model;
        preparing.hidden = col.value !== 'share' || lod.tint;
        setTimeout(tick, 100);
    };
    tick();
}
