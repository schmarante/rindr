// Page entry (index.astro): the RINDR viewer as one player on the page's elements – stage 1 of docs/player.md.
// viewer.js first: its first import (worker-monitor.js) replaces `Worker` before anything starts one (?debug), and the
// modules are evaluated in the same order as before.
import { createPlayer } from './viewer.js';
import { applyDom } from './i18n.js';

// static page texts (data-i18n in index.astro) in the current language
applyDom();

// what to open at the start comes from the page's URL – the player itself gets it as options:
//   ?model=<file from public/models> (sub folders allowed), ?samplescene, ?hdr=<file from public/hdr>
// (developer switches like ?debug, ?lod, ?kernel … stay read where they are used)
const params = new URLSearchParams(location.search);

// not caught: a start without a renderer stays an error in the console (the status line already says so)
await createPlayer({
    model: params.get('model'),
    sampleScene: params.has('samplescene'),
    hdr: params.get('hdr'),
});
