// Path tracer side of the wool material (wool.js): WGSL inserted into three-gpu-pathtracer by the Vite plugin
// rindr-wool (astro.config.mjs). Own module: only the lazily loaded path tracer imports it.
//  - the fibres are the raster's shells, intersected inside the BVH traversal (like an alpha test): every triangle of
//    a wool mesh (ptVolume 4) also tests its WOOL_SHELLS offset copies (the vertices pushed out along their normals)
//    and keeps a hit only where a fibre is – no extra geometry, the mesh's own BVH with its bounds grown over the
//    fibres (wool-bounds.js)
//  - fibre field: the same function as the raster (wool.js, woolFibre) – own hash/noise, must stay identical there
//  - a fibre hit is shaded at the fibre (position, facing normal), darker towards the roots, tinted per fibre
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { WOOL_SHELLS, WOOL_FIBRE, WOOL_SHADE } from './wool.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

// integer hash of a cell (pcg3d, Jarzynski & Olano 2020) → 0…1
const HASH = wgslTagFn/* wgsl */`
    fn rindrWoolHash( c: vec3f ) -> vec3f {

        var v = vec3u( vec3i( c ) );
        v = v * 1664525u + 1013904223u;
        v.x += v.y * v.z;
        v.y += v.z * v.x;
        v.z += v.x * v.y;
        v = v ^ ( v >> vec3u( 16u ) );
        v.x += v.y * v.z;
        v.y += v.z * v.x;
        v.z += v.x * v.y;
        return vec3f( v ) * ( 1.0 / 4294967296.0 );

    }
`;

// value noise from the hash, −1…1 per channel
const NOISE = wgslTagFn/* wgsl */`
    fn rindrWoolNoise( p: vec3f ) -> vec3f {

        let i = floor( p );
        let t = p - i;
        let s = t * t * ( 3.0 - 2.0 * t );
        let x0 = mix( ${ HASH }( i ), ${ HASH }( i + vec3f( 1.0, 0.0, 0.0 ) ), s.x );
        let x1 = mix( ${ HASH }( i + vec3f( 0.0, 1.0, 0.0 ) ), ${ HASH }( i + vec3f( 1.0, 1.0, 0.0 ) ), s.x );
        let x2 = mix( ${ HASH }( i + vec3f( 0.0, 0.0, 1.0 ) ), ${ HASH }( i + vec3f( 1.0, 0.0, 1.0 ) ), s.x );
        let x3 = mix( ${ HASH }( i + vec3f( 0.0, 1.0, 1.0 ) ), ${ HASH }( i + vec3f( 1.0, 1.0, 1.0 ) ), s.x );
        return mix( mix( x0, x1, s.y ), mix( x2, x3, s.y ), s.z ) * 2.0 - 1.0;

    }
`;

// fibre at a base position (object space) and height (0…1 of the fibre length), cell = fibre cell size (object units):
// x = coverage 0…1, y = the fibre's random tint
const FIBRE = wgslTagFn/* wgsl */`
    fn rindrWoolFibre( base: vec3f, layer: f32, cell: f32 ) -> vec2f {

        let bend = ${ NOISE }( base / ( cell * 3.0 ) + vec3f( layer * 1.7 ) ) * ( layer * ${ f(WOOL_FIBRE.curl) } );
        let p = base / cell + bend;
        let c = floor( p );
        let rnd = ${ HASH }( c );
        let centre = rnd * 0.5 + 0.25;
        let height = rnd.x * 0.5 + 0.5;
        let radius = ${ f(WOOL_FIBRE.radius) } * pow( max( 1.0 - layer / height, 1e-6 ), 0.8 );
        let d = length( p - c - centre );
        let coverage = select( 0.0, smoothstep( radius, radius * 0.6, d ), layer <= height && radius > 1e-4 );
        return vec2f( coverage, rnd.y );

    }
`;

// a hit on a wool mesh (world units; base = the surface point under it, len = fibre length): x = height 0…1 of the
// fibre (0: the surface itself), y = colour factor – darker at the roots, tinted per fibre like the raster's shells
const SHADE = wgslTagFn/* wgsl */`
    fn rindrWoolShade( hit: vec3f, base: vec3f, inv: mat4x4f, dir: vec3f, len: f32 ) -> vec2f {

        let height = min( length( hit - base ) / len, 1.0 );
        let layer = select( 0.0, height, height > ${ f(0.5 / WOOL_SHELLS) } );
        var tint = 1.0;
        if ( layer > 0.0 ) {

            let cell = len * length( ( inv * vec4f( dir, 0.0 ) ).xyz ) / ${ f(WOOL_FIBRE.perLength) };
            tint = ${ FIBRE }( ( inv * vec4f( base, 1.0 ) ).xyz, layer, cell ).y * 0.16 + 0.92;

        }
        return vec2f( layer, mix( ${ f(WOOL_SHADE.root) }, ${ f(WOOL_SHADE.tip) }, layer ) * tint * ${ f(WOOL_SHADE.through) } );

    }
`;

export const WOOL_PT = {
    sheen: f(WOOL_SHADE.sheen),
    fibre: FIBRE,
    noise: NOISE,   // soap-pt.js
    shade: SHADE,
    shells: `${WOOL_SHELLS}u`,
    shellsF: f(WOOL_SHELLS),
    perLength: f(WOOL_FIBRE.perLength),
};
