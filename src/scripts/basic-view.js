// Basic view (view mode 'basic'): a slimmed-down Standard – every model material is drawn as a plain twin with its base
// colour (colour map, vertex colours, emission, opacity), diffuse only (roughness 1, no metal, coat, sheen, transmission
// or special effects). Shadow maps, the ground shadow and the ambient occlusion are off in Basic (viewer.js).
//
// The twin is swapped in while drawing: renderer.renderObject is wrapped. three.js calls it for every draw – also from
// compileAsync, which ignores setRenderObjectFunction – so the first Basic precompiles the twins (no freeze with many
// colours). The meshes keep their materials: the batches stay grouped (render-batcher.js keys by material), selection,
// material editor, scene state and path tracer see the real ones. Passes with an override material (shadow maps,
// contours, selection outline …) still draw their override – three.js applies it after this swap.
//
// Only materials of the material manager (userData.materialId) in the main scene: material previews and helper meshes
// (ground, clouds, grass blades) keep theirs.

import * as THREE from 'three/webgpu';
import { FADE_MASK } from './material-manager.js';

export class BasicView {
    /** @param {THREE.WebGPURenderer} renderer @param {THREE.Scene} scene the main scene */
    constructor(renderer, scene) {
        this.scene = scene;
        this.active = false;
        this.twins = new WeakMap();   // source material → twin
        const renderObject = renderer.renderObject.bind(renderer);
        renderer.renderObject = (object, s, camera, geometry, material, ...rest) => renderObject(object, s, camera, geometry,
            this.active && s === this.scene && material?.userData?.materialId !== undefined ? this.twin(material) : material, ...rest);
    }

    /** Plain twin of a model material – structure synced when the source's version changes, values every draw */
    twin(src) {
        let t = this.twins.get(src);
        if (!t || t.userData.sourceVersion !== src.version) t = this._sync(src, t);
        // uniforms: no new shader – a colour changed in the material editor shows at once
        t.color.copy(src.color);
        t.emissive.copy(src.emissive);
        t.emissiveIntensity = src.emissiveIntensity;
        t.opacity = src.transmission > 0 ? Math.min(src.opacity, GLASS_OPACITY) : src.opacity;
        t.displacementScale = src.displacementScale;
        t.displacementBias = src.displacementBias;
        return t;
    }

    // what changes the twin's shader – a new one only if one of these really differs (the source's version also
    // counts changes the twin does not have, e.g. its coat or special effects)
    _sync(src, t) {
        const fresh = !t;
        t ??= new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
        const want = {
            map: src.map || null,
            emissiveMap: src.emissiveMap || null,
            vertexColors: src.vertexColors,
            side: src.side,
            // glass shows as tinted see-through instead of refraction; other transparency as in the source
            transparent: src.transparent || src.transmission > 0,
            depthWrite: src.transmission > 0 ? false : src.depthWrite,
            alphaTest: src.alphaTest,
            alphaMap: src.alphaMap || null,
            // the shape stays: displacement and position nodes of the source (as three.js does for override materials)
            positionNode: src.positionNode?.isNode ? src.positionNode : null,
            displacementMap: src.displacementMap || null,
        };
        let changed = fresh;
        for (const [k, v] of Object.entries(want)) if (t[k] !== v) { t[k] = v; changed = true; }
        if (fresh) {
            t.name = `${src.name} (Basic)`;
            t.maskNode = FADE_MASK;   // fade-in on import
            t.userData.basicTwin = true;
            this.twins.set(src, t);
        }
        t.userData.sourceVersion = src.version;
        if (changed) t.needsUpdate = true;
        return t;
    }
}

const GLASS_OPACITY = 0.35;
