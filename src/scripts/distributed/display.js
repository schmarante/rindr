// Picture of a distributed render on the master (docs/distributed.md): the assembled linear HDR image as a float
// texture drawn over the whole view through the renderer's normal output (tone mapping, exposure, sRGB) – each
// finished bucket is written straight into its rectangle of the GPU texture. Until a bucket arrives its place shows
// the view of the start, dimmed (user: "if my computer does not render along I only see a black picture") – started
// from HQ the path traced image there was (user: no jump into the raster look), otherwise one raster frame into an HDR
// target; alpha of the image = bucket done. Above it a 2D canvas labels the buckets being
// rendered: frame in the client's colour, its name, a progress bar.
import * as THREE from 'three/webgpu';
import { texture, uv, vec4, mix } from 'three/tsl';

const DIM = 0.35;   // brightness of the preview behind the buckets still missing

export class BucketDisplay {
    constructor(renderer, container) {
        this.renderer = renderer;
        this.width = 0;
        this.height = 0;
        this.active = false;
        this.tex = null;
        this.quad = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.quad.name = 'DistributedImage';
        this.overlay = document.createElement('canvas');
        this.overlay.className = 'pointer-events-none absolute inset-0 size-full';
        this.overlay.hidden = true;
        container.append(this.overlay);
    }

    /**
     * new image fullW × fullH; preview (behind the buckets still missing): drawPreview(target) renders the current view
     * into an HDR target, or a linear image { data, width, height } (Float32 RGBA, rows top to bottom, any size)
     */
    begin(width, height, preview) {
        this.width = width;
        this.height = height;
        this.tex?.dispose();
        this.preview?.dispose();
        let behindTex;
        if (typeof preview === 'function') {
            this.preview = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType });
            preview(this.preview);
            behindTex = this.preview.texture;
        } else {
            this.preview = behindTex = preview
                ? new THREE.DataTexture(preview.data, preview.width, preview.height, THREE.RGBAFormat, THREE.FloatType)
                : new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
            behindTex.flipY = false;
            behindTex.minFilter = behindTex.magFilter = THREE.LinearFilter;
            behindTex.needsUpdate = true;
        }
        this.data = new Float32Array(width * height * 4);   // alpha 0 = bucket not there yet
        this.tex = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat, THREE.FloatType);
        this.tex.flipY = false;
        this.tex.needsUpdate = true;
        this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
        // rows top to bottom in the data, like the quad's uv (WebGPU: v = 0 at the top)
        const image = texture(this.tex, uv());
        const behind = texture(behindTex, uv()).rgb.mul(DIM);
        this.quad.material.fragmentNode = vec4(mix(behind, image.rgb, image.a), 1);
        this.quad.material.needsUpdate = true;
        this._uploaded = false;
        this.active = true;
        this.overlay.hidden = false;
    }

    /** a finished bucket: into the CPU copy and its rectangle of the GPU texture */
    put(bucket, data) {
        const { x, y, w, h } = bucket;
        for (let i = 3; i < data.length; i += 4) data[i] = 1;   // done (the path tracer's alpha may be below 1)
        for (let r = 0; r < h; r++) this.data.set(data.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * this.width + x) * 4);
        const gpu = this._uploaded && this.renderer.backend.get(this.tex)?.texture;
        if (gpu) {
            this.renderer.backend.device.queue.writeTexture({ texture: gpu, origin: { x, y } }, data, { bytesPerRow: w * 16, rowsPerImage: h }, { width: w, height: h });
        } else this.tex.needsUpdate = true;   // not on the GPU yet: the whole CPU copy goes up with the next draw
    }

    /** draw the image onto the canvas (instead of the scene) */
    draw() {
        if (!this.active) return;
        const r = this.renderer;
        const autoClear = r.autoClear;
        r.autoClear = true;
        r.setRenderTarget(null);
        this.quad.render(r);
        r.autoClear = autoClear;
        this._uploaded = true;
    }

    /** labels of the buckets in progress: [{ bucket, color, name, progress }] */
    label(pending) {
        const c = this.overlay;
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(c.clientWidth * dpr), ch = Math.round(c.clientHeight * dpr);
        if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
        const g = c.getContext('2d');
        g.clearRect(0, 0, cw, ch);
        if (!this.active || !this.width) return;
        const sx = cw / this.width, sy = ch / this.height;
        const font = Math.round(9 * dpr);
        g.font = `600 ${font}px ui-sans-serif, system-ui, sans-serif`;
        g.textBaseline = 'top';
        for (const p of pending) {
            const { x, y, w, h } = p.bucket;
            const X = Math.round(x * sx) + 0.5, Y = Math.round(y * sy) + 0.5, W = Math.round(w * sx) - 1, H = Math.round(h * sy) - 1;
            g.lineWidth = Math.max(1, dpr);
            g.strokeStyle = p.color;
            g.strokeRect(X, Y, W, H);
            // corner brackets thicker (like a viewfinder)
            g.lineWidth = 3 * dpr;
            const k = Math.min(W, H) * 0.2;
            g.beginPath();
            for (const [px, py, dx, dy] of [[X, Y, 1, 1], [X + W, Y, -1, 1], [X, Y + H, 1, -1], [X + W, Y + H, -1, -1]]) {
                g.moveTo(px + dx * k, py); g.lineTo(px, py); g.lineTo(px, py + dy * k);
            }
            g.stroke();
            // name tag
            const text = p.name || '?';
            const tw = g.measureText(text).width + 8 * dpr;
            g.fillStyle = p.color;
            g.fillRect(X, Y, Math.min(tw, W), font + 4 * dpr);
            g.fillStyle = '#0b0b0b';
            g.save();
            g.beginPath();
            g.rect(X, Y, W, font + 4 * dpr);
            g.clip();
            g.fillText(text, X + 4 * dpr, Y + 2 * dpr);
            g.restore();
            // progress
            g.fillStyle = 'rgba(0,0,0,0.5)';
            g.fillRect(X + 2 * dpr, Y + H - 5 * dpr, W - 4 * dpr, 3 * dpr);
            g.fillStyle = p.color;
            g.fillRect(X + 2 * dpr, Y + H - 5 * dpr, (W - 4 * dpr) * Math.min(p.progress || 0, 1), 3 * dpr);
        }
    }

    end() {
        this.active = false;
        this.overlay.hidden = true;
        this.label([]);
        this.tex?.dispose();
        this.tex = null;
        this.preview?.dispose();
        this.preview = null;
        this.data = null;
    }
}
