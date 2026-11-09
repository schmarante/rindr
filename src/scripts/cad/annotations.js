// Lines, flat fills and texts of drawings (DXF/DWG – cad/drawing-build.js) in the scene and their own picture pass.
//
// They sit in the model's layer groups (Scene Graph: show/hide, explosion, moving) but only on ANNOTATION_LAYER: the
// raster camera, shadows, picking, the batcher and all other passes skip them; the path tracer leaves them out
// (userData.ptHidden). AnnotationPass draws them over the finished picture – raster and HQ alike (user's choice:
// sharp, widths in screen pixels as in CAD programs, hidden by bodies in front), like the toon contours (contour.js):
//   1. depth of the visible model meshes into an own multisampled target (pushed back a little, so lines lying on a
//      surface stay in front)
//   2. the annotation objects into the same target: fills, then lines (fat lines, width in CSS px), then texts
//      (signed distance field of the glyph atlas – sharp at every zoom)
//   3. the target over the picture (premultiplied)
import * as THREE from 'three/webgpu';
import { texture, float, fwidth, smoothstep, uv as uvNode } from 'three/tsl';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

export const ANNOTATION_LAYER = 28;

const mark = (o, matrix) => {
    o.layers.set(ANNOTATION_LAYER);
    o.userData.cadAnnotation = true;
    o.userData.ptHidden = true;
    o.castShadow = o.receiveShadow = false;
    o.matrixAutoUpdate = false;
    o.matrix.fromArray(matrix);
    return o;
};

/**
 * Three.js objects for the annotation data of a drawing; each is added to the group of its node.
 * @param {object} extras result of buildDrawing (lines, fills, texts, atlas)
 * @param {(node: number) => THREE.Object3D} groupOf
 * @returns {THREE.Object3D[]}
 */
export function createAnnotations(extras, groupOf) {
    const out = [];
    for (const l of extras.lines || []) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(l.positions);
        geometry.setColors(l.colors);
        const material = new THREE.Line2NodeMaterial({ vertexColors: true, linewidth: l.width, worldUnits: false });
        material.toneMapped = false;
        material.depthWrite = false;   // annotations only test against the bodies (same plane: painter's order)
        material.userData.baseWidth = l.width;
        const lines = mark(new LineSegments2(geometry, material), l.matrix);
        lines.renderOrder = 1;
        lines.name = 'lines';
        groupOf(l.node).add(lines);
        out.push(lines);
    }
    for (const f of extras.fills || []) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(f.colors, 3));
        geometry.setIndex(new THREE.BufferAttribute(f.index, 1));
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        const material = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, depthWrite: false });
        material.toneMapped = false;
        const mesh = mark(new THREE.Mesh(geometry, material), f.matrix);
        mesh.renderOrder = f.sheet ? -1 : 0;   // the paper sheet of a layout below everything (no depth between fills)
        mesh.name = 'fills';
        groupOf(f.node).add(mesh);
        out.push(mesh);
    }
    if (extras.texts?.length && extras.atlas) {
        const { width, height, data } = extras.atlas;
        const map = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
        // mipmaps: small texts (a viewport scaled down) would miss their strokes when sampled from the full-size field
        map.minFilter = THREE.LinearMipmapLinearFilter;
        map.magFilter = THREE.LinearFilter;
        map.generateMipmaps = true;
        map.colorSpace = THREE.NoColorSpace;
        map.needsUpdate = true;
        // one material for all texts of the drawing: colour per vertex, coverage from the distance field
        const material = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false });
        const d = texture(map, uvNode()).r;
        // edge width from the screen derivative: small texts (mip levels averaged) still show as soft strokes
        const w = fwidth(d).max(1e-4);
        material.opacityNode = smoothstep(float(0.5).sub(w), float(0.5).add(w), d);
        material.toneMapped = false;
        material.userData.atlas = map;
        for (const t of extras.texts) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
            geometry.setAttribute('color', new THREE.BufferAttribute(t.colors, 3));
            geometry.setIndex(new THREE.BufferAttribute(t.index, 1));
            geometry.computeBoundingSphere();
            geometry.computeBoundingBox();
            const mesh = mark(new THREE.Mesh(geometry, material), t.matrix);
            mesh.renderOrder = 2;
            mesh.name = 'texts';
            groupOf(t.node).add(mesh);
            out.push(mesh);
        }
    }
    return out;
}

/** free the GPU data of annotation objects below root (with their materials – they are their own) */
export function disposeAnnotations(root) {
    const textures = new Set();
    root.traverse(o => {
        if (!o.userData.cadAnnotation) return;
        o.geometry?.dispose();
        if (o.material?.userData.atlas) textures.add(o.material.userData.atlas);
        o.material?.dispose();
        o.dispatchEvent({ type: 'dispose' });
    });
    textures.forEach(t => t.dispose());
}

export class AnnotationPass {
    /**
     * @param {{ roots: () => THREE.Object3D[], hide?: () => THREE.Object3D[] }} opts roots = model roots, hide = objects
     *   left out of the depth pass (ground disc …)
     */
    constructor(renderer, scene, camera, { roots, hide = () => [] }) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.roots = roots;
        this.hide = hide;
        this.target = new THREE.RenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType, depthBuffer: true });
        this.depthMaterial = new THREE.MeshBasicNodeMaterial();
        this.depthMaterial.colorWrite = false;
        this.depthMaterial.polygonOffset = true;
        this.depthMaterial.polygonOffsetFactor = 1;
        this.depthMaterial.polygonOffsetUnits = 2;
        this.depthMaterial.side = THREE.DoubleSide;
        const quad = new THREE.MeshBasicNodeMaterial();
        quad.colorNode = texture(this.target.texture);
        quad.transparent = true;
        quad.premultipliedAlpha = true;
        quad.depthTest = false;
        quad.depthWrite = false;
        quad.toneMapped = false;
        this.quad = new THREE.QuadMesh(quad);
        this._size = new THREE.Vector2();
    }

    // visible annotation objects (all parents visible) and whether any model mesh is visible (depth pass needed)
    _scan() {
        const lines = [];
        let solids = false;
        const visit = o => {
            if (!o.visible) return;
            if (o.userData.cadAnnotation) { lines.push(o); return; }
            if (o.isMesh && !o.isSplat && !solids) solids = true;
            for (const c of o.children) visit(c);
        };
        for (const r of this.roots()) if (r) visit(r);
        return { list: lines, solids };
    }

    has() {
        return this._scan().list.length > 0;
    }

    /** draw the annotations over the image of the current render target (the canvas by default) */
    render(camera = this.camera, { scale = 1 } = {}) {
        const { list, solids } = this._scan();
        if (!list.length) return;
        const { renderer, scene } = this;
        const current = renderer.getRenderTarget();
        if (current) this._size.set(current.width, current.height);
        else renderer.getDrawingBufferSize(this._size);
        if (this.target.width !== this._size.x || this.target.height !== this._size.y) this.target.setSize(this._size.x, this._size.y);
        for (const o of list) if (o.material?.isLine2NodeMaterial) o.material.linewidth = o.material.userData.baseWidth * scale;
        const prev = {
            target: current, face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(), autoClear: renderer.autoClear,
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial, mask: camera.layers.mask,
            clearAlpha: renderer.getClearAlpha(), toneMapping: renderer.toneMapping,
        };
        const clearColor = renderer.getClearColor(new THREE.Color());
        const hidden = this.hide().filter(o => o?.visible);
        hidden.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        renderer.setClearColor(0x000000, 0);
        renderer.toneMapping = THREE.NoToneMapping;
        try {
            renderer.setRenderTarget(this.target);
            renderer.clear(true, true, false);
            renderer.autoClear = false;
            if (solids) {
                // 1. depth of the model (layer 0 – what the raster camera sees)
                scene.overrideMaterial = this.depthMaterial;
                camera.layers.set(0);
                renderer.render(scene, camera);
                scene.overrideMaterial = null;
            }
            // 2. fills, lines, texts (render order), depth-tested against 1
            camera.layers.set(ANNOTATION_LAYER);
            renderer.render(scene, camera);
        } finally {
            camera.layers.mask = prev.mask;
            scene.overrideMaterial = prev.override;
            scene.background = prev.background;
            scene.backgroundNode = prev.backgroundNode;
            hidden.forEach(o => { o.visible = true; });
            renderer.setClearColor(clearColor, prev.clearAlpha);
            renderer.toneMapping = prev.toneMapping;
            renderer.setRenderTarget(prev.target, prev.face, prev.mip);
        }
        // 3. over the picture
        renderer.autoClear = false;
        this.quad.render(renderer);
        renderer.autoClear = prev.autoClear;
    }

    dispose() {
        this.target.dispose();
        this.depthMaterial.dispose();
        this.quad.material.dispose();
    }
}
