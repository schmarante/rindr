// .blend scene (blend-parse.js, from the worker) → a three.js object tree like the loaders give it; mesh-importer.js
// converts it like the other formats.
// Transforms: local = T(loc) · R(rotmode) · S(size), in the parent: parentinv · local (Blender: world = parent · parentinv ·
// local); Z up → the root turned −90° about X. Rotation modes 1…6 = Euler XYZ, XZY, YXZ, YZX, ZXY, ZYX (the first axis
// first → three.js' reversed order), 0 quaternion (w, x, y, z), −1 axis angle.
// Materials: Principled values in scene-linear colour (no sRGB conversion) – a linked input ignores its value (Base
// Color with an image: white × image; multiplied it darkened, a nearly black value under a wall texture) –, image
// textures from the packed bytes (or the file path, relative "//" = next to the .blend) with the Mapping node's scale /
// location; transmission → physical glass. Both sides drawn unless the material culls back faces (blend_flag bit 2).
// Cameras: the clip start goes with the view (its near plane – a camera behind a wall with a 26.8 m clip start).
// Cameras: look along −Z, up +Y; the lens over the sensor width (fit auto: the larger render side).
import * as THREE from 'three/webgpu';

const EULER = [null, 'ZYX', 'YZX', 'ZXY', 'XZY', 'YXZ', 'XYZ'];   // Blender's 1…6 → three.js

export function buildBlend(scene, manager, name = '') {
    const root = new THREE.Group();
    root.name = name;
    const zUp = new THREE.Group();
    zUp.rotation.x = -Math.PI / 2;
    root.add(zUp);
    const loader = new THREE.TextureLoader(manager);
    const urls = [];
    const textures = new Map();
    const texture = (map, srgb) => {
        if (!map) return null;
        const im = scene.images[map.image];
        if (!im) return null;
        const key = map.image + (srgb ? '|s' : '');
        let base = textures.get(key);
        if (!base) {
            let url;
            if (im.data) { url = URL.createObjectURL(new Blob([im.data])); urls.push(url); }
            else url = im.path.replace(/^\/\//, '');
            base = loader.load(url);
            base.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            base.wrapS = base.wrapT = THREE.RepeatWrapping;
            base.name = im.path.split('/').pop() || im.name;
            textures.set(key, base);
        }
        if (!map.repeat && !map.offset && !map.rotation) return base;
        const t = base.clone();
        if (map.repeat) t.repeat.set(map.repeat[0], map.repeat[1]);
        if (map.offset) t.offset.set(map.offset[0], map.offset[1]);
        if (map.rotation) t.rotation = map.rotation;
        return t;
    };
    const materials = scene.materials.map(m => {
        const glass = m.transmission > 0.01;
        const mat = new THREE.MeshPhysicalMaterial({ name: m.name, ior: Math.min(Math.max(m.ior || 1.5, 1), 2.333) });
        if (glass) { mat.transmission = m.transmission; mat.thickness = 0; }
        // Blender's Specular IOR Level 0.5 = three.js' specular intensity 1 (0 = no reflection: fabrics shone like satin)
        mat.specularIntensity = Math.min(Math.max((m.specular ?? 0.5) * 2, 0), 1);
        mat.color.setRGB(...m.color);   // scene-linear
        mat.roughness = Math.min(Math.max(m.roughness, 0), 1);
        mat.metalness = Math.min(Math.max(m.metallic, 0), 1);
        const map = texture(m.maps.color, true);
        if (map) { mat.map = map; mat.color.set(0xffffff); }
        if (!m.cullBack) mat.side = THREE.DoubleSide;
        const rough = texture(m.maps.roughness, false);
        if (rough) { mat.roughnessMap = rough; mat.roughness = 1; }
        const metal = texture(m.maps.metallic, false);
        if (metal) { mat.metalnessMap = metal; mat.metalness = 1; }
        const normal = texture(m.maps.normal, false);
        if (normal) mat.normalMap = normal;
        const bump = texture(m.maps.bump, false);
        if (bump) { mat.bumpMap = bump; mat.bumpScale = m.bumpStrength ?? 1; }
        if (m.emissionStrength > 0 && Math.max(...m.emission) > 0) {
            mat.emissive.setRGB(...m.emission.map(v => v * Math.min(m.emissionStrength, 10)));
            const glow = texture(m.maps.emission, true);
            if (glow) mat.emissiveMap = glow;
        }
        const alpha = texture(m.maps.alpha, false);
        if (!glass && (m.alpha < 0.999 || alpha)) { mat.transparent = true; mat.opacity = m.alpha; if (alpha) mat.alphaMap = alpha; }
        return mat;
    });
    const fallback = new THREE.MeshStandardMaterial({ name: 'Standard', color: 0xb0b0b0, roughness: 0.5 });

    const nodes = [];
    const cameras = [];
    const local = o => {
        const q = new THREE.Quaternion();
        if (o.rotmode === 0 && o.quat) q.set(o.quat[1], o.quat[2], o.quat[3], o.quat[0]).normalize();
        else if (o.rotmode === -1 && o.rotAxis) q.setFromAxisAngle(new THREE.Vector3(...o.rotAxis).normalize(), o.rotAngle || 0);
        else q.setFromEuler(new THREE.Euler(o.rot[0], o.rot[1], o.rot[2], EULER[o.rotmode] || 'ZYX'));
        const m = new THREE.Matrix4().compose(new THREE.Vector3(...o.loc), q, new THREE.Vector3(...o.size));
        if (o.parent >= 0 && o.parentinv) m.premultiply(new THREE.Matrix4().fromArray(o.parentinv));
        return m;
    };
    scene.objects.forEach((o, i) => {
        let node;
        const g = o.geometry >= 0 ? scene.geometries[o.geometry] : null;
        if (g && g.parts.length) {
            node = new THREE.Group();
            for (const p of g.parts) {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
                geometry.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
                if (p.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
                geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
                const slotMat = o.slots[p.slot] ?? g.slots[p.slot];
                const mesh = new THREE.Mesh(geometry, slotMat >= 0 ? materials[slotMat] : fallback);
                mesh.name = g.parts.length > 1 ? `${o.name} ${mesh.material.name}` : o.name;
                node.add(mesh);
            }
            if (g.parts.length === 1) node = node.children[0];
        } else node = new THREE.Group();
        node.name = o.name;
        local(o).decompose(node.position, node.quaternion, node.scale);
        if (o.hidden) node.visible = false;
        nodes[i] = node;
        if (o.camera && o.camera.type === 0) {
            const r = scene.render;
            const aspect = r?.x && r?.y ? (r.x * (r.aspx || 1)) / (r.y * (r.aspy || 1)) : 16 / 9;
            const horizontal = o.camera.fit === 1 || (o.camera.fit === 0 && aspect >= 1);
            const sensor = o.camera.fit === 2 ? o.camera.sensorY : o.camera.sensor;
            const fov = THREE.MathUtils.radToDeg(2 * Math.atan(sensor / 2 / o.camera.lens));
            cameras.push({ name: o.name, object: node, fov, fovAxis: horizontal ? 'h' : 'v', aspect, near: o.camera.clip > 0.01 ? o.camera.clip : 0 });
        }
    });
    scene.objects.forEach((o, i) => (o.parent >= 0 && nodes[o.parent] ? nodes[o.parent] : zUp).add(nodes[i]));
    return { object: root, cameras, scale: (scene.metersPerUnit || 1) * 1000, urls, modifiers: [...new Set(scene.objects.flatMap(o => o.modifiers))] };
}
