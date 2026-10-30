						// RINDR scattering media (materials/medium.js) – inserted into three-gpu-pathtracer's megakernel by the Vite plugin
						// rindr-medium (astro.config.mjs) right after the material of a hit is read. OpenPBR transmission_scatter and
						// subsurface (accurate mode): a homogeneous medium inside a closed mesh, behind its dielectric surface (the
						// library's glass lobe refracts into it and out of it). A hit on the back face of such a material ends a stretch
						// inside: its free flight distance is sampled in one colour channel, picked by throughput × albedo and weighted
						// by the mixed pdf of all three (chromatic media: wax, skin, jade – picked evenly, the channel with the longest
						// path, red, grew by up to 3× per event, the firefly clamp cut those paths: red too dark, green/blue too light).
						// Before the face: a scattering event – a light sample straight through the
						// surface (glass shadow snippet: Fresnel, extinction up to the face), a Henyey-Greenstein direction, the path goes
						// on from there without using up a bounce. Otherwise the face is shaded as usual, the stretch's transmittance
						// instead of the library's absorption. Objects inside the medium: stretches up to their faces count as clear.
						mdPassed = false;
						mdNoLight = false;
						if ( hitResult.side > 0.0 ) {

							mdScattered = false;

						}
						if ( hitResult.side < 0.0 && materialInfo.transmission > 0.0 && materialInfo.thinWall == 0 && any( materialInfo.mediumScatter > vec3f( 0.0 ) ) ) {

							let mdSigmaS = materialInfo.mediumScatter;
							let mdSigmaA = - log( max( materialInfo.attenuationColor, vec3f( 1e-8 ) ) ) / max( materialInfo.attenuationDistance, 1e-8 );
							let mdSigmaT = mdSigmaA + mdSigmaS;
							var mdRng = u32( ${ rand1 }( 195u ) * 4294967040.0 ) ^ ( ( mdEvents + 1u ) * 2654435761u );
							let mdWant = throughputColor * mdSigmaS / max( mdSigmaT, vec3f( 1e-30 ) );
							let mdWantSum = mdWant.r + mdWant.g + mdWant.b;
							let mdP = select( vec3f( 1.0 / 3.0 ), mdWant / mdWantSum, mdWantSum > 0.0 );
							mdRng = mdRng * 747796405u + 2891336453u;
							let mdU = ${ __CLOUD.pcg }( mdRng );
							let mdSt = select( select( mdSigmaT.b, mdSigmaT.g, mdU < mdP.r + mdP.g ), mdSigmaT.r, mdU < mdP.r );
							mdRng = mdRng * 747796405u + 2891336453u;
							let mdT = select( 1e30, - log( max( 1.0 - ${ __CLOUD.pcg }( mdRng ), 1e-12 ) ) / mdSt, mdSt > 0.0 );
							if ( mdT < hitResult.dist ) {

								// cap: very dense, bright media (paths that never find out) end dark rather than run on
								if ( mdEvents >= 1024u ) {

									break;

								}
								let mdTr = exp( - mdSigmaT * mdT );
								throughputColor *= mdSigmaS * mdTr / max( dot( mdSigmaT * mdTr, mdP ), 1e-30 );
								let mdPos = ray.origin + ray.direction * mdT;
								let mdDir = ray.direction;
								let mdG = clamp( materialInfo.mediumAnisotropy, - 0.95, 0.95 );
								mdEvents ++;
								mdScattered = true;
								gsRough = true;
								gsCaustic = false;
								isFullyTransmissive = false;

								// next event estimation: one light or the environment, straight through the surface (the light refracted
								// out of the medium after this event is a caustic path – not counted while glass shadows are transparent)
								if ( misEnabled != 0u ) {

									mdRng = mdRng * 747796405u + 2891336453u;
									let mdL0 = ${ __CLOUD.pcg }( mdRng );
									mdRng = mdRng * 747796405u + 2891336453u;
									let mdL1 = ${ __CLOUD.pcg }( mdRng );
									mdRng = mdRng * 747796405u + 2891336453u;
									let mdL2 = ${ __CLOUD.pcg }( mdRng );
									// the light chosen by its estimated contribution (three-gpu-pathtracer 0.0.27's selection, the same weights the
									// forward hits are MIS-weighted with)
									var mdSel = 0.0;
									let mdLightIndex = ${ selectLightFn }( mdPos, envWeight, mdL0, &mdSel );
									var mdLight: ${ lightRecordStruct };
									if ( envActive && mdLightIndex == lightsCount ) {

										let mdEnv = ${ sampleEnvDir }( vec2f( mdL1, mdL2 ) );
										mdLight.direction = mdEnv.direction;
										mdLight.emission = mdEnv.color;
										mdLight.pdf = mdEnv.pdf;
										mdLight.dist = ${ LIGHT_FAR_DISTANCE };
										mdLight.lightType = ${ ENVIRONMENT_LIGHT_TYPE };

									} else {

										mdLight = ${ randomLightSampleFn }( mdLightIndex, mdPos, vec2f( mdL1, mdL2 ) );

									}
									if ( mdSel > 0.0 && mdLight.pdf > 0.0 ) {

										let mdShadowMax = mdLight.dist * ( 1.0 - ${ LIGHT_EPSILON } );
										//@glass-shadow mdPos | mdLight.direction | mdShadowMax | mdLight.direction | false
										if ( any( gsShadow > vec3f( 0.0 ) ) ) {

											let mdPhase = ${ __CLOUD.pdfHG }( dot( mdDir, mdLight.direction ), mdG );
											let mdLightPdf = mdLight.pdf * mdSel;
											let mdMis = select( 1.0, ${ misHeuristicFn }( mdLightPdf, mdPhase ), ${ isMISWeightLightFn }( mdLight.lightType ) && ! gsGlass );
											let mdDirect = throughputColor * mdLight.emission * mdPhase * mdMis * gsShadow / mdLightPdf;
											resultColor += vec4f( ${ clampPathContributionFunc }( mdDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );

										}

									}

								}

								// new direction
								mdRng = mdRng * 747796405u + 2891336453u;
								let mdH0 = ${ __CLOUD.pcg }( mdRng );
								mdRng = mdRng * 747796405u + 2891336453u;
								let mdH1 = ${ __CLOUD.pcg }( mdRng );
								let mdNewDir = ${ __CLOUD.sampleHG }( mdDir, mdG, vec2f( mdH0, mdH1 ) );
								// (not into minPdf: the glossy filter would roughen the smooth face the light leaves through – less total
								// internal reflection, the media came out too bright)
								bsdfPdf = ${ __CLOUD.pdfHG }( dot( mdDir, mdNewDir ), mdG );

								// russian roulette after a few events (the albedo only ever lowers the throughput)
								if ( mdEvents > 2u ) {

									let mdKeep = clamp( max( max( throughputColor.r, throughputColor.g ), throughputColor.b ), 0.05, 0.98 );
									mdRng = mdRng * 747796405u + 2891336453u;
									if ( ${ __CLOUD.pcg }( mdRng ) > mdKeep ) {

										break;

									}
									throughputColor /= mdKeep;

								}

								ray.origin = mdPos;
								ray.direction = mdNewDir;
								ray.maxDist = 0.0;
								bounce --;
								${ rngNextBounce }();
								continue;

							}

							// the face is reached: the stretch's transmittance (the library's absorption is skipped below); its light
							// sample would count the light of the event's sample once more (both refract it into the medium)
							let mdTr = exp( - mdSigmaT * hitResult.dist );
							throughputColor *= mdTr / max( dot( mdTr, mdP ), 1e-30 );
							mdPassed = true;
							mdNoLight = mdScattered && ${ __GS.mode } == 1u;

						}
