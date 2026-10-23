// Instances of parts and assemblies (Oct. 2026, user's wish: Shift + gizmo drag clones the object like in MAX – as an
// instance). A block = a copy of one node with everything below it: new groups (appended to the model's node list,
// parent = the source's parent), meshes sharing geometry and material with their source. Moved, rotated, scaled,
// hidden, deleted and given a material per object (user: "instances can have different materials – they are no
// references"); the UV mapping (the modifier) is linked within the instance family (all objects copied from the same
// original that are not made unique – viewer.js propagates it) until "make unique".
//
// model = { root, nodeGroups, meshes, importNodes, partCounts } (the arrays the viewer and the Scene Graph share – a
// block is appended to them and removed from their end again: undo is last in, first out). Keys: groups are 'n<index>'
// like the file's nodes, meshes `<source key>~<tag>` – stable across reloads when the blocks are replayed in order
// (scene state `duplicates`, root.userData.duplicates).
import * as THREE from 'three/webgpu';
import { applyTransform } from './transform.js';

/** first object of an instance family (the original) */
export const familyOf = o => o.userData.instanceOf ?? o;

/** object linked to its instance family (made unique = a copy of its own) */
export const isLinked = o => !o.userData.unique;

const cloneXf = xf => ({
    pivot: xf.pivot.clone(), offset: xf.offset.clone(), rotation: xf.rotation.clone(), scale: (xf.scale ?? new THREE.Vector3(1, 1, 1)).clone(),
    explode: (xf.explode ?? new THREE.Vector3()).clone(), rest: xf.rest?.clone(),
});

/**
 * Copy node `index` with its subtree as instances. Returns the block { tag, of, top, nodeStart, nodeEnd, meshStart,
 * meshEnd, groups, meshes } – top = the new group of the node itself (same place as the source).
 */
export function duplicateNode(model, index, tag) {
    const nodes = model.importNodes;
    // subtree in index order (children always come after their parent – also in appended blocks)
    const tree = [index];
    const inTree = new Set(tree);
    for (let i = index + 1; i < nodes.length; i++) if (inTree.has(nodes[i].parent)) { inTree.add(i); tree.push(i); }
    const map = new Map();
    const nodeStart = nodes.length, meshStart = model.meshes.length;
    const groupIndex = new Map(model.nodeGroups.map((g, i) => [g, i]));
    const groups = [];
    for (const i of tree) {
        const j = nodes.length;
        map.set(i, j);
        const parent = i === index ? nodes[i].parent : map.get(nodes[i].parent);
        nodes.push({ ...nodes[i], parent });
        model.partCounts.push(model.partCounts[i] || 0);
        const src = model.nodeGroups[i];
        const g = new THREE.Group();
        g.name = src.name;
        if (src.userData.ifc) g.userData.ifc = src.userData.ifc;
        if (src.userData.mapping) g.userData.mapping = { ...src.userData.mapping };
        g.userData.instanceOf = familyOf(src);
        if (src.userData.xf) {
            g.userData.xf = cloneXf(src.userData.xf);
            applyTransform(g);
        } else {
            g.matrix.copy(src.matrix);
            g.matrixAutoUpdate = src.matrixAutoUpdate;
        }
        (parent >= 0 ? model.nodeGroups[parent] : model.root).add(g);
        model.nodeGroups.push(g);
        groups.push(g);
    }
    // meshes of the subtree: share geometry (the import geometry – an own UV mapping is projected again for the
    // copy, a shared projected geometry would be freed when the source is projected anew) and material
    const meshes = [];
    for (const m of model.meshes.slice(0, meshStart)) {
        const gi = groupIndex.get(m.parent);
        if (gi === undefined || !map.has(gi)) continue;
        const c = new THREE.Mesh(m.userData.uvBase ?? m.geometry, m.material);
        c.name = m.name;
        c.matrixAutoUpdate = false;
        c.matrix.copy(m.matrix);
        c.castShadow = m.castShadow;
        c.receiveShadow = m.receiveShadow;
        // not Mesh.clone(): it copies userData as JSON (geometries, transforms …)
        c.userData = { key: `${m.userData.key}~${tag}`, instance: m.userData.instance, defaultMaterialId: m.userData.defaultMaterialId,
            instanceOf: familyOf(m), dupOf: m };
        model.nodeGroups[map.get(gi)].add(c);
        model.meshes.push(c);
        meshes.push(c);
    }
    model.root.updateMatrixWorld(true);
    return { tag, of: index, top: groups[0], nodeStart, nodeEnd: nodes.length, meshStart, meshEnd: model.meshes.length, groups, meshes };
}

/** remove the block again (must be the last one appended) */
export function removeDuplicate(model, block) {
    if (model.importNodes.length !== block.nodeEnd || model.meshes.length !== block.meshEnd) {
        throw new Error('duplicate block is not the last one');
    }
    for (const c of model.meshes.splice(block.meshStart)) {
        // an own projected geometry (UV mapping of the copy) goes with it; the shared import geometry stays
        if (c.userData.uvBase && c.geometry !== c.userData.uvBase) { c.geometry.boundsTree = null; c.geometry.dispose(); }
        c.removeFromParent();
        c.dispatchEvent({ type: 'dispose' });   // three.js keeps render objects until the mesh says so
    }
    for (const g of model.nodeGroups.splice(block.nodeStart)) g.removeFromParent();
    model.importNodes.length = block.nodeStart;
    model.partCounts.length = block.nodeStart;
}

/** linked members of the instance families of the given objects (the objects themselves included) */
export function linkedMembers(objects, candidates) {
    const families = new Set(objects.filter(isLinked).map(familyOf));
    if (!families.size) return objects;
    const out = new Set(objects);
    for (const o of candidates) if (isLinked(o) && families.has(familyOf(o))) out.add(o);
    return [...out];
}

/** make an object and everything below it a copy of its own (leaves its instance family) – returns what was linked */
export function makeUnique(object) {
    const changed = [];
    object.traverse(o => { if ((o.isMesh || o.isGroup) && !o.userData.unique) { o.userData.unique = true; changed.push(o); } });
    return changed;
}
