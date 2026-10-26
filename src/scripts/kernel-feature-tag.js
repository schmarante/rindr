// Tag for the kernel's WGSL templates that keeps the code of the features that are on (kernel-features.js).
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { kernelFeatures } from './kernel-features.js';

const MARKER = /\/\*@(?:if:([\w,]+)|(else)|endif)\*\//g;

/**
 * A tag for WGSL templates (in place of wgslTagFn) that keeps the code of the features that are on: marked regions
 * of the template's text are dropped, with the values (${ … }) inside them. Regions nest.
 */
export function featureTag(features = kernelFeatures.current) {
    return (tokens, ...args) => {
        const outTokens = [''], outArgs = [];
        const stack = [];   // per open region: is its current branch kept
        const kept = () => stack.every(Boolean);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            let last = 0;
            MARKER.lastIndex = 0;
            for (let m; (m = MARKER.exec(token));) {
                if (kept()) outTokens[outTokens.length - 1] += token.slice(last, m.index);
                if (m[1]) stack.push(m[1].split(',').some(f => features.has(f)));
                else if (m[2]) stack[stack.length - 1] = !stack[stack.length - 1];
                else stack.pop();
                last = MARKER.lastIndex;
            }
            if (kept()) outTokens[outTokens.length - 1] += token.slice(last);
            if (i < args.length && kept()) {
                outArgs.push(args[i]);
                outTokens.push('');
            }
        }
        if (stack.length) throw new Error(`kernel features: ${stack.length} region(s) not closed`);
        return wgslTagFn(outTokens, ...outArgs);
    };
}
