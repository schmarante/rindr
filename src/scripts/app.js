// Page entry (index.astro): the RINDR viewer as one player on the page's elements – stage 1 of docs/player.md.
// viewer.js first: its first import (worker-monitor.js) replaces `Worker` before anything starts one (?debug), and the
// modules are evaluated in the same order as before.
import { createPlayer } from './viewer.js';
import { applyDom } from './i18n.js';

// static page texts (data-i18n in index.astro) in the current language
applyDom();

// not caught: a start without a renderer stays an error in the console (the status line already says so)
await createPlayer();
