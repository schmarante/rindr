// What the viewer needs from the mesh importer without loading it (mesh-importer.js comes with the first mesh file –
// docs/player.md "schlank"): the file extensions it opens and the error for missing companion files.

export const MESH_EXTENSIONS = ['glb', 'gltf', 'fbx', 'max', 'c4d', 'blend', 'obj', '3mf', 'usd', 'usda', 'usdc', 'usdz', 'stl', 'pbrt', 'ifc', 'ifczip', 'vdb', 'nvdb'];

/** a model needs files that were not given (glTF buffers/textures) – the asset window offers to link them */
export class MissingFilesError extends Error {
    constructor(files) {
        super('Missing files: ' + files.map(f => f.uri).join(', '));
        this.name = 'MissingFilesError';
        this.files = files;
    }
}
