// Page entry (index.astro): the RINDR app = one <rindr-player> with every feature over the whole page (docs/player.md).
// First the debug overlay's worker overview: it replaces `Worker` before anything starts one (only with ?debug, a
// change of the whole page – the app's business, never an embedded player's).
import './worker-monitor.js';
import './rindr-player.js';
import { applyDom } from './i18n.js';

// The app page (index.astro, <body data-rindr-app>): one player over the whole page. Elsewhere the same script only
// defines <rindr-player> for the page's own elements (embedding tests, tools/player-check).
const appPage = document.body.hasAttribute('data-rindr-app');

// what to open at the start comes from the page's URL – the player itself gets it as options:
//   ?model=<file from public/models> (sub folders allowed), ?samplescene, ?hdr=<file from public/hdr>
// (developer switches like ?debug, ?lod, ?kernel … stay read where they are used)
const params = new URLSearchParams(location.search);

if (appPage) {
    // static page texts (data-i18n in index.astro: title, preloader) in the current language
    applyDom();
    const app = document.createElement('rindr-player');
    app.id = 'rindr-app';
    app.style.cssText = 'position:fixed;inset:0';
    app.rindrOptions = {
        appMode: true,     // the whole page: may reload it, change its URL, offer distributed rendering
        keyScope: 'page',  // keys and file drops anywhere on the page
        features: 'all',   // every part of the interface
        preloader: document.getElementById('preloader'),
        model: params.get('model'),
        sampleScene: params.has('samplescene'),
        hdr: params.get('hdr'),
    };
    document.body.prepend(app);
    // not caught: a start without a renderer stays an error in the console (the status line already says so)
    const player = await app.ready;
    // debug access for automated tests (tools/player-check) and the console
    if (params.has('debug')) globalThis.__viewer = player;
}
