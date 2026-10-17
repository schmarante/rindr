// Path tracer side of the soap film (soap.js): the film thickness from the same noise as the raster, inserted into
// the megakernel by the Vite plugin rindr-soap (astro.config.mjs) before the surface record is made – the thin-film
// interference itself is three-gpu-pathtracer's (matched IOR + iridescence). Own module: only the lazily loaded path
// tracer imports it.
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { WOOL_PT } from './wool-pt.js';
import { SOAP_CELL, SOAP_LIMITS, SOAP_SHAPE } from './soap.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

// film thickness (nm) at a world position with its unflipped world normal – the same as soapThickness in soap.js
const THICKNESS = wgslTagFn/* wgsl */`
    fn rindrSoapThickness( p: vec3f, n: vec3f, film: f32, swirl: f32, cell: f32 ) -> f32 {

        let q = p / cell;
        let w = ${ WOOL_PT.noise }( q * 0.45 );
        let v = ${ WOOL_PT.noise }( q + w * ${ f(SOAP_SHAPE.warp) } );
        let fine = ${ WOOL_PT.noise }( q * 2.6 + w * 1.3 );
        let bands = v.x * 0.65 + fine.y * 0.35;
        let drain = 1.0 - n.y * ${ f(SOAP_SHAPE.drain) };
        return clamp( film * drain * ( 1.0 + swirl * ${ f(SOAP_SHAPE.amplitude) } * bands ), ${ f(SOAP_LIMITS.min) }, ${ f(SOAP_LIMITS.max) } );

    }
`;

// soap films a path may pass without using up its bounces (two per bubble – with 8 bounces a cluster of bubbles turned
// black inside)
const FILM_BOUNCES = 48;

export const SOAP_PT = { thickness: THICKNESS, cell: SOAP_CELL, filmBounces: `${FILM_BOUNCES}u` };
