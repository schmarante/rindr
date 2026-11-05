// Path tracer: all participating media of the scene in one walk – the cloud volumes (clouds.js) and the splat volume
// (splat/splat-volume.js). Before, each box had a walk of its own and handed the path over at the other's faces: rays
// that were already inside one medium when they reached the other lost the stretch in between (clouds punched out in
// squares next to splats, hidden splats kept inside cloud boxes). Now a hit on any volume box (ptVolume 3 or 6) runs
// volume-walk.patch.wgsl: delta tracking against the sum of the majorants of every medium at the current point, a
// collision picks the medium by its share of the density. Shadow rays (glass-shadow.patch.wgsl) take the transmittance
// of all media along the rest of the ray at once (jittered march), nested boxes are counted once.
// Media from uniforms (CLOUD_MEDIA, SPLAT_UNIFORMS – updated every frame), lookups from cloud-pt.js / splat-pt.js.
// Own module: only the lazily loaded path tracer imports it.
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { CLOUD_PT } from './materials/cloud-pt.js';
import { CLOUD_MEDIA, CLOUD_G } from './materials/clouds.js';
import { SPLAT_PT } from './splat/splat-pt.js';
import { GRID_MEDIA } from './volumes/grid-volumes.js';
import { GRID_PT } from './volumes/grid-pt.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

// a WGSL function from text pieces and nodes (the per-cloud code is unrolled – uniforms cannot be indexed)
function fn(...pieces) {
    const strings = [], args = [];
    let current = '';
    for (const p of pieces.flat(Infinity)) {
        if (typeof p === 'string') current += p;
        else { strings.push(current); args.push(p); current = ''; }
    }
    strings.push(current);
    return wgslTagFn(strings, ...args);
}

const S = SPLAT_PT;

// [near, far] of the unit box along ld (local change per world unit), near clamped to 0; empty if far < near
const BOX_SPAN = wgslTagFn/* wgsl */`
    fn rindrBoxSpan( lo: vec3f, ld: vec3f ) -> vec2f {

        let inv = 1.0 / ( ld + vec3f( 1e-12 ) );
        let t0 = ( vec3f( - 0.5 ) - lo ) * inv;
        let t1 = ( vec3f( 0.5 ) - lo ) * inv;
        let tNear = max( max( max( min( t0.x, t1.x ), min( t0.y, t1.y ) ), min( t0.z, t1.z ) ), 0.0 );
        let tFar = min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) );
        return vec2f( tNear, tFar );

    }
`;

const cloudLocal = (k, p) => [`( `, CLOUD_MEDIA[k].inverse, ` * vec4f( ${p}, 1.0 ) ).xyz`];
// grid volumes (volumes/grid-volumes.js): kind 3, per slot its box, block majorants, density × σt
const gridLocal = (k, p) => [`( `, GRID_MEDIA[k].inverse, ` * vec4f( ${p}, 1.0 ) ).xyz`];
const gridDir = (k, d) => [`( `, GRID_MEDIA[k].inverse, ` * vec4f( ${d}, 0.0 ) ).xyz`];
const cloudDir = (k, d) => [`( `, CLOUD_MEDIA[k].inverse, ` * vec4f( ${d}, 0.0 ) ).xyz`];

// majorant at p (x) and how far it holds along dir (y): per cloud inside its box its σ, or the distance to where its
// shape could have density (field gap), outside the distance to its box; the splat box: its block majorant / block exit
const MAJORANT = fn(
    `fn rindrMediaMajorant( p: vec3f, dir: vec3f, splatOn: bool ) -> vec2f {
        var maj = 0.0;
        var lim = 1e30;
`,
    CLOUD_MEDIA.map((m, k) => [`
        if ( `, m.albedo, `.w > 0.5 ) {
            let lo = `, cloudLocal(k, 'p'), `;
            let ld = `, cloudDir(k, 'dir'), `;
            let prm = `, m.params, `;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                let gap = `, CLOUD_PT.gap, `( lo, prm.x, prm.y, prm.z );
                if ( gap > 0.004 * prm.y ) {
                    lim = min( lim, gap );
                } else {
                    maj += prm.w;
                    lim = min( lim, `, BOX_SPAN, `( lo, ld ).y );
                }
            } else {
                let span = `, BOX_SPAN, `( lo, ld );
                if ( span.y > span.x ) { lim = min( lim, span.x ); }
            }
        }
`]),
    GRID_MEDIA.map((m, k) => [`
        if ( `, m.params, `.w > 0.5 ) {
            let lo = `, gridLocal(k, 'p'), `;
            let ld = `, gridDir(k, 'dir'), `;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                maj += `, GRID_PT.block, `( lo, `, m.dims, `, `, m.blockDims, `, `, m.offset, `.y ) * `, m.params, `.x;
                lim = min( lim, min( `, GRID_PT.blockExit, `( lo, ld, `, m.dims, ` ), `, BOX_SPAN, `( lo, ld ).y ) );
            } else {
                let span = `, BOX_SPAN, `( lo, ld );
                if ( span.y > span.x ) { lim = min( lim, span.x ); }
            }
        }
`]),
    `
        if ( splatOn && `, S.active, ` > 0.5 ) {
            let lo = ( `, S.inverse, ` * vec4f( p, 1.0 ) ).xyz;
            let ld = ( `, S.inverse, ` * vec4f( dir, 0.0 ) ).xyz;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                maj += `, S.majorant, `( lo ) * `, S.sigma, `;
                lim = min( lim, `, S.blockExit, `( lo, ld ) );
            } else {
                lim = min( lim, `, S.boxEntry, `( lo, ld ) );
            }
        }
        return vec2f( maj, lim );
    }
`);

// density of every medium at p; u in [0, majorant): the medium whose share contains u → (kind, cloud/grid index, total
// density, –); kind 0 = null collision, 1 = cloud, 2 = splat, 3 = grid volume
const PICK = fn(
    `fn rindrMediaPick( p: vec3f, splatOn: bool, u: f32 ) -> vec4f {
        var acc = 0.0;
        var kind = 0.0;
        var slot = 0.0;
`,
    CLOUD_MEDIA.map((m, k) => [`
        if ( `, m.albedo, `.w > 0.5 ) {
            let lo = `, cloudLocal(k, 'p'), `;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                let prm = `, m.params, `;
                acc += `, CLOUD_PT.density, `( lo, p, prm.x, prm.y, prm.z ) * prm.w;
                if ( kind == 0.0 && u < acc ) { kind = 1.0; slot = ${f(k)}; }
            }
        }
`]),
    GRID_MEDIA.map((m, k) => [`
        if ( `, m.params, `.w > 0.5 ) {
            let lo = `, gridLocal(k, 'p'), `;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                acc += `, GRID_PT.sample, `( lo, `, m.dims, `, `, m.offset, `.x ).x * `, m.params, `.x;
                if ( kind == 0.0 && u < acc ) { kind = 3.0; slot = ${f(k)}; }
            }
        }
`]),
    `
        if ( splatOn && `, S.active, ` > 0.5 ) {
            let lo = ( `, S.inverse, ` * vec4f( p, 1.0 ) ).xyz;
            if ( all( abs( lo ) < vec3f( 0.5 ) ) ) {
                acc += `, S.density, `( lo ) * `, S.sigma, `;
                if ( kind == 0.0 && u < acc ) { kind = 2.0; }
            }
        }
        return vec4f( kind, slot, acc, 0.0 );
    }
`);

// albedo of cloud k
const CLOUD_ALBEDO = fn(
    `fn rindrCloudAlbedo( k: u32 ) -> vec3f {
        var a = vec3f( 1.0 );
`,
    CLOUD_MEDIA.map((m, k) => [`        if ( k == ${k}u ) { a = `, m.albedo, `.xyz; }\n`]),
    `        return a;
    }
`);

// albedo, anisotropy and emitted radiance (σa share × emission, fire) of grid volume k
const GRID_ALBEDO = fn(
    `fn rindrGridAlbedo( k: u32 ) -> vec3f {
        var a = vec3f( 1.0 );
`,
    GRID_MEDIA.map((m, k) => [`        if ( k == ${k}u ) { a = `, m.albedo, `.xyz; }\n`]),
    `        return a;
    }
`);
const GRID_G = fn(
    `fn rindrGridG( k: u32 ) -> f32 {
        var g = 0.0;
`,
    GRID_MEDIA.map((m, k) => [`        if ( k == ${k}u ) { g = `, m.params, `.y; }\n`]),
    `        return g;
    }
`);
const GRID_EMIT = fn(
    `fn rindrGridEmit( k: u32, p: vec3f ) -> vec3f {
        var e = vec3f( 0.0 );
`,
    GRID_MEDIA.map((m, k) => [`
        if ( k == ${k}u && `, m.params, `.z > 0.5 ) {
            let t = `, GRID_PT.sample, `( `, gridLocal(k, 'p'), `, `, m.dims, `, `, m.offset, `.x ).y;
            e = `, GRID_PT.emission, `( ${k}u, t ) * ( vec3f( 1.0 ) - `, m.albedo, `.xyz );
        }
`]),
    `        return e;
    }
`);

// distance along dir until every active medium's box is left (0: none ahead)
const EXIT = fn(
    `fn rindrMediaExit( p: vec3f, dir: vec3f, splatOn: bool ) -> f32 {
        var far = 0.0;
`,
    CLOUD_MEDIA.map((m, k) => [`
        if ( `, m.albedo, `.w > 0.5 ) {
            let span = `, BOX_SPAN, `( `, cloudLocal(k, 'p'), `, `, cloudDir(k, 'dir'), ` );
            if ( span.y > span.x ) { far = max( far, span.y ); }
        }
`]),
    GRID_MEDIA.map((m, k) => [`
        if ( `, m.params, `.w > 0.5 ) {
            let span = `, BOX_SPAN, `( `, gridLocal(k, 'p'), `, `, gridDir(k, 'dir'), ` );
            if ( span.y > span.x ) { far = max( far, span.y ); }
        }
`]),
    `
        if ( splatOn && `, S.active, ` > 0.5 ) {
            let span = `, BOX_SPAN, `( ( `, S.inverse, ` * vec4f( p, 1.0 ) ).xyz, ( `, S.inverse, ` * vec4f( dir, 0.0 ) ).xyz );
            if ( span.y > span.x ) { far = max( far, span.y ); }
        }
        return far;
    }
`);

// p inside any active medium's box
const INSIDE = fn(
    `fn rindrMediaInside( p: vec3f, splatOn: bool ) -> bool {
        var inside = false;
`,
    CLOUD_MEDIA.map((m, k) => [`        inside = inside || ( `, m.albedo, `.w > 0.5 && all( abs( `, cloudLocal(k, 'p'), ` ) < vec3f( 0.5 ) ) );\n`]),
    GRID_MEDIA.map((m, k) => [`        inside = inside || ( `, m.params, `.w > 0.5 && all( abs( `, gridLocal(k, 'p'), ` ) < vec3f( 0.5 ) ) );\n`]),
    `        inside = inside || ( splatOn && `, S.active, ` > 0.5 && all( abs( ( `, S.inverse, ` * vec4f( p, 1.0 ) ).xyz ) < vec3f( 0.5 ) ) );
        return inside;
    }
`);

// transmittance of all media along o + dir·t, t ∈ [t0, t1] – 48 jittered steps over the span, stretches without any
// medium jumped over. Ratio tracking (unbiased) took hundreds of lookups per shadow ray in dense smoke – HQ of a
// smoke splat went from 15 s to 85 s
const SHADOW_STEPS = 48;
const TRANSMITTANCE = fn(
    `fn rindrMediaTransmittance( o: vec3f, dir: vec3f, t0: f32, t1: f32, seed: u32 ) -> f32 {
        let dt = ( t1 - t0 ) / ${f(SHADOW_STEPS)};
        let eps = max( t1, 1.0 ) * 1e-6;
        var t = t0 + dt * `, CLOUD_PT.pcg, `( seed * 747796405u + 2891336453u );
        var tau = 0.0;
        for ( var k = 0u; k < 256u; k ++ ) {
            if ( t >= t1 ) { break; }
            let m = `, MAJORANT, `( o + dir * t, dir, true );
            if ( m.x <= 0.0 ) { t += max( m.y, dt ) + eps; continue; }
            tau += `, PICK, `( o + dir * t, true, 1e30 ).z * dt;
            if ( tau > 7.0 ) { break; }
            t += dt;
        }
        return exp( - tau );
    }
`);

export const VOLUME_PT = {
    majorant: MAJORANT, pick: PICK, cloudAlbedo: CLOUD_ALBEDO, exit: EXIT, inside: INSIDE, transmittance: TRANSMITTANCE,
    gridAlbedo: GRID_ALBEDO, gridG: GRID_G, gridEmit: GRID_EMIT,
    cloudG: f(CLOUD_G), splatPrimary: S.primary,
};
