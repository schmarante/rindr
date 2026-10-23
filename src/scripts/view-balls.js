// Balls of the view choice (view-mode.js) that a CSS gradient cannot draw well (user: "render UV and wire nicer"):
// drawn once into small images (data URLs) on a 2D canvas.
//   uv:   a shaded sphere with the UV test pattern wrapped around it (uv-checker.js, longitude → u, latitude → v)
//   wire: a wireframe sphere – meridians and parallels, the back half fainter
// Both slightly tilted towards the viewer (the top shows) and lit from the upper left like the CSS balls.
import { sampleUvChecker } from './uv-checker.js';

const SIZE = 64;                   // px (shown at 16 px – sharp on high-density screens)
const TILT = 0.38;                 // rad, sphere tipped towards the viewer
const LIGHT = norm([-0.55, 0.6, 0.6]);

function norm(v) {
    const l = Math.hypot(...v);
    return v.map(x => x / l);
}
const toSrgb = c => Math.round(255 * Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));

let uvUrl = null, wireUrl = null;

/** sphere with the UV test pattern (3 × 3 samples per pixel) */
export function uvBall() {
    if (uvUrl) return uvUrl;
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    const img = g.createImageData(SIZE, SIZE);
    const col = [0, 0, 0], sum = [0, 0, 0];
    const cos = Math.cos(TILT), sin = Math.sin(TILT);
    for (let py = 0; py < SIZE; py++) {
        for (let px = 0; px < SIZE; px++) {
            sum.fill(0);
            let cover = 0;
            for (let sy = 0; sy < 3; sy++) {
                for (let sx = 0; sx < 3; sx++) {
                    const x = ((px + (sx + 0.5) / 3) / SIZE) * 2 - 1, y = 1 - ((py + (sy + 0.5) / 3) / SIZE) * 2;
                    const r2 = x * x + y * y;
                    if (r2 > 1) continue;
                    const z = Math.sqrt(1 - r2);
                    cover++;
                    // normal in view space → object space (undo the tilt about x)
                    const oy = y * cos + z * sin, oz = -y * sin + z * cos;
                    const u = 0.5 + Math.atan2(x, oz) / (2 * Math.PI);
                    const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, oy))) / Math.PI;
                    sampleUvChecker(u * 2, v, col);   // twice around: the cells stay readable at this size
                    const d = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
                    const spec = Math.max(0, 2 * d * z - LIGHT[2]) ** 24 * 0.35;
                    for (let k = 0; k < 3; k++) sum[k] += col[k] * (0.22 + 0.9 * d) + spec;
                }
            }
            const o = (py * SIZE + px) * 4;
            if (!cover) continue;
            for (let k = 0; k < 3; k++) img.data[o + k] = toSrgb(sum[k] / cover);
            img.data[o + 3] = Math.round(255 * cover / 9);
        }
    }
    g.putImageData(img, 0, 0);
    return (uvUrl = c.toDataURL());
}

/** wireframe sphere: 6 meridians (every 30°), 5 parallels; the back fainter */
export function wireBall() {
    if (wireUrl) return wireUrl;
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    const R = SIZE / 2 - 2, C = SIZE / 2;
    const cos = Math.cos(TILT), sin = Math.sin(TILT);
    // a point of the sphere (object space) → screen and its depth (front > 0)
    const project = (x, y, z) => { const vy = y * cos - z * sin, vz = y * sin + z * cos; return [C + x * R, C - vy * R, vz]; };
    const curve = (fn, steps = 96) => {
        // split into front and back parts by depth
        let prev = null;
        for (let i = 0; i <= steps; i++) {
            const p = project(...fn(i / steps));
            if (prev) {
                const front = (prev[2] + p[2]) / 2 > 0;
                g.strokeStyle = front ? 'rgba(235,235,235,0.95)' : 'rgba(235,235,235,0.22)';
                g.lineWidth = front ? 2.2 : 1.6;
                g.beginPath();
                g.moveTo(prev[0], prev[1]);
                g.lineTo(p[0], p[1]);
                g.stroke();
            }
            prev = p;
        }
    };
    g.lineCap = 'round';
    // dark ground so the lines read on the bar
    g.fillStyle = 'rgba(30,30,30,0.9)';
    g.beginPath();
    g.arc(C, C, R + 1, 0, Math.PI * 2);
    g.fill();
    for (let m = 0; m < 6; m++) {
        const a = (m / 6) * Math.PI;
        curve(t => { const th = t * Math.PI * 2; return [Math.cos(a) * Math.sin(th), Math.cos(th), Math.sin(a) * Math.sin(th)]; });
    }
    for (const lat of [-60, -30, 0, 30, 60]) {
        const phi = (lat * Math.PI) / 180;
        curve(t => { const th = t * Math.PI * 2; return [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)]; });
    }
    // silhouette
    g.strokeStyle = 'rgba(235,235,235,0.95)';
    g.lineWidth = 2.2;
    g.beginPath();
    g.arc(C, C, R, 0, Math.PI * 2);
    g.stroke();
    return (wireUrl = c.toDataURL());
}
