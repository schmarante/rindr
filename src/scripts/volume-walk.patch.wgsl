// RINDR volumes (volume-pt.js) – inserted into three-gpu-pathtracer's megakernel by the Vite plugin rindr-cloud
// (astro.config.mjs) right after the material of a hit is read. One walk for every participating medium (cloud volumes,
// splat volume): a hit on any volume box starts it, it tracks all media until every box is left or a surface is
// reached. Own random generator (PCG, seeded once per bounce): hundreds of draws per path.
						if ( materialInfo.fogVolume == 3 || materialInfo.fogVolume == 6 ) {

							let vmScale = length( objectInfo.matrixWorld[ 0 ].xyz ) + length( objectInfo.matrixWorld[ 1 ].xyz ) + length( objectInfo.matrixWorld[ 2 ].xyz );
							let vmEps = 1e-5 * vmScale;
							// scans are drawn by the raster over the path traced image: camera rays pass the splat medium
							let vmSplatOn = ! ( bounce == 0u && ${ __VOL.splatPrimary } < 0.5 );
							var vmRng = u32( ${ rand1 }( 190u ) * 4294967040.0 ) ^ ( bounce * 2654435761u );
							let vmHitPos = ray.origin + ray.direction * hitResult.dist;
							// already inside a medium (camera in a cloud, a bounce off a surface inside one): from the ray origin
							var vmPos = select( vmHitPos, ray.origin, hitResult.side < 0.0 || ${ __VOL.inside }( ray.origin, vmSplatOn ) );
							var vmDir = ray.direction;
							var vmScattered = false;
							var vmDone = false;
							var vmAlive = true;
							// russian roulette from the 3rd event (unbiased): dense dark media (a smoke splat's core) scattered dozens of times
							// per path, each with a light sample – HQ took 6× as long; white clouds keep their paths (keep ≈ albedo)
							for ( var vmEvent = 0u; vmEvent < 64u; vmEvent ++ ) {

								// segment: until every medium's box is left, or the first real surface before (faces of volume boxes are
								// stepped over – the media are tracked here)
								var vmEnd = ${ __VOL.exit }( vmPos, vmDir, vmSplatOn );
								var vmSurface = false;
								var vmSkipped = 0.0;
								var vmRay: ${ rayStruct };
								vmRay.direction = vmDir;
								for ( var vmTry = 0u; vmTry < 8u; vmTry ++ ) {

									if ( vmEnd - vmSkipped <= vmEps ) {

										break;

									}
									vmRay.origin = vmPos + vmDir * ( vmSkipped + vmEps );
									vmRay.maxDist = vmEnd - vmSkipped;
									var vmHit: ${ raycastOutput };
									if ( ! ${ raycastFirstHitFn }( vmRay, &vmHit ) ) {

										break;

									}
									let vmAt = vmSkipped + vmEps + vmHit.dist;
									if ( vmAt >= vmEnd ) {

										break;

									}
									let vmFog = ( *materials )[ transforms[ vmHit.objectIndex ].materialIndex ].fogVolume;
									if ( vmFog == 3 || vmFog == 6 ) {

										vmSkipped = vmAt;
										continue;

									}
									vmEnd = vmAt;
									vmSurface = true;
									break;

								}

								// delta tracking against the summed majorants; empty stretches jumped over
								var vmT = 0.0;
								var vmKind = 0.0;
								var vmSlot = 0.0;
								for ( var vmK = 0u; vmK < 2048u; vmK ++ ) {

									if ( vmT >= vmEnd ) {

										break;

									}
									let vmM = ${ __VOL.majorant }( vmPos + vmDir * vmT, vmDir, vmSplatOn );
									let vmLim = min( vmM.y, vmEnd - vmT );
									if ( vmM.x <= 0.0 ) {

										vmT += vmLim + vmEps;
										continue;

									}
									vmRng = vmRng * 747796405u + 2891336453u;
									let vmStep = - log( 1.0 - ${ __CLOUD.pcg }( vmRng ) ) / vmM.x;
									if ( vmStep >= vmLim ) {

										vmT += vmLim + vmEps;
										continue;

									}
									vmT += vmStep;
									vmRng = vmRng * 747796405u + 2891336453u;
									let vmPick = ${ __VOL.pick }( vmPos + vmDir * vmT, vmSplatOn, ${ __CLOUD.pcg }( vmRng ) * vmM.x );
									if ( vmPick.x > 0.5 ) {

										vmKind = vmPick.x;
										vmSlot = vmPick.y;
										break;

									}

								}

								if ( vmKind < 0.5 ) {

									// out of all media (or onto the surface inside): the path goes on from there – at least past the face hit
									var vmNext = vmPos + vmDir * select( vmEnd + vmEps, max( vmEnd - vmEps, 0.0 ), vmSurface );
									if ( ! vmSurface && dot( vmNext - ray.origin, ray.direction ) < hitResult.dist + vmEps ) {

										vmNext = vmHitPos + ray.direction * vmEps;

									}
									vmPos = vmNext;
									vmDone = true;
									break;

								}

								// scattering event – cloud (its albedo, Henyey-Greenstein) or splats (baked: their colour reaches the eye,
								// the path ends; relit: albedo = colour or override material, isotropic)
								vmPos = vmPos + vmDir * vmT;
								var vmG = ${ __VOL.cloudG };
								if ( vmKind > 1.5 ) {

									let vmSc = ${ __SPLAT.color }( ( ${ __SPLAT.inverse } * vec4f( vmPos, 1.0 ) ).xyz );
									if ( ${ __SPLAT.relit } < 0.5 ) {

										resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * vmSc, bounce, clampDirect, clampIndirect ), 0.0 );
										vmAlive = false;
										break;

									}
									var vmSa = vmSc;
									if ( ${ __SPLAT.override } > 0.5 ) {

										vmSa = ${ __SPLAT.tint } * pow( clamp( dot( vmSc, vec3f( 0.2126, 0.7152, 0.0722 ) ) / max( ${ __SPLAT.mean }, 1e-4 ), 0.0, 4.0 ), ${ __SPLAT.detail } );

									}
									resultColor += vec4f( ${ clampPathContributionFunc }( throughputColor * ${ __SPLAT.glow }, bounce, clampDirect, clampIndirect ), 0.0 );
									throughputColor *= min( vmSa, vec3f( 0.98 ) );
									vmG = 0.0;

								} else {

									throughputColor *= ${ __VOL.cloudAlbedo }( u32( vmSlot ) );

								}
								vmScattered = true;
								gsRough = true;
								gsCaustic = false;

								// next event estimation: one light or the environment (transmittance through all media + glass)
								if ( misEnabled != 0u && lightsDenom > 0.0 ) {

									vmRng = vmRng * 747796405u + 2891336453u;
									let vmL0 = ${ __CLOUD.pcg }( vmRng );
									vmRng = vmRng * 747796405u + 2891336453u;
									let vmL1 = ${ __CLOUD.pcg }( vmRng );
									vmRng = vmRng * 747796405u + 2891336453u;
									let vmL2 = ${ __CLOUD.pcg }( vmRng );
									let vmLightIndex = min( u32( vmL0 * lightsDenom ), u32( lightsDenom ) - 1u );
									var vmLight: ${ lightRecordStruct };
									if ( envActive && vmLightIndex == lightsCount ) {

										let vmEnv = ${ sampleEnvDir }( vec2f( vmL1, vmL2 ) );
										vmLight.direction = vmEnv.direction;
										vmLight.emission = vmEnv.color;
										vmLight.pdf = vmEnv.pdf;
										vmLight.dist = ${ LIGHT_FAR_DISTANCE };
										vmLight.lightType = ${ ENVIRONMENT_LIGHT_TYPE };

									} else {

										vmLight = ${ randomLightSampleFn }( vmLightIndex, vmPos, vec2f( vmL1, vmL2 ) );

									}
									if ( vmLight.pdf > 0.0 ) {

										let vmShadowMax = vmLight.dist - ${ LIGHT_EPSILON };
										//@glass-shadow vmPos | vmLight.direction | vmShadowMax | vmLight.direction | false
										if ( any( gsShadow > vec3f( 0.0 ) ) ) {

											let vmPhase = ${ __CLOUD.pdfHG }( dot( vmDir, vmLight.direction ), vmG );
											let vmLightPdf = vmLight.pdf / lightsDenom;
											let vmMis = select( 1.0, ${ misHeuristicFn }( vmLightPdf, vmPhase ), ${ isMISWeightLightFn }( vmLight.lightType ) && ! gsGlass );
											let vmDirect = throughputColor * vmLight.emission * vmPhase * vmMis * gsShadow / vmLightPdf;
											resultColor += vec4f( ${ clampPathContributionFunc }( vmDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );

										}

									}

								}

								// new direction
								vmRng = vmRng * 747796405u + 2891336453u;
								let vmH0 = ${ __CLOUD.pcg }( vmRng );
								vmRng = vmRng * 747796405u + 2891336453u;
								let vmH1 = ${ __CLOUD.pcg }( vmRng );
								let vmNewDir = ${ __CLOUD.sampleHG }( vmDir, vmG, vec2f( vmH0, vmH1 ) );
								bsdfPdf = ${ __CLOUD.pdfHG }( dot( vmDir, vmNewDir ), vmG );
								minPdf = min( minPdf, bsdfPdf );
								vmDir = vmNewDir;

								// russian roulette after a few events (the albedo only ever lowers the throughput)
								if ( vmEvent >= 2u ) {

									let vmKeep = clamp( max( max( throughputColor.r, throughputColor.g ), throughputColor.b ), 0.05, 0.98 );
									vmRng = vmRng * 747796405u + 2891336453u;
									if ( ${ __CLOUD.pcg }( vmRng ) > vmKeep ) {

										vmAlive = false;
										break;

									}
									throughputColor /= vmKeep;

								}

							}

							if ( ! vmDone || ! vmAlive ) {

								break;

							}

							ray.origin = vmPos;
							ray.direction = vmDir;
							ray.maxDist = 0.0;
							if ( vmScattered ) {

								isFullyTransmissive = false;

							} else {

								// no scattering: like a transparent pass – the bounce does not count
								if ( transparentBounce >= maxTransparentBounces ) {

									break;

								}
								transparentBounce ++;
								bounce --;
								// a ground reflection of the models only (background hidden) took the ground back for this box:
								// nothing was hit – count it again and let the next segment decide (shadow-catcher patch)
								if ( scMirrorTaken ) {

									resultColor += vec4f( scMirrorBg, 0.0 );
									scMirrorPending = true;

								}

							}
							${ rngNextBounce }();
							continue;

						}
