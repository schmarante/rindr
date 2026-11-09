// DWG reader (after the public DWG format description): sections from container.js, then the classes, the object map
// (handle → offset), the header variables up to the units, and every object – into the same drawing model as the DXF
// reader (drawing.js), so building, annotations and solids are shared.
//
// Objects: modular-short size, (2010+) the handle stream size, the object type, (2000–2007) the data size in bits, the
// handle, extended data, then for entities the common entity data (entity mode, reactors, colour, line type scale and
// flags, invisibility, lineweight), the type's own data, and at the end of the data the handle stream (owner, reactors,
// extension dictionary, layer, line type …, the type's handles). From 2007 on the texts of an object are in a string
// stream at the end of its data. Model and paper space objects carry no owner (entity mode 2 / 1); block contents,
// vertices and attributes name theirs.
import { readDwgSections } from './container.js';
import { BitReader, readMC, readMS, versionNumber, R14, R2000, R2004, R2007, R2010, R2013, R2018 } from './bits.js';
import { Drawing, ACI_BYLAYER, ACI_BYBLOCK, ACI_BYOBJECT, LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT } from '../drawing.js';

// DWG code pages → TextDecoder labels
const CODEPAGES = { 28: 'windows-874', 29: 'shift_jis', 30: 'gbk', 31: 'euc-kr', 32: 'big5', 33: 'windows-1250', 34: 'windows-1251',
    35: 'windows-1252', 36: 'windows-1253', 37: 'windows-1254', 38: 'windows-1255', 39: 'windows-1256', 40: 'windows-1257', 41: 'windows-1258' };
// lineweight index of entities/layers (2000+) → 1/100 mm
const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lineweight = i => (i === 29 ? LW_BYLAYER : i === 30 ? LW_BYBLOCK : i === 31 ? LW_DEFAULT : LINEWEIGHTS[i] ?? LW_DEFAULT);

// fixed object types
const T = {
    TEXT: 1, ATTRIB: 2, ATTDEF: 3, BLOCK: 4, ENDBLK: 5, SEQEND: 6, INSERT: 7, MINSERT: 8, VERTEX_2D: 10, VERTEX_3D: 11, VERTEX_MESH: 12,
    VERTEX_PFACE: 13, VERTEX_PFACE_FACE: 14, POLYLINE_2D: 15, POLYLINE_3D: 16, ARC: 17, CIRCLE: 18, LINE: 19, DIM_ORDINATE: 20,
    DIM_DIAMETER: 26, POINT: 27, FACE3D: 28, POLYLINE_PFACE: 29, POLYLINE_MESH: 30, SOLID: 31, TRACE: 32, SHAPE: 33, VIEWPORT: 34,
    ELLIPSE: 35, SPLINE: 36, REGION: 37, SOLID3D: 38, BODY: 39, RAY: 40, XLINE: 41, DICTIONARY: 42, MTEXT: 44, LEADER: 45,
    TOLERANCE: 46, MLINE: 47, BLOCK_CONTROL: 48, BLOCK_HEADER: 49, LAYER_CONTROL: 50, LAYER: 51, STYLE_CONTROL: 52, STYLE: 53,
    LTYPE_CONTROL: 56, LTYPE: 57, DIMSTYLE: 69, LWPOLYLINE: 77, HATCH: 78, LAYOUT: 82,
};
const TYPE_NAMES = new Map(Object.entries(T).map(([name, n]) => [n, name]));   // hints about skipped objects
const ENTITY_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 44, 45, 46, 47, 77, 78]);
// class-based types by their DXF name
const CLASS_ENTITY = new Set(['LWPOLYLINE', 'HATCH', 'MESH', 'WIPEOUT', 'IMAGE', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'MLEADER',
    'ACAD_TABLE', 'ACAD_PROXY_ENTITY', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE',
    'HELIX', 'LIGHT', 'OLE2FRAME', 'PDFUNDERLAY', 'DWFUNDERLAY', 'DGNUNDERLAY', 'POINTCLOUD', 'POINTCLOUDEX', 'SECTIONOBJECT', 'GEOPOSITIONMARKER']);

/**
 * @param {Uint8Array} bytes the DWG file
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Drawing}
 */
export function readDwg(bytes, onProgress = () => {}) {
    const file = readDwgSections(bytes);
    return new DwgReader(file, bytes, onProgress).run();
}

class DwgReader {
    constructor(file, bytes, onProgress) {
        this.file = file;
        this.bytes = bytes;
        this.v = versionNumber(file.version);
        this.onProgress = onProgress;
        let decoder = null;
        try { decoder = new TextDecoder(CODEPAGES[file.codepage] || 'windows-1252'); } catch { decoder = new TextDecoder('windows-1252'); }
        this.decoder = decoder;
        this.objects = file.sections.get('AcDb:AcDbObjects');
        if (!this.objects) throw new Error('DWG without object data');
        this.maintenance = bytes[11] || 0;
        this.d = new Drawing();
        this.d.header.version = file.version;
        this.classes = new Map();
        this.records = new Map();   // handle → parsed object
    }

    run() {
        this.readClasses();
        this.readMap();
        try { this.readHeader(); } catch (err) { console.warn('[DWG] header variables not read:', err.message); }
        const handles = this.handleList;
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            try {
                const o = this.object(this.offsets.get(h), h);
                if (o) this.records.set(h, o);
            } catch (err) {
                this.d.skip('(unreadable object)');
                if (globalThis.DWG_DEBUG && (this.errors = (this.errors || 0) + 1) <= 5) console.warn('[DWG] object', h.toString(16), err.stack.split('\n').slice(0, 3).join(' | '));
            }
            if ((i & 4095) === 0) this.onProgress(i / handles.length);
        }
        this.assemble();
        return this.d;
    }

    // --- classes: class number → DXF name ---
    // sentinel, RL size (2010/2013 with maintenance > 3 and 2018+: one more RL), (2004+) max class number …, then per class
    // number, flags, application, C++ name, DXF name … – from 2007 on the texts in a string stream at the end of the data
    readClasses() {
        const data = this.file.sections.get('AcDb:Classes');
        if (!data) return;
        const v = this.v;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let p = 16;
        const size = dv.getUint32(p, true); p += 4;
        if (v >= R2010) p += 4;   // one more long (every 2010+ file, whatever the maintenance version says)
        const attempt = (start, endBit) => {
            const map = new Map();
            const r = new BitReader(data, v, start, this.decoder);
            if (v >= R2007) this.stringStream(r, data, endBit);
            if (v >= R2004) { r.BS(); r.RC(); r.RC(); r.B(); }
            const stop = v >= R2007 ? (r.strings ? r.strings.p : endBit) : endBit;
            while (r.p < stop - 16) {
                const num = r.BS();
                r.BS();
                r.TV(); r.TV();
                const dxf = r.TV();
                r.B(); r.BS();
                if (v >= R2004) { r.BL(); r.BS(); r.BS(); r.BL(); r.BL(); }
                if (!(num >= 500 && num < 10000) || !/^[A-Za-z0-9_]+$/.test(dxf || '')) break;
                map.set(num, dxf.toUpperCase());
            }
            return map;
        };
        // the end of the class data: the byte size, or (2007+) a bit size in front of the data
        const candidates = [[p * 8, (p + size) * 8]];
        if (v >= R2007) { const bits = dv.getUint32(p, true); candidates.unshift([(p + 4) * 8, (p + 4) * 8 + bits], [p * 8 + 32, p * 8 + bits]); }
        for (const [start, endBit] of candidates) {
            let map;
            try { map = attempt(start, endBit); } catch { continue; }
            if (map.size > this.classes.size) this.classes = map;
        }
    }

    // the string stream of an object or section: the last data bit says whether there is one; its size sits before it
    stringStream(r, data, endBit) {
        const flag = new BitReader(data, this.v, endBit - 1);
        if (!flag.B()) return;
        let start = endBit - 1 - 16;
        let size = new BitReader(data, this.v, start).RS();
        if (size & 0x8000) {
            start -= 16;
            const hi = new BitReader(data, this.v, start).RS();
            size = (size & 0x7fff) | (hi << 15);
        }
        start -= size;
        r.strings = new BitReader(data, this.v, start, this.decoder);
    }

    // --- object map: pages of [2-byte big-endian size, (handle offset, location offset) modular chars …, CRC] ---
    readMap() {
        const data = this.file.sections.get('AcDb:Handles');
        if (!data) throw new Error('DWG without object map');
        const offsets = new Map();
        let p = 0, handle = 0, loc = 0;
        while (p + 2 <= data.length) {
            const size = (data[p] << 8) | data[p + 1];
            if (size <= 2) break;
            const end = p + size;
            p += 2;
            handle = 0; loc = 0;   // the deltas start again in every block
            while (p < end) {
                let dh, dl;
                [dh, p] = readMC(data, p, false);
                [dl, p] = readMC(data, p, true);
                handle += dh;
                loc += dl;
                offsets.set(handle, loc);
            }
            p = end + 2;   // CRC
        }
        this.offsets = offsets;
        this.handleList = [...offsets.keys()].sort((a, b) => a - b);
    }

    // --- header variables (the beginning, up to the units) ---
    readHeader() {
        const data = this.file.sections.get('AcDb:Header');
        if (!data) return;
        const v = this.v, h = this.d.header;
        let p = 16 + 4;   // sentinel, size of the data
        if (v >= R2010) p += 4;   // one more long (every 2010+ file, whatever the maintenance version says)
        const r = new BitReader(data, v, p * 8, this.decoder);
        // 2007+: texts in a string stream, handles in a handle stream – the data stream holds neither (but HANDSEED)
        const sep = v >= R2007;
        if (v >= R2007) r.RL();   // size in bits (every 2007+ file, not only 2007 as described)
        if (v >= R2013) r.BLL();   // REQUIREDVERSIONS
        const TV = () => { if (!sep) r.TV(); };
        const H = () => { if (!sep) r.H(); };
        r.BD(); r.BD(); r.BD(); r.BD();
        TV(); TV(); TV(); TV();
        r.BL(); r.BL();
        if (v <= R14) r.BS();
        if (v < R2004) H();
        r.B(); r.B();                     // DIMASO, DIMSHO
        if (v <= R14) r.B();              // DIMSAV
        r.B(); r.B(); r.B();              // PLINEGEN, ORTHOMODE, REGENMODE
        h.fillmode = !!r.B();
        r.B(); r.B(); r.B();              // QTEXTMODE, PSLTSCALE, LIMCHECK
        if (v <= R14) r.B();              // BLIPMODE
        if (v >= R2004) r.B();
        r.B(); r.B(); r.B(); r.B();       // USRTIMER, SKPOLY, ANGDIR, SPLFRAME
        if (v <= R14) { r.B(); r.B(); }   // ATTREQ, ATTDIA
        r.B(); r.B();                     // MIRRTEXT, WORLDVIEW
        if (v <= R14) r.B();              // WIREFRAME
        r.B(); r.B(); r.B();              // TILEMODE, PLIMCHECK, VISRETAIN
        if (v <= R14) r.B();              // DELOBJ
        r.B(); r.B();                     // DISPSILH, PELLIPSE
        r.BS();                           // PROXYGRAPHICS
        if (v <= R14) r.BS();             // DRAGMODE
        r.BS(); r.BS(); r.BS(); r.BS(); r.BS();   // TREEDEPTH, LUNITS, LUPREC, AUNITS, AUPREC
        if (v <= R14) r.BS();             // OSMODE
        r.BS();                           // ATTMODE
        if (v <= R14) r.BS();             // COORDS
        h.pdmode = r.BS();
        if (v <= R14) r.BS();             // PICKSTYLE
        if (v >= R2004) { r.BL(); r.BL(); r.BL(); }
        for (let i = 0; i < 19; i++) r.BS();   // USERI1–5 … TEXTQLTY
        h.ltscale = r.BD() || 1;
        r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD();   // TEXTSIZE … ANGBASE
        h.pdsize = r.BD();
        for (let i = 0; i < 12; i++) r.BD();   // PLINEWID, USERR1–5, CHAMFERA–D, FACETRES, CMLSCALE
        r.BD();                           // CELTSCALE
        if (v < R2007) TV();              // MENUNAME (R13–R2004)
        r.BL(); r.BL(); r.BL(); r.BL();   // TDCREATE, TDUPDATE
        if (v >= R2004) { r.BL(); r.BL(); r.BL(); }
        r.BL(); r.BL(); r.BL(); r.BL();   // TDINDWG, TDUSRTIMER
        r.CMC();                          // CECOLOR
        r.H();                            // HANDSEED (data stream also in 2007+)
        H(); H(); H();                    // CLAYER, TEXTSTYLE, CELTYPE
        if (v >= R2007) H();              // CMATERIAL
        H(); H();                         // DIMSTYLE, CMLSTYLE
        if (v >= R2000) r.BD();           // PSVPSCALE
        r.BD3(); r.BD3(); r.BD3(); r.RD2(); r.RD2(); r.BD(); r.BD3(); r.BD3(); r.BD3(); H();   // paper space
        if (v >= R2000) { H(); r.BS(); H(); for (let i = 0; i < 6; i++) r.BD3(); }
        r.BD3();                          // INSBASE (model space)
        const extmin = r.BD3(), extmax = r.BD3();
        h.extmin = extmin; h.extmax = extmax;
        r.RD2(); r.RD2(); r.BD(); r.BD3(); r.BD3(); r.BD3(); H();
        if (v >= R2000) { H(); r.BS(); H(); for (let i = 0; i < 6; i++) r.BD3(); TV(); TV(); }
        if (v <= R14) {
            for (let i = 0; i < 11; i++) r.B();
            r.RC(); r.RC(); r.B(); r.B(); r.RC(); r.RC(); r.RC(); r.B(); r.RC(); r.RC(); r.RC(); r.RC();
            r.BS(); r.BS(); r.BS(); r.BS(); r.BS(); r.BS(); H();
        }
        h.dimscale = r.BD() || 1;
        h.dimasz = r.BD();
        for (let i = 0; i < 7; i++) r.BD();   // DIMEXO … DIMTM
        if (v >= R2007) { r.BD(); r.BD(); r.BS(); r.CMC(); }
        if (v >= R2000) { for (let i = 0; i < 6; i++) r.B(); r.BS(); r.BS(); r.BS(); }
        if (v >= R2007) r.BS();
        for (let i = 0; i < 8; i++) r.BD();   // DIMTXT … DIMGAP
        if (v <= R14) { TV(); TV(); TV(); TV(); TV(); }
        if (v >= R2000) { r.BD(); r.B(); r.BS(); r.B(); r.B(); r.B(); r.B(); }
        r.CMC(); r.CMC(); r.CMC();
        if (v >= R2000) {
            for (let i = 0; i < 11; i++) r.BS();
            r.B(); r.B(); r.BS(); r.BS(); r.BS(); r.BS(); r.B(); r.BS();
        }
        if (v >= R2007) r.B();
        if (v >= R2010) { r.B(); r.BD(); TV(); r.BD(); TV(); }
        if (v >= R2000) { H(); H(); H(); H(); H(); }
        if (v >= R2007) { H(); H(); H(); }
        if (v >= R2000) { r.BS(); r.BS(); }
        for (let i = 0; i < 9; i++) H();      // control objects
        if (v <= R2000) H();
        H(); H(); H();                         // dictionaries
        if (v >= R2000) {
            r.BS(); r.BS(); TV(); TV(); H(); H(); H();
            if (v >= R2004) { H(); H(); }
            if (v >= R2007) H();
            if (v >= R2013) H();
            const flags = r.BL();
            h.lwdisplay = !(flags & 0x0200);
            const units = r.BS();
            if (units >= 0 && units <= 24) h.insunits = units;
        }
    }

    // --- one object ---
    object(offset, handle) {
        if (offset === undefined) return null;
        const data = this.objects, v = this.v;
        let [size, p] = readMS(data, offset);
        let handleBits = 0;
        if (v >= R2010) [handleBits, p] = readMC(data, p, false);   // (not counted in the size)
        if (!(size > 0) || p + size > data.length) return null;
        const origin = p * 8;
        const r = new BitReader(data, v, p * 8, this.decoder);
        const typeNum = r.OT();
        let dataEnd = 0;
        if (v >= R2010) dataEnd = origin + size * 8 - handleBits;
        else if (v >= R2000) dataEnd = origin + r.RLu();
        const own = r.H().value;
        // extended data: (size, application, bytes) until size 0
        const eed = [];
        for (let guard = 0; guard < 4096; guard++) {
            const n = r.BS();
            if (n <= 0) break;
            const app = r.H().value;
            const start = r.p;
            eed.push({ app, start, size: n });
            r.p = start + n * 8;
        }
        const type = typeNum >= 500 ? this.classes.get(typeNum) || `CLASS${typeNum}` : typeNum;
        const entity = typeof type === 'number' ? ENTITY_TYPES.has(type) : CLASS_ENTITY.has(type);
        const o = { handle: own, type, r, eed, data };
        if (entity) {
            if (r.B()) {   // graphics present
                const n = v >= R2010 ? r.BLL() : r.RLu();
                r.p += n * 8;
            }
            if (v <= R14) dataEnd = origin + r.RLu();
            o.entmode = r.BB();
            o.reactors = r.BL();
            o.xdicMissing = v >= R2004 ? r.B() : 0;
            if (v >= R2013) o.hasDs = r.B();
            o.bylayerLt = v <= R14 ? r.B() : 0;
            o.nolinks = v >= R2004 ? 1 : r.B();   // from 2004 on not stored (always 1: no links)
            o.color = r.ENC();
            o.ltscale = r.BD();
            if (v >= R2000) { o.ltflags = r.BB(); o.psflags = r.BB(); }
            if (v >= R2007) { o.matflags = r.BB(); r.RC(); }
            if (v >= R2010) { o.vs = [r.B(), r.B(), r.B()]; }
            o.invisible = r.BS() & 1;
            o.lineweight = v >= R2000 ? lineweight(r.RC()) : LW_BYLAYER;
        } else {
            if (v <= R14) dataEnd = origin + r.RLu();
            o.reactors = r.BL();
            o.xdicMissing = v >= R2004 ? r.B() : 0;
            if (v >= R2013) o.hasDs = r.B();
        }
        o.dataEnd = dataEnd;
        o.end = origin + size * 8;   // end of the handle stream (the CRC follows)
        if (v >= R2007) this.stringStream(r, data, dataEnd);
        o.entity = entity;
        const res = this.parse(o);
        // only the results stay (a file with a million vertices keeps a million of these)
        if (res) { res.r = res.h = res.ref = res.eed = res.data = null; }
        return res;
    }

    // the handle stream: common part (owner, reactors, extension dictionary; for entities layer, line type, …)
    handles(o) {
        const h = new BitReader(o.data, this.v, o.dataEnd);
        const v = this.v;
        const ref = () => h.Href(o.handle);
        if (o.entity) {
            o.owner = o.entmode === 0 ? ref() : null;
            for (let i = 0; i < o.reactors && i < 1e5; i++) ref();
            if (!o.xdicMissing) ref();
            if (v <= R14) { o.layerH = ref(); if (!o.bylayerLt) o.ltypeH = ref(); }
            if (v <= R2000 && !o.nolinks) { ref(); ref(); }
            if (v >= R2004 && o.color.book) ref();
            if (v >= R2000) {
                o.layerH = ref();
                if (o.ltflags === 3) o.ltypeH = ref();
                if (v >= R2007 && o.matflags === 3) ref();
                if (o.psflags === 3) ref();
            }
            if (v >= R2010) for (const f of o.vs) if (f) ref();
        } else {
            o.owner = ref();
            for (let i = 0; i < o.reactors && i < 1e5; i++) ref();
            if (!o.xdicMissing) ref();
        }
        o.h = h;
        o.ref = ref;
        return h;
    }

    // common part of table entries: name, 64-flag, xref index + 1 (up to 2004 – from 2007 on not stored: every flag and
    // count after it was read a few bits off, layers came out "off" and block headers owned millions of objects), xref
    // dependency
    entryName(r) {
        const name = r.TV();
        r.B();
        if (this.v < R2007) r.BS();
        r.B();
        return name;
    }

    // --- type dispatch: the data of a type, then its handles ---
    parse(o) {
        const r = o.r, v = this.v, t = o.type;
        switch (t) {
            case T.LAYER: {
                o.name = this.entryName(r);
                let frozen = false, off = false, lw = LW_DEFAULT;
                if (v <= R14) { frozen = !!r.B(); off = !!r.B(); r.B(); r.B(); }
                else {
                    const f = r.BS();
                    frozen = !!(f & 1); off = !!(f & 2);
                    // (the "on" bit of the description is set for layers that are off)
                    lw = lineweight((f & 0x3e0) >> 5);
                }
                const c = r.CMC();
                // an off layer is also told by a negative colour index
                const index = c.index < 0 ? -c.index : c.index;
                if (c.index < 0) off = true;
                o.layer = { name: o.name, color: index > 0 && index < 256 ? index : 7, rgb: c.rgb, off, frozen, lineweight: lw, linetype: '' };
                this.handles(o);
                o.ref();   // xref block
                if (v >= R2000) o.ref();   // plot style
                if (v >= R2007) o.ref();   // material
                o.ltypeH = o.ref();
                return o;
            }
            case T.LTYPE: {
                o.name = this.entryName(r);
                r.TV();   // description
                const total = r.BD();
                r.RC();
                const n = r.RC();
                const pattern = [];
                for (let i = 0; i < n; i++) {
                    pattern.push(r.BD());
                    r.BS(); r.RD(); r.RD(); r.BD(); r.BD(); r.BS();
                }
                o.linetype = { name: o.name, pattern, total: Math.abs(total) || pattern.reduce((s, x) => s + Math.abs(x), 0) };
                return o;
            }
            case T.STYLE: {
                o.name = this.entryName(r);
                const vertical = r.B(), shape = r.B();
                const height = r.BD(), width = r.BD(), oblique = r.BD();
                const gen = r.RC();
                r.BD();
                const font = r.TV(), bigFont = r.TV();
                // a TrueType family in the extended data (1000 string after the application)
                const family = this.eedString(o);
                o.style = { name: o.name, font, bigFont, family, height, width: width || 1, oblique: oblique * 180 / Math.PI, flags: (vertical ? 4 : 0) | (shape ? 1 : 0), gen };
                return o;
            }
            case T.DIMSTYLE: return o;
            case T.BLOCK_HEADER: {
                o.name = this.entryName(r);
                const anon = r.B(); r.B();
                const isXref = r.B(), overlaid = r.B();
                if (v >= R2000) r.B();
                const owned = v >= R2004 ? r.BL() : 0;
                o.base = r.BD3();
                r.TV();
                let inserts = 0;
                if (v >= R2000) {
                    while (r.RC() !== 0 && inserts < 1e6) inserts++;
                    r.TV();
                    const preview = r.BL();
                    r.p += Math.max(0, preview) * 8;
                }
                o.flags = (anon ? 1 : 0) | (isXref ? 4 : 0) | (overlaid ? 8 : 0);
                this.handles(o);
                o.ref();            // NULL
                o.blockEntity = o.ref();
                o.entities = [];
                if (v <= R2000) { if (!isXref && !overlaid) { o.first = o.ref(); o.last = o.ref(); } }
                else for (let i = 0; i < owned && i < 1e7; i++) o.entities.push(o.ref());
                o.ref();            // ENDBLK
                if (v >= R2000) { for (let i = 0; i < inserts; i++) o.ref(); o.layoutH = o.ref(); }
                return o;
            }
            case T.LAYOUT: return this.layout(o);
            case T.DICTIONARY: return null;
            default: break;
        }
        if (typeof t === 'string' && t === 'LAYOUT') return this.layout(o);
        if (!o.entity) return null;
        return this.entity(o);
    }

    eedString(o) {
        for (const e of o.eed) {
            const r = new BitReader(o.data, this.v, e.start, this.decoder);
            const end = e.start + e.size * 8;
            while (r.p < end) {
                const code = r.RC();
                if (code === 0) {
                    if (this.v >= R2007) { const n = r.RS(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(r.RS()); return s; }
                    const n = r.RC(); r.RS();
                    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r.RC();
                    return this.decoder.decode(b);
                }
                break;
            }
        }
        return '';
    }

    layout(o) {
        const r = o.r, v = this.v;
        r.TV(); r.TV(); r.BS();
        const margins = [r.BD(), r.BD(), r.BD(), r.BD()];
        const paper = [r.BD(), r.BD()];
        r.TV(); r.BD2(); r.BS();
        const rotation = r.BS();
        r.BS(); r.BD2(); r.BD2();
        if (v <= R2000) r.TV();
        r.BD(); r.BD(); r.TV(); r.BS(); r.BD(); r.BD2();
        if (v >= R2004) { r.BS(); r.BS(); r.BS(); }
        const name = r.TV();
        const order = r.BL();
        r.BS(); r.BD3();
        const lim0 = r.RD2(), lim1 = r.RD2();
        r.BD3(); r.BD3(); r.BD3(); r.BD(); r.BS(); r.BD3(); r.BD3();
        const vpCount = v >= R2004 ? r.RL() : 0;
        this.handles(o);
        if (v >= R2004) o.ref();   // plot view
        if (v >= R2007) o.ref();   // visual style
        o.blockH = o.ref();
        o.layout = { name, order, limits: lim1[0] > lim0[0] ? [lim0[0], lim0[1], lim1[0], lim1[1]] : null, paper, margins, rotation, vpCount };
        return o;
    }

    // --- entities → drawing records (drawing.js) ---
    entity(o) {
        const r = o.r, v = this.v, t = o.type;
        const rec = { type: '', invisible: !!o.invisible, ltscale: o.ltscale || 1, lineweight: o.lineweight, extrusion: null, thickness: 0, handle: o.handle.toString(16).toUpperCase() };
        let after = null;   // reading of the type's handles
        switch (t) {
            case T.LINE: {
                rec.type = 'LINE';
                if (v <= R14) { rec.a = r.BD3(); rec.b = r.BD3(); }
                else {
                    const zz = r.B();
                    const x0 = r.RD(), x1 = r.DD(x0), y0 = r.RD(), y1 = r.DD(y0);
                    let z0 = 0, z1 = 0;
                    if (!zz) { z0 = r.RD(); z1 = r.DD(z0); }
                    rec.a = [x0, y0, z0]; rec.b = [x1, y1, z1];
                }
                rec.thickness = r.BT(); rec.extrusion = r.BE();
                break;
            }
            case T.CIRCLE: rec.type = 'CIRCLE'; rec.c = r.BD3(); rec.r = r.BD(); rec.thickness = r.BT(); rec.extrusion = r.BE(); break;
            case T.ARC:
                rec.type = 'ARC'; rec.c = r.BD3(); rec.r = r.BD(); rec.thickness = r.BT(); rec.extrusion = r.BE();
                rec.start = r.BD() * 180 / Math.PI; rec.end = r.BD() * 180 / Math.PI;
                break;
            case T.POINT: rec.type = 'POINT'; rec.p = r.BD3(); rec.thickness = r.BT(); rec.extrusion = r.BE(); break;
            case T.ELLIPSE:
                rec.type = 'ELLIPSE'; rec.c = r.BD3(); rec.major = r.BD3(); rec.extrusion = r.BD3(); rec.ratio = r.BD(); rec.start = r.BD(); rec.end = r.BD();
                break;
            case T.RAY: case T.XLINE: rec.type = t === T.RAY ? 'RAY' : 'XLINE'; rec.p = r.BD3(); rec.dir = r.BD3(); break;
            case T.FACE3D: {
                rec.type = '3DFACE';
                let pts, hidden = 0;
                if (v <= R14) { pts = [...r.BD3(), ...r.BD3(), ...r.BD3(), ...r.BD3()]; hidden = r.BS(); }
                else {
                    const noFlags = r.B(), zz = r.B();
                    const p0 = [r.RD(), r.RD(), zz ? 0 : r.RD()];
                    const p1 = r.DD3(p0), p2 = r.DD3(p1), p3 = r.DD3(p2);
                    pts = [...p0, ...p1, ...p2, ...p3];
                    if (!noFlags) hidden = r.BS();
                }
                rec.pts = pts; rec.hidden = hidden;
                break;
            }
            case T.SOLID: case T.TRACE: {
                rec.type = t === T.SOLID ? 'SOLID' : 'TRACE';
                rec.thickness = r.BT();
                const z = r.BD();
                const q = [r.RD2(), r.RD2(), r.RD2(), r.RD2()];
                rec.pts = q.flatMap(p => [p[0], p[1], z]);
                rec.extrusion = r.BE();
                break;
            }
            case T.TEXT: case T.ATTRIB: case T.ATTDEF: this.text(r, rec, t); break;
            case T.MTEXT: {
                rec.type = 'MTEXT';
                rec.p = r.BD3(); rec.extrusion = r.BD3(); rec.dir = r.BD3();
                rec.width = r.BD();
                if (v >= R2007) r.BD();
                rec.h = r.BD(); rec.attach = r.BS(); r.BS(); r.BD(); r.BD();
                rec.text = r.TV();
                if (v >= R2000) { r.BS(); rec.spacing = r.BD(); r.B(); } else rec.spacing = 1;
                rec.rot = 0;
                after = () => { rec.styleH = o.ref(); };
                break;
            }
            case T.INSERT: case T.MINSERT: case 'ACAD_TABLE': {
                // a table up to 2007 starts like an insert of its anonymous block (*T…) – drawn as that block; from 2010
                // on its data is laid out differently (not read)
                if (t === 'ACAD_TABLE' && v >= R2010) { this.d.skip(t); return null; }
                rec.type = 'INSERT';
                rec.p = r.BD3();
                if (v <= R14) rec.scale = [r.BD(), r.BD(), r.BD()];
                else {
                    const f = r.BB();
                    if (f === 3) rec.scale = [1, 1, 1];
                    else if (f === 1) rec.scale = [1, r.DD(1), r.DD(1)];
                    else if (f === 2) { const s = r.RD(); rec.scale = [s, s, s]; }
                    else { const sx = r.RD(); rec.scale = [sx, r.DD(sx), r.DD(sx)]; }
                }
                rec.rot = r.BD() * 180 / Math.PI;
                rec.extrusion = r.BD3();
                const hasAttribs = r.B();
                const owned = v >= R2004 ? r.BL() : 0;
                rec.cols = 1; rec.rows = 1; rec.colSpacing = 0; rec.rowSpacing = 0;
                if (t === T.MINSERT) { rec.cols = Math.max(1, r.BS()); rec.rows = Math.max(1, r.BS()); rec.colSpacing = r.BD(); rec.rowSpacing = r.BD(); }
                rec.attribs = [];
                after = () => {
                    rec.blockH = o.ref();
                    rec.attribH = [];
                    if (hasAttribs) {
                        if (v <= R2000) { rec.firstAttrib = o.ref(); rec.lastAttrib = o.ref(); }
                        else for (let i = 0; i < owned && i < 1e6; i++) rec.attribH.push(o.ref());
                    }
                };
                break;
            }
            case T.POLYLINE_2D: {
                rec.type = 'POLYLINE'; rec.kind = '2d';
                rec.flags = r.BS(); r.BS();
                rec.w0 = r.BD(); rec.w1 = r.BD();
                rec.thickness = r.BT(); rec.elevation = r.BD(); rec.extrusion = r.BE();
                this.ownedVertices(o, r, rec);
                after = rec.readVertexHandles;
                break;
            }
            case T.POLYLINE_3D: {
                rec.type = 'POLYLINE'; rec.kind = '3d';
                r.RC();
                rec.flags = r.RC() & 1 ? 1 : 0;
                this.ownedVertices(o, r, rec);
                after = rec.readVertexHandles;
                break;
            }
            case T.POLYLINE_PFACE: {
                rec.type = 'POLYLINE'; rec.kind = 'pface';
                rec.nv = r.BS(); rec.nf = r.BS();
                this.ownedVertices(o, r, rec);
                after = rec.readVertexHandles;
                break;
            }
            case T.POLYLINE_MESH: {
                rec.type = 'POLYLINE'; rec.kind = 'mesh';
                rec.flags = r.BS(); rec.curve = r.BS(); rec.m = r.BS(); rec.n = r.BS(); rec.md = r.BS(); rec.nd = r.BS();
                this.ownedVertices(o, r, rec);
                after = rec.readVertexHandles;
                break;
            }
            case T.VERTEX_2D: {
                rec.type = 'VERTEX'; rec.vflags = r.RC(); rec.p = r.BD3();
                let w0 = r.BD(), w1;
                if (w0 < 0) { w0 = -w0; w1 = w0; } else w1 = r.BD();
                rec.w0 = w0; rec.w1 = w1; rec.bulge = r.BD();
                if (v >= R2010) r.BL();
                r.BD();
                break;
            }
            case T.VERTEX_3D: case T.VERTEX_MESH: case T.VERTEX_PFACE: rec.type = 'VERTEX'; rec.vflags = r.RC(); rec.p = r.BD3(); break;
            case T.VERTEX_PFACE_FACE: rec.type = 'VERTEX'; rec.face = [r.BS(), r.BS(), r.BS(), r.BS()]; break;
            case T.SEQEND: case T.BLOCK: case T.ENDBLK: rec.type = t === T.SEQEND ? 'SEQEND' : t === T.BLOCK ? 'BLOCK' : 'ENDBLK'; break;
            case T.LWPOLYLINE: case 'LWPOLYLINE': this.lwpolyline(r, rec); break;
            case T.SPLINE: case 'HELIX': this.spline(r, rec); break;
            case T.HATCH: case 'HATCH': this.hatch(r, rec); break;
            case T.VIEWPORT: this.viewport(r, rec, o); after = rec.readHandles; break;
            case T.LEADER: {
                rec.type = 'LEADER';
                r.B(); r.BS(); const pathType = r.BS();
                const n = r.BL();
                rec.pts = [];
                for (let i = 0; i < n && i < 1e5; i++) rec.pts.push(...r.BD3());
                r.BD3(); rec.extrusion = r.BD3(); r.BD3(); r.BD3();
                if (v >= R14) r.BD3();
                if (v <= R14) r.BD();
                r.BD(); r.BD(); r.B(); rec.arrow = r.B();
                rec.spline = pathType === 1;
                rec.arrowSize = (this.d.header.dimasz || 2.5) * (this.d.header.dimscale || 1);
                break;
            }
            case T.MLINE: {
                rec.type = 'MLINE';
                r.BD(); r.RC(); r.BD3(); r.BD3();
                const flags = r.BS(), elements = r.RC(), n = r.BS();
                rec.pts = []; rec.miters = []; rec.params = []; rec.closed = !!(flags & 2);
                for (let i = 0; i < n && i < 1e5; i++) {
                    rec.pts.push(...r.BD3()); r.BD3(); rec.miters.push(...r.BD3());
                    const per = [];
                    for (let e = 0; e < elements; e++) {
                        const np = r.BS(); const ps = []; for (let q = 0; q < np; q++) ps.push(r.BD());
                        per.push(ps[0] ?? 0);
                        const nf = r.BS(); for (let q = 0; q < nf; q++) r.BD();
                    }
                    rec.params.push(per);
                }
                break;
            }
            case T.REGION: case T.SOLID3D: case T.BODY:
            case 'PLANESURFACE': case 'EXTRUDEDSURFACE': case 'LOFTEDSURFACE': case 'REVOLVEDSURFACE': case 'SWEPTSURFACE': case 'NURBSURFACE':
                rec.type = typeof t === 'number' ? ({ 37: 'REGION', 38: '3DSOLID', 39: 'BODY' })[t] : t;
                rec.acis = this.acis(r, o);
                break;
            case 'MESH': this.mesh(r, rec); break;
            case 'WIPEOUT': this.wipeout(r, rec); break;
            default:
                if (t >= 20 && t <= 26 || t === 'ARC_DIMENSION' || t === 'LARGE_RADIAL_DIMENSION') {
                    rec.type = 'DIMENSION';
                    if (v >= R2010) r.RC();
                    rec.extrusion = r.BD3();
                    rec.p = [0, 0, 0];
                    // DIMSTYLE, anonymous block (some kinds hold more handles): every handle up to the end – the block is
                    // the last one naming a block header
                    after = () => { rec.dimH = []; for (let i = 0; i < 16 && o.h.p < o.end - 8; i++) rec.dimH.push(o.ref()); };
                    break;
                }
                this.d.skip(typeof t === 'number' ? TYPE_NAMES.get(t) || `type ${t}` : t);
                return null;
        }
        // common handles (layer, line type …), then the type's own
        this.handles(o);
        if (after) after();
        if (t === T.TEXT || t === T.ATTRIB || t === T.ATTDEF) rec.styleH = o.ref();
        o.rec = rec;
        return o;
    }

    text(r, rec, t) {
        const v = this.v;
        rec.type = t === T.TEXT ? 'TEXT' : t === T.ATTRIB ? 'ATTRIB' : 'ATTDEF';
        let elevation = 0, ins, align = null, oblique = 0, rot = 0, h, width = 1, gen = 0, ha = 0, va = 0;
        if (v <= R14) {
            elevation = r.BD(); ins = r.RD2(); align = r.RD2(); rec.extrusion = r.BD3(); rec.thickness = r.BD();
            oblique = r.BD(); rot = r.BD(); h = r.BD(); width = r.BD(); rec.text = r.TV(); gen = r.BS(); ha = r.BS(); va = r.BS();
        } else {
            const f = r.RC();
            if (!(f & 1)) elevation = r.RD();
            ins = r.RD2();
            if (!(f & 2)) align = [r.DD(ins[0]), r.DD(ins[1])];
            rec.extrusion = r.BE(); rec.thickness = r.BT();
            if (!(f & 4)) oblique = r.RD();
            if (!(f & 8)) rot = r.RD();
            h = r.RD();
            if (!(f & 16)) width = r.RD();
            rec.text = r.TV();
            if (!(f & 32)) gen = r.BS();
            if (!(f & 64)) ha = r.BS();
            if (!(f & 128)) va = r.BS();
        }
        rec.p = [ins[0], ins[1], elevation];
        rec.p2 = align ? [align[0], align[1], elevation] : null;
        rec.h = h; rec.rot = rot * 180 / Math.PI; rec.width = width || 1; rec.oblique = oblique * 180 / Math.PI;
        rec.mirror = gen; rec.hAlign = ha; rec.vAlign = va; rec.style = '';
        if (t !== T.TEXT) {
            if (v >= R2010) r.RC();
            let multiline = false;
            if (v >= R2018) multiline = (r.RC() & 6) !== 0 && false;   // multi-line attributes: shown by their text value only
            if (!multiline) {
                rec.tag = r.TV(); r.BS();
                const flags = r.RC();
                if (v >= R2007) r.B();
                if (flags & 1) rec.invisible = true;
            }
            if (t === T.ATTDEF) { if (v >= R2010) r.RC(); r.TV(); }
        }
    }

    // vertices of a polyline: owned handles (2004+) or first/last (up to 2000); read after the common handles
    ownedVertices(o, r, rec) {
        const v = this.v;
        const owned = v >= R2004 ? r.BL() : 0;
        rec.vertexH = [];
        rec.readVertexHandles = () => {
            if (v <= R2000) { rec.firstVertex = o.ref(); rec.lastVertex = o.ref(); }
            else for (let i = 0; i < owned && i < 1e7; i++) rec.vertexH.push(o.ref());
        };
    }

    lwpolyline(r, rec) {
        const v = this.v;
        rec.type = 'POLYLINE'; rec.kind = '2d';
        const flag = r.BS();
        let constWidth = 0;
        if (flag & 4) constWidth = r.BD();
        rec.elevation = flag & 8 ? r.BD() : 0;
        rec.thickness = flag & 2 ? r.BD() : 0;
        rec.extrusion = flag & 1 ? r.BD3() : null;
        const n = r.BL();
        const nb = flag & 16 ? r.BL() : 0;
        const nid = v >= R2010 && flag & 1024 ? r.BL() : 0;
        const nw = flag & 32 ? r.BL() : 0;
        rec.pts = [];
        if (n > 0 && n < 1e7) {
            if (v <= R14) for (let i = 0; i < n; i++) rec.pts.push(...r.RD2());
            else {
                let [x, y] = r.RD2();
                rec.pts.push(x, y);
                for (let i = 1; i < n; i++) { x = r.DD(x); y = r.DD(y); rec.pts.push(x, y); }
            }
        }
        rec.bulges = new Array(n > 0 && n < 1e7 ? n : 0).fill(0);
        for (let i = 0; i < nb && i < 1e7; i++) { const b = r.BD(); if (i < n) rec.bulges[i] = b; }
        for (let i = 0; i < nid && i < 1e7; i++) r.BL();
        let widths = null;
        if (nw) { widths = []; for (let i = 0; i < nw && i < 1e7; i++) widths.push(r.BD(), r.BD()); }
        else if (constWidth && n > 0 && n < 1e7) widths = new Array(n * 2).fill(constWidth);
        rec.widths = widths;
        rec.closed = !!(flag & 512);
    }

    spline(r, rec) {
        const v = this.v;
        rec.type = 'SPLINE';
        let scenario = r.BL();
        if (v >= R2013) {
            const f1 = r.BL(), knotParam = r.BL();
            scenario = (knotParam === 15 || !(f1 & 1)) ? 1 : 2;
        }
        rec.degree = r.BL();
        rec.ctrl = []; rec.fit = null; rec.knots = []; rec.weights = null; rec.closed = false; rec.periodic = false;
        let nfit = 0, nknots = 0, nctrl = 0, weighted = false;
        if (scenario === 2) { r.BD(); r.BD3(); r.BD3(); nfit = r.BL(); }
        else {
            const rational = r.B(); rec.closed = !!r.B(); rec.periodic = !!r.B();
            r.BD(); r.BD(); nknots = r.BL(); nctrl = r.BL(); weighted = !!r.B() || !!rational;
        }
        for (let i = 0; i < nknots && i < 1e7; i++) rec.knots.push(r.BD());
        if (nctrl) { if (weighted) rec.weights = []; }
        for (let i = 0; i < nctrl && i < 1e7; i++) { rec.ctrl.push(...r.BD3()); if (weighted) rec.weights.push(r.BD()); }
        if (nfit) { rec.fit = []; for (let i = 0; i < nfit && i < 1e7; i++) rec.fit.push(...r.BD3()); }
    }

    hatch(r, rec) {
        const v = this.v;
        rec.type = 'HATCH';
        let gradient = null;
        if (v >= R2004) {
            const isGrad = r.BL(); r.BL();
            const angle = r.BD(), shift = r.BD(), single = r.BL(), tint = r.BD();
            const nc = r.BL();
            const colors = [];
            for (let i = 0; i < nc && i < 64; i++) { r.BD(); r.BS(); colors.push(r.BL() & 0xffffff); r.RC(); }
            const name = r.TV();
            if (isGrad) gradient = { name: (name || 'LINEAR').toUpperCase(), angle, shift, oneColor: single === 1, tint, colors };
        }
        rec.elevation = r.BD();
        rec.extrusion = r.BD3();
        rec.pattern = r.TV();
        rec.solid = !!r.B();
        r.B();
        const np = r.BL();
        rec.loops = [];
        let pixel = false;
        const deg = x => x * 180 / Math.PI;
        for (let l = 0; l < np && l < 1e5; l++) {
            const flags = r.BL();
            if (flags & 4) pixel = true;
            const loop = { flags, edges: [] };
            if (!(flags & 2)) {
                const ns = r.BL();
                for (let s = 0; s < ns && s < 1e6; s++) {
                    const et = r.RC();
                    if (et === 1) loop.edges.push({ type: 'line', a: r.RD2(), b: r.RD2() });
                    else if (et === 2) { const c = r.RD2(), rad = r.BD(), a0 = r.BD(), a1 = r.BD(), ccw = r.B(); loop.edges.push({ type: 'arc', c, r: rad, start: deg(a0), end: deg(a1), ccw: !!ccw }); }
                    else if (et === 3) { const c = r.RD2(), m = r.RD2(), ratio = r.BD(), a0 = r.BD(), a1 = r.BD(), ccw = r.B(); loop.edges.push({ type: 'ellipse', c, major: m, ratio, start: deg(a0), end: deg(a1), ccw: !!ccw }); }
                    else if (et === 4) {
                        const degree = r.BL(), rational = r.B(); r.B();
                        const nk = r.BL(), nc = r.BL();
                        const knots = [], ctrl = [], weights = [];
                        for (let k = 0; k < nk && k < 1e6; k++) knots.push(r.BD());
                        for (let k = 0; k < nc && k < 1e6; k++) { const p = r.RD2(); ctrl.push(p[0], p[1], 0); if (rational) weights.push(r.BD()); }
                        let fit = null;
                        if (v >= R2010) {
                            const nf = r.BL();
                            if (nf) { fit = []; for (let k = 0; k < nf && k < 1e6; k++) { const p = r.RD2(); fit.push(p[0], p[1], 0); } r.RD2(); r.RD2(); }
                        }
                        loop.edges.push({ type: 'spline', spline: { degree, knots, ctrl, weights: rational ? weights : null, fit: fit && !nc ? fit : null, closed: false, periodic: false } });
                    }
                }
            } else {
                const bulged = r.B(); r.B();
                const n = r.BL();
                const pts = [], bulges = [];
                for (let k = 0; k < n && k < 1e6; k++) { const p = r.RD2(); pts.push(p[0], p[1]); bulges.push(bulged ? r.BD() : 0); }
                loop.poly = { pts, bulges };
            }
            const nh = r.BL();
            loop.handles = nh;
            rec.loops.push(loop);
        }
        rec.style = r.BS();
        r.BS();
        rec.patterns = [];
        if (!rec.solid) {
            r.BD(); r.BD(); r.B();
            const nl = r.BS();
            for (let i = 0; i < nl && i < 1e4; i++) {
                const angle = deg(r.BD()), base = r.BD2(), offset = r.BD2();
                const nd = r.BS();
                const dashes = [];
                for (let k = 0; k < nd && k < 1e4; k++) dashes.push(r.BD());
                rec.patterns.push({ angle, base, offset, dashes });
            }
        }
        if (pixel) r.BD();
        rec.gradient = gradient;
    }

    viewport(r, rec, o) {
        const v = this.v;
        rec.type = 'VIEWPORT';
        const c = r.BD3();
        rec.center = c; rec.w = r.BD(); rec.h = r.BD();
        rec.viewDir = [0, 0, 1]; rec.target = [0, 0, 0]; rec.twist = 0; rec.viewHeight = rec.h; rec.viewCenter = [0, 0];
        let frozen = 0;
        if (v >= R2000) {
            rec.target = r.BD3(); rec.viewDir = r.BD3(); rec.twist = r.BD() * 180 / Math.PI; rec.viewHeight = r.BD();
            r.BD(); r.BD(); r.BD(); r.BD();
            rec.viewCenter = r.RD2(); r.RD2(); r.RD2(); r.RD2(); r.BS();
            if (v >= R2007) r.BS();
            frozen = r.BL();
            rec.flags = r.BL();
            rec.status = 1;
            r.TV();
        }
        rec.id = 0;
        rec.frozenH = [];
        rec.readHandles = () => {
            if (v <= R14) o.ref();
            if (v >= R2000) { for (let i = 0; i < frozen && i < 1e5; i++) rec.frozenH.push(o.ref()); rec.clipH = o.ref(); }
        };
    }

    // MESH (subdivision mesh, not in the description; read like its DXF form): BS version, B blend crease, BL subdivision
    // level, BL vertex count + 3BD each, BL face list size + BL entries (n, i0 … in-1), edges, creases (not needed)
    mesh(r, rec) {
        rec.type = 'MESH';
        r.BS(); r.B(); r.BL();
        // a BD takes 2 bits at least, a BL too – counts the data cannot hold are damage
        const room = () => Math.max(0, (this.objects.length * 8 - r.p) / 2);
        const nv = r.BL();
        if (!(nv >= 0 && nv * 3 <= room())) { rec.pts = new Float64Array(0); rec.faces = new Int32Array(0); return; }
        const pts = new Float64Array(nv * 3);
        for (let i = 0; i < nv * 3; i++) pts[i] = r.BD();
        const nf = r.BL();   // the size of the face list: per face its corner count, then the vertex indices
        const faces = new Int32Array(nf >= 0 && nf <= room() ? nf : 0);
        for (let i = 0; i < faces.length; i++) faces[i] = r.BL();
        rec.pts = pts;
        rec.faces = faces;
    }

    wipeout(r, rec) {
        rec.type = 'WIPEOUT';
        r.BL();
        const p = r.BD3(), u = r.BD3(), w = r.BD3();
        const size = r.RD2();
        r.BS(); r.B(); r.RC(); r.RC(); r.RC();
        if (this.v >= R2010) r.B();
        const clipType = r.BS();
        const pix = [];
        if (clipType === 1) { const a = r.RD2(), b = r.RD2(); pix.push(a[0], a[1], b[0], a[1], b[0], b[1], a[0], b[1]); }
        else { const n = r.BL(); for (let i = 0; i < n && i < 1e5; i++) { const q = r.RD2(); pix.push(q[0], q[1]); } }
        const polygon = [];
        for (let i = 0; i < pix.length; i += 2) {
            const x = pix[i] + 0.5, y = pix[i + 1] + 0.5;
            polygon.push(p[0] + u[0] * x + w[0] * (size[1] - y), p[1] + u[1] * x + w[1] * (size[1] - y), p[2] + u[2] * x + w[2] * (size[1] - y));
        }
        rec.polygon = polygon;
    }

    // ACIS data of a body: SAT text blocks (version 1, 159 − c), SAB (version 2), or (2013+) in the data storage
    acis(r, o) {
        if (o.hasDs) return { ref: o.handle.toString(16).toUpperCase() };
        const empty = r.B();
        if (empty) return { ref: o.handle.toString(16).toUpperCase() };
        r.B();
        const version = r.BS();
        if (version === 1) {
            let text = '';
            for (let guard = 0; guard < 1e6; guard++) {
                const n = r.BL();
                if (n <= 0) break;
                for (let i = 0; i < n; i++) {
                    const c = r.RC();
                    text += c <= 32 ? (c === 9 ? ' ' : String.fromCharCode(c)) : String.fromCharCode(159 - c);
                }
            }
            return { sat: text };
        }
        if (version === 2) {
            // a SAB/SAT file right here, up to its end marker – bit aligned like everything else (taken from the byte
            // the position falls in, the file was garbage)
            const bytes = bitBytes(o.data, r.p, Math.min(o.dataEnd, o.data.length * 8));
            const head = String.fromCharCode(...bytes.subarray(0, 15));
            if (head === 'ACIS BinaryFile' || head.startsWith('ASM BinaryFile')) return { sab: bytes.subarray(0, findEnd(bytes, 0, bytes.length)) };
            return { sat: new TextDecoder().decode(bytes) };
        }
        return { ref: o.handle.toString(16).toUpperCase() };
    }

    // --- the drawing model out of the objects ---
    assemble() {
        const d = this.d, rec = this.records;
        const hex = h => h.toString(16).toUpperCase();
        const nameOf = new Map();
        const layers = new Map(), ltypes = new Map(), styles = new Map();
        for (const o of rec.values()) {
            if (o.layer) { layers.set(o.handle, o); d.layers.set(o.layer.name.toUpperCase(), o.layer); d.layerByHandle.set(hex(o.handle), o.layer.name); }
            if (o.linetype) { ltypes.set(o.handle, o.linetype); d.linetypes.set(o.linetype.name.toUpperCase(), o.linetype); }
            if (o.style) { styles.set(o.handle, o.style); d.styles.set(o.style.name.toUpperCase(), o.style); }
        }
        for (const o of layers.values()) o.layer.linetype = ltypes.get(o.ltypeH)?.name || '';
        if (!d.layers.has('0')) d.layers.set('0', { name: '0', color: 7, rgb: null, off: false, frozen: false, linetype: 'CONTINUOUS', lineweight: -3, handle: '' });
        // blocks: header + its entities. Names in DWG need not be unique (anonymous blocks are all "*D", "*U" …, several
        // paper spaces "*Paper_Space"): the DXF export numbers them – here the handle makes them unique
        const blockHeaders = [...rec.values()].filter(o => o.type === T.BLOCK_HEADER);
        const seen = new Map();
        for (const b of blockHeaders) seen.set(b.name.toUpperCase(), (seen.get(b.name.toUpperCase()) || 0) + 1);
        for (const b of blockHeaders) nameOf.set(b.handle, seen.get(b.name.toUpperCase()) > 1 ? `${b.name}#${hex(b.handle)}` : b.name);
        const children = new Map();   // owner handle → [object]
        for (const o of rec.values()) {
            if (!o.rec || o.owner === null || o.owner === undefined) continue;
            if (!children.has(o.owner)) children.set(o.owner, []);
            children.get(o.owner).push(o);
        }
        const modelSpace = [], paperSpace = [];
        const records = new Map();
        // records of every entity (vertices and attributes are gathered into their owners)
        for (const o of rec.values()) if (o.rec) records.set(o.handle, o);
        const toRecord = o => this.toRecord(o, records, children, layers, ltypes, styles, nameOf);
        const isPart = o => ['VERTEX', 'SEQEND', 'BLOCK', 'ENDBLK'].includes(o.rec.type) || (o.rec.type === 'ATTRIB' && records.get(o.owner)?.rec.type === 'INSERT');
        for (const o of records.values()) {
            if (isPart(o)) continue;
            if (o.entmode === 2) { const e = toRecord(o); if (e) modelSpace.push([o.handle, e]); }
            else if (o.entmode === 1) { const e = toRecord(o); if (e) paperSpace.push([o.handle, e]); }
        }
        // drawing order: the owned list of the space's block header (2004+), else by handle
        const sortBy = (b, list) => {
            const order = new Map((b?.entities || []).map((h, i) => [h, i]));
            return list.sort((a, c) => (order.get(a[0]) ?? 1e12 + a[0]) - (order.get(c[0]) ?? 1e12 + c[0])).map(x => x[1]);
        };
        const model = blockHeaders.find(x => x.name.toUpperCase() === '*MODEL_SPACE');
        d.modelSpace = sortBy(model, modelSpace);
        const paperBlocks = [];
        for (const b of blockHeaders) {
            const key = nameOf.get(b.handle).toUpperCase();
            const list = (children.get(b.handle) || []).filter(o => o.rec && !isPart(o)).map(o => [o.handle, toRecord(o)]).filter(x => x[1]);
            const entities = sortBy(b, list);
            const blockEntity = records.get(b.blockEntity);
            d.blocks.set(key, { name: nameOf.get(b.handle), base: b.base || [0, 0, 0], entities, flags: b.flags, record: hex(b.handle), layer: blockEntity ? this.layerName(blockEntity, layers) : '0' });
            d.blockByRecord.set(hex(b.handle), nameOf.get(b.handle));
            if (b.name.toUpperCase().startsWith('*PAPER_SPACE')) { paperBlocks.push(b); if (entities.length) d.paperSpace.set(key, entities); }
        }
        // the active layout's objects carry no owner (entity mode 1): its block is the paper space without own objects
        if (paperSpace.length) {
            const empty = paperBlocks.filter(b => !d.paperSpace.has(nameOf.get(b.handle).toUpperCase()));
            const active = empty.length === 1 ? empty[0] : paperBlocks.find(b => b.name.toUpperCase() === '*PAPER_SPACE') || paperBlocks[0];
            const key = active ? nameOf.get(active.handle).toUpperCase() : '*PAPER_SPACE';
            d.paperSpace.set(key, [...sortBy(active, paperSpace), ...(d.paperSpace.get(key) || [])]);
        }
        // layouts
        for (const o of rec.values()) {
            if (!o.layout) continue;
            d.layouts.push({ ...o.layout, block: nameOf.get(o.blockH) || null });
        }
        d.layouts.sort((a, b) => a.order - b.order);
        // viewport ids: the first viewport of a layout (by handle) is the sheet itself
        for (const [, list] of d.paperSpace) {
            const vps = list.filter(e => e.type === 'VIEWPORT').sort((a, b) => parseInt(a.handle, 16) - parseInt(b.handle, 16));
            vps.forEach((e, i) => { e.id = i + 1; });
        }
        // ACIS data in the data storage (2013+): by entity handle
        const ds = this.file.sections.get('AcDb:AcDsPrototype_1b');
        if (ds) {
            try { for (const [h, sab] of readDataStorage(ds)) d.acisBlobs.set(hex(h), sab); } catch (err) { console.warn('[DWG] data storage not read:', err.message); }
        }
    }

    layerName(o, layers) {
        return layers.get(o.layerH)?.layer.name || '0';
    }

    // an object → a record of drawing.js (vertices, attributes and handles resolved)
    toRecord(o, records, children, layers, ltypes, styles, nameOf) {
        const e = o.rec;
        const color = o.color;
        e.layer = this.layerName(o, layers);
        if (color.rgb !== null && color.rgb !== undefined) { e.color = ACI_BYOBJECT; e.rgb = color.rgb; }
        else { e.color = color.index === 0 ? ACI_BYBLOCK : color.index >= 256 || color.index < 0 ? ACI_BYLAYER : color.index; e.rgb = null; }
        e.linetype = o.ltflags === 0 ? '' : o.ltflags === 1 ? 'BYBLOCK' : o.ltflags === 2 ? 'CONTINUOUS' : (ltypes.get(o.ltypeH)?.name || '');
        if (o.ltflags === undefined) e.linetype = ltypes.get(o.ltypeH)?.name || '';
        if (e.styleH !== undefined) e.style = styles.get(e.styleH)?.name || 'STANDARD';
        const kids = () => (children.get(o.handle) || []).filter(c => c.rec).sort((a, b) => a.handle - b.handle);
        const ordered = handles => (handles?.length ? handles.map(h => records.get(h)).filter(Boolean) : kids());
        switch (e.type) {
            case 'INSERT': {
                e.name = nameOf.get(e.blockH) || '';
                const attribs = ordered(e.attribH).filter(c => c.rec.type === 'ATTRIB');
                e.attribs = attribs.map(c => this.toRecord(c, records, children, layers, ltypes, styles, nameOf)).filter(Boolean);
                if (e.cols > 1 || e.rows > 1) e.type = 'INSERT';
                return e;
            }
            case 'DIMENSION': {
                const h = (e.dimH || []).filter(x => nameOf.has(x)).pop();
                e.block = h !== undefined ? nameOf.get(h) : '';
                return e.block ? e : null;
            }
            case 'POLYLINE': return e.vertexH ? this.polyline(o, e, ordered(e.vertexH).filter(c => c.rec.type === 'VERTEX')) : e;   // (LWPOLYLINE: points of its own)
            case 'VIEWPORT': e.frozen = (e.frozenH || []).map(h => layers.get(h)?.layer.name).filter(Boolean); return e;
            default: return e;
        }
    }

    polyline(o, e, vertices) {
        if (e.kind === 'pface') {
            const pts = [], faces = [];
            for (const v of vertices) {
                if (v.rec.face) faces.push(v.rec.face);
                else if (v.rec.p) pts.push(...v.rec.p);
            }
            return { ...e, pts, faces };
        }
        if (e.kind === 'mesh') {
            const pts = [];
            let m = e.m, n = e.n;
            let use = vertices;
            if (e.curve && vertices.some(v => v.rec.vflags & 8)) { use = vertices.filter(v => v.rec.vflags & 8); m = e.md || m; n = e.nd || n; }
            for (const v of use) pts.push(...v.rec.p);
            if (m * n !== pts.length / 3) { n = Math.max(1, Math.round(pts.length / 3 / Math.max(m, 1))); m = Math.floor(pts.length / 3 / n); }
            return { ...e, pts, m, n, closedM: !!(e.flags & 1), closedN: !!(e.flags & 32) };
        }
        if (e.kind === '3d') {
            const pts = [];
            for (const v of vertices) if (!(v.rec.vflags & 16)) pts.push(...v.rec.p);
            return { ...e, pts, closed: !!(e.flags & 1) };
        }
        const fitted = e.flags & 4;
        const pts = [], bulges = [], widths = [];
        let hasWidth = false;
        for (const v of vertices) {
            if (fitted && (v.rec.vflags & 16)) continue;
            pts.push(v.rec.p[0], v.rec.p[1]);
            bulges.push(v.rec.bulge || 0);
            widths.push(v.rec.w0 ?? e.w0, v.rec.w1 ?? e.w1);
            hasWidth ||= (v.rec.w0 || 0) !== 0 || (v.rec.w1 || 0) !== 0;
        }
        return { ...e, pts, bulges, widths: hasWidth ? widths : null, closed: !!(e.flags & 1) };
    }
}

// the bytes from a bit position up to an end bit
function bitBytes(data, from, to) {
    const n = Math.max(0, (to - from) >> 3), k = from >> 3, sh = from & 7;
    if (!sh) return data.slice(k, k + n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = ((data[k + i] << sh) | (data[k + i + 1] >> (8 - sh))) & 255;
    return out;
}

function findEnd(data, start, limit) {
    // "End-of-ACIS-data" / "End-of-ASM-data" as type name parts (14 len "End", 14 len "of", 14 len …, 13 len "data")
    for (let i = start; i < Math.min(limit, data.length) - 4; i++) {
        if (data[i] === 13 && data[i + 1] === 4 && data[i + 2] === 100 && data[i + 3] === 97 && data[i + 4] === 116 && data[i + 5] === 97) return i + 6;
    }
    return Math.min(limit, data.length);
}

// --- data storage (AcDs, 2013+): SAB data of solids by entity handle ---
function readDataStorage(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = new Map();
    const segIdxOffset = dv.getInt32(24, true), segCount = dv.getInt32(32, true), dataIdxSeg = dv.getInt32(40, true);
    // segment index: (UInt64 offset, UInt32 size) per segment, after its 48-byte header
    const segs = [];
    for (let i = 0; i < segCount; i++) {
        const q = segIdxOffset + 48 + i * 12;
        if (q + 12 > b.length) break;
        segs.push({ offset: Number(dv.getBigUint64(q, true)), size: dv.getUint32(q + 8, true) });
    }
    const di = segs[dataIdxSeg];
    if (!di) throw new Error('no data index');
    let q = di.offset + 48;
    const count = dv.getInt32(q, true); q += 8;
    const bySeg = new Map();
    for (let i = 0; i < count && q + 12 <= b.length; i++, q += 12) {
        const seg = dv.getUint32(q, true), local = dv.getUint32(q + 4, true);
        if (!seg) continue;
        if (!bySeg.has(seg)) bySeg.set(seg, []);
        bySeg.get(seg).push(local);
    }
    for (const [si, locals] of bySeg) {
        const seg = segs[si];
        if (!seg) continue;
        locals.sort((a, c) => a - c);
        // record headers (size, 1, handle, offset) after the 48-byte segment header, the records right after the last one
        const base = seg.offset + 48;
        const heads = locals.map(l => {
            const p = base + l;
            return { size: dv.getUint32(p, true), handle: Number(dv.getBigUint64(p + 8, true)), local: dv.getUint32(p + 16, true) };
        });
        const dataStart = base + locals[locals.length - 1] + 20;
        for (const h of heads) {
            const p = dataStart + h.local;
            if (p + 4 > b.length) continue;
            const size = dv.getUint32(p, true);
            if (size === 0xbb106bb1) {
                // blob in pages (blob01 segments)
                const total = Number(dv.getBigUint64(p + 4, true)), pages = dv.getUint32(p + 12, true);
                const buf = new Uint8Array(total);
                let o = 0;
                for (let k = 0; k < pages; k++) {
                    const s = dv.getUint32(p + 32 + k * 8, true);
                    const page = segs[s];
                    if (!page) continue;
                    const pq = page.offset + 48;
                    const len = Number(dv.getBigUint64(pq + 24, true));
                    buf.set(b.subarray(pq + 32, pq + 32 + len), o);
                    o += len;
                }
                out.set(h.handle, buf);
            } else if (size > 0 && p + 4 + size <= b.length) out.set(h.handle, b.slice(p + 4, p + 4 + size));
        }
    }
    return out;
}

export { readDataStorage, DwgReader };
