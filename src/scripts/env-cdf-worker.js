// Importance-sampling table of an equirect environment (see env-cdf.js) – same computation as
// three-gpu-pathtracer's EquirectHdrInfoUniform.updateFrom with the solid-angle weight of EquirectHdrInfoNode
// (luminance · sin θ), off the main thread. Input: RGBA half float, flipY = false.
import { DataUtils } from 'three';

self.onmessage = ({ data: { data, width, height } }) => {
    const { fromHalfFloat } = DataUtils;
    const cdfConditional = new Float32Array(width * height);
    const cdfMarginal = new Float32Array(height);
    let totalSum = 0;
    let cumulativeWeightMarginal = 0;
    for (let y = 0; y < height; y++) {
        const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
        let cumulativeRowWeight = 0;
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const r = fromHalfFloat(data[4 * i]), g = fromHalfFloat(data[4 * i + 1]), b = fromHalfFloat(data[4 * i + 2]);
            const weight = (0.2126 * r + 0.7152 * g + 0.0722 * b) * sinTheta;
            cumulativeRowWeight += weight;
            totalSum += weight;
            cdfConditional[i] = cumulativeRowWeight;
        }
        if (cumulativeRowWeight !== 0) {
            for (let i = y * width, l = i + width; i < l; i++) cdfConditional[i] /= cumulativeRowWeight;
        }
        cumulativeWeightMarginal += cumulativeRowWeight;
        cdfMarginal[y] = cumulativeWeightMarginal;
    }
    if (cumulativeWeightMarginal !== 0) {
        for (let i = 0; i < height; i++) cdfMarginal[i] /= cumulativeWeightMarginal;
    }

    // three-gpu-pathtracer ≥ 0.0.28 searches these CDFs in the shader (EquirectHdrInfoNode packs them into a buffer)
    self.postMessage({ cdfMarginal, cdfConditional, totalSum }, [cdfMarginal.buffer, cdfConditional.buffer]);
};
