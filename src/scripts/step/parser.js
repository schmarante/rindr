// STEP (ISO 10303-21) Parser.
//
// Two stages, so several workers can use the same file:
//  1. buildIndex(): a single linear scan over the bytes, returns for every
//     entity id the byte offset of its body (after the '='). Optionally the
//     ids of selected types are collected (e.g. STYLED_ITEM).
//  2. StepFile.get(id): parses an entity only on demand (lazy) and caches it.
//
// Bytes and index can be SharedArrayBuffer-based – then all workers share
// the same memory without a copy.
//
// Value representation after parsing:
//   #123        -> Ref(123)            (instance of Ref)
//   1.5 / 12    -> number
//   'text'      -> string
//   .T. / .F.   -> true / false
//   .ENUM.      -> Enum('ENUM')
//   $ / *       -> null
//   (a, b)      -> Array
//   NAME(...)   -> { type: 'NAME', args } (typed parameter, e.g. LENGTH_MEASURE(1.))

const C_HASH = 35, C_EQ = 61, C_SEMI = 59, C_QUOTE = 39, C_LPAR = 40, C_RPAR = 41,
    C_COMMA = 44, C_DOT = 46, C_DOLLAR = 36, C_STAR = 42, C_SLASH = 47, C_MINUS = 45, C_PLUS = 43;

export class Ref {
    constructor(id) { this.id = id; }
}
export class Enum {
    constructor(name) { this.name = name; }
}

// Short entity names (ISO 10303-21 allows the schema's short names instead of the full ones; older exports use
// them throughout) → full names, for the entities the kernel reads. Keywords of 6 characters or fewer only.
const SHORT_NAMES = new Map(Object.entries({
    ABSR: 'ADVANCED_BREP_SHAPE_REPRESENTATION', ADVFC: 'ADVANCED_FACE', A1PL: 'AXIS1_PLACEMENT', A2PL2D: 'AXIS2_PLACEMENT_2D',
    A2PL3D: 'AXIS2_PLACEMENT_3D', BRWTVD: 'BREP_WITH_VOIDS', BSPCR: 'B_SPLINE_CURVE', BSCWK: 'B_SPLINE_CURVE_WITH_KNOTS',
    BSPSR: 'B_SPLINE_SURFACE', BSSWK: 'B_SPLINE_SURFACE_WITH_KNOTS', BZRCRV: 'BEZIER_CURVE', BZRSRF: 'BEZIER_SURFACE',
    CRTPNT: 'CARTESIAN_POINT', CTO3: 'CARTESIAN_TRANSFORMATION_OPERATOR_3D', CLSSHL: 'CLOSED_SHELL', CNCSRF: 'CONICAL_SURFACE',
    CDSR: 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', CYLSRF: 'CYLINDRICAL_SURFACE', DGTRSR: 'DEGENERATE_TOROIDAL_SURFACE',
    DRCTN: 'DIRECTION', EDGCRV: 'EDGE_CURVE', EDGLP: 'EDGE_LOOP', ELLPS: 'ELLIPSE', FCTBR: 'FACETED_BREP',
    FBSR: 'FACETED_BREP_SHAPE_REPRESENTATION', FCBND: 'FACE_BOUND', FCOTBN: 'FACE_OUTER_BOUND', FCSRF: 'FACE_SURFACE',
    GBSSR: 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION', HYPRBL: 'HYPERBOLA', INTCRV: 'INTERSECTION_CURVE',
    ITDFTR: 'ITEM_DEFINED_TRANSFORMATION', MNSLBR: 'MANIFOLD_SOLID_BREP', MSSR: 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
    MPPITM: 'MAPPED_ITEM', NAUO: 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', OFFSRF: 'OFFSET_SURFACE', OPNSHL: 'OPEN_SHELL',
    ORCLSH: 'ORIENTED_CLOSED_SHELL', ORNEDG: 'ORIENTED_EDGE', ORNFC: 'ORIENTED_FACE', PRBL: 'PARABOLA', PLYLN: 'POLYLINE',
    PLYLP: 'POLY_LOOP', PRDCT: 'PRODUCT', PRDDFN: 'PRODUCT_DEFINITION', PRDFSH: 'PRODUCT_DEFINITION_SHAPE',
    QSUNCR: 'QUASI_UNIFORM_CURVE', QSUNSR: 'QUASI_UNIFORM_SURFACE', RCTRSR: 'RECTANGULAR_TRIMMED_SURFACE',
    RPRMP: 'REPRESENTATION_MAP', RPRRLT: 'REPRESENTATION_RELATIONSHIP', RRWT: 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION',
    SMCRV: 'SEAM_CURVE', SHDFRP: 'SHAPE_DEFINITION_REPRESENTATION', SHPRPR: 'SHAPE_REPRESENTATION',
    SHRPRL: 'SHAPE_REPRESENTATION_RELATIONSHIP', SBSM: 'SHELL_BASED_SURFACE_MODEL', SPHSRF: 'SPHERICAL_SURFACE',
    SRFCRV: 'SURFACE_CURVE', SRFLNE: 'SURFACE_OF_LINEAR_EXTRUSION', SRFRVL: 'SURFACE_OF_REVOLUTION', TRDSRF: 'TOROIDAL_SURFACE',
    TRMCRV: 'TRIMMED_CURVE', UNFCRV: 'UNIFORM_CURVE', UNFSRF: 'UNIFORM_SURFACE', VRTLP: 'VERTEX_LOOP', VRTPNT: 'VERTEX_POINT',
    RBSC: 'RATIONAL_B_SPLINE_CURVE', RBSS: 'RATIONAL_B_SPLINE_SURFACE', GUAC: 'GLOBAL_UNIT_ASSIGNED_CONTEXT',
    CNBSUN: 'CONVERSION_BASED_UNIT', PLANUN: 'PLANE_ANGLE_UNIT', LNGUNT: 'LENGTH_UNIT', SUNT: 'SI_UNIT', NMDUNT: 'NAMED_UNIT',
    LMWU: 'LENGTH_MEASURE_WITH_UNIT', GMRPCN: 'GEOMETRIC_REPRESENTATION_CONTEXT', CMPCRV: 'COMPOSITE_CURVE',
    CMCRSG: 'COMPOSITE_CURVE_SEGMENT', GMTST: 'GEOMETRIC_SET', CRBNSR: 'CURVE_BOUNDED_SURFACE', BNDCR: 'BOUNDARY_CURVE',
    OTBNCR: 'OUTER_BOUNDARY_CURVE', OFCR2D: 'OFFSET_CURVE_2D', OFCR3D: 'OFFSET_CURVE_3D', DFNRPR: 'DEFINITIONAL_REPRESENTATION',
}));
const fullName = s => (s.length <= 6 && SHORT_NAMES.get(s)) || s;

function isSpace(c) { return c === 32 || c === 10 || c === 13 || c === 9; }
function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function isDigit(c) { return c >= 48 && c <= 57; }

const POW10 = [];
for (let i = 0; i <= 22; i++) POW10.push(Math.pow(10, i));

// Finds the start of the DATA section ("DATA;")
export function findData(bytes) {
    const n = bytes.length;
    for (let i = 0; i < n - 5; i++) {
        if (bytes[i] === 68 && bytes[i + 1] === 65 && bytes[i + 2] === 84 && bytes[i + 3] === 65) {
            let j = i + 4;
            while (j < n && isSpace(bytes[j])) j++;
            if (bytes[j] === C_SEMI && (i === 0 || !isLetter(bytes[i - 1]))) return j + 1;
        }
        // skip strings in the header
        if (bytes[i] === C_QUOTE) {
            i++;
            while (i < n && bytes[i] !== C_QUOTE) i++;
        }
    }
    return 0;
}

/**
 * Builds the offset index. Returns { offsets: Int32Array|Float64Array, maxId, typeIds: {TYPE: number[]} }.
 * offsets[id] = byte position of the entity body, -1 if not present. Files of 2 GB and more need
 * 64-bit positions (Float64Array, exact up to 2^53), otherwise Int32Array suffices (half the memory).
 * @param {Uint8Array} bytes
 * @param {string[]} collectTypes type names whose ids should be collected
 * @param {boolean} shared create the index in a SharedArrayBuffer
 */
export function buildIndex(bytes, collectTypes = [], shared = false) {
    const part = scanEntities(bytes, findData(bytes), bytes.length, collectTypes);
    return mergeIndex([part], bytes.length, collectTypes, shared);
}

// Offsets type for a file of n bytes
const offsetsType = n => (n > 0x7fffffff ? Float64Array : Int32Array);

/**
 * The scan of buildIndex over a part of the data: entities whose '#' lies before `stop`, starting at `start` (outside of
 * any entity – the data start, or a start found by resyncEntity). The last entity is read to its ';' even beyond stop.
 * Returns { ids, offs, count, maxId, typeIds, start, stop, end, ended }: end = where the scan stopped (outside of any entity,
 * ≥ stop unless the data ended – ENDSEC: ended), so a sequential scan would go on at end.
 * Several parts in order (each starting where the previous one ended) give exactly the index of one scan (mergeIndex).
 */
export function scanEntities(bytes, start, stop, collectTypes = []) {
    const n = bytes.length;
    const collect = new Set(collectTypes);
    const typeIds = {};
    for (const t of collectTypes) typeIds[t] = [];
    // collect ids and offsets in growing buffers first
    const Offsets = offsetsType(n);
    let ids = new Int32Array(1 << 16), offs = new Offsets(1 << 16), count = 0, maxId = 0;
    let pos = start, ended = false;

    while (pos < n) {
        if (pos >= stop) break;
        const c = bytes[pos];
        if (c === C_HASH) {
            pos++;
            let id = 0;
            while (pos < n && isDigit(bytes[pos])) id = id * 10 + (bytes[pos++] - 48);
            while (pos < n && isSpace(bytes[pos])) pos++;
            if (bytes[pos] !== C_EQ) continue;
            pos++;
            while (pos < n && isSpace(bytes[pos])) pos++;
            if (count === ids.length) {
                const ni = new Int32Array(count * 2); ni.set(ids); ids = ni;
                const no = new Offsets(count * 2); no.set(offs); offs = no;
            }
            ids[count] = id; offs[count] = pos; count++;
            if (id > maxId) maxId = id;

            if (collect.has('COMPLEX') && bytes[pos] === C_LPAR) typeIds.COMPLEX.push(id);
            else if (collect.size && isLetter(bytes[pos])) {
                let s = '';
                let p = pos;
                while (p < n && (isLetter(bytes[p]) || isDigit(bytes[p]))) s += String.fromCharCode(bytes[p++]);
                s = fullName(s.toUpperCase());
                if (collect.has(s)) typeIds[s].push(id);
            }

            // jump to the terminating ';' (respecting strings)
            while (pos < n) {
                const d = bytes[pos];
                if (d === C_QUOTE) {
                    pos++;
                    while (pos < n) {
                        if (bytes[pos] === C_QUOTE) {
                            if (bytes[pos + 1] === C_QUOTE) { pos += 2; continue; }
                            break;
                        }
                        pos++;
                    }
                    pos++;
                } else if (d === C_SEMI) { pos++; break; }
                else pos++;
            }
        } else if (c === C_SLASH && bytes[pos + 1] === C_STAR) {
            pos = skipComment(bytes, pos);
        } else if (isEndsec(bytes, pos)) {
            ended = true;
            break;
        } else {
            pos++;
        }
    }
    if (pos >= n) ended = true;
    return { ids: ids.slice(0, count), offs: offs.slice(0, count), count, maxId, typeIds, start, stop, end: pos, ended };
}

const skipComment = (bytes, pos) => {
    const n = bytes.length;
    pos += 2;
    while (pos < n - 1 && !(bytes[pos] === C_STAR && bytes[pos + 1] === C_SLASH)) pos++;
    return pos + 2;
};
const isEndsec = (bytes, pos) => bytes[pos] === 69 && bytes[pos + 1] === 78 && bytes[pos + 2] === 68 && bytes[pos + 3] === 83;

/**
 * Where a sequential scan that stands at `pos` (outside of any entity) finds its next entity: the next '#' outside of
 * comments – or -1 if the data end (ENDSEC, end of file) comes first.
 */
export function nextEntity(bytes, pos) {
    const n = bytes.length;
    while (pos < n) {
        const c = bytes[pos];
        if (c === C_HASH) return pos;
        if (c === C_SLASH && bytes[pos + 1] === C_STAR) pos = skipComment(bytes, pos);
        else if (isEndsec(bytes, pos)) return -1;
        else pos++;
    }
    return -1;
}

/**
 * A likely entity start at or after `from` for a scan of a part of the file: '#' digits '=' right after a ';' (only
 * whitespace between). A string can contain the same – the caller checks it against the end of the previous part
 * (nextEntity) and scans the part again from the right place if it does not fit. n if there is none.
 */
export function resyncEntity(bytes, from) {
    const n = bytes.length;
    for (let p = from; p < n; p++) {
        if (bytes[p] !== C_HASH) continue;
        let q = p + 1;
        if (!isDigit(bytes[q])) continue;
        while (q < n && isDigit(bytes[q])) q++;
        while (q < n && isSpace(bytes[q])) q++;
        if (bytes[q] !== C_EQ) continue;
        let b = p - 1;
        while (b >= 0 && isSpace(bytes[b])) b--;
        if (b >= 0 && bytes[b] === C_SEMI) return p;
    }
    return n;
}

/**
 * Index from parts scanned in parallel (one per worker, the first from the data start, the others from resyncEntity):
 * each part must start where a sequential scan would find the next entity after the previous part's end – otherwise
 * (its start lay in a string, or the previous part's last entity reaches into it) it is scanned again from there, or
 * left out if that entity covers it completely. The result is the same as buildIndex. rescans = parts scanned again.
 */
export function indexFromParts(bytes, parts, collectTypes = [], shared = false) {
    const used = [parts[0]];
    let { end, ended } = parts[0], rescans = 0;
    for (let k = 1; k < parts.length && !ended; k++) {
        const want = nextEntity(bytes, end);
        if (want < 0) break;
        let p = parts[k];
        if (want >= p.stop) continue;
        if (p.start !== want) { p = scanEntities(bytes, want, p.stop, collectTypes); rescans++; }
        used.push(p);
        ({ end, ended } = p);
    }
    return { ...mergeIndex(used, bytes.length, collectTypes, shared), rescans };
}

/** Offsets table from scanned parts in file order (scanEntities) – later duplicates win, as in one scan */
export function mergeIndex(parts, nBytes, collectTypes = [], shared = false) {
    const Offsets = offsetsType(nBytes);
    let maxId = 0, count = 0;
    for (const p of parts) { if (p.maxId > maxId) maxId = p.maxId; count += p.count; }
    // shared with cross-origin isolation: postMessage to the workers then does not copy
    const size = (maxId + 1) * Offsets.BYTES_PER_ELEMENT;
    const buf = shared && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
    const offsets = new Offsets(buf);
    offsets.fill(-1);
    for (const p of parts) for (let i = 0; i < p.count; i++) offsets[p.ids[i]] = p.offs[i];
    const typeIds = {};
    for (const t of collectTypes) typeIds[t] = parts.length === 1 ? parts[0].typeIds[t] : parts.flatMap(p => p.typeIds[t] || []);
    return { offsets, maxId, count, typeIds };
}

// --- Entity-Parser ---

export class StepFile {
    /**
     * @param {Uint8Array} bytes
     * @param {Int32Array} offsets
     */
    constructor(bytes, offsets) {
        this.bytes = bytes;
        this.offsets = offsets;
        this.cache = new Map();
        // Upper limit of the entity cache: for large files (millions of entities) it would otherwise
        // hold the whole file as JS objects (>1 GB per worker). When it is full, it is cleared;
        // callers keep the entities they need as direct references anyway.
        this.cacheLimit = 250000;
        this.pos = 0;
    }

    has(id) {
        return id >= 0 && id < this.offsets.length && this.offsets[id] >= 0;
    }

    /** Returns { id, type, args } or for complex entities { id, type: 'COMPLEX', parts: {NAME: args} } */
    get(id) {
        if (id instanceof Ref) id = id.id;
        let e = this.cache.get(id);
        if (e !== undefined) return e;
        if (!this.has(id)) return null;
        this.pos = this.offsets[id];
        e = this.parseEntity();
        e.id = id;
        if (this.cache.size >= this.cacheLimit) this.cache.clear();
        this.cache.set(id, e);
        return e;
    }

    /** Type of an entity without parsing it ('COMPLEX' for complex entities, null if missing) – e.g. a large spline surface */
    typeOf(id) {
        if (id instanceof Ref) id = id.id;
        const e = this.cache.get(id);
        if (e !== undefined) return e.type;
        if (!this.has(id)) return null;
        this.pos = this.offsets[id];
        this.skipWs();
        if (this.bytes[this.pos] === C_LPAR) return 'COMPLEX';
        return this.readKeyword();
    }

    skipWs() {
        const b = this.bytes;
        let p = this.pos;
        for (;;) {
            const c = b[p];
            if (c === 32 || c === 10 || c === 13 || c === 9) p++;
            else if (c === C_SLASH && b[p + 1] === C_STAR) {
                p += 2;
                while (p < b.length - 1 && !(b[p] === C_STAR && b[p + 1] === C_SLASH)) p++;
                p += 2;
            } else break;
        }
        this.pos = p;
    }

    readKeyword() {
        const b = this.bytes;
        let p = this.pos, s = '';
        while (isLetter(b[p]) || isDigit(b[p]) || b[p] === C_MINUS) s += String.fromCharCode(b[p++]);
        this.pos = p;
        return fullName(s.toUpperCase());
    }

    parseEntity() {
        this.skipWs();
        if (this.bytes[this.pos] === C_LPAR) {
            // complex entity: (A(...) B(...) ...)
            this.pos++;
            const parts = {};
            for (;;) {
                this.skipWs();
                if (this.bytes[this.pos] === C_RPAR) { this.pos++; break; }
                const name = this.readKeyword();
                if (!name) throw new Error('STEP: invalid complex entity at byte ' + this.pos);
                this.skipWs();
                parts[name] = this.parseList();
            }
            return { type: 'COMPLEX', parts, args: null };
        }
        const type = this.readKeyword();
        this.skipWs();
        const args = this.parseList();
        return { type, args };
    }

    parseList() {
        const b = this.bytes;
        if (b[this.pos] !== C_LPAR) throw new Error('STEP: "(" expected at byte ' + this.pos);
        this.pos++;
        const out = [];
        this.skipWs();
        if (b[this.pos] === C_RPAR) { this.pos++; return out; }
        for (;;) {
            this.skipWs();
            out.push(this.parseValue());
            this.skipWs();
            const c = b[this.pos];
            if (c === C_COMMA) { this.pos++; continue; }
            if (c === C_RPAR) { this.pos++; return out; }
            throw new Error('STEP: "," or ")" expected at byte ' + this.pos);
        }
    }

    parseValue() {
        const b = this.bytes;
        const c = b[this.pos];
        if (c === C_HASH) {
            let p = this.pos + 1, id = 0;
            while (isDigit(b[p])) id = id * 10 + (b[p++] - 48);
            this.pos = p;
            return new Ref(id);
        }
        if (isDigit(c) || c === C_MINUS || c === C_PLUS || c === C_DOT && isDigit(b[this.pos + 1])) return this.parseNumber();
        if (c === C_QUOTE) return this.parseString();
        if (c === C_LPAR) return this.parseList();
        if (c === C_DOLLAR || c === C_STAR) { this.pos++; return null; }
        if (c === C_DOT) {
            let p = this.pos + 1, s = '';
            while (b[p] !== C_DOT && p < b.length) s += String.fromCharCode(b[p++]);
            this.pos = p + 1;
            s = s.toUpperCase();
            if (s === 'T') return true;
            if (s === 'F') return false;
            if (s === 'U') return null;
            return new Enum(s);
        }
        if (c === 34) { // "..." binary
            let p = this.pos + 1;
            while (b[p] !== 34) p++;
            this.pos = p + 1;
            return null;
        }
        if (isLetter(c)) {
            const type = this.readKeyword();
            this.skipWs();
            return { type, args: this.parseList() };
        }
        throw new Error('STEP: unexpected character "' + String.fromCharCode(c) + '" at byte ' + this.pos);
    }

    parseNumber() {
        const b = this.bytes;
        let p = this.pos, neg = false;
        if (b[p] === C_MINUS) { neg = true; p++; } else if (b[p] === C_PLUS) p++;
        let mant = 0, digits = 0, exp = 0;
        while (isDigit(b[p])) {
            if (digits < 17) { mant = mant * 10 + (b[p] - 48); digits++; } else exp++;
            p++;
        }
        if (b[p] === C_DOT) {
            p++;
            while (isDigit(b[p])) {
                if (digits < 17) { mant = mant * 10 + (b[p] - 48); digits++; exp--; }
                p++;
            }
        }
        if (b[p] === 69 || b[p] === 101) { // E/e
            p++;
            let eneg = false, e = 0;
            if (b[p] === C_MINUS) { eneg = true; p++; } else if (b[p] === C_PLUS) p++;
            while (isDigit(b[p])) e = e * 10 + (b[p++] - 48);
            exp += eneg ? -e : e;
        }
        this.pos = p;
        let v;
        if (exp === 0) v = mant;
        else if (exp < 0 && exp >= -22) v = mant / POW10[-exp];
        else if (exp > 0 && exp <= 22) v = mant * POW10[exp];
        else v = mant * Math.pow(10, exp);
        return neg ? -v : v;
    }

    parseString() {
        const b = this.bytes;
        const start = this.pos + 1;
        let p = start, s = '', high = false;
        for (;;) {
            const c = b[p];
            if (c === undefined) break;
            if (c === C_QUOTE) {
                if (b[p + 1] === C_QUOTE) { s += "'"; p += 2; continue; }
                p++;
                break;
            }
            if (c >= 0x80) high = true;
            s += String.fromCharCode(c);
            p++;
        }
        this.pos = p;
        // The standard wants ASCII with \X2\ escapes, but many exporters (FreeCAD, …) write raw UTF-8:
        // read as one char per byte it became 'NorÃ©e'. Valid UTF-8 → decode it, otherwise Latin-1.
        // (slice: TextDecoder rejects views on a SharedArrayBuffer)
        if (high) {
            try { s = UTF8.decode(b.slice(start, b[p - 1] === C_QUOTE ? p - 1 : p)).replace(/''/g, "'"); } catch { /* not UTF-8: keep Latin-1 */ }
        }
        return s.indexOf('\\') >= 0 ? decodeStepString(s) : s;
    }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Decodes STEP escapes: \X2\00E4\X0\ (UCS-2), \X\E4 (ISO-8859-1), \S\x, \\
export function decodeStepString(s) {
    return s
        .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
            let out = '';
            for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
            return out;
        })
        .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
            let out = '';
            for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.substr(i, 8), 16));
            return out;
        })
        .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\S\\(.)/g, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 128))
        .replace(/\\\\/g, '\\');
}

// Helper functions for complex entities
export function partArgs(e, name) {
    if (!e) return null;
    if (e.type === name) return e.args;
    if (e.type === 'COMPLEX') return e.parts[name] || null;
    return null;
}

export function hasPart(e, name) {
    return e && (e.type === name || (e.type === 'COMPLEX' && name in e.parts));
}
