// Render window (teapot in the bottom bar – image export and distributed rendering in one, user's wish): the current
// view path traced as PNG – optionally with a transparent background that keeps the ground shadow – or as JPG, in the
// canvas resolution or 2–4× larger (rendered again at that size, up to ctx.maxSize() px per side), with a chosen
// number of samples. Here: waits for the finished (denoised) image like the AI button. Distributed: the buckets go to
// the render clients (docs/distributed.md) – the window closes so the labelled buckets can be watched, status and ✕
// bottom left, the file is saved when the image is done. Panel style like the other windows, no darkening.
// The image itself comes from the viewer (ctx.exportImage → canvas; transparency: exportImage/composeMatte in viewer.js;
// ctx.distributed.render).
import { t } from './i18n.js';
import { dialogOpen } from './dialog.js';
import { icon } from './icons.js';

const BTN = 'rounded px-3 py-1 outline-none transition-colors';
const ICON_CLOSE = icon('close', 'size-3.5');

/**
 * @param {{ exportImage(transparent: boolean, onProgress: (text: string, p: number) => void, isOpen: () => boolean): Promise<HTMLCanvasElement|Blob>,
 *           getName(): string, getSize(): { width: number, height: number }, maxSize(): number, samples(): number,
 *           distributed?: { ready(): { clients: number, local: boolean }, render(scale, samples): Promise<HTMLCanvasElement>,
 *           manage(): void } }} ctx
 *   exportImage(transparent, onProgress, isOpen, scale, samples)
 */
export const SAMPLE_CHOICES = [16, 32, 64, 128, 256, 512, 1024, 2048];

export function createImageExport(ctx) {
    const state = { format: 'png', transparent: true, scale: 1, samples: 0, distributed: false, busy: false };
    const SCALES = [1, 2, 3, 4];
    const root = document.createElement('div');
    root.className = 'pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-4 text-xs text-white/90';
    root.hidden = true;
    document.body.append(root);

    const close = () => { root.hidden = true; state.busy = false; };
    document.addEventListener('pointerdown', e => {
        if (root.hidden || dialogOpen()) return;
        if (!root.firstElementChild?.contains(e.target)) close();
    }, true);
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden && !dialogOpen()) { e.stopPropagation(); close(); } }, true);

    function render(progress = null) {
        const panel = document.createElement('div');
        panel.className = 'pointer-events-auto w-[min(22rem,100%)] overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm';
        const head = document.createElement('div');
        head.className = 'flex items-center gap-2 border-b border-white/10 px-4 py-2.5';
        const title = document.createElement('span');
        title.className = 'flex-1 font-medium';
        title.textContent = t('imageExport.title');
        const dist = ctx.distributed?.ready() ?? { clients: 0, local: true };
        if (state.distributed && !dist.clients) state.distributed = false;   // the clients went away
        const x = document.createElement('button');
        x.className = 'text-white/50 hover:text-white';
        x.innerHTML = ICON_CLOSE;
        x.title = t('setup.close');
        x.onclick = close;
        head.append(title, x);

        const body = document.createElement('div');
        body.className = 'flex flex-col gap-2.5 px-4 py-3';
        // format
        const formats = document.createElement('div');
        formats.className = 'flex gap-1';
        for (const f of ['png', 'jpg']) {
            const b = document.createElement('button');
            b.className = `${BTN} ${state.format === f ? 'bg-sky-500/40 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'}`;
            b.textContent = f.toUpperCase();
            b.disabled = state.busy;
            b.onclick = () => { state.format = f; render(); };
            formats.append(b);
        }
        body.append(row(t('imageExport.format'), formats));
        // transparent background (PNG) – not distributed yet (it needs two passes in front of different backgrounds)
        if (state.format === 'png' && !state.distributed) {
            const label = document.createElement('label');
            label.className = 'flex cursor-pointer items-start gap-2';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'mt-0.5 accent-sky-400';
            box.checked = state.transparent;
            box.disabled = state.busy;
            box.onchange = () => { state.transparent = box.checked; render(); };
            const text = document.createElement('span');
            text.append(t('imageExport.transparent'));
            const hint = document.createElement('div');
            hint.className = 'text-white/40';
            hint.textContent = t('imageExport.transparentHint');
            text.append(hint);
            label.append(box, text);
            body.append(label);
        }
        // size: screen resolution or a multiple (only what the GPU can hold)
        const { width, height } = ctx.getSize();
        const max = ctx.maxSize();
        const fits = s => Math.max(width, height) * s <= max;
        if (!fits(state.scale)) state.scale = 1;
        const scales = document.createElement('div');
        scales.className = 'flex gap-1';
        scales.title = t('imageExport.scaleTitle');
        for (const s of SCALES) {
            const b = document.createElement('button');
            b.className = `${BTN} ${state.scale === s ? 'bg-sky-500/40 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'} disabled:opacity-30`;
            b.textContent = `${s}×`;
            b.disabled = state.busy || !fits(s);
            b.title = fits(s) ? t('imageExport.size', { width: width * s, height: height * s }) : t('imageExport.tooLarge', { max });
            b.onclick = () => { state.scale = s; render(); };
            scales.append(b);
        }
        body.append(row(t('imageExport.scale'), scales));
        const size = document.createElement('div');
        size.className = 'text-white/50';
        size.textContent = state.scale === 1 ? t('imageExport.size', { width, height }) + ' · ' + t('imageExport.sizeScreen')
            : t('imageExport.size', { width: width * state.scale, height: height * state.scale });
        body.append(size);
        // samples per pixel (0 = as in the path tracing settings)
        const samples = document.createElement('select');
        samples.className = 'min-w-0 flex-1 cursor-pointer rounded bg-white/10 px-1.5 py-0.5 text-white outline-none focus:bg-white/20';
        samples.append(new Option(t('imageExport.samplesAsSet', { samples: ctx.samples() }), '0'));
        for (const n of SAMPLE_CHOICES) samples.append(new Option(String(n), String(n)));
        for (const o of samples.options) o.className = 'bg-neutral-900';
        samples.value = String(state.samples);
        samples.disabled = state.busy;
        samples.onchange = () => { state.samples = Number(samples.value); };
        body.append(row(t('imageExport.samples'), samples));
        // distributed rendering: on the render clients (and this computer, if it renders along)
        if (ctx.distributed) {
            const label = document.createElement('label');
            label.className = `flex items-start gap-2 ${dist.clients ? 'cursor-pointer' : 'opacity-50'}`;
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'mt-0.5 accent-sky-400';
            box.checked = state.distributed;
            box.disabled = state.busy || !dist.clients;
            box.onchange = () => { state.distributed = box.checked; render(); };
            const text = document.createElement('span');
            text.append(t('imageExport.distributed'));
            const hint = document.createElement('div');
            hint.className = 'text-white/40';
            hint.textContent = dist.clients
                ? t(dist.local ? 'imageExport.distributedClientsLocal' : 'imageExport.distributedClients', { count: dist.clients })
                : t('imageExport.distributedNone');
            const manage = document.createElement('button');
            manage.className = 'ml-1 text-sky-300 hover:underline';
            manage.textContent = t('imageExport.distributedManage');
            manage.onclick = e => { e.preventDefault(); close(); ctx.distributed.manage(); };
            hint.append(' ', manage);
            text.append(hint);
            label.append(box, text);
            body.append(label);
        }
        if (progress) {
            const p = document.createElement('div');
            p.className = 'text-sky-200';
            p.textContent = progress;
            body.append(p);
        }

        const foot = document.createElement('div');
        foot.className = 'flex justify-end gap-2 px-4 pb-3';
        const cancel = document.createElement('button');
        cancel.className = `${BTN} bg-white/10 text-white/80 hover:bg-white/20`;
        cancel.textContent = t('dialog.cancel');
        cancel.onclick = close;
        const go = document.createElement('button');
        go.className = `${BTN} bg-sky-500/80 text-white hover:bg-sky-500 disabled:opacity-50`;
        go.textContent = t('imageExport.export');
        go.disabled = state.busy;
        go.onclick = run;
        foot.append(cancel, go);

        panel.append(head, body, foot);
        root.replaceChildren(panel);
    }

    function row(label, control) {
        const r = document.createElement('div');
        r.className = 'flex items-center gap-3';
        const l = document.createElement('span');
        l.className = 'w-20 text-white/60';
        l.textContent = label;
        r.append(l, control);
        return r;
    }

    // the window gets out of the way: progress and ✕ in the status bottom left (viewer.js), the file comes at the end
    async function run() {
        if (state.distributed) return runDistributed();
        const { format, scale, samples } = state;
        const transparent = format === 'png' && state.transparent;
        close();
        let canvas;
        try {
            canvas = await ctx.exportImage(transparent, null, null, scale, samples);
        } catch (err) {
            if (err?.name !== 'AbortError') ctx.onError?.(err);
            return;
        }
        const type = format === 'png' ? 'image/png' : 'image/jpeg';
        // transparent: already a finished PNG (premultiplied, see composeMatte), otherwise a canvas
        const blob = canvas instanceof Blob ? canvas : await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
        await saveBlob(blob, `${ctx.getName() || 'rindr'}.${format}`);
    }

    // distributed: the window gets out of the way (buckets, status and ✕ bottom left), the file comes at the end
    async function runDistributed() {
        const { format, scale } = state;
        close();
        let canvas;
        try {
            canvas = await ctx.distributed.render(scale, state.samples || ctx.samples());
        } catch (err) {
            if (err?.name !== 'AbortError') ctx.onError?.(err);
            return;
        }
        const type = format === 'png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
        await saveBlob(blob, `${ctx.getName() || 'rindr'}.${format}`);
    }

    return {
        open() { if (!root.hidden) return; root.hidden = false; render(); },
        get isOpen() { return !root.hidden; },
    };
}

// always straight into the downloads (a "save as" dialog only works right after the click – in HQ the export
// waits for the finished image, then the browser refused the dialog and downloaded anyway: inconsistent)
async function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
