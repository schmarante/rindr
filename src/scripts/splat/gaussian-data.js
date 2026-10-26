// Data of the traced Gaussian splats (gaussian-bvh-worker.js builds it, gaussian-pt.js reads it in the path tracer):
// one storage buffer (header, BVH nodes, splats – vec4 units) and the uniforms. Own module without WGSL helpers – the
// viewer's start bundle sets it (splat-volume.js), only the path tracer's modules bring the shader code.
import * as THREE from 'three/webgpu';
import { storage, uniform } from 'three/tsl';

export const GAUSS = {
    data: storage(new THREE.StorageBufferAttribute(new Float32Array(16), 4), 'vec4').toReadOnly().setName('rindr_gaussians'),
    on: uniform(0),                          // traced (1) or the grid's medium (0, splat-volume.js)
    mode: uniform(0, 'uint'),                // look: 0 baked (light as captured), 1 surface, 2 volume (relit)
    primary: uniform(1),                     // seen by camera rays (object splats; scans are drawn by the raster)
    inverse: uniform(new THREE.Matrix4()),   // world → the splats' data space
    shRange: uniform(1),                     // view-dependent colour: scale of the snorm8 SH bands (splat-mesh.js)
};
