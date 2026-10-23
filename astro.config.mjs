// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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
      code = code.replace(anchor, () => readFileSync(SHADOW_CATCHER_PATCH, 'utf8'));
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
        replaceOnce('const m = materials[ i ];', () => 'const m = __ptStandIn( materials[ i ] );');
        replaceOnce(/(intArray\[ index \+\+ \] = Number\( m\.transparent \);\n\t+intArray\[ index \+\+ \] = )0;/, (_, head) => `${head}getField( m, 'ptVolume', 0 );`);
        return { code: `import { ptStandIn as __ptStandIn } from ${JSON.stringify(PT_STAND_IN_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n(\t+)\/\/ emission, clamped at the depth of the segment that found it/, m => '\n' + MARBLE_EMISSION + m.slice(1));
        return { code: `import { MARBLE_WGSL as __MARBLE } from ${JSON.stringify(MARBLE_MODULE)};\n` + code, map: null };
      }
      return null;
    },
  };
}

// Glass while orbiting (src/scripts/pt-motion.js): refractions up to PT_MOTION.glassBounces do not use up the bounce
// budget of the megakernel – with the 3 bounces of the motion mode glass was black (fails loudly if the library
// changed, check on every update).
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
      // end of the iteration (after Russian roulette): a refraction or a smooth mirror reflection (chrome: mirror in
      // mirror) within the budget does not count
      code = code.replace(next, (m, tab) => `\n${tab}if ( ( scatterRec.isTransmissive || ( surface.metalness > 0.9 && surface.roughness < 0.1 ) ) && glassBounce < \${ __PT_MOTION.glassBounces } ) {\n\n${tab}\tglassBounce ++;\n\n${tab}}\n` + m);
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
      const snippet = ({ origin, dir, maxDist, normal, primary }) => readFileSync(GLASS_SHADOW_PATCH, 'utf8')
        .replace(/\$ORIGIN/g, origin).replace(/\$DIR/g, dir).replace(/\$MAXDIST/g, maxDist)
        .replace(/\$NORMAL/g, normal).replace(/\$PRIMARY/g, primary);
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-glass-shadow: ${from} not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      // markers of other patches: shadow catcher (shadow-catcher.patch.wgsl, rindr-shadow-catcher) and the light samples
      // of the volume walk (volume-walk.patch.wgsl, rindr-cloud) – both inserted before this plugin
      const markers = /\n\t*\/\/@glass-shadow ([^\n]+)/g;
      if ((code.match(markers) || []).length !== 2) this.error('rindr-glass-shadow: expected 2 //@glass-shadow markers in PathTracerMegaKernel.js');
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
      return { code: `import { GLASS_SHADOW as __GS } from ${JSON.stringify(GLASS_SHADOW_MODULE)};\n` + code, map: null };
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
      replaceOnce(/\n\t+materialInfo\.opacity \*= objectInfo\.color\.a;\n/, m => m + readFileSync(VOLUME_WALK_PATCH, 'utf8'), 'PathTracerMegaKernel.js');
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
        replaceOnce(/\n(\t+)var triResult = \$\{ intersectRayTriangle \}\( ray, a, b, c, 0\.0 \);/, m => '\n' + readFileSync(WOOL_HIT_PATCH, 'utf8') + m.slice(1));
        replaceOnce(/\n(\t+)let material = \$\{ storage\.materials \}\[ object\.materialIndex \];/, (m, tab) => `${m}\n${tab}\${ woolLength } = select( 0.0, material.iridescenceThicknessMinimum / \${ scratchRayScalar }, material.fogVolume == 4 );`);
        replaceOnce(/\n(\t+)\$\{ scratchRayScalar \} = 1\.0;\n\t+\$\{ baseOpacityScalar \} = 1\.0;/, (m, tab) => `${m}\n${tab}\${ woolLength } = 0.0;`);
        return { code: head + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n\t+vertexData\.position = objectInfo\.matrixWorld \* vertexData\.position;\n/, m => m + WOOL_SHADE);
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
      code = code.replace(from, m => m + SOAP_FILM);
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
        replaceOnce(/\n\t+var vertexData = \$\{ sampleTrianglePointFn \}\( hitResult\.barycoord, hitResult\.indices\.xyz \);\n/, m => m + EDGE_NORMAL);
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
    plugins: [tailwindcss(), shadowCatcherPatch(), pathTracerPerfPatch(), atlasCapacityPatch(), stableKernelPatch(), bucketPatch(), ptStandInPatch(), glassBouncesPatch(), cloudPatch(), woolPatch(), soapPatch(), edgesPatch(), glassShadowPatch()],
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    // bundle analysis: SOURCEMAP=1 npm run build → bytes per source module from the maps (CLAUDE.md "Bundle")
    build: { sourcemap: !!process.env.SOURCEMAP },
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    optimizeDeps: {
      // These packages create workers via `new URL(..., import.meta.url)` –
      // pre-bundling would break the relative worker paths.
      exclude: ['three-mesh-bvh', 'three-gpu-pathtracer'],
    },
  },
});
