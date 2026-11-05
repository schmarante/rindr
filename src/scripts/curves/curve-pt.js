// Path tracer side of hair (curves/, Vite patch rindr-curves): which piece a ray leaves. Set by the megakernel at every
// surface hit (object index + 1 and the piece's two points; zero for other surfaces and camera rays), read by the ray
// test: that piece and its neighbours on the same hair (sharing a point) are passed – no self-hit – while every other
// fibre is hit, from inside too (overlapping or touching hairs; files that write each hair as overlapping segments get
// them back as the separate fibres a renderer sees there). Before, every cylinder containing the ray's origin was
// passed: light went through all overlapping copies at once – blond hair came out pale.
import { uvec4, uint } from 'three/tsl';

export const CURVE_SKIP = uvec4(0, 0, 0, 0).toVar('rindr_curveSkip');
export const CURVE_OBJECT_INDEX = uint(0).toVar('rindr_curveObjectIndex');
