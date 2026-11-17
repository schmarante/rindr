// STEP text (ISO 10303-21) written piece by piece into a growing byte buffer – shared by the converters that go the STEP
// way (iges/iges-to-step.js, sat/sat-to-step.js): `add(body)` writes one instance and returns its id.

// real number in STEP form (always with a decimal point, exponent with E)
export function num(x) {
    if (!Number.isFinite(x)) x = 0;
    const s = String(x);
    const e = s.indexOf('e');
    if (e >= 0) { const m = s.slice(0, e); return (m.includes('.') ? m : m + '.') + 'E' + s.slice(e + 1); }
    return s.includes('.') ? s : s + '.';
}
export const str = s => `'${String(s ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
export const list = a => `(${a.join(',')})`;
export const ref = id => `#${id}`;

export class StepWriter {
    constructor() {
        this.id = 0;
        this.parts = [];
        this.pending = 0;
        this.buf = new Uint8Array(1 << 24);
        this.used = 0;
        this.enc = new TextEncoder();
    }
    add(body) {
        const id = ++this.id;
        this.text(`#${id}=${body};\n`);
        return id;
    }
    text(s) {
        this.parts.push(s);
        this.pending += s.length;
        if (this.pending > 1 << 20) this.flush();
    }
    flush() {
        const s = this.parts.join('');
        this.parts = [];
        this.pending = 0;
        if (this.used + s.length > this.buf.length) {
            let size = this.buf.length;
            while (size < this.used + s.length) size *= 2;
            const b = new Uint8Array(size);
            b.set(this.buf.subarray(0, this.used));
            this.buf = b;
        }
        this.used += this.enc.encodeInto(s, this.buf.subarray(this.used)).written;
    }
    finish() {
        this.text('ENDSEC;\nEND-ISO-10303-21;\n');
        this.flush();
        return this.buf.subarray(0, this.used);
    }
}
