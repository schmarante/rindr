// Page entry (index.astro): the RINDR app = one player on the page's elements (docs/player.md).
// First the debug overlay's worker overview: it replaces `Worker` before anything starts one (only with ?debug, a
// change of the whole page – the app's business, never an embedded player's).
import './worker-monitor.js';
import { createPlayer } from './viewer.js';
import { applyDom } from './i18n.js';

// static page texts (data-i18n in index.astro) in the current language
applyDom();

// what to open at the start comes from the page's URL – the player itself gets it as options:
//   ?model=<file from public/models> (sub folders allowed), ?samplescene, ?hdr=<file from public/hdr>
// (developer switches like ?debug, ?lod, ?kernel … stay read where they are used)
const params = new URLSearchParams(location.search);

// not caught: a start without a renderer stays an error in the console (the status line already says so)
const player = await createPlayer({
    appMode: true,   // the whole page: may reload it, change its URL, offer distributed rendering
    model: params.get('model'),
    sampleScene: params.has('samplescene'),
    hdr: params.get('hdr'),
});
// debug access for automated tests (tools/player-check) and the console
if (params.has('debug')) globalThis.__viewer = player;
