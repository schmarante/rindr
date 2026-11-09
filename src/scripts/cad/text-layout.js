// Text of drawings laid out as glyph quads (CAD worker): single-line TEXT/ATTRIB with the justification of the file,
// MTEXT with its format codes (paragraphs, font/height/width/colour changes, stacked fractions as a/b), word wrap to the
// reference width and the attachment point. Coordinates in the text's own plane (x along the baseline, y up, drawing
// units); drawing-build.js places them. Heights follow CAD: the text height is the height of a capital letter.
import { fontFamily } from './text-atlas.js';
import { aciRgb } from './drawing.js';

/** special codes of single-line text: %%c ⌀, %%d °, %%p ±, %%nnn, %%% – underline/overline toggles dropped */
export function decodeSpecial(s) {
    if (!s.includes('%%')) return s;
    return s.replace(/%%(\d{3}|[cdpuoCDPUO%])/g, (_, c) => {
        if (/^\d{3}$/.test(c)) return String.fromCharCode(Number(c));
        switch (c.toLowerCase()) {
            case 'c': return '⌀';
            case 'd': return '°';
            case 'p': return '±';
            case '%': return '%';
            default: return '';
        }
    });
}

// glyph quads of one run of text along x from pen (returns the new pen) into out
function emitRun(atlas, family, text, pen, baseline, height, width, oblique, rgb, out) {
    const shear = Math.tan(oblique * Math.PI / 180);
    for (const ch of text) {
        const g = atlas.glyph(family, ch);
        if (g.rect) {
            const [x0, y0, x1, y1] = g.box;
            const ax = pen + x0 * height * width, bx = pen + x1 * height * width;
            const ay = baseline + y0 * height, by = baseline + y1 * height;
            // shear (oblique): x += y · tan relative to the baseline
            const sa = (ay - baseline) * shear, sb = (by - baseline) * shear;
            out.quads.push(ax + sa, ay, bx + sa, ay, bx + sb, by, ax + sb, by);
            out.rects.push(g.rect);
            out.colors.push(rgb);
        }
        pen += g.advance * height * width;
    }
    return pen;
}

function measure(atlas, family, text, height, width) {
    let w = 0;
    for (const ch of text) w += atlas.glyph(family, ch).advance * height * width;
    return w;
}

/**
 * Single-line text (TEXT, ATTRIB, ATTDEF): quads relative to the insertion point and the rotation to apply.
 * @returns {{ quads, rects, colors, origin: [x,y,z], rotation: number (degrees), mirrorX, mirrorY } | null}
 */
export function layoutText(e, style, atlas, rgb) {
    const text = decodeSpecial(e.text || '');
    if (!text.trim()) return null;
    const family = fontFamily(style);
    let h = e.h || style?.height || 1;
    let width = e.width || 1;
    const out = { quads: [], rects: [], colors: [] };
    let w = measure(atlas, family, text, h, width);
    if (!(w > 0)) return null;
    let origin = e.p, rotation = e.rot || 0;
    const aligned = e.hAlign === 3, fit = e.hAlign === 5;
    let dx = 0, dy = 0;
    if ((aligned || fit) && e.p2) {
        // between the two points: aligned scales the height too, fit only the width
        const len = Math.hypot(e.p2[0] - e.p[0], e.p2[1] - e.p[1]);
        rotation = Math.atan2(e.p2[1] - e.p[1], e.p2[0] - e.p[0]) * 180 / Math.PI;
        if (len > 0) {
            const k = len / w;
            if (aligned) h *= k;
            width *= k;
            w = len;
        }
    } else if (e.hAlign || e.vAlign) {
        origin = e.p2 || e.p;
        if (e.hAlign === 1 || e.hAlign === 4) dx = -w / 2;
        else if (e.hAlign === 2) dx = -w;
        if (e.hAlign === 4) dy = -h / 2;   // middle: centre of the cap height
        else if (e.vAlign === 1) dy = h * 0.3;   // bottom: below the descenders
        else if (e.vAlign === 2) dy = -h / 2;
        else if (e.vAlign === 3) dy = -h;
    }
    emitRun(atlas, family, text, dx, dy, h, width, e.oblique || style?.oblique || 0, rgb, out);
    const gen = e.mirror ?? style?.gen ?? 0;
    return { ...out, origin, rotation, mirrorX: !!(gen & 2), mirrorY: !!(gen & 4) };
}

// MTEXT format codes → paragraphs of runs { text, family, height (factor), width, oblique, rgb }
function parseMText(raw, base) {
    const paragraphs = [[]];
    const stack = [];
    let st = { ...base };
    let buf = '';
    const flush = () => { if (buf) { paragraphs[paragraphs.length - 1].push({ ...st, text: buf }); buf = ''; } };
    const s = decodeSpecial(raw);
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') { flush(); stack.push(st); st = { ...st }; continue; }
        if (c === '}') { flush(); st = stack.pop() || st; continue; }
        if (c === '^' && i + 1 < s.length) {
            const n = s[i + 1];
            if (n === 'J' || n === 'M') { flush(); paragraphs.push([]); i++; continue; }
            if (n === 'I') { buf += '    '; i++; continue; }
        }
        if (c !== '\\' || i + 1 >= s.length) { buf += c; continue; }
        const cmd = s[++i];
        const arg = () => {
            const end = s.indexOf(';', i + 1);
            const v = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
            i = end < 0 ? s.length : end;
            return v;
        };
        switch (cmd) {
            case 'P': case 'N': case 'X': flush(); paragraphs.push([]); break;
            case '~': buf += ' '; break;
            case '\\': case '{': case '}': buf += cmd; break;
            case 'f': case 'F': {
                flush();
                const name = arg().split('|')[0];
                st.family = fontFamily(/\./.test(name) ? { font: name } : { family: name, font: name + '.ttf' });
                break;
            }
            case 'H': {
                flush();
                const v = arg();
                const n = parseFloat(v);
                if (Number.isFinite(n)) st.height = /x$/i.test(v) ? st.height * n : n / base.h;
                break;
            }
            case 'W': { flush(); const n = parseFloat(arg().replace(/x$/i, '')); if (Number.isFinite(n) && n > 0) st.width = n; break; }
            case 'Q': { flush(); const n = parseFloat(arg()); if (Number.isFinite(n)) st.oblique = n; break; }
            case 'C': { flush(); const n = parseInt(arg(), 10); if (n > 0 && n < 256) st.rgb = aciRgb(n); else if (n === 256 || n === 0) st.rgb = base.rgb; break; }
            case 'c': {
                flush();
                const n = parseInt(arg(), 10) & 0xffffff;   // stored as BGR
                st.rgb = ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16);
                break;
            }
            case 'S': {
                // stacked: top^bottom, top/bottom, top#bottom → "top/bottom"
                const v = arg();
                const m = v.match(/^(.*?)(?<!\\)[\^/#](.*)$/);
                buf += m ? `${m[1].trim()}/${m[2].trim()}` : v;
                break;
            }
            case 'A': case 'T': case 'p': arg(); break;
            case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': break;
            case 'U': {
                // \U+XXXX (not resolved by the reader inside MTEXT codes)
                const m = s.slice(i + 1).match(/^\+([0-9A-Fa-f]{4})/);
                if (m) { buf += String.fromCharCode(parseInt(m[1], 16)); i += 5; }
                break;
            }
            default: break;
        }
    }
    flush();
    return paragraphs;
}

/**
 * MTEXT: quads relative to the insertion point; rotation = direction of the x axis (degrees, in the text's plane).
 */
export function layoutMText(e, style, atlas, rgb) {
    const h = e.h || style?.height || 1;
    const base = { h, family: fontFamily(style), height: 1, width: style?.width || 1, oblique: style?.oblique || 0, rgb };
    const paragraphs = parseMText(e.text || '', base);
    const maxWidth = e.width > 0 ? e.width : Infinity;
    // lines of runs with word wrap at blanks
    const lines = [];
    for (const runs of paragraphs) {
        let line = { runs: [], width: 0, height: h };
        const push = () => { lines.push(line); line = { runs: [], width: 0, height: h }; };
        for (const run of runs) {
            const words = run.text.split(/(?<= )/);
            for (const word of words) {
                const rh = h * run.height;
                const ww = measure(atlas, run.family, word, rh, run.width);
                if (line.width > 0 && line.width + ww - (word.endsWith(' ') ? measure(atlas, run.family, ' ', rh, run.width) : 0) > maxWidth * 1.001) push();
                const last = line.runs[line.runs.length - 1];
                if (last && last.family === run.family && last.height === run.height && last.width === run.width && last.oblique === run.oblique && last.rgb === run.rgb) last.text += word;
                else line.runs.push({ ...run, text: word });
                line.width += ww;
                line.height = Math.max(line.height, rh);
            }
        }
        push();
    }
    while (lines.length && !lines[lines.length - 1].runs.length) lines.pop();
    if (!lines.some(l => l.runs.some(r => r.text.trim()))) return null;
    // trailing blanks do not count for alignment
    for (const l of lines) {
        const last = l.runs[l.runs.length - 1];
        if (last && / +$/.test(last.text)) l.width -= measure(atlas, last.family, last.text.match(/ +$/)[0], h * last.height, last.width);
    }
    const attach = e.attach || 1;
    const col = (attach - 1) % 3, row = Math.floor((attach - 1) / 3);
    const step = h * (5 / 3) * (e.spacing || 1);
    const blockW = Number.isFinite(maxWidth) ? maxWidth : Math.max(...lines.map(l => l.width));
    const total = h + (lines.length - 1) * step;
    const top = row === 0 ? 0 : row === 1 ? total / 2 : total;
    const out = { quads: [], rects: [], colors: [] };
    lines.forEach((l, i) => {
        const left = col === 0 ? 0 : col === 1 ? -blockW / 2 : -blockW;
        const x0 = left + (col === 0 ? 0 : col === 1 ? (blockW - l.width) / 2 : blockW - l.width);
        let pen = x0;
        const y = top - h - i * step;
        for (const r of l.runs) pen = emitRun(atlas, r.family, r.text, pen, y, h * r.height, r.width, r.oblique, r.rgb, out);
    });
    return out.quads.length ? out : null;
}
