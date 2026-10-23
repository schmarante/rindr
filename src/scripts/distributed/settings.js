// Settings page "Distributed Rendering" (setup menu) and the status page of a render client
// (docs/distributed.md).
import { t } from '../i18n.js';
import { INPUT } from '../ui-controls.js';
import { LOCAL_ID, CLIENT_COLORS } from './master.js';
import { createOffer, rtcSupported } from './rtc.js';

const el = (tag, cls = '', text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

export const BUCKET_OPTIONS = [64, 128, 256];
const TEXT = INPUT.replace('text-right tabular-nums', 'text-left');
const SMALL_BUTTON = 'shrink-0 rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20 disabled:opacity-40';

/** copy a text, the button says so for a moment */
function copyButton(getText) {
    const b = el('button', SMALL_BUTTON, t('setup.distributed.copy'));
    b.type = 'button';
    b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(getText()); } catch { return; }
        b.textContent = t('setup.distributed.copied');
        setTimeout(() => { b.textContent = t('setup.distributed.copy'); }, 1500);
    });
    return b;
}

/**
 * Pairing with a computer in the network (rtc.js): link with the offer for the render computer, field for its answer
 * code. addPeer(channel) when connected.
 */
function pairingBox(section, addPeer) {
    const box = el('div', 'mt-2 flex flex-col gap-1.5 rounded bg-white/5 p-2');
    box.hidden = true;
    const link = el('input', TEXT);
    Object.assign(link, { readOnly: true, spellcheck: false });
    const answer = el('input', TEXT);
    Object.assign(answer, { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: t('setup.distributed.answerPlaceholder') });
    const connect = el('button', SMALL_BUTTON, t('setup.distributed.connect'));
    connect.type = 'button';
    const status = el('div', 'text-white/60');
    const row = (...nodes) => { const r = el('div', 'flex items-center gap-1.5'); r.append(...nodes); return r; };
    const steps = el('div', 'flex flex-col gap-1.5');
    steps.append(el('div', 'text-white/70', t('setup.distributed.pairStep1')), row(link, copyButton(() => link.value)),
        el('div', 'mt-1 text-white/70', t('setup.distributed.pairStep2')), row(answer, connect));
    box.append(steps, status);
    section.append(box);

    let offer = null;
    const setStatus = (text, tone = 'text-white/60') => { status.textContent = text; status.className = tone; };
    async function start() {
        offer?.close();
        offer = null;
        box.hidden = steps.hidden = false;
        link.value = answer.value = '';
        connect.disabled = true;
        setStatus(t('setup.distributed.pairCreating'));
        try {
            const o = await createOffer();
            offer = o;
            link.value = `${location.origin}${location.pathname}?render-client#pair=${o.code}`;
            connect.disabled = false;
            setStatus(t('setup.distributed.pairWaiting'));
        } catch (err) {
            setStatus(t('setup.distributed.pairFailed', { message: err?.message || err }), 'text-red-300');
        }
    }
    async function accept() {
        const o = offer;
        if (!o || !answer.value.trim()) return;
        connect.disabled = true;
        setStatus(t('setup.distributed.pairConnecting'));
        try {
            addPeer(await o.accept(answer.value));
            offer = null;
            link.value = answer.value = '';
            steps.hidden = true;
            setStatus(t('setup.distributed.pairDone'), 'text-emerald-300');
        } catch (err) {
            if (err?.message === 'timeout') {
                o.close();
                offer = null;
                setStatus(t('setup.distributed.pairTimeout'), 'text-red-300');
            } else {
                connect.disabled = false;   // a broken code: try again with the same link
                setStatus(t('setup.distributed.pairBadCode'), 'text-red-300');
            }
        }
    }
    connect.addEventListener('click', accept);
    answer.addEventListener('keydown', e => { if (e.key === 'Enter') accept(); });
    return { start };
}

/**
 * @param section  setup menu section
 * @param {{ master, settings: { renderLocal, bucket }, save: () => void, cancel: () => void,
 *   openClient: () => void, addPeer: (channel: RTCDataChannel) => void }} api
 * @returns {{ refresh: () => void }}
 */
export function buildDistributedSection(section, api) {
    const { master, settings } = api;
    section.hint(t('setup.distributed.hint'));
    section.heading(t('setup.distributed.clients'));
    const list = el('div', 'flex flex-col gap-1');
    section.append(list);
    if (rtcSupported()) {
        let pairing = null;
        section.button(t('setup.distributed.pair'), () => pairing.start());
        section.hint(t('setup.distributed.pairHint'));
        pairing = pairingBox(section, api.addPeer);
    }
    section.button(t('setup.distributed.openClient'), api.openClient);
    section.heading(t('setup.distributed.job'));
    section.toggle(t('setup.distributed.renderLocal'), () => settings.renderLocal, v => { settings.renderLocal = v; master.setRenderLocal(v); api.save(); refresh(); });
    section.select(t('setup.distributed.bucketSize'), BUCKET_OPTIONS.map(n => ({ label: `${n} × ${n} px`, value: String(n) })),
        () => String(settings.bucket), v => { settings.bucket = Number(v); api.save(); });
    section.hint(t('setup.distributed.startHint'));
    const cancel = section.button(t('setup.distributed.cancel'), api.cancel);
    const status = el('div', 'mt-1 text-white/60');
    section.append(status);

    const row = (color, name, detail, state) => {
        const r = el('div', 'flex items-center gap-2 rounded bg-white/5 px-2 py-1');
        const dot = el('span', 'size-2.5 shrink-0 rounded-full');
        dot.style.background = color;
        const text = el('div', 'min-w-0 flex-1');
        text.append(el('div', 'truncate text-white', name), el('div', 'truncate text-white/40', detail));
        r.append(dot, text, el('span', 'shrink-0 text-white/60', state));
        return r;
    };
    function refresh() {
        const job = master.job;
        const rows = [];
        if (settings.renderLocal) {
            const busy = job && !job.finished && [...job.pending.values()].some(p => p.client === LOCAL_ID);
            const done = job?.perClient.get(LOCAL_ID) || 0;
            rows.push(row(CLIENT_COLORS[0], t('setup.distributed.thisComputer'), t('setup.distributed.buckets', { count: done }),
                busy ? t('setup.distributed.state.rendering') : t('setup.distributed.state.ready')));
        }
        for (const c of master.list()) {
            const state = !c.online ? 'lost' : c.busyOther ? 'other' : c.error ? 'error' : c.bucket ? 'rendering'
                : job && !job.finished && c.sceneId !== job.sceneId ? 'loading' : 'ready';
            const done = job?.perClient.get(c.id) || 0;
            rows.push(row(c.color, c.name || c.id, [c.gpu, t('setup.distributed.buckets', { count: done })].filter(Boolean).join(' · '),
                t(`setup.distributed.state.${state}`)));
        }
        if (!master.clients.size) rows.push(el('div', 'text-white/40', t('setup.distributed.none')));
        list.replaceChildren(...rows);
        const running = master.running;
        cancel.enable(running);
        status.textContent = running ? t('setup.distributed.progress', { done: job.done, total: job.total })
            : api.lastResult ?? '';
    }
    refresh();
    return { refresh };
}

/** full page of a render client: who it is, whom it works for, what it renders; while pairing its answer code */
export function clientView(name, gpu) {
    const page = el('div', 'fixed inset-0 z-50 flex items-center justify-center bg-[#171717] text-sm text-white');
    const box = el('div', 'w-96 max-w-[calc(100vw-2rem)] rounded-lg bg-black/60 p-4 backdrop-blur');
    const title = el('div', 'mb-1 font-medium', t('distributed.client.title'));
    const who = el('div', 'mb-3 text-white/50', [name, gpu].filter(Boolean).join(' · '));
    const state = el('div', 'text-white/80');
    const bar = el('div', 'mt-2 h-1 overflow-hidden rounded bg-white/10');
    const fill = el('div', 'h-full bg-sky-400 transition-[width]');
    fill.style.width = '0%';
    bar.append(fill);
    const count = el('div', 'mt-2 text-white/40');
    // pairing with a master in the network: the answer code to bring back to it
    const pair = el('div', 'mt-3 flex flex-col gap-1.5');
    pair.hidden = true;
    const code = el('textarea', `${TEXT} h-16 resize-none break-all font-mono text-xs`);
    Object.assign(code, { readOnly: true, spellcheck: false });
    code.addEventListener('focus', () => code.select());
    pair.append(el('div', 'text-white/70', t('distributed.client.answerLabel')), code, copyButton(() => code.value));
    box.append(title, who, state, bar, count, pair);
    page.append(box);
    document.body.append(page);
    return {
        update({ state: s, bucket, progress = 0, done = 0, message }) {
            state.textContent = t(`distributed.client.${s}`, { id: bucket?.id ?? '', message: message || '', percent: Math.round(progress * 100) });
            fill.style.width = s === 'rendering' || s === 'receiving' ? `${Math.round(progress * 100)}%` : '0%';
            count.textContent = t('setup.distributed.buckets', { count: done });
        },
        showAnswer(text) {
            code.value = text;
            pair.hidden = !text;
        },
    };
}
