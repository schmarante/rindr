// The drawing model shared by the DXF reader (dxf-reader.js) and the DWG reader (dwg/): tables, blocks, layouts and the
// objects of model and paper space as plain records. drawing-build.js turns it into scene data. Runs in the CAD worker.
//
// Records (all coordinates in drawing units, angles as the file has them – the readers convert to the forms below):
//   common: { type, layer, color (ACI 1…255, 0 = BYBLOCK, 256 = BYLAYER, 257 = by object), rgb (0xRRGGBB or null),
//             linetype ('' = BYLAYER, 'BYBLOCK', name), ltscale, lineweight (1/100 mm; -1 BYLAYER, -2 BYBLOCK, -3 default),
//             invisible, extrusion ([x,y,z] or null = 0,0,1), thickness, handle }
//   LINE { a, b } · POINT { p } · CIRCLE { c, r } (OCS) · ARC { c, r, start, end } (OCS, degrees, counter-clockwise)
//   ELLIPSE { c, major, ratio, start, end } (WCS, parameters in radians)
//   LWPOLYLINE / POLYLINE kind '2d' { pts: [x,y,…], bulges, widths: [s0,e0,…] | null, closed, elevation } (OCS)
//   POLYLINE kind '3d' { pts: [x,y,z,…], closed } · kind 'mesh' { pts, m, n, closedM, closedN } · kind 'pface' { pts, faces }
//   SPLINE { degree, closed, periodic, knots, ctrl: [x,y,z,…], weights | null, fit: [x,y,z,…] | null }
//   3DFACE { pts: [4 × xyz], hidden (edge bits) } · SOLID / TRACE { pts: [4 × xyz] OCS, in drawing order 1, 2, 4, 3 }
//   INSERT { name, p (OCS), scale, rot (degrees), cols, rows, colSpacing, rowSpacing, attribs: [records] }
//   TEXT / ATTRIB / ATTDEF { p, p2, h, rot, width, oblique, style, hAlign, vAlign, mirror, text } (OCS)
//   MTEXT { p (WCS), dir | null, rot, h, width, attach, spacing, style, text (with format codes) }
//   DIMENSION { block } · (ACAD_TABLE: an INSERT of its *T block) · HATCH { elevation, solid, loops, style, patterns, gradient }
//   MESH { pts, faces: flat list (corner count, vertex indices …) } · LEADER { pts, arrow } · MLINE { pts, miters, params } · WIPEOUT { polygon (WCS) }
//   VIEWPORT { center, w, h, id, status, viewCenter, viewDir, target, viewHeight, twist, frozen: [layer names] }
//   MLEADER { roots: [{ connection, dir, landing, lines: [[x,y,z …] from the arrowhead on] }], leaderType (0 none, 1 straight,
//     2 spline), leaderColor, leaderLw, dogleg, arrowSize, arrowHandle, text: { text, p, dir, normal, rot (rad), h, width,
//     spacing, attach (1–3), styleHandle, color } | null, block: { handle, p, normal, scale, rot (rad), color } | null,
//     labels: [{ attdef (handle), text }] } – colours { color (ACI code), rgb } | null; points WCS
//   ACIS (3DSOLID, REGION, BODY, SURFACE …) { acis: { sat: string } | { sab: Uint8Array } | { ref } }

export const ACI_BYBLOCK = 0, ACI_BYLAYER = 256, ACI_BYOBJECT = 257;
export const LW_BYLAYER = -1, LW_BYBLOCK = -2, LW_DEFAULT = -3;

// $INSUNITS → millimetres per drawing unit (0 = unitless: millimetres)
export const UNIT_MM = {
    0: 1, 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7,
    12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5, 17: 1e12, 18: 1.495978707e14, 19: 9.4607304725808e18, 20: 3.0856776e19,
    21: 304.8006096, 22: 25.4000508, 23: 914.4018288, 24: 1609347.2187,
};

// The ACI palette (format property): 1–9 named, 10–249 24 hues × 5 levels × (full | half saturation), 250–255 greys
const ACI = (() => {
    const table = new Uint32Array(256);
    const basic = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
    basic.forEach((c, i) => { table[i] = c; });
    const levels = [255, 204, 153, 127, 76];
    for (let i = 10; i < 250; i++) {
        const hue = Math.floor((i - 10) / 10) * 15, j = (i - 10) % 10;
        const v = levels[j >> 1] / 255, s = j & 1 ? 0.5 : 1;
        // HSV → RGB
        const f = (n) => {
            const k = (n + hue / 60) % 6;
            return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        };
        const r = Math.floor(f(5) * 255 + 1e-6), g = Math.floor(f(3) * 255 + 1e-6), b = Math.floor(f(1) * 255 + 1e-6);
        table[i] = (r << 16) | (g << 8) | b;
    }
    [51, 91, 132, 173, 214, 255].forEach((g, k) => { table[250 + k] = (g << 16) | (g << 8) | g; });
    return table;
})();

/** ACI 1…255 → 0xRRGGBB (7 = white – the drawing is shown on a dark background, a paper sheet maps it to black) */
export const aciRgb = i => ACI[Math.min(Math.max(i | 0, 1), 255)];

/** Arbitrary axis algorithm: the object coordinate system of an extrusion direction → { ax, ay, az } (unit vectors) */
export function ocsBasis(n) {
    if (!n) return null;
    let [x, y, z] = n;
    const len = Math.hypot(x, y, z);
    if (!(len > 0)) return null;
    x /= len; y /= len; z /= len;
    if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12 && z > 0) return null;   // world: no change
    // Ax = (|Nx| < 1/64 and |Ny| < 1/64 ? Wy : Wz) × N
    let ax;
    if (Math.abs(x) < 1 / 64 && Math.abs(y) < 1 / 64) ax = [z, 0, -x];   // (0,1,0) × N
    else ax = [-y, x, 0];                                                  // (0,0,1) × N
    const la = Math.hypot(ax[0], ax[1], ax[2]);
    ax = [ax[0] / la, ax[1] / la, ax[2] / la];
    const ay = [y * ax[2] - z * ax[1], z * ax[0] - x * ax[2], x * ax[1] - y * ax[0]];
    const ly = Math.hypot(ay[0], ay[1], ay[2]);
    return { ax, ay: [ay[0] / ly, ay[1] / ly, ay[2] / ly], az: [x, y, z] };
}

/** 4 × 4 matrix (column-major, like three.js) of an OCS: object coordinates → world */
export function ocsMatrix(extrusion) {
    const b = ocsBasis(extrusion);
    if (!b) return null;
    return [b.ax[0], b.ax[1], b.ax[2], 0, b.ay[0], b.ay[1], b.ay[2], 0, b.az[0], b.az[1], b.az[2], 0, 0, 0, 0, 1];
}

export class Drawing {
    constructor() {
        this.header = { version: '', insunits: 0, ltscale: 1, lwdisplay: false, pdmode: 0, pdsize: 0, fillmode: true,
            extmin: null, extmax: null, measurement: 1, dimscale: 1 };
        /** @type {Map<string, {name: string, color: number, rgb: number|null, off: boolean, frozen: boolean, linetype: string, lineweight: number, handle: string}>} keys upper-case */
        this.layers = new Map();
        /** @type {Map<string, {name: string, pattern: number[], total: number}>} keys upper-case */
        this.linetypes = new Map();
        /** @type {Map<string, {name: string, font: string, family: string, height: number, width: number, oblique: number, flags: number}>} */
        this.styles = new Map();
        /** dimension styles: arrow size etc. (keys upper-case) */
        this.dimstyles = new Map();
        /** @type {Map<string, {name: string, base: number[], entities: object[], flags: number, record: string}>} keys upper-case */
        this.blocks = new Map();
        /** layouts (paper space sheets): { name, order, block (block name), limits: [x0,y0,x1,y1] | null } */
        this.layouts = [];
        this.modelSpace = [];
        /** paper space objects by block name (upper-case); '*PAPER_SPACE' = the active layout */
        this.paperSpace = new Map();
        /** handle (hex string, upper-case) → layer name (viewport frozen layers), block record → block name */
        this.layerByHandle = new Map();
        this.blockByRecord = new Map();
        /** handle → text style name (multileaders name their style by handle) */
        this.styleByHandle = new Map();
        /** objects not shown, by type (counted for the notice) */
        this.skipped = {};
        this.acisBlobs = new Map();   // ACDSDATA / AcDs: SAB data by entity handle (stage 2)
    }

    layer(name) {
        return this.layers.get(String(name ?? '0').toUpperCase()) || null;
    }

    skip(type, n = 1) {
        this.skipped[type] = (this.skipped[type] || 0) + n;
    }

    /** millimetres per drawing unit – unitless drawings: inches when imperial ($MEASUREMENT 0, like the CAD program's
     *  default), else millimetres */
    get unitMm() {
        if (!this.header.insunits) return this.header.measurement === 0 ? 25.4 : 1;
        return UNIT_MM[this.header.insunits] ?? 1;
    }
}
