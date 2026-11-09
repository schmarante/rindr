// DWG container reader: a DWG file (R13 … R2018) → its sections as plain byte arrays, decompressed. Lowest layer of the
// DWG reader; the bit reader and the object parser work on the section data. Runs in the CAD worker (no dependencies).
//
// The first 6 bytes name the version (AC1012 R13, AC1014 R14, AC1015 R2000, AC1018 R2004, AC1021 R2007, AC1024 R2010,
// AC1027 R2013, AC1032 R2018); the code page is a raw short at 0x13 in all versions. There are three container layouts:
//
// R13–R15 (AC1012–AC1015): no compression. At 0x15 a long gives the number of section locator records (from 0x19,
// 9 bytes each: record number, absolute file offset, size). Record 0 is the header variables, 1 the classes, 2 the
// object map, 3 a small unnamed table (R13 C3 and later), 4 the template (MEASUREMENT), 5 the auxiliary header (R2000),
// unused records have size 0. Objects lie between them in the file; the object map holds absolute file offsets, so
// 'AcDb:AcDbObjects' is the whole file. A second copy of the locator records sits near the end of the file (second file
// header) – used when the first one is damaged.
//
// R2004, R2010, R2013, R2018 (AC1018, AC1024, AC1027, AC1032): the file is cut into pages, starting at 0x100. At 0x80
// lie 0x6C bytes of file header data, XOR-ed with a fixed pseudo-random sequence: they point to two system pages – the
// page map (number and size of every page; page addresses follow by adding up the sizes) and the section map (per
// section: name, size, page size, compression, and its pages with their start offsets in the section). A system page
// has a plain 0x14-byte header, a data page a 0x20-byte header XOR-ed with a mask that depends on its file address.
// Page data is compressed with an LZ77 variant (opcodes for back references and literal runs, see decompress18); each
// page is decompressed on its own. Pages of only zeroes are not written (gaps in the start offsets stay zero).
//
// R2007 (AC1021): like R2004 in principle, but the file header, the system pages and the data pages are Reed-Solomon
// encoded (stored interleaved) and use another LZ77 variant (decompress21). The error correction itself is skipped – a
// Reed-Solomon block stores its data bytes unchanged, the parity bytes are only dropped.
//
// What the section data starts with (sentinels and size fields are kept, the parser checks them):
// - 'AcDb:Header': 16-byte sentinel CF 7B 1F 23 …, RL size, then the bit-coded header variables, CRC, end sentinel.
//   R2010+: one more RL after the size (the specification ties it to maintenance version > 3; it was there in every
//   file seen so far, whatever byte 0x0B said). The section may be longer than its content (padding after the end).
// - 'AcDb:Classes': 16-byte sentinel 8D A1 C4 B8 …, RL size (R2010+: one more RL), class data, CRC, end sentinel
//   (R2004+: 8 more bytes after it). Header and classes CRC: 16-bit, start value 0xC0C1, from the size to the CRC.
// - 'AcDb:Handles' (object map): blocks of [2-byte big-endian block size, pairs of modular chars (handle delta, offset
//   delta – both start from 0 again in every block), 2-byte big-endian CRC of size and pairs]; the last block has
//   size 2. Offsets: R13–R15 absolute in the file, R2004+ relative to the start of 'AcDb:AcDbObjects'.
// - 'AcDb:AcDbObjects': R13–R15 the whole file; R2004+ starts with an RL 0x0DCA, the objects follow back to back
//   (each: modular short size, R2010+ a modular char handle stream size in bits – not counted in the size –, object
//   data, 2-byte CRC from the first size byte on, start value 0xC0C1).
// - 'AcDb:Template': RS description length, description bytes, RS MEASUREMENT (R13–R15: the record may be empty).
// - 'AcDb:Unknown3' (R13–R15): the unnamed 53-byte table of record 3.
// - Other R2004+ sections ('AcDb:SummaryInfo', 'AcDb:Preview', 'AcDb:AuxHeader', 'AcDb:AcDsPrototype_1b', …) as stored.
//
// Checksums and CRCs are not verified. Damaged files are read as far as possible: short or missing pages leave zeroes.
// Big files: each section is decompressed straight into one Uint8Array of its final size; R13–R15 sections are views
// into the file bytes (no copy).

const HEADER_SENTINEL = [0xCF, 0x7B, 0x1F, 0x23, 0xFD, 0xDE, 0x38, 0xA9, 0x5F, 0x7C, 0x68, 0xB8, 0x4E, 0x6D, 0x33,
    0x5F];
const SECOND_HEADER_SENTINEL = [0xD4, 0x7B, 0x21, 0xCE, 0x28, 0x93, 0x9F, 0xBF, 0x53, 0x24, 0x40, 0x09, 0x12, 0x3C,
    0xAA, 0x01];

// R13–R15 section locator record number → section name (record 5, R2000: the auxiliary header, same data as the
// R2004+ section of that name)
const R13_NAMES = ['AcDb:Header', 'AcDb:Classes', 'AcDb:Handles', 'AcDb:Unknown3', 'AcDb:Template', 'AcDb:AuxHeader'];

const R13_VERSIONS = new Set(['AC1012', 'AC1014', 'AC1015']);
const R2004_VERSIONS = new Set(['AC1018', 'AC1024', 'AC1027', 'AC1032']);

// R2004+ page types
const PAGE_MAP_TYPE = 0x41630E3B;
const SECTION_MAP_TYPE = 0x4163003B;
const DATA_PAGE_TYPE = 0x4163043B;
const DATA_PAGE_MASK = 0x4164536B;
const FILE_ID = 'AcFssFcAJMB';

// sections without which the drawing can't be read (damage elsewhere only drops the section)
const ESSENTIAL = ['AcDb:Header', 'AcDb:Classes', 'AcDb:Handles', 'AcDb:AcDbObjects'];

/**
 * @param {Uint8Array} bytes the whole DWG file
 * @returns {{ version: string, codepage: number, maintenanceVersion: number, sections: Map<string, Uint8Array>,
 *             objectsBase: number }} sections by name ('AcDb:Header', 'AcDb:Classes', 'AcDb:Handles',
 *             'AcDb:AcDbObjects', …); object offsets of the object map are relative to the start of 'AcDb:AcDbObjects'
 *             plus objectsBase (always 0: R13–R15 the section is the whole file, R2004+ the offsets are
 *             section-relative).
 *             maintenanceVersion: byte 0x0B as stored (in practice not reliable – see 'AcDb:Header' above).
 */
export function readDwgSections(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('DWG: expected the file as Uint8Array');
    if (bytes.length < 0x40) throw new Error('Not a DWG file (too short)');
    const version = String.fromCharCode(...bytes.subarray(0, 6));
    if (!/^AC\d{4}$/.test(version)) throw new Error('Not a DWG file (no version signature)');
    const base = { version, codepage: u16(bytes, 0x13), maintenanceVersion: bytes[0x0B], objectsBase: 0 };
    if (R13_VERSIONS.has(version)) return { ...base, sections: readR13(bytes) };
    if (R2004_VERSIONS.has(version)) return { ...base, sections: readR2004(bytes) };
    if (version === 'AC1021') return { ...base, sections: readR2007(bytes) };
    const n = +version.slice(2);
    if (n < 1012) throw new Error(`DWG version ${version} (before R13) is not supported`);
    // newer than R2018: the container has stayed the same since R2010 – try it
    if (bytes.length >= 0x100 && checkR2004Header(bytes)) return { ...base, sections: readR2004(bytes) };
    throw new Error(`DWG version ${version} is not supported`);
}

// ---------------------------------------------------------------------------------------------------------------------
// little-endian helpers

function u16(b, o) {
    return b[o] | b[o + 1] << 8;
}

function u32(b, o) {
    return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
}

function i32(b, o) {
    return b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
}

// unsigned 64-bit value as Number (exact up to 2^53)
function u64(b, o) {
    return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

function matches(b, o, pattern) {
    if (o < 0 || o + pattern.length > b.length) return false;
    for (let i = 0; i < pattern.length; i++) if (b[o + i] !== pattern[i]) return false;
    return true;
}

// bytes [offset, offset + size) of the file: a view if inside the file, else a zero-filled copy of what exists
function fileRange(bytes, offset, size) {
    if (offset + size <= bytes.length) return bytes.subarray(offset, offset + size);
    const out = new Uint8Array(size);
    if (offset < bytes.length) out.set(bytes.subarray(offset));
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// R13–R15

function readR13(bytes) {
    // first header; if its records don't check out the copy in the second header; else the first as it is
    const records = readLocatorRecords(bytes, true) ?? readSecondHeaderRecords(bytes)
        ?? readLocatorRecords(bytes, false);
    if (!records) {
        const map = u32(bytes, 0x19 + 2 * 9 + 1);
        if (bytes[0x19 + 2 * 9] === 2 && map >= bytes.length && map < bytes.length * 4) {
            throw new Error('DWG file truncated (object map missing)');
        }
        throw new Error('DWG file header damaged (no valid section locator records)');
    }
    const sections = new Map();
    for (const { recno, seeker, size } of records) {
        if (!size) continue;                                     // optional record not used
        const name = R13_NAMES[recno] ?? `AcDb:Unknown${recno}`;
        if (sections.has(name)) continue;
        sections.set(name, fileRange(bytes, seeker, size));
    }
    if (!sections.has('AcDb:Handles')) throw new Error('DWG file without object map');
    sections.set('AcDb:AcDbObjects', bytes);
    return sections;
}

// locator records of the file header (record number, offset, size); strict: null unless they check out (header
// sentinel at record 0, object map inside the file), else null only if they can't be records at all
function readLocatorRecords(bytes, strict) {
    const count = u32(bytes, 0x15);
    if (count < 3 || count > 16 || 0x19 + count * 9 > bytes.length) return null;
    const records = [];
    for (let i = 0; i < count; i++) {
        const o = 0x19 + i * 9;
        records.push({ recno: bytes[o], seeker: u32(bytes, o + 1), size: u32(bytes, o + 5) });
    }
    if (strict) return validRecords(bytes, records) ? records : null;
    const map = records.find((r) => r.recno === 2);
    return map && map.size && map.seeker < bytes.length ? records : null;
}

function validRecords(bytes, records) {
    const header = records.find((r) => r.recno === 0), map = records.find((r) => r.recno === 2);
    if (!header || !map || !map.size || map.seeker + map.size > bytes.length) return false;
    return matches(bytes, header.seeker, HEADER_SENTINEL);
}

// second file header (R13–R15, after the object map): sentinel, RL size, then bit-coded: BL own address, version
// string, zero bytes and fixed bytes, then the records as RC number, BL address, BL size (0 header, 1 classes,
// 2 object map, 3 unknown table, …), then the handle records. In the files seen so far the records start 182 bits
// after the size; a few bit positions around it are tried, each result has to check out.
function readSecondHeaderRecords(bytes) {
    for (let s = bytes.length - 16; s >= 0x19; s--) {
        if (bytes[s] !== SECOND_HEADER_SENTINEL[0] || !matches(bytes, s, SECOND_HEADER_SENTINEL)) continue;
        const bits = (s + 20) * 8;
        for (let d = 0; d <= 64; d++) {
            for (const bit of [bits + 182 - d, bits + 182 + d]) {
                const records = bitRecords(bytes, bit);
                if (records && validRecords(bytes, records)) return records;
            }
        }
    }
    return null;
}

// records 0, 1, 2, … (RC number, BL address, BL size) from bit position bit, MSB first; null if record 0 isn't there
function bitRecords(bytes, bit) {
    const end = bytes.length * 8;
    const readBits = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++, bit++) v = v * 2 + (bit < end ? bytes[bit >> 3] >> (7 - (bit & 7)) & 1 : 0);
        return v;
    };
    // bitlong: 00 four bytes (LSB first), 01 one byte, 10 zero, 11 unused
    const bitLong = () => {
        const code = readBits(2);
        if (code === 0) return readBits(8) + readBits(8) * 0x100 + readBits(8) * 0x10000 + readBits(8) * 0x1000000;
        if (code === 1) return readBits(8);
        return code === 2 ? 0 : -1;
    };
    const records = [];
    for (let i = 0; i < 8; i++) {
        if (readBits(8) !== i) break;
        const seeker = bitLong(), size = bitLong();
        if (seeker < 0 || size < 0) break;
        records.push({ recno: i, seeker, size });
    }
    return records.length >= 3 ? records : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// R2004+ (also R2010, R2013, R2018)

// the 0x6C-byte pseudo-random sequence (linear congruential generator, seed 1) that masks the file header data;
// longer variants also fill the gaps between pages
function magicSequence(length) {
    const out = new Uint8Array(length);
    let seed = 1;
    for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 0x343FD) + 0x269EC3) | 0;
        out[i] = seed >> 16;
    }
    return out;
}

function decryptR2004Header(bytes) {
    const magic = magicSequence(0x6C);
    const h = new Uint8Array(0x6C);
    for (let i = 0; i < 0x6C; i++) h[i] = bytes[0x80 + i] ^ magic[i];
    return h;
}

function checkR2004Header(bytes) {
    const h = decryptR2004Header(bytes);
    return String.fromCharCode(...h.subarray(0, 11)) === FILE_ID;
}

function readR2004(bytes) {
    if (bytes.length < 0x100) throw new Error('DWG file too short');
    const h = decryptR2004Header(bytes);
    if (String.fromCharCode(...h.subarray(0, 11)) !== FILE_ID) {
        throw new Error('DWG file header damaged (wrong file ID)');
    }
    if (u32(bytes, 0x18) & 1) throw new Error('Password-protected DWG files are not supported');
    const pageMapAddress = u64(h, 0x54) + 0x100;
    const sectionMapId = u32(h, 0x5C);

    // page map: page number → file address (1-based numbers; negative numbers are gaps, with 16 more bytes)
    const pageMapData = readSystemPage(bytes, pageMapAddress, PAGE_MAP_TYPE, 'page map');
    const pageAddress = new Map();
    let address = 0x100;
    for (let o = 0; o + 8 <= pageMapData.length;) {
        const number = i32(pageMapData, o), size = u32(pageMapData, o + 4);
        o += 8;
        if (number >= 0) pageAddress.set(number, address);
        else o += 16;
        address += size;
    }

    // section map
    const sectionMapAddress = pageAddress.get(sectionMapId);
    if (sectionMapAddress === undefined) throw new Error('DWG file damaged (section map page missing)');
    const map = readSystemPage(bytes, sectionMapAddress, SECTION_MAP_TYPE, 'section map');
    const count = u32(map, 0);
    const sections = new Map();
    let o = 0x14;
    for (let s = 0; s < count && o + 0x60 <= map.length; s++) {
        const size = u64(map, o);
        const pageCount = u32(map, o + 0x08);
        const pageSize = u32(map, o + 0x0C);
        const compressed = u32(map, o + 0x14);
        const encrypted = u32(map, o + 0x1C);
        let name = '';
        for (let i = 0; i < 64 && map[o + 0x20 + i]; i++) name += String.fromCharCode(map[o + 0x20 + i]);
        o += 0x60;
        const pages = [];
        for (let p = 0; p < pageCount && o + 16 <= map.length; p++, o += 16) {
            pages.push({ number: u32(map, o), dataSize: u32(map, o + 4), start: u64(map, o + 8) });
        }
        if (!name || sections.has(name) || !readable(bytes, name, size, encrypted)) continue;
        sections.set(name, readDataSection(bytes, pageAddress, size, pageSize, compressed === 2, pages));
    }
    return checkSections(sections);
}

// whether a section of the section map can be read; for an essential section an error instead of false
function readable(bytes, name, size, encrypted) {
    let problem = null;
    if (encrypted === 1) problem = 'Encrypted DWG files are not supported';
    else if (size > 0x7FFFFFFF || size > bytes.length * 256 + 0x100000) problem = `DWG file damaged (size of ${name})`;
    if (problem && ESSENTIAL.includes(name)) throw new Error(problem);
    return !problem;
}

function checkSections(sections) {
    if (!sections.has('AcDb:Handles') || !sections.has('AcDb:AcDbObjects')) {
        throw new Error('DWG file damaged (no object map or objects section)');
    }
    return sections;
}

// system page: 0x14-byte header (type, decompressed size, compressed size, compression type, checksum), compressed data
function readSystemPage(bytes, address, type, what) {
    if (address + 0x14 > bytes.length) throw new Error(`DWG file truncated or damaged (${what} outside the file)`);
    if (u32(bytes, address) !== type) throw new Error(`DWG file damaged (${what} not found)`);
    const size = u32(bytes, address + 4), compSize = u32(bytes, address + 8);
    const start = address + 0x14, end = Math.min(bytes.length, start + compSize);
    if (size > 0x10000000) throw new Error(`DWG file damaged (${what} size)`);
    const out = new Uint8Array(size);
    if (u32(bytes, address + 12) === 2) decompress18(bytes, start, end, out, 0, size);
    else out.set(bytes.subarray(start, Math.min(end, start + size)));
    return out;
}

// data section: pages in section map order, each decompressed to its place (start offset) in one array
function readDataSection(bytes, pageAddress, size, pageSize, compressed, pages) {
    const out = new Uint8Array(size);
    const header = new Uint8Array(0x20);
    for (const page of pages) {
        const address = pageAddress.get(page.number);
        if (address === undefined || address + 0x20 > bytes.length) continue;      // missing page → zeroes
        // page header, masked with its file address: type, section number, data size, page size, start offset, …
        const mask = (DATA_PAGE_MASK ^ address) >>> 0;
        for (let i = 0; i < 0x20; i += 4) {
            const v = (u32(bytes, address + i) ^ mask) >>> 0;
            header[i] = v; header[i + 1] = v >>> 8; header[i + 2] = v >>> 16; header[i + 3] = v >>> 24;
        }
        if (u32(header, 0) !== DATA_PAGE_TYPE) continue;
        let dataSize = u32(header, 8);
        if (!dataSize || dataSize > page.dataSize && page.dataSize) dataSize = page.dataSize;
        const start = page.start;
        if (start >= size) continue;
        const end = Math.min(size, start + (pageSize || size - start));
        const src = address + 0x20, srcEnd = Math.min(bytes.length, src + dataSize);
        if (compressed) decompress18(bytes, src, srcEnd, out, start, end);
        else out.set(bytes.subarray(src, Math.min(srcEnd, src + end - start)), start);
    }
    return out;
}

// R2004 compression (LZ77 variant). Reads src[sp, srcEnd), writes dst[dp, dstEnd); back references count from the
// current output position (an offset of 0 means the previous byte). Stops at the end opcode 0x11, at the end of the
// input or when the output is full; returns the output position reached.
function decompress18(src, sp, srcEnd, dst, dp, dstEnd) {
    const dstStart = dp;

    // literal length: 0x01–0x0F → +3; 0x00 → 0x0F + following bytes (0x00 adds 0xFF, else adds and ends) + 3;
    // a byte with a bit in the high nibble means length 0 (the byte is the next opcode, not consumed)
    const literalLength = () => {
        const b = src[sp];
        if (b & 0xF0) return 0;
        sp++;
        if (b) return b + 3;
        let total = 0x0F;
        while (sp < srcEnd) {
            const n = src[sp++];
            if (n) { total += n; break; }
            total += 0xFF;
        }
        return total + 3;
    };
    // long length: 0x01–0xFF as is; 0x00 → 0xFF + following bytes (0x00 adds 0xFF, else adds and ends)
    const longLength = () => {
        const b = src[sp++];
        if (b) return b;
        let total = 0xFF;
        while (sp < srcEnd) {
            const n = src[sp++];
            if (n) { total += n; break; }
            total += 0xFF;
        }
        return total;
    };
    const copyLiteral = (n) => {
        if (n > srcEnd - sp) n = srcEnd - sp;
        if (n > dstEnd - dp) n = dstEnd - dp;
        if (n > 32) dst.set(src.subarray(sp, sp + n), dp);
        else for (let i = 0; i < n; i++) dst[dp + i] = src[sp + i];
        sp += n;
        dp += n;
    };

    copyLiteral(literalLength());
    while (sp < srcEnd && dp < dstEnd) {
        const op = src[sp++];
        if (op === 0x11) break;
        let length, offset, literal;
        if (op >= 0x40) {
            length = (op >> 4) - 1;
            offset = (src[sp++] << 2 | (op & 0x0C) >> 2);
            literal = op & 3;
        } else {
            if (op >= 0x21) length = op - 0x1E;
            else if (op === 0x20) length = longLength() + 0x21;
            else if (op >= 0x10) length = op & 7 ? (op & 7) + 2 : longLength() + 9;
            else break;                                          // 0x00–0x0F: invalid here – damaged data
            const b0 = src[sp++], b1 = src[sp++];
            offset = b0 >> 2 | b1 << 6;
            // 0x10–0x1F: far references, bit 3 of the opcode is the highest offset bit (the specification lists
            // 0x12–0x1F as length (op & 0x0F) + 2 – only true while bit 3 is clear, i.e. for offsets below 0x8000,
            // which covers every data page; larger system pages, e.g. the page map of a big file, use the bit)
            if (op < 0x20) offset += 0x3FFF + ((op & 8) << 11);
            literal = b0 & 3;
        }
        if (!literal) literal = literalLength();
        // back reference (may overlap the bytes it produces)
        const from = dp - offset - 1;
        if (from < dstStart) break;                              // points before the page – damaged data
        if (length > dstEnd - dp) length = dstEnd - dp;
        if (offset + 1 >= length && length > 32) dst.copyWithin(dp, from, from + length);
        else for (let i = 0; i < length; i++) dst[dp + i] = dst[from + i];
        dp += length;
        copyLiteral(literal);
    }
    return dp;
}

// ---------------------------------------------------------------------------------------------------------------------
// R2007
//
// Reed-Solomon blocks of 255 bytes: k data bytes, then 255 − k parity bytes (system pages k = 239, data pages k = 251).
// Interleaved storage of n blocks: byte i of block j at n · i + j. Not interleaved: the data bytes of all blocks first.
// Layout: 0x80 bytes like the R2004 header, at 0x80 the file header page (3 interleaved system blocks, 0x400 bytes with
// check data), pages from 0x480. The file header (after decoding: RL CRC, key, compressed CRC as 3 × 8 bytes, RL
// compressed length – negative: stored as is –, RL unknown, data) decompresses to 0x110 bytes with the page map and
// section map locations. A system page repeats its compressed data (padded to 8 bytes) "correction factor" times
// before the Reed-Solomon coding; the first copy is enough.

const RS_SYSTEM = 239, RS_DATA = 251;

function readR2007(bytes) {
    if (bytes.length < 0x480) throw new Error('DWG file too short');
    if (u32(bytes, 0x18) & 1) throw new Error('Password-protected DWG files are not supported');
    const block = deinterleave(bytes, 0x80, 3, RS_SYSTEM);
    const comprLen = i32(block, 0x18);
    let h;
    if (comprLen < 0) h = block.subarray(0x20, Math.min(block.length, 0x20 - comprLen));
    else {
        h = new Uint8Array(0x110);
        decompress21(block, 0x20, Math.min(block.length, 0x20 + comprLen), h, 0, 0x110);
    }
    if (h.length < 0x110) throw new Error('DWG file header damaged');

    // page map: pairs of 64-bit page size and page id; pages follow each other from 0x480 (negative ids: gaps)
    const pageMap = readSystemPage21(bytes, [0x480 + u64(h, 0x38), 0x480 + u64(h, 0x28)], u64(h, 0x50), u64(h, 0x58),
        u64(h, 0x18), 'page map');
    const pageAddress = new Map();
    let address = 0x480;
    for (let o = 0; o + 16 <= pageMap.length; o += 16) {
        const size = u64(pageMap, o), id = i32(pageMap, o + 8);
        pageAddress.set(Math.abs(id), address);
        address += size;
    }

    // section map: per section 8 × 64-bit values (size, page size, encryption, hash, name length in bytes, unknown,
    // encoding, page count), the name (UTF-16, with terminating zero), then per page 7 × 64-bit values (offset in the
    // section, page size, page id, decompressed size, compressed size, checksum, CRC)
    const mapAddresses = [u64(h, 0xC0), u64(h, 0xB8)].map((id) => pageAddress.get(id)).filter((a) => a !== undefined);
    if (!mapAddresses.length) throw new Error('DWG file damaged (section map page missing)');
    const map = readSystemPage21(bytes, mapAddresses, u64(h, 0xB0), u64(h, 0xC8), u64(h, 0xD8), 'section map');
    const sections = new Map();
    for (let o = 0; o + 0x40 <= map.length;) {
        const size = u64(map, o), encrypted = u64(map, o + 0x10), nameBytes = u64(map, o + 0x20);
        const interleaved = u64(map, o + 0x30) === 4, pageCount = u64(map, o + 0x38);
        o += 0x40;
        if (nameBytes > 0x200 || pageCount > 0x1000000) break;                      // damaged map
        let name = '';
        for (let i = 0; i + 1 < nameBytes && o + i + 1 < map.length; i += 2) {
            const c = u16(map, o + i);
            if (!c) break;
            name += String.fromCharCode(c);
        }
        o += nameBytes;
        const pages = [];
        for (let p = 0; p < pageCount && o + 56 <= map.length; p++, o += 56) {
            pages.push({
                start: u64(map, o), id: u64(map, o + 16), size: u64(map, o + 24), compSize: u64(map, o + 32),
            });
        }
        if (!name || sections.has(name) || !readable(bytes, name, size, encrypted)) continue;
        sections.set(name, readDataSection21(bytes, pageAddress, size, interleaved, pages));
    }
    return checkSections(sections);
}

// Reed-Solomon coded data from address: the data bytes of `blocks` interleaved blocks with k data bytes each
function deinterleave(bytes, address, blocks, k, out = new Uint8Array(blocks * k)) {
    const end = bytes.length;
    for (let j = 0; j < blocks; j++) {
        for (let i = 0, s = address + j, d = j * k; i < k; i++, s += blocks) out[d + i] = s < end ? bytes[s] : 0;
    }
    return out;
}

// system page from the first address that decodes completely (the maps are stored twice)
function readSystemPage21(bytes, addresses, compSize, size, factor, what) {
    if (size > 0x10000000 || compSize > 0x10000000) throw new Error(`DWG file damaged (${what} size)`);
    const aligned = (compSize + 7) & ~7;
    for (const address of addresses) {
        // the block count is also the interleave stride – it must be exact
        const blocks = Math.ceil(aligned * Math.max(1, factor) / RS_SYSTEM);
        if (address + blocks * 255 > bytes.length) continue;
        const data = deinterleave(bytes, address, blocks, RS_SYSTEM);
        if (compSize >= size) return data.slice(0, size);
        const out = new Uint8Array(size);
        if (decompress21(data, 0, Math.min(compSize, data.length), out, 0, size) === size) return out;
    }
    throw new Error(`DWG file truncated or damaged (${what})`);
}

function readDataSection21(bytes, pageAddress, size, interleaved, pages) {
    const out = new Uint8Array(size);
    let data = new Uint8Array(0);
    for (const page of pages) {
        const address = pageAddress.get(page.id);
        if (address === undefined || address >= bytes.length || page.start >= size) continue;    // missing → zeroes
        const length = Math.min(page.size, size - page.start);
        const blocks = Math.ceil(((page.compSize + 7) & ~7) / RS_DATA);
        if (blocks * RS_DATA > 0x4000000) continue;
        if (data.length < blocks * RS_DATA) data = new Uint8Array(blocks * RS_DATA);
        if (interleaved) deinterleave(bytes, address, blocks, RS_DATA, data);
        else data.set(fileRange(bytes, address, blocks * RS_DATA));
        if (page.compSize < page.size) decompress21(data, 0, page.compSize, out, page.start, page.start + length);
        else out.set(data.subarray(0, length), page.start);
    }
    return out;
}

// Literal runs of the R2007 compression are stored in a shuffled byte order. The specification gives it per run
// length 1–32 as a sequence of blocks [size, source offset]; a block of 2, 3 or 16 bytes is itself ordered by the
// rule of its length (2 and 3 reversed, 16 as two swapped halves – checked against object CRCs), 1, 4 and 8 bytes
// keep their order. Longer runs: 32-byte blocks first, then the rest. LITERAL_ORDER[n · 32 + i]: source index of
// output byte i in a run of n.
const LITERAL_BLOCKS = [null,
    [[1, 0]], [[1, 1], [1, 0]], [[1, 2], [1, 1], [1, 0]], [[1, 0], [1, 1], [1, 2], [1, 3]],
    [[1, 4], [4, 0]], [[1, 5], [4, 1], [1, 0]], [[2, 5], [4, 1], [1, 0]], [[4, 0], [4, 4]],
    [[1, 8], [8, 0]], [[1, 9], [8, 1], [1, 0]], [[2, 9], [8, 1], [1, 0]], [[4, 8], [8, 0]],
    [[1, 12], [4, 8], [8, 0]], [[1, 13], [4, 9], [8, 1], [1, 0]], [[2, 13], [4, 9], [8, 1], [1, 0]], [[8, 8], [8, 0]],
    [[8, 9], [1, 8], [8, 0]], [[1, 17], [16, 1], [1, 0]], [[3, 16], [16, 0]], [[4, 16], [16, 0]],
    [[1, 20], [4, 16], [16, 0]], [[2, 20], [4, 16], [16, 0]], [[3, 20], [4, 16], [16, 0]], [[8, 16], [16, 0]],
    [[8, 17], [1, 16], [16, 0]], [[1, 25], [8, 17], [1, 16], [16, 0]], [[2, 25], [8, 17], [1, 16], [16, 0]],
    [[4, 24], [8, 16], [16, 0]], [[1, 28], [4, 24], [8, 16], [16, 0]], [[2, 28], [4, 24], [8, 16], [16, 0]],
    [[1, 30], [4, 26], [8, 18], [16, 2], [2, 0]], [[16, 16], [16, 0]],
];
const LITERAL_ORDER = (() => {
    const expand = (n) => n === 1 ? [0] : LITERAL_BLOCKS[n].flatMap(([size, at]) => expand(size).map((i) => at + i));
    const table = new Uint8Array(33 * 32);
    for (let n = 1; n <= 32; n++) table.set(expand(n), n * 32);
    return table;
})();

// R2007 compression (another LZ77 variant). A run of literal bytes alternates with back references; the last byte
// of a back reference instruction carries the length (0–7) of the literal run that follows; 0 → the next byte is
// either another instruction or (high nibble 0) the length opcode of a long literal run (opcode + 8, 0x0F extended).
// A stream may start with an opcode 0x2X: then byte 3 & 7 is the first literal length and data starts at byte 4.
// Returns the output position reached.
function decompress21(src, sp, srcEnd, dst, dp, dstEnd) {
    const dstStart = dp;
    let length = 0, op = -1;
    if (src[sp] >> 4 === 2) {
        length = src[sp + 3] & 7;
        sp += 4;
    }
    while (sp < srcEnd && dp < dstEnd) {
        // literal run
        if (!length) {
            if (op < 0) op = src[sp++];
            length = op + 8;
            if (length === 0x17) {
                let n = src[sp++];
                length += n;
                if (n === 0xFF) {
                    do {
                        n = src[sp] | src[sp + 1] << 8;
                        sp += 2;
                        length += n;
                    } while (n === 0xFFFF && sp < srcEnd);
                }
            }
        }
        if (length > srcEnd - sp) length = srcEnd - sp;
        for (; length >= 32; length -= 32, sp += 32, dp += 32) {
            if (dp + 32 > dstEnd) return dstEnd;
            for (let i = 0; i < 32; i++) dst[dp + i] = src[sp + LITERAL_ORDER[1024 + i]];
        }
        if (length) {
            const order = length * 32, n = Math.min(length, dstEnd - dp);
            for (let i = 0; i < n; i++) dst[dp + i] = src[sp + LITERAL_ORDER[order + i]];
            sp += length;
            dp += n;
        }
        if (sp >= srcEnd) break;

        // back references
        op = src[sp++];
        for (;;) {
            let offset;
            switch (op >> 4) {
                case 0:
                    length = (op & 0x0F) + 0x13;
                    offset = src[sp++];
                    op = src[sp++];
                    length += op >> 3 & 0x10;
                    offset += ((op & 0x78) << 5) + 1;
                    break;
                case 1:
                    length = (op & 0x0F) + 3;
                    offset = src[sp++];
                    op = src[sp++];
                    offset += ((op & 0xF8) << 5) + 1;
                    break;
                case 2:
                    offset = src[sp] | src[sp + 1] << 8;
                    sp += 2;
                    length = op & 7;
                    if (op & 8) {
                        offset++;
                        length += (src[sp++] << 3) + 0x100;
                        op = src[sp++];
                        length += (op & 0xF8) << 8;
                    } else {
                        op = src[sp++];
                        length += op & 0xF8;
                    }
                    break;
                default:
                    length = op >> 4;
                    offset = op & 0x0F;
                    op = src[sp++];
                    offset += ((op & 0xF8) << 1) + 1;
            }
            const from = dp - offset;
            if (from < dstStart || !(length >= 0)) return dp;                       // damaged data
            if (length > dstEnd - dp) length = dstEnd - dp;
            if (offset >= length && length > 32) dst.copyWithin(dp, from, from + length);
            else for (let i = 0; i < length; i++) dst[dp + i] = dst[from + i];
            dp += length;
            length = op & 7;
            if (length || sp >= srcEnd || dp >= dstEnd) break;
            op = src[sp++];
            if (op >> 4 === 0) break;                                               // long literal run follows
            if (op >> 4 === 15) op &= 0x0F;
        }
    }
    return dp;
}
