// Entry of the embeddable player build (vite.player.config.mjs → player/<version>/rindr-player.js, docs/player-embed.md):
// defines <rindr-player> – a small script; the viewer (three.js, importers …) loads when the first player starts – and the
// page-wide `RINDR` object.
import { playerDefaults, configure } from './rindr-player.js';

// the player's own files (denoiser weights …) lie next to this script, wherever it is served from
playerDefaults.assetBase = new URL(/* @vite-ignore */ './', import.meta.url).href;

globalThis.RINDR ??= {};
globalThis.RINDR.version = __APP_VERSION__;
globalThis.RINDR.configure = configure;   // RINDR.configure({ theme: { accent, panel, background, font }, base })
