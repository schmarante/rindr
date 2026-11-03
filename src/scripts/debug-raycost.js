// Debug display (?debug): ray cost heat map – how much BVH work the path tracer's first hit costs per pixel, to find
// expensive geometry (dense or overlapping parts, huge or sliver triangles, many instances on top of each other).
//
// One ray per pixel with the raster camera (fisheye like the path tracer – FISHEYE_RAY) through the path tracer's own
// scene data (TLAS + BLAS, transforms: pathTracer._bvhData), traversed by an own shapecast (three-mesh-bvh
// getShapecastFn – public API, no patch) that counts per ray:
//   box tests  – child bounds tested (two per inner node visited, TLAS and BLAS)
//   triangles  – triangles tested in the leaves
//   clusters   – BLAS entered: the path tracer splits meshes into clusters, each a TLAS leaf with a BLAS of its own
//                (overlapping parts / instances show up here)
// Like the library's first-hit raycast: front to back, nodes behind the closest hit skipped; no alpha test. The ray
// enters an object's space unnormalized, so distances stay those of the world ray (no scale variable needed).
// Not counted: what is not in the BVH – wool fibres, cloud and splat volumes, traced Gaussians (own walks after a hit).
//
// Shown over the whole picture (after the frame, under the highlight and gizmo), linear up to the 99th percentile (or a
// fixed value; a log scale made most of the picture yellow – hot spots did not stand out); statistics per metric from a histogram (16 exact bins, then 8 per octave) + maximum; the values
// under the mouse with the part there (raster picking). Needs the path tracer's scene – switching on starts HQ once.
import { StorageTexture, FloatType, RGBAFormat, NearestFilter, Matrix4, Vector2, StorageBufferAttribute, StructTypeNode, MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { uniform, globalId, textureStore, textureLoad, storage, uint, Fn, vec3, ivec2, screenCoordinate, clamp, mix, max, select } from 'three/tsl';
import { wgslTagFn, rayStruct, bvhNodeBoundsStruct, bvhNodeStruct, intersectRayTriangle, ndcToCameraRay } from 'three-mesh-bvh/webgpu';
import { FISHEYE_RAY } from './fisheye.js';
import { t } from './i18n.js';
import { CHECKBOX, SELECT } from './ui-controls.js';

const BINS = 128;
const METRICS = ['boxes', 'tris', 'objects'];
const STATS = METRICS.length * BINS + METRICS.length;   // histograms, then the maxima
const BAND_PIXELS = 262_144;   // pixels per dispatch (one over a 4K image of a huge scene could hit the GPU watchdog)
const _rotation = new Matrix4();

// histogram bin of a count: exact below 16, then 8 bins per octave
const binOf = wgslTagFn/* wgsl */`
    fn rindrCostBin( v: u32 ) -> u32 {

        if ( v < 16u ) {

            return v;

        }
        return min( u32( 16.0 + floor( log2( f32( v ) / 16.0 ) * 8.0 ) ), ${ BINS - 1 }u );

    }
`;
const binValue = b => (b < 16 ? b : 16 * 2 ** ((b - 16) / 8));

// entry distance of the ray into the bounds (a miss: far away)
const entryDistance = wgslTagFn/* wgsl */`
    fn rindrCostEntry( ray: ${ rayStruct }, bounds: ${ bvhNodeBoundsStruct } ) -> f32 {

        let inv = 1.0 / ray.direction;
        let t0 = ( vec3f( bounds.min[ 0 ], bounds.min[ 1 ], bounds.min[ 2 ] ) - ray.origin ) * inv;
        let t1 = ( vec3f( bounds.max[ 0 ], bounds.max[ 1 ], bounds.max[ 2 ] ) - ray.origin ) * inv;
        let tNear = max( max( min( t0.x, t1.x ), min( t0.y, t1.y ) ), min( t0.z, t1.z ) );
        let tFar = min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) );
        return select( max( tNear, 0.0 ), 3.4e38, tFar < max( tNear, 0.0 ) );

    }
`;

const costResultStruct = new StructTypeNode({
    didHit: 'bool',
    dist: 'float',
    boxes: 'uint',
    tris: 'uint',
}, 'RindrCostResult');

// colour ramp of the heat map (the legend in the panel uses the same stops)
const STOPS = [[0.03, 0.02, 0.18], [0.0, 0.22, 0.85], [0.0, 0.75, 0.85], [0.1, 0.8, 0.2], [1.0, 0.85, 0.1], [0.95, 0.12, 0.08]];
const ramp = Fn(([x]) => {
    const s = clamp(x, 0, 1).mul(STOPS.length - 1);
    let c = vec3(...STOPS[0]);
    for (let i = 1; i < STOPS.length; i++) c = mix(c, vec3(...STOPS[i]), clamp(s.sub(i - 1), 0, 1));
    return c;
});

const storageTexture = () => {
    const tex = new StorageTexture(1, 1);
    tex.type = FloatType;
    tex.format = RGBAFormat;
    tex.generateMipmaps = false;
    tex.minFilter = tex.magFilter = NearestFilter;
    return tex;
};

class RayCostKernel {
    constructor() {
        this.counts = storageTexture();
        this.counts.name = 'Ray cost counts';
        this.statsAttr = new StorageBufferAttribute(new Uint32Array(STATS), 1);
        this.objects = uint(0).toVar('rindr_costObjects');
        this.params = {
            globalIdBand: globalId,
            size: uniform(new Vector2()),
            rowOffset: uniform(0, 'uint'),
            invViewProj: uniform(new Matrix4()),
            cameraWorld: uniform(new Matrix4()),
            target: textureStore(this.counts).toWriteOnly(),
            stats: storage(this.statsAttr, 'uint', STATS).toAtomic(),
        };
        this._size = new Vector2();
        this._bvhData = null;
        this.kernel = null;
        this.order = 'sign';   // child order (see _shapecast)
    }

    setOrder(order) {
        if (order === this.order) return;
        this.order = order;
        this._bvhData = null;   // rebuilt on the next run
    }

    // counting first-hit shapecast over this scene data's TLAS + BLAS
    _shapecast(bvhData) {
        const { index, attributes, transforms } = bvhData.storage;
        const objects = this.objects;
        return bvhData.getShapecastFn({
            name: 'rindrCostRaycast',
            shapeStruct: rayStruct,
            resultStruct: costResultStruct,
            // child order: as the path tracer (sign of the ray along the node's split axis) or the nearer child first
            // (entry distances – comparison: is the cheap order of the path tracer good here?)
            boundsOrderFn: this.order === 'distance' ? wgslTagFn/* wgsl */`
                fn rindrCostOrderNear( ray: ${ rayStruct }, splitAxis: u32, node: ${ bvhNodeStruct } ) -> bool {

                    return ${ entryDistance }( ray, node.leftBounds ) <= ${ entryDistance }( ray, node.rightBounds );

                }
            ` : wgslTagFn/* wgsl */`
                fn rindrCostOrder( ray: ${ rayStruct }, splitAxis: u32, node: ${ bvhNodeStruct } ) -> bool {

                    return ray.direction[ splitAxis ] >= 0.0;

                }
            `,
            intersectsBoundsFn: wgslTagFn/* wgsl */`
                fn rindrCostBounds( ray: ${ rayStruct }, bounds: ${ bvhNodeBoundsStruct }, result: ptr<function, ${ costResultStruct }> ) -> u32 {

                    result.boxes += 1u;
                    let lo = vec3f( bounds.min[ 0 ], bounds.min[ 1 ], bounds.min[ 2 ] );
                    let hi = vec3f( bounds.max[ 0 ], bounds.max[ 1 ], bounds.max[ 2 ] );
                    let inv = 1.0 / ray.direction;
                    let t0 = ( lo - ray.origin ) * inv;
                    let t1 = ( hi - ray.origin ) * inv;
                    let tNear = max( max( min( t0.x, t1.x ), min( t0.y, t1.y ) ), min( t0.z, t1.z ) );
                    let tFar = min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) );
                    let enter = max( tNear, 0.0 );
                    if ( tFar < enter || ( ray.maxDist > 0.0 && enter >= ray.maxDist ) || ( result.didHit && enter >= result.dist ) ) {

                        return 0u;

                    }
                    return 1u;

                }
            `,
            intersectRangeFn: wgslTagFn/* wgsl */`
                fn rindrCostRange( ray: ${ rayStruct }, offset: u32, count: u32, result: ptr<function, ${ costResultStruct }> ) -> bool {

                    result.tris += count;
                    var didHit = false;
                    for ( var ti = offset; ti < offset + count; ti = ti + 1u ) {

                        let a = ${ attributes }[ ${ index }[ ti * 3u ] ].position.xyz;
                        let b = ${ attributes }[ ${ index }[ ti * 3u + 1u ] ].position.xyz;
                        let c = ${ attributes }[ ${ index }[ ti * 3u + 2u ] ].position.xyz;
                        let hit = ${ intersectRayTriangle }( ray, a, b, c, 0.0 );
                        if ( hit.didHit && ( ray.maxDist <= 0.0 || hit.dist < ray.maxDist ) && ( ! result.didHit || hit.dist < result.dist ) ) {

                            result.didHit = true;
                            result.dist = hit.dist;
                            didHit = true;

                        }

                    }
                    return didHit;

                }
            `,
            transformShapeFn: wgslTagFn/* wgsl */`
                fn rindrCostToLocal( ray: ptr<function, ${ rayStruct }>, objectIndex: u32 ) -> void {

                    let toLocal = ${ transforms }[ objectIndex ].inverseMatrixWorld;
                    ray.origin = ( toLocal * vec4f( ray.origin, 1.0 ) ).xyz;
                    ray.direction = ( toLocal * vec4f( ray.direction, 0.0 ) ).xyz;
                    ${ objects } += 1u;

                }
            `,
        });
    }

    _build(bvhData) {
        const p = this.params, objects = this.objects;
        const raycast = this._shapecast(bvhData);
        const shader = wgslTagFn/* wgsl */`
            fn compute( globalIdBand: vec3u, size: vec2u, rowOffset: u32 ) -> void {

                let id = vec2u( globalIdBand.x, globalIdBand.y + rowOffset );
                if ( id.x >= size.x || id.y >= size.y ) {

                    return;

                }
                // pixel centre, ndc like the path tracer (row 0 = bottom); camera position added afterwards (precision far away)
                let ndc = ( vec2f( id ) + vec2f( 0.5 ) ) / vec2f( size ) * 2.0 - vec2f( 1.0 );
                var ray: ${ rayStruct };
                if ( ! ${ FISHEYE_RAY }( ndc, ${ p.cameraWorld }, &ray ) ) {

                    ray = ${ ndcToCameraRay }( ndc, ${ p.invViewProj } );
                    ray.origin += ( ${ p.cameraWorld } * vec4f( 0.0, 0.0, 0.0, 1.0 ) ).xyz;

                }
                ray.direction = normalize( ray.direction );

                var result: ${ costResultStruct };
                result.didHit = false;
                result.dist = 0.0;
                result.boxes = 0u;
                result.tris = 0u;
                ${ objects } = 0u;
                ${ raycast }( ray, &result );
                let entered = ${ objects };

                textureStore( ${ p.target }, vec2u( id.x, size.y - 1u - id.y ), vec4f( f32( result.boxes ), f32( result.tris ), f32( entered ), select( 0.0, 1.0, result.didHit ) ) );
                atomicAdd( &${ p.stats }[ ${ binOf }( result.boxes ) ], 1u );
                atomicAdd( &${ p.stats }[ ${ BINS }u + ${ binOf }( result.tris ) ], 1u );
                atomicAdd( &${ p.stats }[ ${ 2 * BINS }u + ${ binOf }( entered ) ], 1u );
                atomicMax( &${ p.stats }[ ${ 3 * BINS }u ], result.boxes );
                atomicMax( &${ p.stats }[ ${ 3 * BINS + 1 }u ], result.tris );
                atomicMax( &${ p.stats }[ ${ 3 * BINS + 2 }u ], entered );

            }
        `;
        const fn = shader(p);
        const node = fn.context({});
        node.parameters = fn.parameters;
        this.kernel = node.computeKernel([8, 8, 1]);
    }

    /** Count for the scene data, size and camera; the statistics start from zero */
    run(renderer, bvhData, width, height, camera) {
        const p = this.params;
        if (bvhData !== this._bvhData) {
            this._bvhData = bvhData;
            this._build(bvhData);
        }
        if (this._size.x !== width || this._size.y !== height) {
            this._size.set(width, height);
            const old = this.counts;
            this.counts = old.clone();
            old.dispose();
            this.counts.setSize(width, height);
            p.target.value = this.counts;
        }
        p.size.value.set(width, height);
        camera.updateMatrixWorld();
        p.invViewProj.value.multiplyMatrices(_rotation.copy(camera.matrixWorld).setPosition(0, 0, 0), camera.projectionMatrixInverse);
        p.cameraWorld.value.copy(camera.matrixWorld);
        this.statsAttr.array.fill(0);
        this.statsAttr.needsUpdate = true;
        const rows = Math.max(8, Math.floor(BAND_PIXELS / Math.max(width, 1) / 8) * 8);
        for (let y = 0; y < height; y += rows) {
            p.rowOffset.value = y;
            renderer.compute(this.kernel, [Math.ceil(width / 8), Math.ceil(Math.min(rows, height - y) / 8), 1]);
        }
    }

    /** { boxes|tris|objects: { p50, p95, p99, max } } of the last run */
    async readStats(renderer) {
        const data = new Uint32Array(await renderer.getArrayBufferAsync(this.statsAttr));
        const out = {};
        METRICS.forEach((key, m) => {
            const hist = data.subarray(m * BINS, (m + 1) * BINS);
            let total = 0;
            for (const n of hist) total += n;
            const at = q => {
                let sum = 0;
                for (let b = 0; b < BINS; b++) { sum += hist[b]; if (sum >= q * total) return Math.round(binValue(b)); }
                return 0;
            };
            out[key] = { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: data[3 * BINS + m], total };
        });
        return out;
    }

    /** counts at a pixel of the picture (top-down rows) */
    async readPixel(renderer, x, y) {
        const px = await renderer.backend.copyTextureToBuffer(this.counts, x, y, 1, 1);
        return { boxes: px[0], tris: px[1], objects: px[2], hit: px[3] > 0.5 };
    }

    dispose() {
        this.counts.dispose();
    }
}

/**
 * Section "Ray cost" in the debug display.
 * @param {HTMLElement} root debug display
 * @param {{ renderer, pathTracing, pickHit: (event) => object, startHQ: () => void }} ctx
 * @returns {{ readonly active: boolean, draw(camera): void }}
 */
export function attachRayCostDebug(root, { renderer, pathTracing, pickHit, startHQ }) {
    const kernel = new RayCostKernel();
    const metric = uniform(0, 'uint');
    const scale = uniform(64);
    const texScale = uniform(new Vector2(1, 1));   // canvas pixel → counts texel
    const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    material.toneMapped = false;
    const texNode = textureLoad(kernel.counts, ivec2(screenCoordinate.xy.mul(texScale)));
    const value = select(metric.equal(0), texNode.x, select(metric.equal(1), texNode.y, texNode.z));
    material.colorNode = ramp(value.div(max(scale, 1)));   // linear: hot spots stand out (log made most of the picture yellow)
    const quad = new QuadMesh(material);

    // panel
    const box = document.createElement('div');
    box.className = 'mt-1 border-t border-white/15 pt-1';
    const head = document.createElement('div');
    head.textContent = t('debugStats.rayCost.title');
    const row = () => { const d = document.createElement('label'); d.className = 'mt-1 flex items-center gap-2'; box.append(d); return d; };
    box.append(head);
    const onRow = row();
    const on = Object.assign(document.createElement('input'), { type: 'checkbox', className: CHECKBOX });
    onRow.append(on, t('debugStats.rayCost.enabled'));
    const metricRow = row();
    const metricSel = Object.assign(document.createElement('select'), { className: SELECT });
    for (const k of METRICS) metricSel.append(new Option(t(`debugStats.rayCost.metric.${k}`), k));
    const scaleSel = Object.assign(document.createElement('select'), { className: SELECT });
    scaleSel.append(new Option(t('debugStats.rayCost.scaleAuto'), 'auto'));
    for (const v of [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) scaleSel.append(new Option(String(v), String(v)));
    metricRow.append(t('debugStats.rayCost.metric.label'), metricSel, t('debugStats.rayCost.scale'), scaleSel);
    const orderRow = row();
    const orderSel = Object.assign(document.createElement('select'), { className: SELECT });
    for (const k of ['sign', 'distance']) orderSel.append(new Option(t(`debugStats.rayCost.order.${k}`), k));
    orderRow.append(t('debugStats.rayCost.order.label'), orderSel);
    const legend = document.createElement('div');
    legend.className = 'mt-1 flex items-center gap-1';
    const gradient = document.createElement('span');
    gradient.className = 'h-2 w-28 rounded-sm';
    gradient.style.background = `linear-gradient(90deg, ${STOPS.map(c => `rgb(${c.map(v => Math.round(v * 255)).join(' ')})`).join(', ')})`;
    const legendMax = document.createElement('span');
    legend.append('0', gradient, legendMax);
    const text = document.createElement('div');
    text.className = 'mt-1';
    box.append(legend, text);
    root.append(box);

    let active = false, stats = null, mouse = null, pixel = null, part = '', dirty = true, statsPending = false, lastStats = 0;
    let lastView = '', lastBvh = null;
    const metricIndex = () => METRICS.indexOf(metricSel.value);
    const autoScale = () => Math.max(stats?.[metricSel.value]?.p99 ?? 64, 4);
    const applyScale = () => {
        scale.value = scaleSel.value === 'auto' ? autoScale() : Number(scaleSel.value);
        legendMax.textContent = String(Math.round(scale.value));
    };
    on.addEventListener('change', () => {
        active = on.checked;
        dirty = true;
        if (active && !pathTracing.ready) startHQ();
    });
    metricSel.addEventListener('change', () => { metric.value = metricIndex(); applyScale(); });
    scaleSel.addEventListener('change', applyScale);
    orderSel.addEventListener('change', () => { kernel.setOrder(orderSel.value); dirty = true; });
    // values under the mouse: the counts there + the part (raster picking), at most ~10× per second
    let pickAt = 0;
    renderer.domElement.addEventListener('pointermove', e => {
        if (!active) return;
        mouse = { clientX: e.clientX, clientY: e.clientY };
        const now = performance.now();
        if (now - pickAt < 100) return;
        pickAt = now;
        const hit = pickHit(mouse);
        part = hit ? (hit.object.name || hit.object.parent?.name || '–') : '';
        readMouse();
    });
    const readMouse = () => {
        if (!mouse || !kernel.kernel) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const w = kernel.counts.image.width, h = kernel.counts.image.height;
        const x = Math.floor((mouse.clientX - rect.left) / rect.width * w), y = Math.floor((mouse.clientY - rect.top) / rect.height * h);
        if (x < 0 || y < 0 || x >= w || y >= h) { pixel = null; return; }
        kernel.readPixel(renderer, x, y).then(v => { pixel = v; }).catch(() => {});
    };

    const tick = () => {
        if (!box.isConnected) return;
        const lines = [];
        legend.hidden = metricRow.hidden = orderRow.hidden = !active;
        if (active) {
            if (!pathTracing.ready || !pathTracing.pathTracer?._bvhData) lines.push(t('debugStats.rayCost.waiting'));
            else if (stats) {
                for (const k of METRICS) lines.push(t(`debugStats.rayCost.row.${k}`, stats[k]));
                if (pixel) lines.push(t('debugStats.rayCost.mouse', { boxes: pixel.boxes, tris: pixel.tris, objects: pixel.objects, part: pixel.hit ? part : t('debugStats.rayCost.background') }));
                lines.push(t('debugStats.rayCost.notCounted'));
            }
        }
        text.textContent = lines.join('\n');
        text.hidden = !lines.length;
        setTimeout(tick, 150);
    };
    tick();

    return {
        get active() { return active; },
        /** after the frame, onto the canvas (under highlight and gizmo) */
        draw(camera) {
            if (!active) return;
            const bvhData = pathTracing.ready ? pathTracing.pathTracer?._bvhData : null;
            if (!bvhData) return;
            const size = renderer.getDrawingBufferSize(new Vector2());
            const view = `${camera.matrixWorld.elements.join()}|${camera.projectionMatrix.elements.join()}|${size.x}x${size.y}`;
            const now = performance.now();
            // count anew when the view or the scene data changed, else every 0.5 s (animation, moved parts)
            if (dirty || view !== lastView || bvhData !== lastBvh || now - lastStats > 500) {
                kernel.run(renderer, bvhData, size.x, size.y, camera);
                if (texNode.value !== kernel.counts) texNode.value = kernel.counts;   // new size: a new texture
                lastView = view; lastBvh = bvhData; dirty = false; lastStats = now;
                if (!statsPending) {
                    statsPending = true;
                    kernel.readStats(renderer).then(s => { stats = s; applyScale(); }).catch(() => {}).finally(() => { statsPending = false; });
                }
                readMouse();
            }
            texScale.value.set(1, 1);
            const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
            renderer.setRenderTarget(null);
            renderer.autoClear = false;
            quad.render(renderer);
            renderer.autoClear = autoClear;
            renderer.setRenderTarget(target);
        },
    };
}
