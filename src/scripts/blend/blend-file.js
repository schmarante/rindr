// .blend file access (Blender's own format, self-describing): header, blocks, SDNA, typed struct reading.
//
// Header (12 bytes): "BLENDER", pointer size ('_' 4 / '-' 8), endianness ('v' little / 'V' big), version "404".
// (Newer files may start "BLENDER17-01v0405": header length, format version – read as well.)
// Blocks: code (4 chars: "OB\0\0", "ME\0\0", "DATA", "DNA1", "ENDB" …), i32 length, old pointer (4/8), i32 SDNA struct
// index, i32 count, then the data. Pointers in the data are the old addresses → blocks by their old pointer.
// SDNA ("DNA1"): "SDNA", "NAME" n + names ("*next", "co[3]", "(*func)()" …), "TYPE" n + type names, "TLEN" n × i16,
// "STRC" n × (i16 type, i16 field count, fields: i16 type, i16 name) – each section 4-aligned.

const TEXT = new TextDecoder();

export function isBlendFile(bytes) {
    return bytes.length > 12 && TEXT.decode(bytes.subarray(0, 7)) === 'BLENDER';
}

export class BlendFile {
    /** @param {Uint8Array} bytes */
    constructor(bytes) {
        this.bytes = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let p = 7;
        if (bytes[p] === 0x31 || bytes[p] === 0x32) {
            // "BLENDER17-01v0405": header size, '-', format version, endianness, version
            const head = TEXT.decode(bytes.subarray(0, 17));
            this.headerSize = +head.slice(7, 9);
            this.ptr = 8;
            this.little = head[12] === 'v';
            this.version = +head.slice(13, 17);
            this.bheadSize = 4 + 4 + 8 + 8 + 8;   // code, sdna, old pointer, length (i64), count (i64)
            this.large = true;
            p = this.headerSize;
        } else {
            this.ptr = bytes[7] === 0x2d ? 8 : 4;
            this.little = bytes[8] === 0x76;
            this.version = +TEXT.decode(bytes.subarray(9, 12));
            this.bheadSize = 4 + 4 + this.ptr + 4 + 4;
            this.large = false;
            p = 12;
        }
        this.blocks = [];
        this.byPointer = new Map();
        const n = bytes.length;
        while (p + this.bheadSize <= n) {
            const code = TEXT.decode(bytes.subarray(p, p + 4)).replace(/\0+$/, '');
            let len, old, sdna, count;
            if (this.large) {
                sdna = this.i32(p + 4); old = this.pointerAt(p + 8); len = Number(this.dv.getBigInt64(p + 16, this.little)); count = Number(this.dv.getBigInt64(p + 24, this.little));
            } else {
                len = this.i32(p + 4); old = this.pointerAt(p + 8); sdna = this.i32(p + 8 + this.ptr); count = this.i32(p + 12 + this.ptr);
            }
            const data = p + this.bheadSize;
            const block = { code, len, old, sdna, count, data };
            if (code === 'ENDB') break;
            this.blocks.push(block);
            if (old) this.byPointer.set(old, block);
            p = data + len;
        }
        const dna = this.blocks.find(b => b.code === 'DNA1');
        if (!dna) throw new Error('blend: no DNA');
        this.readDna(dna);
    }

    i16(p) { return this.dv.getInt16(p, this.little); }
    i32(p) { return this.dv.getInt32(p, this.little); }
    f32(p) { return this.dv.getFloat32(p, this.little); }
    // pointers as strings of their hex value (64-bit addresses beyond Number precision)
    pointerAt(p) {
        if (this.ptr === 4) { const v = this.dv.getUint32(p, this.little); return v ? v.toString(16) : null; }
        const lo = this.dv.getUint32(p + (this.little ? 0 : 4), this.little), hi = this.dv.getUint32(p + (this.little ? 4 : 0), this.little);
        return lo || hi ? hi.toString(16) + lo.toString(16).padStart(8, '0') : null;
    }

    readDna(block) {
        let p = block.data;
        const tag = () => { const s = TEXT.decode(this.bytes.subarray(p, p + 4)); p += 4; return s; };
        const start = p;
        const align = () => { p = start + ((p - start + 3) & ~3); };   // relative to the block – it need not start 4-aligned
        const strings = count => {
            const out = [];
            for (let i = 0; i < count; i++) {
                let e = p;
                while (this.bytes[e] !== 0) e++;
                out.push(TEXT.decode(this.bytes.subarray(p, e)));
                p = e + 1;
            }
            return out;
        };
        if (tag() !== 'SDNA') throw new Error('blend: bad DNA');
        tag(); const nNames = this.i32(p); p += 4; const names = strings(nNames); align();
        tag(); const nTypes = this.i32(p); p += 4; const types = strings(nTypes); align();
        tag(); const lens = []; for (let i = 0; i < types.length; i++) { lens.push(this.i16(p)); p += 2; } align();
        tag(); const nStructs = this.i32(p); p += 4;
        this.types = types;
        this.typeLen = lens;
        this.structs = [];
        this.structByName = new Map();
        for (let s = 0; s < nStructs; s++) {
            const type = this.i16(p), nf = this.i16(p + 2);
            p += 4;
            const fields = new Map();
            let off = 0;
            for (let f = 0; f < nf; f++) {
                const ft = this.i16(p), fn = this.i16(p + 2);
                p += 4;
                const raw = names[fn];
                const isPtr = raw.startsWith('*') || raw.startsWith('(*');
                const name = raw.replace(/^[*(]+/, '').replace(/\).*$/, '').replace(/\[.*$/, '');
                const dims = [...raw.matchAll(/\[(\d+)\]/g)].map(m => +m[1]);
                const count = dims.reduce((a, b) => a * b, 1);
                const size = (isPtr ? this.ptr : lens[ft]) * count;
                fields.set(name, { type: types[ft], isPtr, ptrDepth: (raw.match(/^\*+/) || [''])[0].length, dims, count, offset: off, size });
                off += size;
            }
            const st = { name: types[type], size: lens[type], fields };
            this.structs.push(st);
            this.structByName.set(st.name, st);
        }
    }

    /** blocks of a code ("OB", "ME" …) */
    blocksOf(code) { return this.blocks.filter(b => b.code === code); }

    /** struct view of the i-th element of a block (by its own SDNA type, or a given struct name) */
    view(block, i = 0, structName = null) {
        if (!block) return null;
        const st = structName ? this.structByName.get(structName) : this.structs[block.sdna];
        return st ? new View(this, st, block.data + i * st.size, block) : null;
    }

    /** the block an old pointer points to */
    deref(ptr) { return ptr ? this.byPointer.get(ptr) ?? null : null; }
}

// a struct at an address: typed field access by name
class View {
    constructor(file, st, at, block) { this.f = file; this.st = st; this.at = at; this.block = block; }
    has(name) { return this.st.fields.has(name); }
    field(name) { return this.st.fields.get(name); }
    int(name, i = 0) {
        const fd = this.field(name);
        if (!fd) return undefined;
        const p = this.at + fd.offset;
        switch (fd.type) {
            case 'char': case 'uchar': case 'int8_t': case 'uint8_t': case 'bool': return this.f.bytes[p + i];
            case 'short': case 'int16_t': case 'ushort': case 'uint16_t': return this.f.i16(p + i * 2);
            case 'int': case 'int32_t': case 'uint': case 'uint32_t': return this.f.i32(p + i * 4);
            case 'int64_t': case 'uint64_t': return Number(this.f.dv.getBigInt64(p + i * 8, this.f.little));
            default: return this.f.i32(p + i * 4);
        }
    }
    float(name, i = 0) {
        const fd = this.field(name);
        if (!fd) return undefined;
        return fd.type === 'double' ? this.f.dv.getFloat64(this.at + fd.offset + i * 8, this.f.little) : this.f.f32(this.at + fd.offset + i * 4);
    }
    floats(name) {
        const fd = this.field(name);
        if (!fd) return null;
        const out = new Array(fd.count);
        for (let i = 0; i < fd.count; i++) out[i] = this.float(name, i);
        return out;
    }
    string(name) {
        const fd = this.field(name);
        if (!fd) return '';
        const p = this.at + fd.offset;
        let e = p;
        while (e < p + fd.size && this.f.bytes[e] !== 0) e++;
        return TEXT.decode(this.f.bytes.subarray(p, e));
    }
    pointer(name, i = 0) {
        const fd = this.field(name);
        return fd ? this.f.pointerAt(this.at + fd.offset + i * this.f.ptr) : null;
    }
    /** nested struct (embedded, not a pointer) */
    sub(name) {
        const fd = this.field(name);
        if (!fd || fd.isPtr) return null;
        const st = this.f.structByName.get(fd.type);
        return st ? new View(this.f, st, this.at + fd.offset, this.block) : null;
    }
    /** struct behind a pointer field (its block, element 0), typed by the block or the field's type */
    deref(name, structName = null) {
        const b = this.f.deref(this.pointer(name));
        if (!b) return null;
        const fd = this.field(name);
        return this.f.view(b, 0, structName ?? (this.f.structByName.has(fd.type) ? fd.type : null));
    }
}
