// Box of voxel volumes (unit cubes placed by their matrices) – needed while loading, without the volume system
// (grid-volumes.js comes with the first volume – docs/player.md "schlank").
import * as THREE from 'three/webgpu';

export function volumeBounds(volumes) {
    const box = new THREE.Box3(), m = new THREE.Matrix4();
    for (const v of volumes || []) box.union(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(m.fromArray(v.matrix)));
    return box;
}
