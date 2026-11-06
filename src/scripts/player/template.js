// The player's markup (until Nov. 2026 static in index.astro): view, panels, status, drop area, logo – rendered into
// the shadow root of <rindr-player> (rindr-player.js, docs/player.md). Same order and classes as the page had; window
// units became container units (cqw/cqh – the player element is the size container); everything sits in one root
// (`data-rindr-root`, display: contents – takes `ui-hidden`), windows/menus/notices go into the layer at its end
// (`data-rindr-layer`, shadow-dom.js layerFor).
import { t, formatHtml } from '../i18n.js';
import { icon } from '../icons.js';
import logoSource from '../../assets/rindr.svg?raw';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = key => esc(t(key));
const html = key => formatHtml(t(key));

// the logo as the page inlined it (own <style> for its fill – scoped to the shadow root)
const LOGO_VIEWBOX = logoSource.match(/viewBox="([^"]+)"/)?.[1] || '0 0 1417.323 1417.323';
const logo = classes => logoSource.slice(logoSource.indexOf('<svg')).replace(/<svg[^>]*>/, `<svg viewBox="${LOGO_VIEWBOX}" class="${classes}" aria-hidden="true">`);

const DROP_ZONE = 'flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-400/80 bg-black/55 p-6 text-center backdrop-blur-sm transition-colors';
const DROP_TITLE = 'text-lg font-medium';
const DROP_HINT = 'max-w-md text-sm text-balance text-white/60';

/** markup of one player (all parts; features are switched later – docs/player.md) */
export function playerTemplate() {
    return `<div data-rindr-root class="contents">
<div id="viewport" class="size-full"></div>
<div id="loading" data-i18n="page.loading" class="pointer-events-none absolute top-1/2 left-1/2 w-max max-w-[90cqw] -translate-x-1/2 -translate-y-1/2 text-center text-xl text-white transition-opacity duration-500">${text('page.loading')}</div>
<div data-ui="left" class="pointer-events-none absolute top-5 left-5 flex max-h-[calc(100cqh-11rem)] w-72 flex-col gap-3">
    <div id="scene-graph" hidden class="pointer-events-auto flex min-h-0 flex-col rounded-lg bg-black/60 text-xs text-white/90 backdrop-blur-sm">
        <div class="flex w-full shrink-0 items-center justify-between gap-2 px-3 py-2 text-left font-medium">
            <span data-i18n="page.sceneGraph">${text('page.sceneGraph')}</span>
            <span data-tree-count class="tabular-nums text-white/50"></span>
        </div>
        <div data-tree-list class="min-h-0 overflow-auto px-1 pb-2 select-none"></div>
    </div>
    <div id="properties" hidden class="pointer-events-auto shrink-0 rounded-lg bg-black/60 px-3 py-2 text-xs text-white/90 backdrop-blur-sm"></div>
</div>
<div id="view-cube" data-ui="right"></div>
<div id="view-mode"></div>
<div id="playbar" hidden></div>
<div id="setup-menu" hidden class="fixed z-30 flex flex-col overflow-hidden rounded-lg bg-black/60 text-xs text-white/90 backdrop-blur-sm"></div>
<div data-ui="right" class="pointer-events-none absolute top-5 right-5 flex max-h-[calc(100cqh-5rem)] w-80 flex-col gap-3">
    <div id="materials" class="pointer-events-auto flex min-h-0 flex-col rounded-lg bg-black/60 text-xs text-white/90 backdrop-blur-sm"></div>
    <div id="debug-stats" hidden></div>
</div>
<div id="hdri-editor" hidden></div>
<div id="node-editor" hidden></div>
<div id="ies-editor" hidden></div>
<div id="progress" hidden class="pointer-events-none absolute bottom-10 left-5 w-72 rounded-lg bg-black/60 px-3 py-2 text-xs text-white/90 backdrop-blur-sm">
    <div data-label class="mb-1.5"></div>
    <div class="h-1 overflow-hidden rounded bg-white/15">
        <div data-bar class="h-full w-0 rounded bg-amber-400 transition-[width] duration-200"></div>
    </div>
</div>
<div id="drop-overlay" hidden class="pointer-events-none absolute inset-3 z-20 flex gap-3 text-white">
    <div data-drop-zone="replace" class="${DROP_ZONE}">
        <div data-drop-single class="flex flex-col items-center gap-2">
            <div class="${DROP_TITLE}" data-i18n="page.drop.title">${text('page.drop.title')}</div>
            <div class="${DROP_HINT}" data-i18n="page.drop.hint">${text('page.drop.hint')}</div>
            <div class="${DROP_HINT}" data-i18n-html="page.drop.addHint">${html('page.drop.addHint')}</div>
        </div>
        <div data-drop-relink hidden class="flex flex-col items-center gap-2">
            <div class="${DROP_TITLE}" data-i18n="page.drop.relinkTitle">${text('page.drop.relinkTitle')}</div>
            <div class="${DROP_HINT}" data-i18n="page.drop.relinkHint">${text('page.drop.relinkHint')}</div>
        </div>
        <div data-drop-hdri hidden class="flex flex-col items-center gap-2">
            <div class="${DROP_TITLE}" data-i18n="page.drop.hdriTitle">${text('page.drop.hdriTitle')}</div>
            <div class="${DROP_HINT}" data-i18n="page.drop.hdriHint">${text('page.drop.hdriHint')}</div>
        </div>
        <div data-drop-split hidden class="flex flex-col items-center gap-2">
            <div class="${DROP_TITLE}" data-i18n="page.drop.replaceTitle">${text('page.drop.replaceTitle')}</div>
            <div class="${DROP_HINT}" data-i18n="page.drop.replaceHint">${text('page.drop.replaceHint')}</div>
        </div>
    </div>
    <div data-drop-zone="add" hidden class="${DROP_ZONE}">
        <div class="${DROP_TITLE}" data-i18n="page.drop.addTitle">${text('page.drop.addTitle')}</div>
        <div class="${DROP_HINT}" data-i18n="page.drop.addSplitHint">${text('page.drop.addSplitHint')}</div>
        <div class="max-w-md text-xs text-balance text-white/45" data-i18n="page.drop.splatNote">${text('page.drop.splatNote')}</div>
    </div>
</div>
<div id="pt-status" data-ui="left" class="pointer-events-none absolute bottom-10 left-5 hidden w-64 rounded-lg bg-black/60 px-3 py-2 text-xs text-white/90 backdrop-blur-sm">
    <div class="mb-1.5 flex items-center justify-between gap-2">
        <span class="flex items-center gap-1.5">
            <span id="pt-status-dot" class="inline-block size-2 rounded-full bg-sky-400"></span>
            <span id="pt-status-label" data-i18n="page.ptStatus">${text('page.ptStatus')}</span>
        </span>
        <span class="flex items-center gap-2">
            <span id="pt-status-value" class="whitespace-nowrap tabular-nums text-white/60"></span>
            <button id="pt-status-cancel" type="button" hidden class="pointer-events-auto flex size-4 items-center justify-center rounded-full bg-white/15 text-white/80 hover:bg-red-500/80 hover:text-white">${icon('cross', 'size-2.5 stroke-2')}</button>
        </span>
    </div>
    <div class="h-1 overflow-hidden rounded bg-white/15">
        <div id="pt-status-bar" class="h-full w-0 rounded bg-sky-400"></div>
    </div>
    <div id="pt-status-detail" class="mt-1.5 text-white/50"></div>
</div>
<div class="pointer-events-none absolute bottom-3 left-5 flex items-center gap-1.5 text-[11px] tracking-wide text-white select-none">
    <svg width="0" height="0" class="absolute" aria-hidden="true">
        <filter id="logo-white" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -0.2126 -0.7152 -0.0722 1 0" />
        </filter>
    </svg>
    ${logo('size-6 shrink-0 [filter:url(#logo-white)_drop-shadow(0_1px_2px_rgb(0_0_0/0.45))]')}
    <span class="opacity-50" data-i18n-html="page.brand">${html('page.brand')}</span>
</div>
<div data-rindr-layer class="contents"></div>
</div>`;
}
