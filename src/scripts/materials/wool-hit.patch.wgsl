// RINDR wool fibres – inserted into three-gpu-pathtracer's ray / triangle test (PathtracerBVHComputeData.js,
// intersectRange) by the Vite plugin rindr-wool (astro.config.mjs): a triangle of a wool mesh also tests its shells
// (the vertices pushed out along their normals, like the raster's) and keeps a hit only on a fibre (wool-pt.js).
// Local units; the interpolations are the variables of that file and __WOOL (wool-pt.js).
						// RINDR wool fibres (wool.js, wool-pt.js)
						if ( ${ woolLength } > 0.0 ) {

							let wn0 = ${ storage.attributes }[ i0 ].normal.xyz;
							let wn1 = ${ storage.attributes }[ i1 ].normal.xyz;
							let wn2 = ${ storage.attributes }[ i2 ].normal.xyz;
							let wTop0 = a + wn0 * ${ woolLength };
							let wTop1 = b + wn1 * ${ woolLength };
							let wTop2 = c + wn2 * ${ woolLength };
							// the prism between the triangle and its outermost shell – most rays pass it by
							let wMin = min( min( min( a, b ), c ), min( min( wTop0, wTop1 ), wTop2 ) );
							let wMax = max( max( max( a, b ), c ), max( max( wTop0, wTop1 ), wTop2 ) );
							let wInv = 1.0 / ray.direction;
							let wT0 = ( wMin - ray.origin ) * wInv;
							let wT1 = ( wMax - ray.origin ) * wInv;
							let wNear = max( max( min( wT0.x, wT1.x ), min( wT0.y, wT1.y ) ), min( wT0.z, wT1.z ) );
							let wFar = min( min( max( wT0.x, wT1.x ), max( wT0.y, wT1.y ) ), max( wT0.z, wT1.z ) );
							if ( wFar >= max( wNear, 0.0 ) && ( ! result.didHit || wNear * ${ scratchRayScalar } < result.dist ) ) {

								// the ray inside the prism: clipped at its three sides (planes through an edge and the mean normal of
								// its ends, a tenth of the fibre length outside – the sides twist a little); rays from within the fur
								// pass most neighbouring prisms by
								var wTa = max( wNear, 0.0 );
								var wTb = select( wFar, min( wFar, result.dist / ${ scratchRayScalar } ), result.didHit );
								let wMargin = 0.1 * ${ woolLength };
								let wFace = normalize( cross( b - a, c - a ) );
								for ( var ws = 0u; ws < 3u; ws ++ ) {

									let wp = select( select( c, b, ws == 1u ), a, ws == 0u );
									let wq = select( select( a, c, ws == 1u ), b, ws == 0u );
									let wr = select( select( b, a, ws == 1u ), c, ws == 0u );
									let wnp = select( select( wn2, wn1, ws == 1u ), wn0, ws == 0u );
									let wnq = select( select( wn0, wn2, ws == 1u ), wn1, ws == 0u );
									var wSide = cross( wq - wp, wnp + wnq );
									wSide *= select( 1.0, - 1.0, dot( wr - wp, wSide ) < 0.0 ) / max( length( wSide ), 1e-20 );
									let wF0 = dot( ray.origin - wp, wSide ) + wMargin;
									let wFd = dot( ray.direction, wSide );
									if ( abs( wFd ) < 1e-12 ) {

										wTb = select( wTb, - 1.0, wF0 < 0.0 );

									} else if ( wFd > 0.0 ) {

										wTa = max( wTa, - wF0 / wFd );

									} else {

										wTb = min( wTb, - wF0 / wFd );

									}

								}

								// only the shells the ray crosses there, in its order, until the first fibre: the height along the ray
								// from the face plane (the shells are close to parallel to it), one shell margin
								let wRise = dot( ( wn0 + wn1 + wn2 ) * ( 1.0 / 3.0 ), wFace );
								let wHa = dot( ray.origin + ray.direction * wTa - a, wFace ) / wRise;
								let wHb = dot( ray.origin + ray.direction * wTb - a, wFace ) / wRise;
								let wScale = ${ __WOOL.shellsF } / ${ woolLength };
								// clipped away: no shell
								let wLo = select( ${ __WOOL.shells } + 1u, u32( clamp( floor( min( wHa, wHb ) * wScale ) - 1.0, 1.0, ${ __WOOL.shellsF } + 1.0 ) ), wTb >= wTa );
								let wHi = u32( clamp( ceil( max( wHa, wHb ) * wScale ) + 1.0, 0.0, ${ __WOOL.shellsF } ) );
								let wDown = wHb < wHa;
								let wCell = ${ woolLength } / ${ __WOOL.perLength };
								for ( var wi = wLo; wi <= wHi; wi ++ ) {

									let wk = select( wi, wHi + wLo - wi, wDown );
									let wLayer = f32( wk ) / ${ __WOOL.shellsF };
									let wH = ${ woolLength } * wLayer;
									var wHit = ${ intersectRayTriangle }( ray, a + wn0 * wH, b + wn1 * wH, c + wn2 * wH, 0.0 );
									wHit.dist *= ${ scratchRayScalar };
									if ( wHit.didHit && ( ray.maxDist <= 0.0 || wHit.dist < ray.maxDist ) && ( ! result.didHit || wHit.dist < result.dist ) ) {

										let wBase = a * wHit.barycoord.x + b * wHit.barycoord.y + c * wHit.barycoord.z;
										if ( ${ __WOOL.fibre }( wBase, wLayer, wCell ).x > 0.5 ) {

											// fibres scatter from both sides: the normal faces the ray
											result.didHit = true;
											result.dist = wHit.dist;
											result.normal = wHit.normal;
											result.side = 1.0;
											result.barycoord = wHit.barycoord;
											result.indices = vec4u( i0, i1, i2, ti );
											didHit = true;
											break;

										}

									}

								}

							}

						}


