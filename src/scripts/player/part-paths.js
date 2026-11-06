// Parts by name (docs/player.md, stage 4): the host page addresses parts by the names in the model file instead of the
// internal node numbers (they change when a configurator exports a variant). A path is the chain of node names from the
// model's top, joined with '/':
//   'Housing/Lid'          the node Lid below Housing
//   'Wheel'                every top node named Wheel (same-named siblings: all of them) …
//   'Wheel[2]'             … or only the second one (1-based, in file order)
//   'Housing/*'            every child of Housing ('*' inside a name: any characters, e.g. 'Screw*')
//   '**/Screw*'            Screw… at any depth ('**' = any number of nodes, also none)
// Names containing / [ ] * \ are written with a backslash before that character. Unnamed nodes have an empty name; a single
// unnamed top node (the file's root, e.g. a glTF scene without a name) is left out – its children are the top.

/** a node name as a path segment (special characters escaped) */
export const escapeName = name => String(name ?? '').replace(/[\\/[\]*]/g, c => '\\' + c);

/**
 * Paths of the nodes of one model. nodes: [{ name, parent }] (parent = index, -1 = top; children after their parent).
 * Returns per node { path, name, index } – index: 1-based among same-named siblings, 0 = the only one of its name; the left
 * out root: { path: '', root: true }.
 */
export function partPaths(nodes) {
    const out = new Array(nodes.length);
    const counts = new Map();   // parent → name → count (to know whether a name repeats)
    nodes.forEach(n => {
        const key = n.parent ?? -1;
        if (!counts.has(key)) counts.set(key, new Map());
        const names = counts.get(key);
        names.set(n.name ?? '', (names.get(n.name ?? '') || 0) + 1);
    });
    const seen = new Map();
    const tops = nodes.filter(n => (n.parent ?? -1) < 0);
    const hiddenRoot = tops.length === 1 && !tops[0].name ? nodes.indexOf(tops[0]) : -1;
    nodes.forEach((n, i) => {
        if (i === hiddenRoot) { out[i] = { path: '', name: '', index: 0, segments: [], root: true }; return; }
        const parent = n.parent ?? -1;
        const name = n.name ?? '';
        const twins = counts.get(parent).get(name) > 1;
        const k = parent + '\u0000' + name;
        const index = twins ? (seen.get(k) || 0) + 1 : 0;
        if (twins) seen.set(k, index);
        const segment = escapeName(name) + (index ? `[${index}]` : '');
        const up = parent >= 0 && !out[parent].root ? out[parent] : null;
        out[i] = { path: up ? `${up.path}/${segment}` : segment, name, index, segments: [...(up?.segments || []), { name, index }] };
    });
    return out;
}

// a pattern split into segments: { any: true } for '**', otherwise { name: RegExp, index: n | null }
const reEscape = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parsePattern(pattern) {
    const segments = [];
    const fresh = () => ({ re: '', raw: '', index: null, inIndex: false, digits: '' });
    let cur = fresh(), escaped = false;
    const flush = () => {
        segments.push(cur.raw === '**' ? { any: true } : { name: new RegExp(`^${cur.re}$`, 's'), index: cur.index });
        cur = fresh();
    };
    for (const c of String(pattern ?? '')) {
        if (cur.inIndex) {   // [n] after a name: only the n-th of same-named siblings
            if (c === ']') { cur.inIndex = false; cur.index = +cur.digits || null; } else cur.digits += c;
            continue;
        }
        if (escaped) { cur.re += reEscape(c); cur.raw += '\\' + c; escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '/') { flush(); continue; }
        if (c === '[') { cur.inIndex = true; continue; }
        if (c === '*') { cur.re += '.*'; cur.raw += '*'; continue; }
        cur.re += reEscape(c);
        cur.raw += c;
    }
    flush();
    return segments;
}

function matchSegments(pattern, segments, p = 0, s = 0) {
    if (p === pattern.length) return s === segments.length;
    const seg = pattern[p];
    if (seg.any) {
        for (let k = s; k <= segments.length; k++) if (matchSegments(pattern, segments, p + 1, k)) return true;
        return false;
    }
    if (s === segments.length) return false;
    const node = segments[s];
    if (!seg.name.test(node.name)) return false;
    if (seg.index !== null && seg.index !== (node.index || 1)) return false;
    return matchSegments(pattern, segments, p + 1, s + 1);
}

/** a matcher for one pattern (or several): (part from partPaths) → true/false */
export function pathMatcher(patterns) {
    const list = (Array.isArray(patterns) ? patterns : [patterns]).map(p => parsePattern(typeof p === 'object' && p ? p.path : p));
    return part => list.some(pattern => matchSegments(pattern, part.segments));
}
