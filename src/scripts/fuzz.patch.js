// rindr-openpbr (astro.config.mjs): OpenPBR fuzz instead of the Charlie sheen – replaces sheenAlbedoScaling and
// sheenColor at the end of three-gpu-pathtracer's sheen.wgsl.js (wgslTagFn and surfaceRecordStruct come from there).
// Zeltner, Burley, Chiang 2022, "Practical Multiple-Scattering Sheen Using Linearly Transformed Cosines": a clamped
// cosine transformed per view angle and roughness, fitted to a volumetric fibre layer. The fits of the transform and of
// the directional albedo after MaterialX (mx_microfacet_sheen.glsl, Apache-2.0, adapted from github.com/tizian/ltc-sheen).
// The raster uses the same formulas (materials/openpbr-lighting.js).

// directional albedo E( mu, r ) of the fuzz lobe (Gaussian fit)
const fuzzAlbedoFunc = wgslTagFn/* wgsl */`

	fn fuzzAlbedo( mu: f32, r: f32 ) -> f32 {

		let s = r * ( 0.0206607 + 1.58491 * r ) / ( 0.0379424 + r * ( 1.32227 + r ) );
		let m = r * ( - 0.193854 + r * ( - 1.14885 + r * ( 1.7932 - 0.95943 * r * r ) ) ) / ( 0.046391 + r );
		let o = r * ( 0.000654023 + ( - 0.0207818 + 0.119681 * r ) * r ) / ( 1.26264 + r * ( - 1.92021 + r ) );
		let d = ( mu - m ) / s;
		return clamp( exp( - 0.5 * d * d ) / ( s * 2.50662827 ) + o, 0.0, 1.0 );

	}

`;

// E( wo ): what lies below is scaled by 1 − fuzz weight × E (OpenPBR: the view direction only, without the fuzz colour)
export const sheenAlbedoScalingFunc = wgslTagFn/* wgsl */`

	fn sheenAlbedoScaling( wo: vec3f, wi: vec3f, surf: ${ surfaceRecordStruct } ) -> f32 {

		return ${ fuzzAlbedoFunc }( clamp( wo.z, 1e-4, 1.0 ), clamp( surf.sheenRoughness, 0.01, 1.0 ) );

	}

`;

// the fuzz BRDF: colour × E( wo ) × D( wi ) / cos( wi ) – D the transformed cosine (normalised, includes the cosine)
export const sheenColorFunc = wgslTagFn/* wgsl */`

	fn sheenColor( wo: vec3f, wi: vec3f, wh: vec3f, surf: ${ surfaceRecordStruct } ) -> vec3f {

		let mu = clamp( wo.z, 1e-4, 1.0 );
		let r = clamp( surf.sheenRoughness, 0.01, 1.0 );

		// frame: x in the plane of normal and view, y only by its length (the lobe is symmetric about that plane; at
		// normal view bInv = 0 and the lobe is round – no basis needed there)
		let x = wo.xy * inverseSqrt( max( dot( wo.xy, wo.xy ), 1e-12 ) );
		let wx = dot( wi.xy, x );
		let wy2 = max( 1.0 - wi.z * wi.z - wx * wx, 0.0 );

		let aInv = ( 2.58126 * mu + 0.813703 * r ) * r / ( 1.0 + 0.310327 * mu * mu + 2.60994 * mu * r );
		let bInv = sqrt( 1.0 - mu ) * ( r - 1.0 ) * r * r * r / ( 0.0000254053 + 1.71228 * mu - 1.71506 * mu * r + 1.34174 * r * r );
		let ox = aInv * wx + bInv * wi.z;
		let k = aInv / ( ox * ox + aInv * aInv * wy2 + wi.z * wi.z );
		let D = max( wi.z, 0.0 ) * 0.318309886 * k * k;

		return surf.sheenColor * ${ fuzzAlbedoFunc }( mu, r ) * D / max( wi.z, 1e-4 );

	}

`;
