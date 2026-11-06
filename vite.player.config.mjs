// The embeddable player as a build of its own (docs/player.md, stage 4; docs/player-embed.md): `npm run build` runs it
// after the app's build → dist/player/<version>/rindr-player.js with its chunks, workers and the denoiser's weights.
// Self-contained with relative paths: works from any server and folder (our service or the customer's own); the version
// in the path – a new version never changes what a shop already embeds. The app's Vite patches and plugins come from
// astro.config.mjs (one place for them).
import fs from 'node:fs';
import { defineConfig } from 'vite';
import astroConfig from './astro.config.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const outDir = `${process.env.OUT_DIR || 'dist'}/player/${version}`;

// Workers from another origin (the player loaded from our server into a shop's page): the browser refuses
// `new Worker(url)` for a script of another origin – a tiny same-origin blob that imports the real file instead (module
// workers; classic ones importScripts – needs CORS on the player's server). Same origin, blob: and data: URLs unchanged.
const WORKER_SHIM = 'var __rindrWorker=typeof Worker>"u"?void 0:class extends Worker{constructor(u,o){let h=u instanceof URL?u.href:String(u);'
    + 'try{const x=new URL(h,self.location.href);if(x.origin!==self.location.origin&&/^https?:$/.test(x.protocol)){'
    + 'const s=o&&o.type==="module"?"import "+JSON.stringify(x.href)+";":"importScripts("+JSON.stringify(x.href)+");";'
    + 'h=URL.createObjectURL(new Blob([s],{type:"text/javascript"}));setTimeout(()=>URL.revokeObjectURL(h),6e4)}}catch{}super(h,o)}};\n';
function crossOriginWorkers() {
    return {
        name: 'rindr-player-workers',
        renderChunk(code) {
            if (!/\bnew Worker\(/.test(code)) return null;
            return { code: WORKER_SHIM + code.replace(/\bnew Worker\(/g, 'new __rindrWorker('), map: null };
        },
    };
}

// the denoiser's weights next to the player (viewer.js: `${assetBase}oidn/…`)
function copyDenoiserWeights() {
    return {
        name: 'rindr-player-oidn',
        writeBundle() { fs.cpSync('public/oidn', `${outDir}/oidn`, { recursive: true }); },
    };
}

const app = astroConfig.vite;
export default defineConfig({
    base: './',
    publicDir: false,
    plugins: [...app.plugins, crossOriginWorkers(), copyDenoiserWeights()],
    worker: { ...app.worker, plugins: () => [crossOriginWorkers()] },
    define: app.define,
    optimizeDeps: app.optimizeDeps,
    build: {
        outDir,
        emptyOutDir: true,
        chunkSizeWarningLimit: 4096,
        modulePreload: { polyfill: false },
        rolldownOptions: {
            ...app.build.rolldownOptions,
            input: 'src/scripts/player-entry.js',
            output: { entryFileNames: 'rindr-player.js', chunkFileNames: 'chunks/[name].[hash].js', assetFileNames: 'assets/[name].[hash][extname]' },
        },
    },
});
