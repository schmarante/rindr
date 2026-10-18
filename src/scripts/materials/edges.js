// Rounded edges (shading only): within a radius around sharp edges the shading normal turns towards the neighbouring
// face as if the edge were a fillet – the geometry and the silhouette stay sharp. Material parameter `edgeRadius`
// (scene units, mm for CAD; 0 = off), `edgeConcave` (inner edges too).
//
// Raster and path tracer evaluate the same WGSL function (EDGE_WGSL) on the same data – they agree exactly:
//   - per geometry a block of precomputed data (edges-build.js, in a worker – edges-worker.js): the sharp edge
//     segments with the normals of both sides, and per vertex the list of segments that can reach the triangles
//     this vertex is the first (provoking) vertex of. All blocks live in one storage buffer (EDGE_DATA); a geometry's
//     block start is its "base" (raster: per-object uniform; path tracer: a spare field of its transform)
//   - fragment / hit point: object-space position + interpolated normal, list of the triangle's first vertex
//     (raster: flat varying of the vertex index; path tracer: the hit's first index), for every segment within the
//     band the normal tilts towards the other side like a circular fillet of that radius; the tilts of several edges
//     add up (box corners blend continuously)
// Only materials with the option pay: the raster shader gets the extra code only then (cache key `edges`), the path
// tracer branches on the stand-in field.
import * as THREE from 'three/webgpu';
import { storage, uniform, varying, vertexIndex, positionGeometry, normalGeometry, positionView, normalViewGeometry,
    dFdx, dFdy, vec3, float, select, faceDirection } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { EDGE_SHAPE } from './edges-build.js';

export const EDGE_NONE = 0xffffffff;   // base of a geometry without data
const MAX_LIST = 48;                  // segments per list the shader looks at
const OWN_SIDE = 0.7;                 // the fragment's normal must be this close to one side of the segment
const HEADROOM = 1.5;                 // lists are built for this much more radius (slider drags need no rebuild)
// path tracer: bounces that bend the normal (0 = camera ray) – later bounces barely show it but cost the loop
export const EDGE_BOUNCES = '2u';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

// all geometry blocks (vec4); replaced when blocks are added or rebuilt (bindings follow the attribute)
export const EDGE_DATA = storage(new THREE.StorageBufferAttribute(new Float32Array(16), 4), 'vec4').toReadOnly().setName('rindr_edges');

/**
 * Normal of a point near sharp edges, object space. p, n = position and interpolated normal; vertex = the triangle's
 * first vertex; base = block start (EDGE_NONE: none); radius = fillet radius in object units, < 0 = convex edges only.
 */
export const EDGE_WGSL = wgslTagFn/* wgsl */`
    fn rindrEdgeNormal( p: vec3f, n: vec3f, vertex: u32, base: u32, radius: f32 ) -> vec3f {

        let nn = normalize( n );
        if ( base == ${ EDGE_NONE }u || radius == 0.0 ) {

            return nn;

        }
        let r = abs( radius );
        let concave = radius > 0.0;
        let tv = ${ EDGE_DATA }[ base + vertex / 2u ];
        let info = select( tv.xy, tv.zw, ( vertex & 1u ) == 1u );
        let start = u32( info.x );
        let count = min( u32( info.y ), ${ MAX_LIST }u );
        var tilt = vec3f( 0.0 );
        for ( var i = 0u; i < count; i ++ ) {

            let s = start + i;
            let slot = ${ EDGE_DATA }[ base + s / 4u ];
            let rec = base + u32( slot[ s % 4u ] );
            let r0 = ${ EDGE_DATA }[ rec ];
            let r1 = ${ EDGE_DATA }[ rec + 1u ];
            let r2 = ${ EDGE_DATA }[ rec + 2u ];
            // cut planes at both ends (length 2 = concave edge), then the distance to the edge line – most entries
            // end here, before the normals are read
            let c0 = vec3f( r0.w, r1.w, r2.x );
            let c1 = r2.yzw;
            if ( ( ! concave && dot( c0, c0 ) > 2.25 ) || dot( p - r0.xyz, c0 ) < 0.0 || dot( p - r1.xyz, c1 ) < 0.0 ) {

                continue;

            }
            let ab = r1.xyz - r0.xyz;
            let ap = p - r0.xyz;
            let along = dot( ap, ab ) / max( dot( ab, ab ), 1e-30 );
            let d = length( ap - ab * along );
            if ( d >= r * ${ f(EDGE_SHAPE.tanMax) } ) {

                continue;

            }
            let r3 = ${ EDGE_DATA }[ rec + 3u ];
            let r4 = ${ EDGE_DATA }[ rec + 4u ];
            let r5 = ${ EDGE_DATA }[ rec + 5u ];
            let t = clamp( along, 0.0, 1.0 );
            let na = normalize( mix( r3.xyz, r4.xyz, t ) );
            let nb = normalize( mix( r5.xyz, vec3f( r3.w, r4.w, r5.w ), t ) );
            let da = dot( nn, na );
            let db = dot( nn, nb );
            if ( max( da, db ) < ${ f(OWN_SIDE) } ) {

                continue;

            }
            let own = select( nb, na, da >= db );
            let other = select( na, nb, da >= db );
            let c = clamp( dot( own, other ), - 1.0, 1.0 );
            let half = 0.5 * acos( c );
            let band = r * min( tan( half ), ${ f(EDGE_SHAPE.tanMax) } );
            let perp = other - own * c;
            let pl = length( perp );
            if ( d >= band || pl < 1e-6 ) {

                continue;

            }
            // circular profile: sin of the normal's angle grows linearly towards the edge, half the turn on the edge
            let sphi = ( 1.0 - d / band ) * sin( half );
            tilt += perp * ( sphi * inverseSqrt( max( 1.0 - sphi * sphi, 1e-6 ) ) / pl );

        }
        return normalize( nn + tilt );

    }
`;

// --- per-geometry blocks ---

const RECORDS = new WeakMap();   // geometry → { data, built, base, rotated, pending }
let packed = [];                 // geometries in EDGE_DATA

/** block start of a geometry in EDGE_DATA (EDGE_NONE: no data) – raster uniform, path tracer transform field */
export function edgeBase(geometry) {
    const rec = geometry && RECORDS.get(geometry);
    return rec && rec.base >= 0 ? rec.base : EDGE_NONE;
}

// the triangle's first vertex (provoking vertex: flat varying), block start and object-space radius per object
const EDGE_VERTEX = varying(vertexIndex, 'v_rindrEdgeVertex').setInterpolation('flat', 'first');
const EDGE_BASE = uniform(EDGE_NONE, 'uint').onObjectUpdate(({ object }) => edgeBase(object.geometry));

/**
 * Raster: the view-space normal `normal` (normal maps included) with the edge rounding applied. radius = uniform,
 * world units, < 0 = convex edges only. Object → view via the screen derivatives of the position (works for
 * instanced/batched meshes, whose instance matrix the fragment shader does not know).
 */
export function edgeNormalView(normal, radius) {
    const dxo = dFdx(positionGeometry), dyo = dFdy(positionGeometry);
    const dxv = dFdx(positionView), dyv = dFdy(positionView);
    const lo = dxo.dot(dxo).add(dyo.dot(dyo)), lv = dxv.dot(dxv).add(dyv.dot(dyv));
    const scale = lv.div(lo.max(1e-30)).sqrt();   // world/view units per object unit (uniform scale)
    const no = normalGeometry.normalize();
    const bent = EDGE_WGSL(positionGeometry, no, EDGE_VERTEX, EDGE_BASE, radius.div(scale.max(1e-30)));
    // bent = a·dxo + b·dyo + c·no  →  view: (a·dxv + b·dyv) / scale + c·normalViewGeometry
    const cyn = dyo.cross(no), cnx = no.cross(dxo), cxy = dxo.cross(dyo);
    const det = dxo.dot(cyn);
    const ok = det.abs().greaterThan(lo.mul(lo.sqrt()).mul(1e-6));
    const a = bent.dot(cyn).div(det), b = bent.dot(cnx).div(det), c = bent.dot(cxy).div(det);
    const view = dxv.mul(a).add(dyv.mul(b)).div(scale.max(1e-30)).add(normalViewGeometry.mul(c)).normalize();
    const delta = select(ok, view.sub(normalViewGeometry), vec3(0));
    return normal.add(delta.mul(faceDirection)).normalize();
}

// --- system: keeps the blocks of all geometries with rounded-edge materials up to date ---

function needsEdges(material) {
    return !!material?.edges && material.userData.edges?.radius > 0;
}

function maxScale(m) {
    const e = m.elements;
    return Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])) || 1;
}

function readXYZ(attr) {
    if (!attr) return null;
    if (!attr.isInterleavedBufferAttribute && attr.itemSize === 3 && attr.array instanceof Float32Array) return attr.array.slice();
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
    return out;
}

export class EdgeSystem {
    /** @param {() => THREE.Object3D[]} getRoots  model roots */
    constructor(getRoots) {
        this.getRoots = getRoots;
        this._scan = true;
        this._need = new Map();      // geometry → radius in its own units (most of its meshes)
        this._queue = [];
        this._busy = false;
        this._worker = null;
        this._jobs = new Map();
        this._jobId = 0;
        this.onChange = null;        // (rebuild) – new data; rebuild = triangle corners rotated (path tracer scene)
        this.stats = { geometries: 0, vec4: 0, buildMs: 0 };
    }

    /** materials, assignments or the model changed – search again on the next update */
    invalidate() {
        this._scan = true;
    }

    /** every frame (cheap unless invalidated) */
    update() {
        if (!this._scan) return;
        this._scan = false;
        const need = new Map();
        for (const root of this.getRoots()) {
            root?.traverse(o => {
                if (!o.isMesh || Array.isArray(o.material) || !needsEdges(o.material) || !o.geometry?.attributes?.position) return;
                const local = o.material.userData.edges.radius / maxScale(o.matrixWorld);
                need.set(o.geometry, Math.max(need.get(o.geometry) ?? 0, local));
            });
        }
        this._need = need;
        for (const [geometry, radius] of need) {
            const rec = RECORDS.get(geometry);
            if (rec?.pending) continue;
            if (!rec || radius > rec.built || radius < rec.built / (HEADROOM * HEADROOM * 2)) this._enqueue(geometry, radius * HEADROOM);
        }
        this._repack();
    }

    _enqueue(geometry, radius) {
        const rec = RECORDS.get(geometry) ?? { data: null, built: 0, base: -1, rotated: false, pending: false };
        rec.pending = true;
        RECORDS.set(geometry, rec);
        this._queue.push({ geometry, radius });
        this._next();
    }

    _next() {
        if (this._busy || !this._queue.length) return;
        const { geometry, radius } = this._queue.shift();
        const rec = RECORDS.get(geometry);
        if (!this._need.has(geometry)) { rec.pending = false; this._next(); return; }
        this._busy = true;
        const input = {
            positions: readXYZ(geometry.attributes.position),
            normals: readXYZ(geometry.attributes.normal),
            index: geometry.index ? geometry.index.array.slice() : null,
            radius, rotate: !rec.rotated,
        };
        const indexVersion = geometry.index?.version;
        this._run(input).then(result => {
            rec.pending = false;
            this._busy = false;
            if (geometry.index && geometry.index.version !== indexVersion) { this._enqueue(geometry, radius); return; }   // changed meanwhile
            let rebuild = false;
            if (result.index) {
                geometry.index.array.set(result.index);
                geometry.index.needsUpdate = true;
                rebuild = true;
            }
            rec.rotated = true;
            rec.data = result.data;
            rec.built = radius;
            this.stats.buildMs += result.stats.ms;
            this._dirty = true;
            this._rebuild ||= rebuild;
            this._repack();
            this._next();
        }, err => {
            console.warn('[edges] build failed:', err);
            rec.pending = false;
            this._busy = false;
            this._next();
        });
    }

    _run(input) {
        if (!this._worker) {
            try {
                this._worker = new Worker(new URL('./edges-worker.js', import.meta.url), { type: 'module', name: 'edges' });
                this._worker.onmessage = ({ data }) => {
                    const job = this._jobs.get(data.id);
                    this._jobs.delete(data.id);
                    if (data.error) job?.reject(new Error(data.error)); else job?.resolve(data.result);
                };
            } catch {
                this._worker = false;
            }
        }
        if (!this._worker) return import('./edges-build.js').then(m => m.buildEdgeData(input));
        const id = ++this._jobId;
        return new Promise((resolve, reject) => {
            this._jobs.set(id, { resolve, reject });
            const transfer = [input.positions.buffer, input.index?.buffer, input.normals?.buffer].filter(Boolean);
            this._worker.postMessage({ id, input }, transfer);
        });
    }

    // all blocks of the geometries in use into one buffer (new bases); onChange when anything changed
    _repack() {
        const list = [...this._need.keys()].filter(g => RECORDS.get(g)?.data);
        const same = list.length === packed.length && list.every((g, i) => g === packed[i]);
        if (same && !this._dirty) return;
        this._dirty = false;
        for (const g of packed) { const rec = RECORDS.get(g); if (rec) rec.base = -1; }
        let total = 0;
        for (const g of list) total += RECORDS.get(g).data.length / 4;
        const array = new Float32Array(Math.max(total, 4) * 4);
        let base = 0;
        for (const g of list) {
            const rec = RECORDS.get(g);
            array.set(rec.data, base * 4);
            rec.base = base;
            base += rec.data.length / 4;
        }
        const old = EDGE_DATA.value;
        EDGE_DATA.value = new THREE.StorageBufferAttribute(array, 4);
        old.dispose?.();
        packed = list;
        this.stats.geometries = list.length;
        this.stats.vec4 = total;
        const rebuild = this._rebuild;
        this._rebuild = false;
        this.onChange?.(rebuild);
    }
}
