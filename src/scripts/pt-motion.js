// Bounce budgets of the path tracer kernel – uniforms read by the megakernel (Vite plugin rindr-glass-bounces in
// astro.config.mjs).
//   glassBounces: refractions that do not count as bounces (setting "Bounces refraction", PATHTRACING.refractionBounces):
//   glass needs one per surface (in, out, the next pane …) – with few bounces the paths ended inside and glass turned
//   black. While orbiting only 3 bounces are traced; the budget then also takes (bounces when standing still − bounces
//   while orbiting), so glass looks as when standing still while diffuse light stays cheap.
//   mirrors: 1 = smooth mirrors (metal, roughness < 0.1) share the budget – only while orbiting (chrome reflecting
//   chrome turned black); standing still they count as bounces (the setting is about refraction).
import { uniform } from 'three/tsl';

export const PT_MOTION = {
    glassBounces: uniform(0, 'uint'),
    mirrors: uniform(0, 'uint'),
};
