// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Kernel features (src/scripts/kernel-features.js): the code of a feature is marked, the kernel is built with the
// features the scene needs (featureTag drops the rest) – otherwise: the library's code it replaced (or nothing)
const KERNEL_FEATURES_MODULE = fileURLToPath(new URL('./src/scripts/kernel-features.js', import.meta.url));
const KERNEL_FEATURE_TAG_MODULE = fileURLToPath(new URL('./src/scripts/kernel-feature-tag.js', import.meta.url));
const gate = (features, code, otherwise = '') => `/*@if:${features}*/${code}${otherwise ? `/*@else*/${otherwise}` : ''}/*@endif*/`;

// Patches three-gpu-pathtracer's megakernel (fails loudly if the library changed – check on every update):
// - shadow catcher (src/scripts/shadow-catcher.js): matte branch → src/scripts/shadow-catcher.patch.wgsl, incl. ground
//   reflection / puddles (src/scripts/ground-reflection.js: GROUND_SURFACE_WGSL)
// - background dome (src/scripts/background-dome.js): every background/environment lookup of a ray goes
//   through domeDirection(ray.origin, ray.direction) – camera rays, reflections and refractions
const SHADOW_CATCHER_MODULE = fileURLToPath(new URL('./src/scripts/shadow-catcher.js', import.meta.url));
const DOME_MODULE = fileURLToPath(new URL('./src/scripts/background-dome.js', import.meta.url));
const GROUND_MODULE = fileURLToPath(new URL('./src/scripts/ground-reflection.js', import.meta.url));
const SHADOW_CATCHER_PATCH = fileURLToPath(new URL('./src/scripts/shadow-catcher.patch.wgsl', import.meta.url));
const FISHEYE_MODULE = fileURLToPath(new URL('./src/scripts/fisheye.js', import.meta.url));
// bucket rendering (distributed rendering, src/scripts/distributed/bucket.js): fisheye ray and noise in the full image
const BUCKET_MODULE = fileURLToPath(new URL('./src/scripts/distributed/bucket.js', import.meta.url));
// fisheye ray + depth of field with a spherical focus surface (distance along the ray) and the aperture
// perpendicular to the ray – the shim's flat focal plane divides by dot( direction, forward ) (0 at 90°)
const FISHEYE_DOF = `
			if ( \${ __FISHEYE }( \${ __BUCKET_UV }( uv ) * 2.0 - vec2f( 1.0 ), \${ cameraWorldMatrix }, ray ) ) {

				let fisheyeFocus = ray.origin + ray.direction * \${ focusDistance };
				var fisheyeAperture = \${ sampleAperture }( \${ apertureBlades }, \${ rand3 }( \${ RNG_INDEX_APERTURE_SAMPLE } ) );
				fisheyeAperture = \${ rotateVector }( fisheyeAperture * \${ bokehSize } * 0.5 * 1e-3, \${ apertureRotation } )
					* vec2f( \${ anamorphicRatio }, 1.0 / \${ anamorphicRatio } );
				let fisheyeUp = normalize( ( \${ cameraWorldMatrix } * vec4f( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
				let fisheyeHelper = select( fisheyeUp, normalize( ( \${ cameraWorldMatrix } * vec4f( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), abs( dot( fisheyeUp, ray.direction ) ) > 0.99 );
				let fisheyeX = normalize( cross( ray.direction, fisheyeHelper ) );
				let fisheyeY = cross( fisheyeX, ray.direction );
				ray.origin += fisheyeX * fisheyeAperture.x + fisheyeY * fisheyeAperture.y;
				ray.direction = normalize( fisheyeFocus - ray.origin );
				return true;

			}`;
function shadowCatcherPatch() {
  const anchor = /if \( materialInfo\.matte != 0 && bounce == 0u \) \{\s*resultColor = vec4f\( 0\.0 \);\s*break;\s*\}/;
  return {
    name: 'rindr-shadow-catcher',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      // fisheye lens (src/scripts/fisheye.js): the base camera ray of the PhysicalCamera gets the fisheye direction
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/shims/PhysicalCameraShim.js')) {
        const base = '*ray = ${ ndcToCameraRay }( ndc, ${ invViewProjectionMatrix } );';
        if (code.split(base).length !== 2) this.error('rindr-fisheye: base ray not found exactly once in PhysicalCameraShim.js (three-gpu-pathtracer changed?)');
        code = code.replace(base, () => base + FISHEYE_DOF);
        return { code: `import { FISHEYE_RAY as __FISHEYE } from ${JSON.stringify(FISHEYE_MODULE)};\n`
          + `import { BUCKET_UV_WGSL as __BUCKET_UV } from ${JSON.stringify(BUCKET_MODULE)};\n` + code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      if (!anchor.test(code)) this.error('rindr-shadow-catcher: matte branch not found in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)');
      code = code.replace(anchor, m => gate('ground', readFileSync(SHADOW_CATCHER_PATCH, 'utf8'), m));
      // background dome: the three lookups by ray direction
      // ground reflection, model only (shadow-catcher.patch.wgsl): the reflection ray's next segment decides –
      // a miss ends the path (the ground was already counted), a hit takes the counted ground back
      const mirrorVars = /\n(\t+)for \( var bounce = 0u; bounce < maxBounces; bounce \+\+ \) \{/;
      const mirrorCheck = /let surfaceDist = select\( \$\{ LIGHT_FAR_DISTANCE \}, hitResult\.dist, didHit \);\n/;
      for (const re of [mirrorVars, mirrorCheck]) if ((code.match(new RegExp(re.source, 'g')) || []).length !== 1) this.error(`rindr-shadow-catcher: ${re} not found exactly once in PathTracerMegaKernel.js`);
      // scMirrorTaken: the take-back happened in this segment – a volume box passed without scattering (volume-walk.patch.wgsl)
      // arms the check again (the ray went on to the HDRI inside a splat box with the background hidden)
      code = code.replace(mirrorVars, m => '\n\t\t\t\tvar scMirrorBg = vec3f( 0.0 );\n\t\t\t\tvar scMirrorPending = false;\n\t\t\t\tvar scMirrorTaken = false;' + m);
      code = code.replace(mirrorCheck, m => m + `
					scMirrorTaken = false;
					if ( scMirrorPending ) {

						scMirrorPending = false;
						if ( ! didHit ) {

							break;

						}
						resultColor -= vec4f( scMirrorBg, 0.0 );
						scMirrorTaken = true;

					}
`);
      for (const [from, to] of [
        ['${ sampleBackground }( ray.direction, rng )', '${ sampleBackground }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ), rng )'],
        ['${ sampleEnvColor }( ray.direction ).rgb * throughputColor * misWeight', '${ sampleEnvColor }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ) ).rgb * throughputColor * misWeight'],
        ['let env = ${ sampleEnvColor }( ray.direction );', 'let env = ${ sampleEnvColor }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ) );'],
      ]) {
        if (code.split(from).length !== 2) this.error(`rindr-shadow-catcher: "${from}" not found exactly once in PathTracerMegaKernel.js`);
        code = code.replace(from, () => to);
      }
      return {
        code: `import { SHADOW_CATCHER as __SC } from ${JSON.stringify(SHADOW_CATCHER_MODULE)};\n` +
          `import { DOME_DIRECTION as __DOME } from ${JSON.stringify(DOME_MODULE)};\n` +
          `import { GROUND_SURFACE_WGSL as __GROUND } from ${JSON.stringify(GROUND_MODULE)};\n` + code,
        map: null,
      };
    },
  };
}

// Patches three-gpu-pathtracer against main-thread stalls when switching to HQ (fails loudly if the library
// changed – check on every update):
// - environment importance sampling: EquirectHdrInfoNode.updateFrom takes the table computed in a worker
//   (src/scripts/env-cdf.js) instead of computing it on the main thread
// - TextureCache.setFromScene hashed the uuid of a fresh clone → never equal → every updateEnvironment()
//   rebuilt environment and background (useMegakernel: table computed twice)
// - EquirectHdrInfoUniform: `Source` → `TextureSource` (renamed in three r186, the old name warns in the console)
const ENV_CDF_MODULE = fileURLToPath(new URL('./src/scripts/env-cdf.js', import.meta.url));
function pathTracerPerfPatch() {
  return {
    name: 'rindr-pathtracer-perf',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const replaceOnce = (from, to, name) => {
        if (code.split(from).length !== 2) this.error(`rindr-pathtracer-perf: "${from.trim()}" not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, () => to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/EquirectHdrInfoNode.js')) {
        replaceOnce('super.updateFrom( envMap );', 'if ( ! __applyEnvCdf( this, envMap ) ) super.updateFrom( envMap );', 'EquirectHdrInfoNode.js');
        return { code: `import { applyEnvCdf as __applyEnvCdf } from ${JSON.stringify(ENV_CDF_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/uniforms/EquirectHdrInfoUniform.js')) {
        replaceOnce(' HalfFloatType, Source, ', ' HalfFloatType, TextureSource, ', 'EquirectHdrInfoUniform.js');
        replaceOnce('new Source(', 'new TextureSource(', 'EquirectHdrInfoUniform.js');
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/WebGPUPathTracer.js')) {
        replaceOnce(`value = value.clone();
			hash = value.uuid + '_' + value.version;`, `hash = value.uuid + '_' + value.version;
			value = value.clone();`, 'WebGPUPathTracer.js');
        return { code, map: null };
      }
      return null;
    },
  };
}

// Texture atlas of three-gpu-pathtracer (AtlasTexture.js): the table of texture placements (textureInfo) goes to the
// shader as a uniform array whose size three.js fixes when the pipeline is built (setScene). Textures added later
// (assigning a material with new maps, node graph maps baked afterwards) had no slot in the buffer – materials read
// stale/empty placements, i.e. the wrong part of the atlas (tiles swapped, black/white stripes of another map; user
// report Oct. 2026, HQ only). The table is padded to a fixed capacity (256, grows in powers of two); pathtracer.js
// rebuilds the scene if it ever grows beyond what the pipeline was built with.
function atlasCapacityPatch() {
  return {
    name: 'rindr-atlas-capacity',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/AtlasTexture.js')) return null;
      const from = `\t\tif ( info.length === 0 ) {

\t\t\tinfo.push( new Vector4( 0, 0, 0, 0 ) );

\t\t}`;
      if (code.split(from).length !== 2) this.error('rindr-atlas-capacity: textureInfo padding not found exactly once in AtlasTexture.js (three-gpu-pathtracer changed?)');
      return {
        code: code.replace(from, () => `\t\t// RINDR: fixed capacity (uniform array size is fixed when the pipeline is built)
\t\tthis.capacity = Math.max( this.capacity || 256, 2 ** Math.ceil( Math.log2( Math.max( info.length, 1 ) ) ) );
\t\twhile ( info.length < this.capacity ) info.push( new Vector4( 0, 0, 0, 0 ) );`),
        map: null,
      };
    },
  };
}

// Bucket rendering (distributed rendering): the megakernel seeds its sampler with the full image's pixel – every
// bucket would otherwise repeat the same noise pattern (src/scripts/distributed/bucket.js)
function bucketPatch() {
  return {
    name: 'rindr-bucket',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const from = '${ rngInit }( indexUV.xy, seed, 0 );';
      if (code.split(from).length !== 2) this.error('rindr-bucket: rngInit not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)');
      return {
        code: `import { BUCKET_PIXEL_WGSL as __BUCKET_PIXEL } from ${JSON.stringify(BUCKET_MODULE)};\n`
          + code.replace(from, () => '${ rngInit }( ${ __BUCKET_PIXEL }( indexUV.xy ), seed, 0 );'),
        map: null,
      };
    },
  };
}

// Stable kernel text (Oct. 2026, user: mapping changes took long in HQ): the texture info uniform array of the BVH
// data is created anew with every path tracer scene and was unnamed → three names it NodeBuffer_<node id>, the id
// differs per scene → the megakernel's WGSL differed only in that name and missed the browser's shader cache: every
// scene rebuild (UV mapping, part quality, added model) compiled ~10 s instead of ~0.1 s. The library's own comment
// says the node "must be named textureInfo" – it just never set the name.
function stableKernelPatch() {
  return {
    name: 'rindr-stable-kernel',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) return null;
      const from = `const textureInfo = uniformArray( textureAtlas.textureInfo, 'uvec4' );`;
      if (code.split(from).length !== 2) this.error('rindr-stable-kernel: textureInfo uniform not found exactly once in PathtracerBVHComputeData.js (three-gpu-pathtracer changed?)');
      return { code: code.replace(from, () => `const textureInfo = uniformArray( textureAtlas.textureInfo, 'uvec4' ).setName( 'textureInfo' );   // RINDR: stable WGSL name`), map: null };
    },
  };
}

// Material stand-ins in three-gpu-pathtracer (src/scripts/pt-stand-in.js, RindrMaterial in toon.js – fails loudly if
// the library changed, check on every update): the material packing reads userData.ptStandIn over each material.
// - subsurface look: translucent share as rough transmission, gloss as clearcoat, colour absorbed over the
//   distance travelled inside. A random walk in the megakernel looked good but took 2–5× the render time of plain
//   plastic (Oct. 2026) – the user chose this fast approximation instead.
// - glowing marble (marble.js): flag in the unused fogVolume field (ptVolume 2), colour/scale/intensity in the
//   sheen/iridescence fields (off for these materials); the megakernel adds the glow seen through a front face
//   (MARBLE_WGSL in marble-pt.js, same function as the raster view) as emission. Wavefront kernels: no glow.
const PT_STAND_IN_MODULE = fileURLToPath(new URL('./src/scripts/pt-stand-in.js', import.meta.url));
const MARBLE_MODULE = fileURLToPath(new URL('./src/scripts/materials/marble-pt.js', import.meta.url));
const MARBLE_EMISSION = `
						// RINDR glowing marble (marble.js): the veins inside, seen through the front face
						if ( materialInfo.fogVolume == 2 && hitResult.side > 0.0 ) {

							let mbOrigin = ( objectInfo.inverseMatrixWorld * vec4f( vertexData.position.xyz, 1.0 ) ).xyz;
							let mbDir = normalize( ( objectInfo.inverseMatrixWorld * vec4f( ray.direction, 0.0 ) ).xyz );
							let mbCos = saturate( abs( dot( hitResult.normal, ray.direction ) ) );
							let mbFresnel = 0.04 + 0.96 * pow( 1.0 - mbCos, 5.0 );
							let mbGlow = \${ __MARBLE }( mbOrigin, mbDir, materialInfo.sheenColor, materialInfo.sheenRoughness, materialInfo.iridescenceThicknessMinimum, \${ rand1 }( 150u ) );
							resultColor += vec4f( \${ clampPathContributionFunc }( throughputColor * mbGlow * ( 1.0 - mbFresnel ), bounce, clampDirect, clampIndirect ), 0.0 );

						}

`;
function ptStandInPatch() {
  return {
    name: 'rindr-pt-stand-in',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-pt-stand-in: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        // kernel features (kernel-features.js): what the materials need, collected while their data is packed
        replaceOnce('// features.reset();', () => '__kernelFeatures.begin();');
        replaceOnce('const m = materials[ i ];', () => 'const m = __kernelFeatures.see( __ptStandIn( materials[ i ] ), materials[ i ] );');
        replaceOnce(/\n(\t+)this\.getRootObject\(\)\.traverse\( o => \{\n/, (m, tab) => `\n${tab}__kernelFeatures.shown.clear();${m}${tab}\t__kernelFeatures.object( o );\n`);
        replaceOnce(/(intArray\[ index \+\+ \] = Number\( m\.transparent \);\n\t+intArray\[ index \+\+ \] = )0;/, (_, head) => `${head}getField( m, 'ptVolume', 0 );`);
        return { code: `import { ptStandIn as __ptStandIn } from ${JSON.stringify(PT_STAND_IN_MODULE)};\n`
          + `import { kernelFeatures as __kernelFeatures } from ${JSON.stringify(KERNEL_FEATURES_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n(\t+)\/\/ emission, clamped at the depth of the segment that found it/, m => '\n' + gate('marble', MARBLE_EMISSION) + m.slice(1));
        return { code: `import { MARBLE_WGSL as __MARBLE } from ${JSON.stringify(MARBLE_MODULE)};\n` + code, map: null };
      }
      return null;
    },
  };
}

// OpenPBR in the path tracer (docs/material-format.md, Oct. 2026): what three-gpu-pathtracer's material does not cover
// yet – coat IOR (fixed 1.5 there) and coat colour (OpenPBR coat_color: tints everything below the coat), the metal
// edge tint after OpenPBR's F82-tint model with specular_color (Schlick before; white = exactly Schlick, so every
// existing material looks as before). The new material fields sit in padding slots of the packed struct (coat IOR
// after clearcoatNormalMap, coat colour before the map transforms) – size and layout stay. Diffuse roughness (EON),
// dispersion, specular colour, anisotropy, thin film IOR/thickness the library reads already (material-manager.js
// sets them). Fails loudly if the library changed.
const F82_CONDUCTOR = `
	fn conductorFresnel( VdotH: f32, f0: vec3f, specular: vec3f ) -> vec3f {

		// OpenPBR F82-tint: Schlick, pulled towards specular × Schlick at mu = 1/7 (the "82°" point)
		let mu = abs( VdotH );
		let schlick = schlickFresnelVec( mu, f0, vec3f( 1 ) );
		let muBar = 1.0 / 7.0;
		let schlickBar = schlickFresnelVec( muBar, f0, vec3f( 1 ) );
		let b = schlickBar * ( vec3f( 1.0 ) - specular );
		let w = mu * pow( 1.0 - mu, 6.0 ) / ( muBar * pow( 1.0 - muBar, 6.0 ) );
		return clamp( schlick - w * b, vec3f( 0.0 ), vec3f( 1.0 ) );

	}
`;
function openPbrPatch() {
  return {
    name: 'rindr-openpbr',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-openpbr: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      const replaceAll = (from, to, count) => {
        const n = code.split(from).length - 1;
        if (n !== count) this.error(`rindr-openpbr: ${from} found ${n}× instead of ${count}× in ${name} (three-gpu-pathtracer changed?)`);
        code = code.split(from).join(to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/structs.wgsl.js')) {
        // material struct: into the padding (float after the int at offset 22; three floats before the mat3 at 72)
        replaceOnce(/\n(\t)clearcoatNormalMap: 'int',\n/, (m, tab) => `${m}${tab}coatIor: 'float',\n`);
        replaceOnce(/\n(\t)anisotropyMap: 'int',\n/, (m, tab) => `${m}${tab}coatColorR: 'float',\n${tab}coatColorG: 'float',\n${tab}coatColorB: 'float',\n`);
        // surface record
        replaceOnce(/\n(\t)clearcoatRoughness: 'f32',\n/, (m, tab) => `${m}${tab}coatIor: 'f32',\n${tab}coatColor: 'vec3f',\n`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        replaceOnce(/(intArray\[ index \+\+ \] = getTexture\( m, 'clearcoatNormalMap' \);\n\t+)index \+\+; \/\/ because of vec2 alignment/,
          (_, head) => `${head}floatArray[ index ++ ] = getField( m, 'coatIor', 1.5 ); // rindr-openpbr (was padding)`);
        replaceOnce(/(intArray\[ index \+\+ \] = getTexture\( m, 'anisotropyMap' \);\n(\t+))index \+\+; \/\/ padding for mat3 alignment\n\t+index \+\+;\n\t+index \+\+;/,
          (_, head, tab) => `${head}// rindr-openpbr: coat colour (was padding)\n${tab}floatArray[ index ++ ] = m.coatColor ? m.coatColor.r : 1.0;\n`
            + `${tab}floatArray[ index ++ ] = m.coatColor ? m.coatColor.g : 1.0;\n${tab}floatArray[ index ++ ] = m.coatColor ? m.coatColor.b : 1.0;`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/material.wgsl.js')) {
        replaceOnce(/\n(\t+)surf\.clearcoat = clearcoat;\n/, (m, tab) => `${m}${tab}surf.coatIor = max( material.coatIor, 1.0 );\n`
          + `${tab}surf.coatColor = vec3f( material.coatColorR, material.coatColorG, material.coatColorB );\n`);
        replaceOnce(/\n\tfn conductorFresnel\( VdotH: f32, f0: vec3f, specular: vec3f \) -> vec3f \{\n[\s\S]*?\n\t\}\n/, () => F82_CONDUCTOR);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/materials/GltfCompliantMaterial.js')) {
        replaceAll('${ iorToF0Func }( 1.5 )', '${ iorToF0Func }( surf.coatIor )', 2);
        replaceOnce('surf.clearcoatRoughness, 1.5 )', 'surf.clearcoatRoughness, surf.coatIor )');
        replaceAll('${ CLEARCOAT_IOR }', 'surf.coatIor', 2);
        replaceOnce(/\n(\t+)attenuation \*= 1\.0 - surf\.clearcoat \* clearcoatFresnelEnergySS;\n/, (m, tab) => `${m}${tab}// rindr-openpbr: what lies below goes through the coat's colour\n${tab}attenuation *= mix( vec3f( 1.0 ), surf.coatColor, surf.clearcoat );\n`);
        replaceOnce('${ this.conductorFresnel }( ctx.VdotH, surf.color, vec3f( 1.0 ) )', '${ this.conductorFresnel }( ctx.VdotH, surf.color, surf.specularColor )');
        return { code, map: null };
      }
      return null;
    },
  };
}

// Scattering media (src/scripts/materials/medium.js, docs/material-format.md – fails loudly if the library changed,
// check on every update): OpenPBR transmission_scatter and subsurface in the accurate mode as a real homogeneous medium
// inside the mesh – a random walk in the megakernel (medium-walk.patch.wgsl, kernel feature 'medium').
// - material struct: scattering coefficient (per world unit), anisotropy, tint flag appended after the last map
//   transform (the struct grows by 8 floats; the absorption stays in attenuationColor / attenuationDistance)
// - surface record: transmissionTint – the colour the glass lobe tints with: the base colour as before, white for
//   subsurface (its colour comes from the medium; the base colour belongs to the diffuse share)
// - megakernel: the walk on back-face hits; no absorption of the library on stretches it handled; no light sample on
//   the exit face after scattering (the events' light samples carry that light already)
const MEDIUM_WALK_PATCH = fileURLToPath(new URL('./src/scripts/medium-walk.patch.wgsl', import.meta.url));
function mediumPatch() {
  return {
    name: 'rindr-medium',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-medium: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/structs.wgsl.js')) {
        replaceOnce(/\n(\t)anisotropyMapTransform: 'mat3',\n/, (m, tab) => `${m}${tab}// rindr-medium\n${tab}mediumScatter: 'vec3',\n${tab}mediumAnisotropy: 'float',\n${tab}mediumTint: 'float',\n`);
        replaceOnce(/\n(\t)clearcoatRoughness: 'f32',\n/, (m, tab) => `${m}${tab}transmissionTint: 'vec3f',\n`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        replaceOnce(/\n(\t+)index \+= writeTextureMatrixToArray\( m, 'anisotropyMap', floatArray, index \);\n/, (m, tab) => `${m}
${tab}// rindr-medium: scattering coefficient, anisotropy, tint flag (+ padding to the struct's alignment)
${tab}const rindrScatter = getField( m, 'mediumScatter', null );
${tab}floatArray[ index ++ ] = rindrScatter ? rindrScatter.r : 0.0;
${tab}floatArray[ index ++ ] = rindrScatter ? rindrScatter.g : 0.0;
${tab}floatArray[ index ++ ] = rindrScatter ? rindrScatter.b : 0.0;
${tab}floatArray[ index ++ ] = getField( m, 'mediumAnisotropy', 0.0 );
${tab}floatArray[ index ++ ] = getField( m, 'mediumTint', 0.0 );
${tab}index += 3;
`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/material.wgsl.js')) {
        replaceOnce(/\n(\t+)surf\.clearcoat = clearcoat;\n/, (m, tab) => `${m}${tab}surf.transmissionTint = mix( surf.color, vec3f( 1.0 ), material.mediumTint );\n`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/materials/GltfCompliantMaterial.js')) {
        replaceOnce('result += ( 1.0 - surf.metalness ) * surf.transmission * refraction * surf.color;', () => 'result += ( 1.0 - surf.metalness ) * surf.transmission * refraction * surf.transmissionTint;');
        replaceOnce(/result\.color = \( 1\.0 - surf\.metalness \) \* surf\.transmission \* surf\.color \*\n/, m => m.replace('surf.color', 'surf.transmissionTint'));
        return { code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      replaceOnce(/\n(\t+)var transparentBounce = 0u;/, (m, tab) => `${m}\n${tab}var mdScattered = false;\n${tab}var mdPassed = false;\n${tab}var mdNoLight = false;\n${tab}var mdEvents = 0u;`);
      replaceOnce(/\n\t+materialInfo\.opacity \*= objectInfo\.color\.a;\n/, m => m + gate('medium', readFileSync(MEDIUM_WALK_PATCH, 'utf8')));
      replaceOnce('if ( hitResult.side < 0.0 && materialInfo.transmission > 0.0 ) {', () => 'if ( hitResult.side < 0.0 && materialInfo.transmission > 0.0 && ! mdPassed ) {');
      replaceOnce(/(\/\/ next event estimation: draw one light or the environment, each with\n\t+\/\/ probability 1 \/ lightsDenom\n\t+)if \( misEnabled != 0u && lightsDenom > 0\.0 \) \{/,
        (_, head) => `${head}if ( misEnabled != 0u && lightsDenom > 0.0 && ! mdNoLight ) {`);
      return { code, map: null };
    },
  };
}

// Refraction bounces (src/scripts/pt-motion.js): refractions up to PT_MOTION.glassBounces do not use up the bounce
// budget of the megakernel – glass gets its own limit (setting "Bounces refraction"); with the 3 bounces of the motion
// mode glass was black (fails loudly if the library changed, check on every update).
const PT_MOTION_MODULE = fileURLToPath(new URL('./src/scripts/pt-motion.js', import.meta.url));
function glassBouncesPatch() {
  return {
    name: 'rindr-glass-bounces',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const loop = /\n(\t+)for \( var bounce = 0u; bounce < maxBounces; bounce \+\+ \) \{/;
      const next = /\n(\t+)ray\.origin = \$\{ offsetRayOriginFunc \}\( vertexData\.position\.xyz, scatterRec\.direction, hitResult\.normal \);/;
      for (const re of [loop, next]) if ((code.match(new RegExp(re.source, 'g')) || []).length !== 1) this.error(`rindr-glass-bounces: ${re} not found exactly once in PathTracerMegaKernel.js`);
      // the budget raises the loop's limit (instead of `bounce --`: a mirror reflection then restarted at bounce 0 and
      // the environment it hit was drawn as the directly seen background – chrome turned black)
      code = code.replace(loop, (m, tab) => `\n${tab}var glassBounce = 0u;\n${tab}for ( var bounce = 0u; bounce < maxBounces + glassBounce; bounce ++ ) {`);
      // end of the iteration (after Russian roulette): a refraction, any scatter at glass (also its reflections – total
      // reflection inside counted as a bounce darkened glass with few bounces) or – while orbiting – a smooth mirror
      // reflection (chrome: mirror in mirror) within the budget does not count
      code = code.replace(next, (m, tab) => `\n${tab}if ( ( scatterRec.isTransmissive || surface.transmission > 0.5 || ( \${ __PT_MOTION.mirrors } != 0u && surface.metalness > 0.9 && surface.roughness < 0.1 ) ) && glassBounce < \${ __PT_MOTION.glassBounces } ) {\n\n${tab}\tglassBounce ++;\n\n${tab}}\n` + m);
      return { code: `import { PT_MOTION as __PT_MOTION } from ${JSON.stringify(PT_MOTION_MODULE)};\n` + code, map: null };
    },
  };
}

// Glass shadows (src/scripts/glass-shadow.js): shadow rays through glass (next event estimation + shadow catcher), the
// colour fringe, and no caustic paths while that is on (fails loudly if the library changed – check on every update).
const GLASS_SHADOW_MODULE = fileURLToPath(new URL('./src/scripts/glass-shadow.js', import.meta.url));
const GLASS_SHADOW_PATCH = fileURLToPath(new URL('./src/scripts/glass-shadow.patch.wgsl', import.meta.url));
function glassShadowPatch() {
  return {
    name: 'rindr-glass-shadow',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      // kernel features: without glass and volumes in the scene a plain occlusion test (every hit blocks – what the
      // snippet does then as well)
      const snippet = ({ origin, dir, maxDist, normal, primary }) => gate('glass,volume,gaussians', readFileSync(GLASS_SHADOW_PATCH, 'utf8')
        .replace(/\$ORIGIN/g, origin).replace(/\$DIR/g, dir).replace(/\$MAXDIST/g, maxDist)
        .replace(/\$NORMAL/g, normal).replace(/\$PRIMARY/g, primary), `
											var gsShadow = vec3f( 1.0 );
											var gsGlass = false;
											{

												var gsRay: \${ rayStruct };
												gsRay.origin = \${ offsetRayOriginFunc }( ${origin}, ${dir}, ${normal} );
												gsRay.direction = ${dir};
												gsRay.maxDist = ${maxDist};
												var gsHit: \${ raycastOutput };
												if ( \${ raycastFirstHitFn }( gsRay, &gsHit ) ) {

													gsShadow = vec3f( 0.0 );

												}

											}
`) + gate('gaussians', `
											// traced Gaussian splats (gaussian-pt.js): the light passing them on the way
											if ( \${ __GX.on } > 0.5 ) {

												gsShadow *= \${ __GX.transmittance }( ${origin}, ${dir}, ${maxDist}, u32( \${ rand1 }( 214u ) * 4294967040.0 ) );

											}
`) + '\n';
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-glass-shadow: ${from} not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      // markers of other patches: shadow catcher (shadow-catcher.patch.wgsl, rindr-shadow-catcher) and the light samples
      // of the volume walk (volume-walk.patch.wgsl, rindr-cloud), the traced Gaussians and the medium walk
      // (medium-walk.patch.wgsl, rindr-medium) – all inserted before this plugin
      const markers = /\n\t*\/\/@glass-shadow ([^\n]+)/g;
      if ((code.match(markers) || []).length !== 4) this.error('rindr-glass-shadow: expected 4 //@glass-shadow markers in PathTracerMegaKernel.js (shadow catcher, volume walk, traced Gaussians, medium walk)');
      code = code.replace(markers, (_, args) => {
        const [origin, dir, maxDist, normal, primary] = args.split('|').map(a => a.trim());
        return '\n' + snippet({ origin, dir, maxDist, normal, primary });
      });
      // next event estimation: transmitted light instead of a plain occlusion test; through glass the full weight
      // (the bsdf-sampled counterpart is a caustic path, not counted, see below)
      replaceOnce(/\n\t+var shadowHit: \$\{ raycastOutput \};\n\t+let occluded = \$\{ raycastFirstHitFn \}\( shadowRay, &shadowHit \);\n(\t+)if \( ! occluded \) \{/,
        (_, tab) => '\n' + snippet({ origin: 'vertexData.position.xyz', dir: 'lightRec.direction', maxDist: 'shadowRay.maxDist', normal: 'hitResult.normal', primary: 'bounce == 0u' })
          + `${tab}if ( any( gsShadow > vec3f( 0.0 ) ) ) {`);
      replaceOnce('${ isMISWeightLightFn }( lightRec.lightType ) );', () => '${ isMISWeightLightFn }( lightRec.lightType ) && ! gsGlass );');
      replaceOnce('let directLight = throughputColor * lightRec.emission * evalRec.color * misWeight / lightPdf;',
        () => 'let directLight = throughputColor * lightRec.emission * evalRec.color * misWeight * gsShadow / lightPdf;');
      // caustic paths: a refraction after a rough bounce (low pdf, not transmissive) – their light/environment hit is
      // dropped while glass shadows are transparent
      replaceOnce(/\n(\t+)var transparentBounce = 0u;/, (m, tab) => `${m}\n${tab}var gsRough = false;\n${tab}var gsCaustic = false;`);
      replaceOnce(/\n(\t+)minPdf = min\( minPdf, scatterRec\.pdf \);/, (m, tab) => `${m}\n\n${tab}if ( ! scatterRec.isTransmissive && scatterRec.pdf < 4.0 ) {\n\n${tab}\tgsRough = true;\n${tab}\tgsCaustic = false;\n\n${tab}} else if ( scatterRec.isTransmissive && gsRough ) {\n\n${tab}\tgsCaustic = true;\n\n${tab}}`);
      const drop = '( gsCaustic && ${ __GS.mode } == 1u )';
      replaceOnce('let contribution = ${ clampPathContributionFunc }( environment, bounce, clampDirect, clampIndirect );',
        () => `let contribution = select( \${ clampPathContributionFunc }( environment, bounce, clampDirect, clampIndirect ), vec3f( 0.0 ), ${drop} );`);
      replaceOnce('let lightHit = ${ clampPathContributionFunc }( lightRec.emission * throughputColor * misWeight, bounce, clampDirect, clampIndirect );',
        () => `let lightHit = select( \${ clampPathContributionFunc }( lightRec.emission * throughputColor * misWeight, bounce, clampDirect, clampIndirect ), vec3f( 0.0 ), ${drop} );`);
      // __GX (traced Gaussians) is imported by rindr-gaussians, which runs before
      return { code: `import { GLASS_SHADOW as __GS } from ${JSON.stringify(GLASS_SHADOW_MODULE)};\n` + code, map: null };
    },
  };
}

// Glass split (src/scripts/glass-split.js – fails loudly if the library changed, check on every update): at the first
// glass hits of the camera ray (entry and exit face) the reflection is traced as a path of its own instead of being
// picked by chance.
// - GltfCompliantMaterial.bsdfSample: the lobe random number is stratified at the end of the reflection side
//   (GLASS_SPLIT.mode / share)
// - megakernel: an outer loop runs the bounce loop again for each stored reflection ray (small stack); every variable
//   of a path (incl. those of other patches: glass shadow, shadow catcher, glass/film bounces) is declared anew inside it.
//   Runs after rindr-glass-shadow (takes over gsRough for the reflection).
const GLASS_SPLIT_MODULE = fileURLToPath(new URL('./src/scripts/glass-split.js', import.meta.url));
const GLASS_SPLIT_STRATA = `
				// RINDR glass split (glass-split.js): split point = end of the reflection side – clearcoat, specular and
				// the reflected share of the glass lobe at the microfacet of directionUV (the same one the glass lobe uses)
				if ( \${ __SPLIT.mode } != 0u ) {

					let rsAlphaB = surf.roughness * surf.roughness;
					let rsAlpha = vec2( mix( rsAlphaB, 1.0, surf.anisotropy * surf.anisotropy ), rsAlphaB );
					let rsWh = \${ ggxDirectionFunc }( wo, rsAlpha, directionUV );
					let rsFresnel = \${ this.transmissionFresnel }( select( dot( wo, rsWh ), wo.z, surf.thinWall ), surf );
					let rsSplit = cdfSpecular + ( cdfTransmission - cdfSpecular ) * rsFresnel.reflectProbability;
					\${ __SPLIT.share } = select( 0.0, rsSplit / cdfTotal, cdfTotal > 0.0 );
					if ( \${ __SPLIT.mode } == 3u ) {

						return result;

					}
					let rsU = lobeSample / max( cdfTotal, 1e-30 );
					lobeSample = select( rsSplit + rsU * ( cdfTotal - rsSplit ), rsU * rsSplit, \${ __SPLIT.mode } == 1u );

				}
`;
const GLASS_SPLIT_SCATTER = `
						// RINDR glass split (glass-split.js): glass hit on the camera ray's chain of refractions (up to
						// \${ __SPLIT_MAX } per pixel – entry and exit face) – the reflection stratum goes onto the stack as a path
						// of its own, this path continues with the refraction stratum; each weighted by its stratum's width
						var rsWeight = 1.0;
						if ( rsSplits < \${ __SPLIT_MAX }u && isFullyTransmissive && surface.transmission > 0.0 && \${ __SPLIT.enabled } != 0u ) {

							\${ __SPLIT.mode } = 3u;
							_ = \${ bsdfSampleFn }( view, surface );
							let rsShare = \${ __SPLIT.share };
							\${ __SPLIT.mode } = 0u;
							if ( rsShare > 1e-4 && rsShare < 0.9999 ) {

								rsSplits ++;
								\${ __SPLIT.mode } = 1u;
								let rsRefl = \${ bsdfSampleFn }( view, surface );
								if ( ! \${ isTerminatingScatterFunc }( rsRefl ) ) {

									var rsRay: \${ rayStruct };
									rsRay.origin = \${ offsetRayOriginFunc }( vertexData.position.xyz, rsRefl.direction, hitResult.normal );
									rsRay.direction = rsRefl.direction;
									rsRay.maxDist = 0.0;
									rsRays[ rsTop ] = rsRay;
									rsThroughputs[ rsTop ] = throughputColor * rsRefl.color / rsRefl.pdf * rsShare;
									rsPdfs[ rsTop ] = rsRefl.pdf;
									rsMinPdfs[ rsTop ] = min( minPdf, rsRefl.pdf );
									rsWavelengths[ rsTop ] = dispersionWavelength;
									rsRough[ rsTop ] = gsRough || ( ! rsRefl.isTransmissive && rsRefl.pdf < 4.0 );
									rsCounts[ rsTop ] = vec4u( bounce + 1u, transparentBounce, glassBounce, filmBounce );
									rsTop ++;

								}
								\${ __SPLIT.mode } = 2u;
								rsWeight = 1.0 - rsShare;

							}

						}
						var scatterRec = \${ bsdfSampleFn }( view, surface );
						\${ __SPLIT.mode } = 0u;
						scatterRec.color *= rsWeight;
`;
// most splits per pixel sample: entry and exit face of a glass body (each adds a path)
const GLASS_SPLIT_MAX = 2;
function glassSplitPatch() {
  return {
    name: 'rindr-glass-split',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-glass-split: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      const head = `import { GLASS_SPLIT as __SPLIT } from ${JSON.stringify(GLASS_SPLIT_MODULE)};\nconst __SPLIT_MAX = ${GLASS_SPLIT_MAX};\n`;
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/materials/GltfCompliantMaterial.js')) {
        replaceOnce(/\n(\t+)let lobeSample = (\$\{ rand1 \}\( \$\{ RNG_INDEX_SCATTER_TYPE \} \) \* cdfTotal;\n\t+let directionUV = \$\{ rand2 \}\( \$\{ RNG_INDEX_SCATTER_DIRECTION \} \);\n)/,
          (_, tab, rest) => `\n${tab}var lobeSample = ${rest}` + GLASS_SPLIT_STRATA);
        return { code: `import { GLASS_SPLIT as __SPLIT } from ${JSON.stringify(GLASS_SPLIT_MODULE)};\n` + code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      // outer loop: each pass declares every path variable anew, a pass from the stack then takes over its reflection
      replaceOnce(/\n(\t+)var resultColor = vec4f\( 0, 0, 0, 1 \);\n/, (m, tab) => `${m}
${tab}// RINDR glass split (glass-split.js): reflections at glass hits, traced after this path (stack)
${tab}var rsRays: array<\${ rayStruct }, \${ __SPLIT_MAX }>;
${tab}var rsThroughputs: array<vec3f, \${ __SPLIT_MAX }>;
${tab}var rsPdfs: array<f32, \${ __SPLIT_MAX }>;
${tab}var rsMinPdfs: array<f32, \${ __SPLIT_MAX }>;
${tab}var rsWavelengths: array<f32, \${ __SPLIT_MAX }>;
${tab}var rsRough: array<bool, \${ __SPLIT_MAX }>;
${tab}var rsCounts: array<vec4u, \${ __SPLIT_MAX }>;   // first bounce, transparent, glass and film bounces
${tab}var rsTop = 0u;
${tab}var rsSplits = 0u;
${tab}var rsFrom = 0u;   // bounce the pass starts with (0 = the camera ray)
${tab}for ( var rsPass = 0u; rsPass <= \${ __SPLIT_MAX }u; rsPass ++ ) {
`);
      replaceOnce(/\n(\t+)for \( var bounce = 0u; bounce < maxBounces \+ glassBounce \+ filmBounce; bounce \+\+ \) \{/, (m, tab) => `
${tab}if ( rsPass > 0u ) {

${tab}\trsTop --;
${tab}\tray = rsRays[ rsTop ];
${tab}\tthroughputColor = rsThroughputs[ rsTop ];
${tab}\tbsdfPdf = rsPdfs[ rsTop ];
${tab}\tminPdf = rsMinPdfs[ rsTop ];
${tab}\tisFullyTransmissive = false;
${tab}\tdispersionWavelength = rsWavelengths[ rsTop ];
${tab}\tgsRough = rsRough[ rsTop ];
${tab}\trsFrom = rsCounts[ rsTop ].x;
${tab}\ttransparentBounce = rsCounts[ rsTop ].y;
${tab}\tglassBounce = rsCounts[ rsTop ].z;
${tab}\tfilmBounce = rsCounts[ rsTop ].w;

${tab}}
${tab}for ( var bounce = rsFrom; bounce < maxBounces + glassBounce + filmBounce; bounce ++ ) {`);
      replaceOnce(/\n(\t+)let scatterRec = \$\{ bsdfSampleFn \}\( view, surface \);\n/, m => gate('glass', GLASS_SPLIT_SCATTER, m));
      replaceOnce(/\n(\t+)let nextSampleCount = sampleCount \+ 1;/, (m, tab) => `
${tab}\tif ( rsTop == 0u ) {

${tab}\t\tbreak;

${tab}\t}

${tab}}
${m}`);
      return { code: head + code, map: null };
    },
  };
}

// Light passes (src/scripts/light-passes.js – fails loudly if the library changed, check on every update): every
// contribution to a sample also goes into the pass of its source (light slot, environment, background, emission) and of
// its kind (diffuse, reflection, refraction after the first scatter – before it: emission / background seen directly),
// plus the shadow pass – in a second variant of the kernel's shader (the normal one stays unchanged; setLightPasses()
// switches). Everything per pixel in the bucket buffer (light-passes.js). Runs last: after rindr-glass-split (its stack
// carries the kind of a reflection path) and rindr-nan-guard (the passes see the sample before the guard replaces it).
// - GltfCompliantMaterial: bsdfLobes (a copy of bsdfEval keeping the lobe kinds apart) in its data for the kernel
// - megakernel: lpOn / lpB (this pixel in the bucket buffer), lpSplit (the path has scattered: its kind weights are stored)
const LIGHT_PASSES_MODULE = fileURLToPath(new URL('./src/scripts/light-passes.js', import.meta.url));
// pass indices as in light-passes.js (PASS)
const LP = { ENV: 4, BG: 5, EMISSION: 6, DIFFUSE: 7, DIRECT_EMISSION: 10, DIRECT_BG: 11, SHADOW: 12, TRANSPARENCY: 13, LAST_LIGHT: 3 };
// the share of the background a contribution of it carries (transparency pass – alpha = 1 − the sum)
const lpT = (tab, value) => `
${tab}if ( lpOn ) {

${tab}	\${ __LP_ADD }( lpB, ${LP.TRANSPARENCY}u, ${value} );

${tab}}`;
const LP_MIRROR_T = '\${ __LP_GET3 }( lpB, \${ __LP.SLOT.MT }u )';
// one-hot kind weights (diffuse, reflection, refraction)
const lpKind = k => `array<vec3f, 3>( ${[0, 1, 2].map(i => `vec3f( ${i === k ? 1 : 0}.0 )`).join(', ')} )`;
// kind weights of the lobes for a direction (bsdfLobes, added to the material by this plugin)
const lpLobes = dir => `\${ __LP_RATIO }( \${ bsdfLobesFn }( view, ${dir}, surface ) )`;
const lpW = slot => `\${ __LP_GETW }( lpB, \${ __LP.SLOT.${slot} }u )`;
const lpSetW = (slot, w) => `\${ __LP_SETW }( lpB, \${ __LP.SLOT.${slot} }u, ${w} );`;
// add `value` (vec3f expression, evaluated once) to pass `src` and to the kinds: the path's weights after its first scatter,
// before it the pass `direct` or the weights `directW`; mirror: the weights of the ground reflection counted ahead
function lpAdd(tab, src, value, { direct = null, directW = null, sign = '', mirror = false } = {}) {
  const otherwise = direct !== null ? `\${ __LP_ADD }( lpB, ${direct}u, lpC );` : `\${ __LP_KINDS }( lpB, ${directW}, lpC );`;
  const kinds = mirror ? `${tab}\t\${ __LP_KINDS }( lpB, ${lpW('MW')}, lpC );`
    : `${tab}\tif ( lpSplit ) {

${tab}\t\t\${ __LP_KINDS }( lpB, ${lpW('W')}, lpC );

${tab}\t} else {

${tab}\t\t${otherwise}

${tab}\t}`;
  return `
${tab}if ( lpOn ) {

${tab}\tlet lpC = ${sign}( ${value} );
${tab}\t\${ __LP_ADD }( lpB, ${src}, lpC );
${kinds}

${tab}}`;
}
const lpClear = tab => `
${tab}if ( lpOn ) {

${tab}\t\${ __LP_CLEAR }( lpB );

${tab}}`;
// the first scatter of the path: its kind from now on
const lpClassify = (tab, weights) => `
${tab}if ( lpOn && ! lpSplit ) {

${tab}\t${lpSetW('W', weights)}
${tab}\tlpSplit = true;

${tab}}`;
const lpLightSlot = index => `select( min( ${index}, ${LP.LAST_LIGHT}u ), ${LP.ENV}u, envActive && ${index} == lightsCount )`;
function lightPassesPatch() {
  return {
    name: 'rindr-light-passes',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceN = (from, to, n = 1) => {
        const count = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (count !== n) this.error(`rindr-light-passes: ${from} found ${count}× instead of ${n}× in ${name} (three-gpu-pathtracer or another patch changed?)`);
        code = typeof from === 'string' ? code.split(from).join(typeof to === 'function' ? to(from) : to) : code.replace(new RegExp(from.source, n > 1 ? 'g' : ''), to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/materials/GltfCompliantMaterial.js')) {
        // bsdfLobes( worldWo, worldWi, surf ): the value of each lobe kind for a direction – a copy of bsdfEval that keeps
        // them apart (only called while passes render; recording them inside bsdfEval cost ~7 % with the passes off)
        const start = code.indexOf('this._bsdfEvalFunc = wgslTagFn/* wgsl */`');
        const end = code.indexOf('`;', start);
        if (start < 0 || end < 0) this.error('rindr-light-passes: bsdfEval not found in GltfCompliantMaterial.js (three-gpu-pathtracer changed?)');
        let lobes = code.slice(start, end + 2).replace('this._bsdfEvalFunc', 'const lpEvalLobes');
        const swap = (from, to) => {
          if (lobes.split(from).length !== 2) this.error(`rindr-light-passes: ${from} not found exactly once in bsdfEval (three-gpu-pathtracer changed?)`);
          lobes = lobes.replace(from, () => to);
        };
        swap('fn bsdfEval( ctx: ${ bxdfContextStruct }, surf: ${ surfaceRecordStruct } ) -> vec3f {', 'fn bsdfEvalLobes( ctx: ${ bxdfContextStruct }, surf: ${ surfaceRecordStruct } ) -> array<vec3f, 3> {');
        swap('var result = vec3f( 0.0 );', 'var result = vec3f( 0.0 );\n\t\t\t\tvar lobes = array<vec3f, 3>( vec3f( 0.0 ), vec3f( 0.0 ), vec3f( 0.0 ) );');
        swap('return result;', 'return lobes;');
        const lobe = (statement, k) => swap(statement, `{ let lpE = ${statement.slice('result += '.length, -1)}; result += lpE; lobes[ ${k} ] += lpE; }`);
        lobe('result += surf.clearcoat * clearcoatFresnel * clearcoatSpecular;', 1);
        lobe('result += attenuation * surf.sheen * ${ sheenColorFunc }( ctx.V, ctx.L, ctx.H, surf );', 0);
        lobe('result += ( 1.0 - surf.metalness ) * surf.transmission * refraction * surf.transmissionTint;', 2);   // rindr-medium: tint
        lobe('result += attenuation * ( 1.0 - surf.metalness ) * surf.transmission * reflection;', 1);
        lobe('result += attenuation * mix( ( 1.0 - surf.transmission ) * dielectric, metallic, surf.metalness );', 1);
        lobe('result += attenuation * diffuse;', 0);
        // the half vector as bsdfEvalPdf builds it; delta transmission (matched IOR) has no value there: all refraction
        const method = `
	// RINDR light passes (astro.config.mjs, rindr-light-passes): lobe kinds for a direction – diffuse, reflection, refraction
	getBsdfLobesNode() {

		if ( this._bsdfLobesNode ) return this._bsdfLobesNode;
		${lobes}
		this._bsdfLobesNode = wgslTagFn/* wgsl */\`

			fn bsdfLobes( worldWo: vec3f, worldWi: vec3f, surf: \${ surfaceRecordStruct } ) -> array<vec3f, 3> {

				let wo = normalize( surf.normalInvBasis * worldWo );
				let wi = normalize( surf.normalInvBasis * worldWi );
				let isTransmission = wi.z < 0.0;
				if ( isTransmission && \${ isMatchedIorFunc }( surf.eta ) ) {

					return array<vec3f, 3>( vec3f( 0.0 ), vec3f( 0.0 ), vec3f( 1.0 ) );

				}
				var wh: vec3f;
				if ( ! isTransmission ) {

					wh = normalize( wo + wi );

				} else if ( surf.thinWall ) {

					wh = normalize( wo + vec3f( wi.xy, - wi.z ) );

				} else {

					wh = normalize( wi + wo * surf.eta );
					wh *= sign( wh.z );

				}
				var ctx: \${ bxdfContextStruct };
				ctx.V = wo;
				ctx.L = wi;
				ctx.H = wh;
				ctx.VdotH = saturate( dot( wo, wh ) );
				return \${ lpEvalLobes }( ctx, surf );

			}

		\`;
		return this._bsdfLobesNode;

	}

	getData() {

		return { ...super.getData(), bsdfLobes: this.getBsdfLobesNode() };

	}
`;
        const close = code.lastIndexOf('\n}');
        if (close < 0) this.error('rindr-light-passes: class end not found in GltfCompliantMaterial.js');
        code = code.slice(0, close) + '\n' + method + code.slice(close);
        return { code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const head = `import { LIGHT_PASSES as __LP, LOBE_RATIO_WGSL as __LP_RATIO, LP_ADD_WGSL as __LP_ADD, LP_ADD_KINDS_WGSL as __LP_KINDS, LP_GET_W_WGSL as __LP_GETW, LP_SET_W_WGSL as __LP_SETW, LP_CLEAR_WGSL as __LP_CLEAR, LP_END_WGSL as __LP_END, LP_MSRC_WGSL as __LP_MSRC, LP_SET_MSRC_WGSL as __LP_SETMSRC, LP_GET3_WGSL as __LP_GET3, LP_SET3_WGSL as __LP_SET3 } from ${JSON.stringify(LIGHT_PASSES_MODULE)};\n`;
      // a second variant of the kernel's shader with the passes – the normal one stays as it is (with the passes in it,
      // cold compile took ~25 s instead of ~12 s): built and compiled on the first render with passes, setLightPasses()
      // switches (the parameters – uniforms, buffers, scene data – are shared)
      const open = 'const shader = wgslTagFn/* wgsl */`';
      const close = '`;\n\n\t\tsuper( shader( params ) );';
      const from = code.indexOf(open), to = code.indexOf(close, from);
      if (from < 0 || to < 0) this.error('rindr-light-passes: kernel shader not found in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)');
      const module = code;
      code = module.slice(from + open.length, to);
      // the pixel's block; this sample's passes from 0
      replaceN(/\n(\t+)var resultColor = vec4f\( 0, 0, 0, 1 \);\n/, (m, tab) => `${m}
${tab}// RINDR light passes (light-passes.js): this pixel's block of the bucket buffer
${tab}let lpPixel = ( targetDimensions.y - 1u - indexUV.y ) * targetDimensions.x + indexUV.x;
${tab}let lpOn = \${ __LP.enabled } != 0u && lpPixel < \${ __LP.capacity };
${tab}let lpB = lpPixel;${lpClear(tab)}
`);
      // per path (pass of the glass split's outer loop); a stacked reflection path takes its kind from the stack
      replaceN(/\n(\t+)var filmBounce = 0u;\n/, (m, tab) => `${m}${tab}var lpSplit = false;\n`);
      replaceN(/\n(\t+)filmBounce = rsCounts\[ rsTop \]\.w;\n/, (m, tab) => `${m}${tab}lpSplit = true;
${tab}if ( lpOn ) {

${tab}\t\${ __LP_SETW }( lpB, \${ __LP.SLOT.W }u, \${ __LP_GETW }( lpB, \${ __LP.SLOT.SW }u + rsTop * 9u ) );

${tab}}
`);
      replaceN(/\n(\t+)rsCounts\[ rsTop \] = vec4u\( bounce \+ 1u, transparentBounce, glassBounce, filmBounce \);\n/, (m, tab) => `${m}${tab}if ( lpOn ) {

${tab}\tif ( lpSplit ) {

${tab}\t\t\${ __LP_SETW }( lpB, \${ __LP.SLOT.SW }u + rsTop * 9u, ${lpW('W')} );

${tab}\t} else {

${tab}\t\t\${ __LP_SETW }( lpB, \${ __LP.SLOT.SW }u + rsTop * 9u, ${lpLobes('rsRefl.direction')} );

${tab}\t}

${tab}}
`);
      replaceN(/\n(\t+)scatterRec\.color \*= rsWeight;\n/, (m, tab) => `${m}${lpClassify(tab, lpLobes('scatterRec.direction'))}\n`);
      // shadow catcher: ground reflection counted ahead / taken back, the ground, its mirror and bounce rays
      replaceN(/\n(\t+)resultColor -= vec4f\( scMirrorBg, 0\.0 \);/, (m, tab) => `${m}${lpAdd(tab, '${ __LP_MSRC }( lpB )', 'scMirrorBg', { sign: '-', mirror: true })}${lpT(tab, `- ${LP_MIRROR_T}`)}`);
      replaceN(/(scMirrorBg = scBase \* scSurf\.x \* scScale;\n)(\t+)(resultColor \+= vec4f\( scMirrorBg, 0\.0 \);)/, (m, before, tab, add) => `${before}${tab}if ( lpOn ) {

${tab}\t\${ __LP_SETMSRC }( lpB, select( ${LP.ENV}u, ${LP.BG}u, bounce == 0u ) );
${tab}\t\${ __LP_SET3 }( lpB, \${ __LP.SLOT.MT }u, select( vec3f( 0.0 ), scShadow * scSurf.z * scSurf.x * scScale, bounce == 0u ) );
${tab}\tif ( lpSplit ) {

${tab}\t\t${lpSetW('MW', lpW('W'))}

${tab}\t} else {

${tab}\t\t${lpSetW('MW', lpKind(1))}

${tab}\t}

${tab}}
${tab}${add}${lpAdd(tab, '${ __LP_MSRC }( lpB )', 'scMirrorBg', { mirror: true })}${lpT(tab, LP_MIRROR_T)}`);
      replaceN(/(if \( scMirrorTaken \) \{\n\n)(\t+)(resultColor \+= vec4f\( scMirrorBg, 0\.0 \);)/, (m, before, tab, add) => `${before}${tab}${add}${lpAdd(tab, '${ __LP_MSRC }( lpB )', 'scMirrorBg', { mirror: true })}${lpT(tab, LP_MIRROR_T)}`, 2);   // volume walk + the box of traced Gaussians (rindr-gaussians)
      replaceN(/\n(\t+)resultColor = vec4f\( scBase \* \( 1\.0 - scSurf\.x \), 1\.0 \);/, (m, tab) => `${lpClear(tab)}${m}${lpAdd(tab, `${LP.BG}u`, 'scBase * ( 1.0 - scSurf.x )', { direct: LP.DIRECT_BG })}
${tab}if ( lpOn ) {

${tab}\t\${ __LP_ADD }( lpB, ${LP.SHADOW}u, scBg.rgb * scSurf.z * ( 1.0 - scSurf.x ) * max( vec3f( 1.0 ) - scShadow, vec3f( 0.0 ) ) );

${tab}}${lpT(tab, 'scShadow * scSurf.z * ( 1.0 - scSurf.x )')}`);
      replaceN(/\n(\t+)resultColor \+= vec4f\( scBase \* \( 1\.0 - scSurf\.x \), 0\.0 \);/, (m, tab) => `${m}${lpAdd(tab, `${LP.ENV}u`, 'scBase * ( 1.0 - scSurf.x )', { direct: LP.DIRECT_BG })}`);
      replaceN(/\n(\t+)throughputColor \*= scSurf\.x \* scScale;/, (m, tab) => `${m}${lpClassify(tab, lpKind(1))}`);
      replaceN(/\n(\t+)throughputColor \*= scAlbedo \* [^\n]*/, (m, tab) => `${m}${lpClassify(tab, lpKind(0))}`);
      // volumes: a scattering event is a diffuse first scatter; baked splat colour and glow count as emission
      replaceN(/\n(\t+)vmScattered = true;/, (m, tab) => `${m}${lpClassify(tab, lpKind(0))}`);
      const wrap = (line, src, options) => replaceN(new RegExp(`\\n(\\t+)${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), (m, tab) => {
        const value = line.slice('resultColor += vec4f( '.length, -', 0.0 );'.length);
        return `\n${tab}{\n\n${tab}\tlet lpV = ${value};\n${tab}\tresultColor += vec4f( lpV, 0.0 );${lpAdd(`${tab}\t`, src, 'lpV', options)}\n\n${tab}}`;
      });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * vmSc, bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * ${ __SPLAT.glow }, bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( vmDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );', lpLightSlot('vmLightIndex'), { direct: LP.DIFFUSE });
      // scattering media (rindr-medium): the path's kind comes from the surface it entered through (glass lobe)
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( mdDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );', lpLightSlot('mdLightIndex'), { direct: LP.DIFFUSE });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * mbGlow * ( 1.0 - mbFresnel ), bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * gxSeg.rgb, bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * gxCaught, bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      // relit traced Gaussians: their glow is emission, their light sample a light slot, the scatter the path's first kind
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * ${ __GX.glow }, bounce, clampDirect, clampIndirect ), 0.0 );', `${LP.EMISSION}u`, { direct: LP.DIRECT_EMISSION });
      wrap('resultColor += vec4f( ${ clampPathContributionFunc }( gxDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );', lpLightSlot('gxLightIndex'), { direct: LP.DIFFUSE });
      replaceN(/\n(\t+)let gxScatter = true;/, (m, tab) => `${m}${lpClassify(tab, lpKind(0))}`);
      // the background seen through traced Gaussians (rindr-gaussians)
      replaceN(/\n(\t+)let gxBg = background \* throughputColor;\n/, (m, tab) => `${m}${lpAdd(tab, `${LP.BG}u`, 'gxBg', { direct: LP.DIRECT_BG })}${lpT(tab, 'vec3f( bg.a ) * throughputColor')}\n`);
      // lights hit, emission
      replaceN(/\n(\t+)resultColor \+= vec4f\( lightHit, 0\.0 \);/, (m, tab) => `${m}${lpAdd(tab, `min( li, ${LP.LAST_LIGHT}u )`, 'lightHit', { direct: LP.DIRECT_EMISSION })}`);
      replaceN(/\n(\t+)resultColor \+= vec4f\( emission, 0\.0 \);/, (m, tab) => `${m}${lpAdd(tab, `${LP.EMISSION}u`, 'emission', { direct: LP.DIRECT_EMISSION })}`);
      // direct light at a surface: kinds by its own evaluation (the lobes still hold it – the glass shadow ray evaluates
      // no material); at the first surface the light lost to the shadow (light sampling alone, no MIS: an estimate of the
      // occluded direct light by itself)
      replaceN(/\n(\t+)if \( any\( gsShadow > vec3f\( 0\.0 \) \) \) \{(\n\n\t+var lightPdf = lightRec\.pdf;)/, (m, tab, rest) => `
${tab}if ( lpOn && ! lpSplit ) {

${tab}\t\${ __LP_ADD }( lpB, ${LP.SHADOW}u, \${ clampPathContributionFunc }( throughputColor * lightRec.emission * evalRec.color * max( vec3f( 1.0 ) - gsShadow, vec3f( 0.0 ) ) * lightsDenom / lightRec.pdf, bounce + 1u, clampDirect, clampIndirect ) );

${tab}}
${tab}if ( any( gsShadow > vec3f( 0.0 ) ) ) {${rest}`);
      replaceN(/(\( directLight, bounce \+ 1u, clampDirect, clampIndirect \);\n)(\t+)(resultColor \+= vec4f\( contribution, 0\.0 \);)/, (m, before, tab, add) => `${before}${tab}${add}${lpAdd(tab, lpLightSlot('lightIndex'), 'contribution', { directW: lpLobes('lightRec.direction') })}`);
      // environment after a bounce, background (camera ray, through glass)
      replaceN(/(\( environment, [^\n]*\n)(\t+)(resultColor \+= vec4f\( contribution, 0\.0 \);)/, (m, before, tab, add) => `${before}${tab}${add}${lpAdd(tab, `${LP.ENV}u`, 'contribution', { direct: LP.DIRECT_BG })}`);
      replaceN(/\n(\t+)resultColor = vec4f\( background, bg\.a \);/, (m, tab) => `${lpClear(tab)}${m}${lpAdd(tab, `${LP.BG}u`, 'background', { direct: LP.DIRECT_BG })}${lpT(tab, 'vec3f( bg.a )')}`);
      replaceN(/\n(\t+)resultColor = vec4f\(\n\t+resultColor\.rgb \+ background,\n[^\n]+\n\t+\);/, (m, tab) => `${m}${lpAdd(tab, `${LP.BG}u`, 'background', { direct: LP.DIRECT_BG })}${lpT(tab, 'select( bg.a, 0.0, transmissiveBackground == \${ TRANSMISSIVE_BACKGROUND_ENVIRONMENT }u ) * envMisWeight * throughputColor')}`, 3);
      // the sample into the sums (before the NaN guard replaces an invalid one)
      replaceN(/\n(\t+)\/\/ RINDR NaN guard /, (m, tab) => `
${tab}// RINDR light passes (light-passes.js): this sample into the sums
${tab}if ( lpOn ) {

${tab}\t\${ __LP_END }( lpB, resultColor.a, f32( sampleCount ), any( ( bitcast<vec4u>( resultColor ) & vec4u( 0x7f800000u ) ) == vec4u( 0x7f800000u ) ) );

${tab}}${m}`);
      const passes = code;
      // kernel features (kernel-features.js): both templates through featureTag – one shader per combination of the
      // scene's features and the passes
      code = module.slice(0, from) + 'const shader = features => __featureTag( features )/* wgsl */`' + module.slice(from + open.length, to) + `\`;
		// RINDR light passes (astro.config.mjs, rindr-light-passes): the kernel variant with the passes
		const shaderPasses = features => __featureTag( features )/* wgsl */\`${passes}\`;
		const bsdfLobesFn = proxyFn( 'material.value.bsdfLobes', params );

		super( shader( __kernelFeatures.current )( params ) );
		this._rindrShaders = { make: ( features, passes ) => ( passes ? shaderPasses : shader )( features )( params ), passes: false, key: '',
			fns: new Map(), nodes: new Map() };
		this._rindrShaders.key = __kernelFeatures.key();
		this._rindrShaders.fns.set( this._rindrShaders.key, this._fn );
		this._rindrShaders.nodes.set( this._rindrShaders.key, this.kernel );` + module.slice(to + close.length);
      const end = code.lastIndexOf('\n}');
      code = code.slice(0, end) + `

	// RINDR kernel variants: the scene's features (kernel-features.js) × light passes on/off. Each shader function is
	// made once; its compute node is kept until a rebuild (scene data, material: setWorkgroupSize) makes the others
	// outdated – switching back to a kept one does not compile again (that restart threw a finished picture away).
	_rindrKey() {

		return __kernelFeatures.key() + ( this._rindrShaders.passes ? '|passes' : '' );

	}

	_rindrFn( key ) {

		const shaders = this._rindrShaders;
		let fn = shaders.fns.get( key );
		if ( ! fn ) {

			fn = shaders.make( new Set( __kernelFeatures.current ), shaders.passes );
			shaders.fns.set( key, fn );

		}
		return fn;

	}

	// the variant for the current features and passes – true if the kernel changed
	_rindrSelect() {

		const shaders = this._rindrShaders;
		const key = this._rindrKey();
		if ( key === shaders.key ) return false;
		shaders.key = key;
		this._fn = this._rindrFn( key );
		const kept = shaders.nodes.get( key );
		if ( kept ) {

			this.kernel = kept;

		} else {

			super.setWorkgroupSize( ...this.workgroupSize );
			shaders.nodes.set( key, this.kernel );

		}
		return true;

	}

	// RINDR light passes: the kernel with the passes or without – true if it changed
	setLightPasses( on ) {

		this._rindrShaders.passes = !! on;
		return this._rindrSelect();

	}

	get lightPasses() {

		return this._rindrShaders.passes;

	}

	// the scene's features changed (material data packed again) – true if the kernel changed
	updateFeatures() {

		return this._rindrSelect();

	}

	get featureKey() {

		return this._rindrShaders.key;

	}

	setWorkgroupSize( x, y, z ) {

		const shaders = this._rindrShaders;
		if ( shaders ) {

			// new scene data: every kept node is outdated – the variant for the features now
			shaders.nodes = new Map();
			shaders.key = this._rindrKey();
			this._fn = this._rindrFn( shaders.key );

		}
		super.setWorkgroupSize( x, y, z );
		if ( shaders ) shaders.nodes.set( shaders.key, this.kernel );
		return this;

	}
` + code.slice(end);
      return { code: head + `import { featureTag as __featureTag } from ${JSON.stringify(KERNEL_FEATURE_TAG_MODULE)};\nimport { kernelFeatures as __kernelFeatures } from ${JSON.stringify(KERNEL_FEATURES_MODULE)};\n` + code, map: null };
    },
  };
}

// Invalid samples (megakernel – fails loudly if the library changed, check on every update): the library rarely produces
// inf/NaN (rough glass, independent of the glass split), such a sample would stay in the pixel's mean until the next
// restart. The sample is dropped instead – the pixel keeps its mean (first sample: black). Checked on the bits: a
// compiler may fold x != x away.
function nanGuardPatch() {
  return {
    name: 'rindr-nan-guard',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const from = /\n(\t+)let blendedColor = \$\{ weightedAlphaBlendFn \}\( prevColor, resultColor, /;
      if ((code.match(new RegExp(from.source, 'g')) || []).length !== 1) this.error('rindr-nan-guard: accumulation not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)');
      code = code.replace(from, (m, tab) => `
${tab}// RINDR NaN guard (astro.config.mjs): drop a sample with inf/NaN – exponent bits all set
${tab}if ( any( ( bitcast<vec4u>( resultColor ) & vec4u( 0x7f800000u ) ) == vec4u( 0x7f800000u ) ) ) {

${tab}\tresultColor = select( prevColor, vec4f( 0, 0, 0, 1 ), f32( sampleCount ) == 0.0 );

${tab}}${m}`);
      return { code, map: null };
    },
  };
}

// Cloud volumes (src/scripts/clouds.js, cloud-pt.js – fails loudly if the library changed, check on every update):
// - megakernel: a hit on a volume box (cloud proxy ptVolume 3, splat volume ptVolume 6) runs the shared volume walk
//   (volume-walk.patch.wgsl), right after the material is read; its light samples carry a //@glass-shadow marker
//   (rindr-glass-shadow runs after this plugin)
// - BVHComputeData: meshes with a cloud material are left out like invisible ones – the proxy stands in for them
const CLOUD_PT_MODULE = fileURLToPath(new URL('./src/scripts/materials/cloud-pt.js', import.meta.url));
// one walk for all participating media – cloud volumes (ptVolume 3) and the splat volume (ptVolume 6,
// src/scripts/splat/splat-volume.js, splat-pt.js): src/scripts/volume-pt.js + volume-walk.patch.wgsl
const SPLAT_PT_MODULE = fileURLToPath(new URL('./src/scripts/splat/splat-pt.js', import.meta.url));
const VOLUME_PT_MODULE = fileURLToPath(new URL('./src/scripts/volume-pt.js', import.meta.url));
const VOLUME_WALK_PATCH = fileURLToPath(new URL('./src/scripts/volume-walk.patch.wgsl', import.meta.url));
// Traced Gaussian splats (src/scripts/splat/gaussian-pt.js – docs/splats.md "Gaussian Ray Tracing"; kernel feature
// 'gaussians', fails loudly if the library changed – check on every update):
// - after each ray test: the Gaussians on the stretch up to the hit (or into the distance), front to back – baked colours
//   light the path (emission), the throughput keeps what passes; scans (primary off) not for camera rays
// - a hit on the splats' box (ptVolume 6) only marks them: stepped over like a transparent pass (before the volume walk,
//   rindr-cloud – its splat medium is off then, SPLAT_UNIFORMS.active)
// - shadow rays: their transmittance (rindr-glass-shadow appends it)
const GAUSSIAN_PT_MODULE = fileURLToPath(new URL('./src/scripts/splat/gaussian-pt.js', import.meta.url));
function gaussianPatch() {
  return {
    name: 'rindr-gaussians',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-gaussians: ${from} not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      replaceOnce(/\n(\t+)let surfaceDist = select\( \$\{ LIGHT_FAR_DISTANCE \}, hitResult\.dist, didHit \);\n/, (m, tab) => m + gate('gaussians', `
${tab}// RINDR traced Gaussian splats (gaussian-pt.js): the ones on this stretch
${tab}if ( \${ __GX.on } > 0.5 && ( bounce > 0u || \${ __GX.primary } > 0.5 ) ) {

${tab}\tif ( \${ __GX.mode } == 0u && bounce > 0u ) {

${tab}\t\t// baked, after a bounce: the Gaussian that catches the ray lights the path, which ends there (expected value =
${tab}\t\t// the blending, one traversal instead of every Gaussian on the way – like the grid's collision)
${tab}\t\tlet gxC = \${ __GX.march }( ray.origin, ray.direction, surfaceDist, 2u, 1.0, u32( \${ rand1 }( 215u ) * 4294967040.0 ) );
${tab}\t\tif ( gxC.x >= 0.0 ) {

${tab}\t\t\tlet gxCaught = \${ __GX.light }( gxC.y, ray.direction );
${tab}\t\t\tresultColor += vec4f( \${ clampPathContributionFunc }( throughputColor * gxCaught, bounce, clampDirect, clampIndirect ), 0.0 );
${tab}\t\t\tbreak;

${tab}\t\t}

${tab}\t} else if ( \${ __GX.mode } == 0u ) {

${tab}\t\t// baked, camera ray: their light front to back (no noise), the throughput keeps what passes
${tab}\t\tlet gxSeg = \${ __GX.march }( ray.origin, ray.direction, surfaceDist, 0u, 1.0, u32( \${ rand1 }( 216u ) * 4294967040.0 ) );
${tab}\t\tif ( gxSeg.a < 1.0 ) {

${tab}\t\t\tresultColor += vec4f( \${ clampPathContributionFunc }( throughputColor * gxSeg.rgb, bounce, clampDirect, clampIndirect ), 0.0 );
${tab}\t\t\tthroughputColor *= gxSeg.a;

${tab}\t\t}

${tab}\t} else {

${tab}\t\t// relit: scattered at the Gaussian that catches the ray (probability = its response) – surface: diffuse around
${tab}\t\t// its shortest axis, volume: in every direction; a light sample like the volume walk's
${tab}\t\tlet gxE = \${ __GX.march }( ray.origin, ray.direction, surfaceDist, 2u, 1.0, u32( \${ rand1 }( 211u ) * 4294967040.0 ) );
${tab}\t\tif ( gxE.x >= 0.0 ) {

${tab}\t\t\tlet gxPos = ray.origin + ray.direction * gxE.x;
${tab}\t\t\tlet gxSurface = \${ __GX.mode } == 1u;
${tab}\t\t\tlet gxN = \${ __GX.normal }( gxE.y, ray.direction );
${tab}\t\t\tresultColor += vec4f( \${ clampPathContributionFunc }( throughputColor * \${ __GX.glow }, bounce, clampDirect, clampIndirect ), 0.0 );
${tab}\t\t\tthroughputColor *= min( \${ __GX.albedo }( gxE.y, ray.direction ), vec3f( 0.98 ) );
${tab}\t\t\tlet gxScatter = true;
${tab}\t\t\tisFullyTransmissive = false;
${tab}\t\t\tgsRough = true;
${tab}\t\t\tgsCaustic = false;
${tab}\t\t\tif ( misEnabled != 0u && lightsDenom > 0.0 ) {

${tab}\t\t\t\tlet gxL = \${ rand3 }( 212u );
${tab}\t\t\t\tlet gxLightIndex = min( u32( gxL.x * lightsDenom ), u32( lightsDenom ) - 1u );
${tab}\t\t\t\tvar gxLight: \${ lightRecordStruct };
${tab}\t\t\t\tif ( envActive && gxLightIndex == lightsCount ) {

${tab}\t\t\t\t\tlet gxEnv = \${ sampleEnvDir }( gxL.yz );
${tab}\t\t\t\t\tgxLight.direction = gxEnv.direction;
${tab}\t\t\t\t\tgxLight.emission = gxEnv.color;
${tab}\t\t\t\t\tgxLight.pdf = gxEnv.pdf;
${tab}\t\t\t\t\tgxLight.dist = \${ LIGHT_FAR_DISTANCE };
${tab}\t\t\t\t\tgxLight.lightType = \${ ENVIRONMENT_LIGHT_TYPE };

${tab}\t\t\t\t} else {

${tab}\t\t\t\t\tgxLight = \${ randomLightSampleFn }( gxLightIndex, gxPos, gxL.yz );

${tab}\t\t\t\t}
${tab}\t\t\t\tlet gxCos = dot( gxN, gxLight.direction );
${tab}\t\t\t\tlet gxPhase = select( 0.0795774715, max( gxCos, 0.0 ) * 0.318309886, gxSurface );
${tab}\t\t\t\tif ( gxLight.pdf > 0.0 && gxPhase > 0.0 ) {

${tab}\t\t\t\t\tlet gxShadowMax = gxLight.dist - \${ LIGHT_EPSILON };
${tab}\t\t\t\t\t//@glass-shadow gxPos | gxLight.direction | gxShadowMax | gxLight.direction | false
${tab}\t\t\t\t\tif ( any( gsShadow > vec3f( 0.0 ) ) ) {

${tab}\t\t\t\t\t\tlet gxLightPdf = gxLight.pdf / lightsDenom;
${tab}\t\t\t\t\t\tlet gxMis = select( 1.0, \${ misHeuristicFn }( gxLightPdf, gxPhase ), \${ isMISWeightLightFn }( gxLight.lightType ) && ! gsGlass );
${tab}\t\t\t\t\t\tlet gxDirect = throughputColor * gxLight.emission * gxPhase * gxMis * gsShadow / gxLightPdf;
${tab}\t\t\t\t\t\tresultColor += vec4f( \${ clampPathContributionFunc }( gxDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );

${tab}\t\t\t\t\t}

${tab}\t\t\t\t}

${tab}\t\t\t}
${tab}\t\t\tlet gxU = \${ rand2 }( 213u );
${tab}\t\t\tvar gxDir = \${ __GX.sphere }( gxU );
${tab}\t\t\tvar gxPdf = 0.0795774715;
${tab}\t\t\tif ( gxSurface ) {

${tab}\t\t\t\tgxDir = \${ __GX.cosine }( gxN, gxU );
${tab}\t\t\t\tgxPdf = max( dot( gxN, gxDir ), 1e-6 ) * 0.318309886;

${tab}\t\t\t}
${tab}\t\t\tbsdfPdf = gxPdf;
${tab}\t\t\tminPdf = min( minPdf, gxPdf );
${tab}\t\t\t// russian roulette from the 3rd bounce (the albedo only ever lowers the throughput; the library's own one
${tab}\t\t\t// comes after a surface, which this event skips)
${tab}\t\t\tif ( bounce >= 2u ) {

${tab}\t\t\t\tlet gxKeep = clamp( max( max( throughputColor.r, throughputColor.g ), throughputColor.b ), 0.05, 0.98 );
${tab}\t\t\t\tif ( \${ rand1 }( 217u ) > gxKeep ) {

${tab}\t\t\t\t\tbreak;

${tab}\t\t\t\t}
${tab}\t\t\t\tthroughputColor /= gxKeep;

${tab}\t\t\t}
${tab}\t\t\tray.origin = gxPos;
${tab}\t\t\tray.direction = gxDir;
${tab}\t\t\tray.maxDist = 0.0;
${tab}\t\t\t\${ rngNextBounce }();
${tab}\t\t\tcontinue;

${tab}\t\t}

${tab}\t}

${tab}}
`));
      replaceOnce(/\n(\t+)materialInfo\.opacity \*= objectInfo\.color\.a;\n/, (m, tab) => m + gate('gaussians', `
${tab}// RINDR traced Gaussian splats: their box only marks them – stepped over like a transparent pass
${tab}if ( materialInfo.fogVolume == 6 && \${ __GX.on } > 0.5 ) {

${tab}	ray.origin = \${ offsetRayOriginFunc }( ray.origin + ray.direction * hitResult.dist, ray.direction, hitResult.normal );
${tab}	if ( transparentBounce >= maxTransparentBounces ) {

${tab}		break;

${tab}	}
${tab}	transparentBounce ++;
${tab}	bounce --;
${tab}	if ( scMirrorTaken ) {

${tab}		resultColor += vec4f( scMirrorBg, 0.0 );
${tab}		scMirrorPending = true;

${tab}	}
${tab}	\${ rngNextBounce }();
${tab}	continue;

${tab}}
`));
      // the camera ray missing everything: the library assigns the background – after Gaussians on the way their light
      // stays and the background shows through what they let pass (alpha: their opacity over the background's)
      replaceOnce(/\n(\t+)resultColor = vec4f\( background, bg\.a \);\n/, (m, tab) => `
${tab}/*@if:gaussians*/
${tab}if ( any( throughputColor < vec3f( 1.0 ) ) || any( resultColor.rgb > vec3f( 0.0 ) ) ) {

${tab}\tlet gxBg = background * throughputColor;
${tab}\tresultColor = vec4f( resultColor.rgb + gxBg, 1.0 - ( throughputColor.r + throughputColor.g + throughputColor.b ) / 3.0 * ( 1.0 - bg.a ) );

${tab}} else {
${tab}/*@endif*/
${tab}resultColor = vec4f( background, bg.a );
${tab}/*@if:gaussians*/
${tab}}
${tab}/*@endif*/
`);
      return { code: `import { GAUSS_PT as __GX } from ${JSON.stringify(GAUSSIAN_PT_MODULE)};\n` + code, map: null };
    },
  };
}

function cloudPatch() {
  return {
    name: 'rindr-cloud',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const replaceOnce = (from, to, name) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-cloud: ${from} not found exactly once in ${name} (three-gpu-pathtracer / three-mesh-bvh changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-mesh-bvh/src/webgpu/BVHComputeData.js')) {
        // ptHidden: helper meshes of the raster only (wool fibre shells, wool.js; fading out grass)
        replaceOnce('let visible = isObjectVisible( object );', () => 'let visible = isObjectVisible( object ) && ! object.material?.userData?.cloud && ! object.userData?.ptHidden && ! object.isSplat;', 'BVHComputeData.js');
        return { code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      replaceOnce(/\n\t+materialInfo\.opacity \*= objectInfo\.color\.a;\n/, m => m + gate('volume', readFileSync(VOLUME_WALK_PATCH, 'utf8')), 'PathTracerMegaKernel.js');
      return { code: `import { CLOUD_PT as __CLOUD } from ${JSON.stringify(CLOUD_PT_MODULE)};\nimport { SPLAT_PT as __SPLAT } from ${JSON.stringify(SPLAT_PT_MODULE)};\nimport { VOLUME_PT as __VOL } from ${JSON.stringify(VOLUME_PT_MODULE)};\n` + code, map: null };
    },
  };
}

// Wool fibres (src/scripts/materials/wool.js, wool-pt.js – fails loudly if the library changed, check on every update):
// - PathtracerBVHComputeData (the path tracer's ray test): a triangle of a wool mesh (ptVolume 4) also tests its shells
//   and keeps fibre hits only (wool-hit.patch.wgsl); the fibre length in local units is set when the ray enters the
//   object
// - BVHComputeData.getBVH: the BVH bounds of wool geometries hold the fibres (wool-bounds.js)
// - megakernel: a fibre hit is shaded at the fibre (position, facing normal), darker towards the roots, tinted
const WOOL_PT_MODULE = fileURLToPath(new URL('./src/scripts/materials/wool-pt.js', import.meta.url));
const WOOL_BOUNDS_MODULE = fileURLToPath(new URL('./src/scripts/materials/wool-bounds.js', import.meta.url));
const WOOL_HIT_PATCH = fileURLToPath(new URL('./src/scripts/materials/wool-hit.patch.wgsl', import.meta.url));
const WOOL_SHADE = `
						// RINDR wool (wool.js, wool-pt.js): a fibre hit lies above the base triangle – shaded there; the surface
						// below (seen between the fibres and where shells part at hard edges) in the colour of the roots
						if ( materialInfo.fogVolume == 4 ) {

							let wlHit = ray.origin + ray.direction * hitResult.dist;
							let wlShade = \${ __WOOL.shade }( wlHit, vertexData.position.xyz, objectInfo.inverseMatrixWorld, ray.direction, max( materialInfo.iridescenceThicknessMinimum, 1e-9 ) );
							if ( wlShade.x > 0.0 ) {

								vertexData.position = vec4f( wlHit, 1.0 );
								vertexData.normal = vec4f( hitResult.normal, 0.0 );

							}
							materialInfo.color = min( materialInfo.color * wlShade.y, vec3f( 1.0 ) );
							materialInfo.sheenColor = min( materialInfo.color * \${ __WOOL.sheen }, vec3f( 1.0 ) );   // like the raster's shells

						}
`;
function woolPatch() {
  return {
    name: 'rindr-wool',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-wool: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      const head = `import { WOOL_PT as __WOOL } from ${JSON.stringify(WOOL_PT_MODULE)};\n`;
      if (file.endsWith('three-mesh-bvh/src/webgpu/BVHComputeData.js')) {
        replaceOnce(/\n(\t+)return bvh;\n/, (m, tab) => `\n${tab}return __woolBounds( object, bvh );\n`);
        return { code: `import { woolBounds as __woolBounds } from ${JSON.stringify(WOOL_BOUNDS_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        // fibre length of the object the ray is in (local units, 0: no wool)
        replaceOnce("const baseOpacityScalar = float( 1.0 ).toVar( 'bvh_baseOpacity' );", m => `${m}
		const woolLength = float( 0.0 ).toVar( 'bvh_woolLength' );`);
        replaceOnce(/\n(\t+)var triResult = \$\{ intersectRayTriangle \}\( ray, a, b, c, 0\.0 \);/, m => '\n' + gate('wool', readFileSync(WOOL_HIT_PATCH, 'utf8')) + m.slice(1));
        // the ray test is built right after the material data (kernel features collected): without wool no fibre test
        replaceOnce('intersectRangeFn: wgslTagFn/* wgsl */`', () => 'intersectRangeFn: __featureTag()/* wgsl */`');
        replaceOnce(/\n(\t+)let material = \$\{ storage\.materials \}\[ object\.materialIndex \];/, (m, tab) => `${m}\n${tab}\${ woolLength } = select( 0.0, material.iridescenceThicknessMinimum / \${ scratchRayScalar }, material.fogVolume == 4 );`);
        replaceOnce(/\n(\t+)\$\{ scratchRayScalar \} = 1\.0;\n\t+\$\{ baseOpacityScalar \} = 1\.0;/, (m, tab) => `${m}\n${tab}\${ woolLength } = 0.0;`);
        return { code: head + `import { featureTag as __featureTag } from ${JSON.stringify(KERNEL_FEATURE_TAG_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n\t+vertexData\.position = objectInfo\.matrixWorld \* vertexData\.position;\n/, m => m + gate('wool', WOOL_SHADE));
        return { code: head + code, map: null };
      }
      return null;
    },
  };
}

// Soap film (src/scripts/materials/soap.js, soap-pt.js – fails loudly if the library changed, check on every update):
// megakernel, before the surface record: a hit on a soap material (ptVolume 5) gets its film thickness from the noise
// (mean film and swirl cell in iridescenceThicknessRange, swirl in sheenRoughness – RindrMaterial.setSoap); the
// interference is the library's own thin film on a matched-IOR (ior 1) transmissive surface; passing a film does not
// count as a bounce (two per bubble – bubbles behind bubbles)
const SOAP_PT_MODULE = fileURLToPath(new URL('./src/scripts/materials/soap-pt.js', import.meta.url));
const SOAP_FILM = `
						// RINDR soap film (soap.js, soap-pt.js): film thickness from the swirl noise (world space)
						if ( materialInfo.fogVolume == 5 ) {

							materialInfo.iridescenceThicknessMaximum = \${ __SOAP.thickness }( vertexData.position.xyz, vertexData.normal.xyz, materialInfo.iridescenceThicknessMinimum, materialInfo.sheenRoughness, max( materialInfo.iridescenceThicknessMaximum, 1e-9 ) );

						}
`;
function soapPatch() {
  return {
    name: 'rindr-soap',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const from = /\n\t+vertexData\.position = objectInfo\.matrixWorld \* vertexData\.position;\n/;
      if ((code.match(new RegExp(from.source, 'g')) || []).length !== 1) this.error(`rindr-soap: ${from} not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)`);
      code = code.replace(from, m => m + gate('soap', SOAP_FILM));
      // a ray crosses two films per bubble – passing a soap film does not use up the bounce budget (up to
      // SOAP_PT.filmBounces; the loop limit comes from rindr-glass-bounces, which runs before)
      const loop = /\n(\t+)for \( var bounce = 0u; bounce < maxBounces \+ glassBounce; bounce \+\+ \) \{/;
      const next = /\n(\t+)if \( \( scatterRec\.isTransmissive \|\| /;
      for (const re of [loop, next]) if ((code.match(new RegExp(re.source, 'g')) || []).length !== 1) this.error(`rindr-soap: ${re} not found exactly once in PathTracerMegaKernel.js`);
      code = code.replace(loop, (m, tab) => `\n${tab}var filmBounce = 0u;\n${tab}for ( var bounce = 0u; bounce < maxBounces + glassBounce + filmBounce; bounce ++ ) {`);
      code = code.replace(next, (m, tab) => `\n${tab}if ( scatterRec.isTransmissive && materialInfo.fogVolume == 5 && filmBounce < \${ __SOAP.filmBounces } ) {\n\n${tab}\tfilmBounce ++;\n\n${tab}} else` + m.replace(/^\n\t+/, ' '));
      return { code: `import { SOAP_PT as __SOAP } from ${JSON.stringify(SOAP_PT_MODULE)};\n` + code, map: null };
    },
  };
}

// Rounded edges (src/scripts/materials/edges.js – fails loudly if the library changed, check on every update):
// - BVHComputeData: remembers per geometry where its vertices start in the packed attribute buffer
// - PathtracerBVHComputeData.writeMaterialData: spare transform fields = the geometry's block in EDGE_DATA
//   (_alignment0) and that vertex start (_alignment1)
// - megakernel: a hit on a material with an edge radius (stand-in anisotropyRotation, anisotropy 0) bends the
//   object-space normal with the same function as the raster (EDGE_WGSL), before it goes to world space
const EDGES_MODULE = fileURLToPath(new URL('./src/scripts/materials/edges.js', import.meta.url));
const EDGE_NORMAL = `
						// RINDR rounded edges (edges.js): the normal near sharp edges like a fillet, object space – on the
						// camera ray and the first bounce (reflections of the edges); deeper bounces barely show it
						if ( materialInfo.anisotropyRotation != 0.0 && materialInfo.anisotropy == 0.0 && bounce < \${ __EDGE_BOUNCES } ) {

							let edScale = ( length( objectInfo.matrixWorld[ 0 ].xyz ) + length( objectInfo.matrixWorld[ 1 ].xyz ) + length( objectInfo.matrixWorld[ 2 ].xyz ) ) / 3.0;
							vertexData.normal = vec4f( \${ __EDGES }( vertexData.position.xyz, vertexData.normal.xyz, hitResult.indices.x - objectInfo._alignment1, objectInfo._alignment0, materialInfo.anisotropyRotation / max( edScale, 1e-30 ) ), 0.0 );
							materialInfo.anisotropyRotation = 0.0;

						}
`;
function edgesPatch() {
  return {
    name: 'rindr-edges',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-edges: ${from} not found exactly once in ${name} (three-gpu-pathtracer / three-mesh-bvh changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-mesh-bvh/src/webgpu/BVHComputeData.js')) {
        replaceOnce(/\n(\t+)bvh: primBvh,\n/, (m, tab) => `${m}${tab}rindrGeometry: object.geometry,\n`);
        replaceOnce(/\n(\t+)appendGeometryData\( info\.bvh, info\.range, attributesOffset, attributesBuffer, attributeStruct, this \);\n/,
          (m, tab) => `${m}${tab}( this.rindrVertexStart ??= new Map() ).set( info.rindrGeometry, ( attributesOffset - info.range.vertexStart ) >>> 0 );\n`);
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        replaceOnce(/\n(\t+)transformBufferU32\[ writeOffset \* transformStruct\.getLength\(\) \+ 33 \] = index;\n/, (m, tab) => `${m}`
          + `${tab}transformBufferU32[ writeOffset * transformStruct.getLength() + 34 ] = __edgeBase( object.geometry );\n`
          + `${tab}transformBufferU32[ writeOffset * transformStruct.getLength() + 35 ] = this.rindrVertexStart?.get( object.geometry ) ?? 0;\n`);
        return { code: `import { edgeBase as __edgeBase } from ${JSON.stringify(EDGES_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n\t+var vertexData = \$\{ sampleTrianglePointFn \}\( hitResult\.barycoord, hitResult\.indices\.xyz \);\n/, m => m + gate('edges', EDGE_NORMAL));
        return { code: `import { EDGE_WGSL as __EDGES, EDGE_BOUNCES as __EDGE_BOUNCES } from ${JSON.stringify(EDGES_MODULE)};\n` + code, map: null };
      }
      return null;
    },
  };
}

// Cross-origin isolation: required for SharedArrayBuffer so three-mesh-bvh can build the BVH
// in parallel on several workers (= CPU cores). In production public/.htaccess sets the
// same headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// App version ("About"): major.minor from package.json (raised by hand), patch = number of git commits – counts up
// with every commit, the same commit always gives the same version, nothing is written back. "-dev": built with
// uncommitted changes. Without git (source archive): package.json as it is. CI needs the full history
// (fetch-depth: 0 in .github/workflows/static.yml – a shallow clone counts 1).
function appVersion() {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const git = args => execSync(`git ${args}`, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commits = git('rev-list --count HEAD');
    const dirty = git('status --porcelain') !== '';
    return `${version.split('.').slice(0, 2).join('.')}.${commits}${dirty ? '-dev' : ''}`;
  } catch {
    return version;
  }
}

// .env is not loaded into process.env for the config itself (prefix '' = all keys, read here only)
const fileEnv = loadEnv(process.env.NODE_ENV === 'production' ? 'production' : 'development', process.cwd(), '');

export default defineConfig({
  // Sub directory on the server: BASE_PATH=/rindr/ npm run build (default: domain root).
  // All runtime paths use import.meta.env.BASE_URL or are relative.
  base: process.env.BASE_PATH || '/',
  // parallel test builds (e.g. OUT_DIR=dist/agents/x BASE_PATH=/agents/x/): output folder, default dist/
  outDir: process.env.OUT_DIR || './dist',
  // Public origin for absolute og:image / og:url links: SITE_URL in .env or the shell
  // (without it the social-preview tags use relative paths, which most crawlers ignore).
  site: process.env.SITE_URL || fileEnv.SITE_URL || undefined,
  server: {
    host: true,
    port: 4321,
    headers: isolationHeaders,
  },
  vite: {
    plugins: [tailwindcss(), shadowCatcherPatch(), pathTracerPerfPatch(), atlasCapacityPatch(), stableKernelPatch(), bucketPatch(), ptStandInPatch(), openPbrPatch(), mediumPatch(), glassBouncesPatch(), cloudPatch(), gaussianPatch(), woolPatch(), soapPatch(), edgesPatch(), glassShadowPatch(), glassSplitPatch(), nanGuardPatch(), lightPassesPatch()],
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    // bundle analysis: SOURCEMAP=1 npm run build → bytes per source module from the maps (CLAUDE.md "Bundle")
    build: {
      sourcemap: !!process.env.SOURCEMAP,
      rolldownOptions: {
        onLog(level, log, handler) {
          // three-mesh-bvh/webgpu re-exports closestPointToTriangle from two modules (WGSL and TSL version);
          // the bundler drops the ambiguous name – nothing here imports it through the index
          if (log.code === 'NAMESPACE_CONFLICT' && log.message.includes('three-mesh-bvh')) return;
          handler(level, log);
        },
      },
    },
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    optimizeDeps: {
      // These packages create workers via `new URL(..., import.meta.url)` –
      // pre-bundling would break the relative worker paths.
      exclude: ['three-mesh-bvh', 'three-gpu-pathtracer'],
    },
  },
});
