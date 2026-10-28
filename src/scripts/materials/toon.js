// Cel shading for the library materials (material-manager.js): every material is a RindrMaterial – a
// MeshPhysicalNodeMaterial (the path tracer reads its physical parameters as before). With `toon` the lit colour
// is snapped to three flat tones of the base colour (shadow / mid / light) – whatever the lights and the
// environment do, at most three colours (the user's cel look; three.js' toon lighting model alone left smooth
// environment shading). `flat` = one colour, unlit (outline materials: surface + contour) – carried as emission on
// a black base, so the path tracer shows it flat as well. Toon is raster only – toon presets are matte in the path
// tracer; outline and important edges come from contour.js in every view mode.
// Subsurface scattering (`subsurface`, setSubsurface) – fast approximation as the user chose (Barré-Brisebois,
// GDC 2011, "Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look"):
//   raster: light wrapping past the terminator, light from behind shining through (light direction bent by the
//     normal, power, scale – the translucency term of three.js' MeshSSSNodeMaterial) and a little environment light
//     bleeding through, all tinted with the scatter colour. Thickness from a signed distance field of the geometry
//     (sss-field.js, generated on the GPU): light through × colour^(thickness along the light / scatter radius) (the
//     path tracer's absorption), the environment share likewise with the thickness behind the surface – thin parts
//     glow, thick ones turn deep and dark like in the path tracer; until the field is there the constant approximation
//   path tracer: stand-in fields (pt-stand-in.js) – a translucent share as rough (diffuse-like) transmission,
//     the gloss as clearcoat and the scatter colour absorbed over the distance travelled inside: the exact
//     thickness of the method, thin parts glow, thick ones stay dense. A real random walk (Oct. 2026) took 2–5× the
//     render time of plastic and came out too dark – dropped as the default; since Oct. 2026 the accurate mode
//     (`subsurfaceMode`, user's choice: a switch per material) is that walk after OpenPBR (medium.js,
//     medium-walk.patch.wgsl) – the raster keeps the approximation.
// Scattering inside glass (OpenPBR transmission_scatter, setTransmissionScatter): milk glass, juice, jade – the same
// walk in the path tracer; the raster only lets less through and shows the scattered share as a diffuse colour.
import * as THREE from 'three/webgpu';
import { diffuseColor, materialEmissive, luminance, select, float, vec4, uniform, normalView, positionViewDirection,
    positionGeometry, positionWorld, cameraPosition, modelWorldMatrixInverse, materialColor, positionLocal, cameraWorldMatrix,
    modelWorldMatrix, normalize, length, exp, mix, log, vec3, materialClearcoat } from 'three/tsl';
import { fieldThickness, fieldReady } from './sss-field.js';
import { marbleGlow } from './marble.js';
import { WOOL_SHADE } from './wool.js';
import { GRASS_SHADE } from './grass-field.js';
import { SOAP_IOR, soapThicknessNode, soapSceneCell } from './soap.js';
import { edgeNormalView } from './edges.js';
import { transmissionMedium, subsurfaceMedium, colorFromAlbedo } from './medium.js';

// brightness of the lit colour relative to the base colour → tone (thresholds, tones as share of the base colour)
const TOON_STEPS = { shadow: 0.55, mid: 1.1 };
const TOON_TONES = { shadow: 0.45, mid: 0.75, light: 1.0 };

// raster approximation of subsurface scattering (see above); strength × scatter colour from the material uniforms
const SSS_WRAP = 0.6;            // light reaches this far past the terminator (N·L down to −0.6)
const SSS_DISTORTION = 0.3;      // translucency: light direction bent towards the normal
const SSS_POWER = 3;             // … focus of the light seen through the object
const SSS_SCALE = 1.5;
const SSS_AMBIENT = 0.25;        // share of the environment light bleeding through
const SSS_FIELD_GAIN = 2;        // with a distance field: thin parts transmit more than the old constant
const SSS_BACK = 0.8;            // … and diffuse transmission of light falling on the back

// thickness (world units) through the object from this fragment along a view-space direction – distance field in the
// geometry's space (sss-field.js), converted back with the object's scale along the path
function thicknessAlong(viewDir, maxWorld) {
    const world = cameraWorldMatrix.mul(vec4(viewDir, 0)).xyz;
    const local = modelWorldMatrixInverse.mul(vec4(world, 0)).xyz;
    const dir = normalize(local);
    const worldPerLocal = length(modelWorldMatrix.mul(vec4(dir, 0)).xyz);
    return fieldThickness(positionLocal, dir, maxWorld.div(worldPerLocal)).mul(worldPerLocal);
}

class SubsurfaceLightingModel extends THREE.PhysicalLightingModel {
    constructor(material, ...flags) {
        super(...flags);
        this.sssColor = material._sssColor.mul(material._sssWeight);
        this.sssLog = log(material._sssColor.max(1e-3));
        this.radius = material._sssRadius;
    }

    // light that gets through `thickness`, per channel like the path tracer's absorption (Beer: the scatter colour after
    // one radius → colour^(thickness / radius) – thin parts bright and lightly tinted, thick ones deep and dark); 1
    // without a field (the constant approximation)
    _through(thickness) {
        const beer = exp(this.sssLog.mul(thickness.div(this.radius.max(1e-6)))).mul(SSS_FIELD_GAIN);
        return mix(vec3(1), beer, fieldReady);
    }

    direct({ lightDirection, lightColor, reflectedLight }, builder) {
        const nl = normalView.dot(lightDirection);
        const wrap = nl.add(SSS_WRAP).div(1 + SSS_WRAP).saturate().sub(nl.saturate());
        const half = lightDirection.add(normalView.mul(SSS_DISTORTION)).normalize();
        // light from behind: the path towards the light leads through the object
        const thickness = thicknessAlong(lightDirection, this.radius.mul(8));
        const transmitted = this._through(thickness);
        const through = positionViewDirection.dot(half.negate()).saturate().pow(SSS_POWER).mul(SSS_SCALE).mul(transmitted);
        // with a field also diffuse transmission: light falling on the back spreads through a thin part (the path
        // tracer's rough transmission lit whole plates, the focused term above only the view towards the light)
        const diffuseThrough = nl.negate().saturate().mul(SSS_BACK).mul(transmitted).mul(fieldReady);
        reflectedLight.directDiffuse.addAssign(this.sssColor.mul(lightColor).mul(wrap.add(through).add(diffuseThrough)).mul(1 / Math.PI));
        super.direct({ lightDirection, lightColor, reflectedLight }, builder);
    }

    indirectDiffuse(builder) {
        super.indirectDiffuse(builder);
        const { irradiance, reflectedLight } = builder.context;
        // environment light bleeding through: the thinner the object behind the surface, the more
        const behind = thicknessAlong(normalView.negate(), this.radius.mul(8));
        reflectedLight.indirectDiffuse.addAssign(irradiance.mul(this.sssColor).mul(SSS_AMBIENT / Math.PI).mul(this._through(behind)));
    }
}

// path tracer stand-in: share of the subsurface weight that passes into the object, roughness of that
// transmission (diffuse-like)
const PT_TRANSLUCENT = 0.6;
const PT_ROUGHNESS = 0.85;

export class RindrMaterial extends THREE.MeshPhysicalNodeMaterial {
    constructor(params) {
        super(params);
        this.toon = false;   // part of the material cache key (RenderObject.getMaterialCacheKey)
        this.flat = false;   // plain colour, no lighting (outline materials: surface + contour); colour = emissive
        this.subsurface = false;   // cache key; strength/colour as uniforms (`_` = not in the key – no rebuild on edits)
        this._sssColor = uniform(new THREE.Color(1, 1, 1));
        this._sssWeight = uniform(0);
        this._sssRadius = uniform(2);   // scatter radius (scene units) – the raster's thickness falloff
        this.marble = false;   // cache key (emissiveNode); colour/scale/intensity as uniforms
        this.wool = false;     // cache key (root colour, sheenNode)
        this.grass = false;    // cache key (soil shade)
        this.soap = false;     // cache key (film thickness node); film/swirl/scale as uniforms
        this._soap = { film: uniform(380), swirl: uniform(0.7), scale: uniform(1) };
        this._marbleColor = uniform(new THREE.Color(0.2, 1, 0.45));
        this._marbleScale = uniform(10);
        this._marbleIntensity = uniform(1);
        this.edges = false;    // cache key (normal node); radius as a uniform
        this._edgeRadius = uniform(0);
        // OpenPBR extras the path tracer reads (rindr-openpbr in astro.config.mjs): diffuse roughness (EON), coat IOR
        // and colour; the raster tints what lies below the coat with its colour (setupDiffuseColor)
        this.diffuseRoughness = 0;
        this.coatIor = 1.5;
        this.coatColor = new THREE.Color(1, 1, 1);
        this._coatColor = uniform(new THREE.Color(1, 1, 1));
    }

    /**
     * Rounded edges (edges.js): radius in scene units (mm for CAD; 0 = off), concave (> 0) = inner edges too. Shading
     * only – the normal turns towards the neighbouring face within the radius. Raster: setupNormal; path tracer:
     * the signed radius in the stand-in's anisotropyRotation (anisotropy stays 0, so the library ignores it).
     */
    setEdges(radius, concave) {
        const on = radius > 0;
        this._edgeRadius.value = on ? (concave > 0 ? radius : -radius) : 0;
        if (on) this.userData.edges = { radius, concave: concave > 0 };
        else delete this.userData.edges;
        if (on !== this.edges) {
            this.edges = on;
            this.needsUpdate = true;
        }
        const pt = this.userData.ptStandIn ?? {};
        delete pt.anisotropyRotation;
        if (on) Object.assign(pt, { anisotropy: 0, anisotropyRotation: this._edgeRadius.value });
        else delete pt.anisotropy;
        if (Object.keys(pt).length) this.userData.ptStandIn = pt; else delete this.userData.ptStandIn;
    }

    setupNormal(builder) {
        const normal = super.setupNormal(builder);
        return this.edges ? edgeNormalView(normal, this._edgeRadius) : normal;
    }

    /**
     * Wool (wool.js): on (> 0) → fibres over the surface (raster: shells, path tracer: wool-pt.js); length = share of
     * the scene size. The surface itself gets the colour of the fibre roots and their sheen (between the fibres the
     * material's own sheen colour showed as light speckles).
     */
    setWool(on, length) {
        if (on > 0) this.userData.wool = { length };
        else delete this.userData.wool;
        if ((on > 0) !== this.wool) {
            this.wool = on > 0;
            this.sheenNode = this.wool ? materialColor.mul(WOOL_SHADE.root * WOOL_SHADE.sheen) : null;
            this.needsUpdate = true;
        }
        // path tracer stand-in of the fibres (set by WoolSystem, wool.js) – gone with the wool
        const pt = this.userData.ptStandIn;
        if (!(on > 0) && pt?.ptVolume === 4) {
            for (const key of ['ptVolume', 'iridescence', 'iridescenceThicknessRange']) delete pt[key];
            if (!Object.keys(pt).length) delete this.userData.ptStandIn;
        }
    }

    /**
     * Grass (grass.js): on (> 0) → blades over the surface (real geometry, raster and path tracer); height = share of
     * the scene size, density = blades per area (1 = lawn), dry = share of straw-coloured blades. The surface itself
     * gets a dark shade of the colour (soil between the blades; path tracer: stand-in colour, grass.js).
     */
    setGrass(on, height, density, dry) {
        if (on > 0) this.userData.grass = { height, density, dry };
        else delete this.userData.grass;
        if ((on > 0) !== this.grass) {
            this.grass = on > 0;
            this.needsUpdate = true;
        }
    }

    /**
     * Soap film (soap.js): on (> 0) → a thin film matched to air (the material's ior should be 1: nothing refracts),
     * coloured by thin-film interference – iridescence 1, film ior 1.33; film = mean thickness (nm), swirl 0…1 =
     * how much it varies, scale = swirl size (× share of the scene size). Double sided (front and back skin).
     * Path tracer: ptVolume 5, thickness noise in rindr-soap (soap-pt.js) – mean film and swirl cell (world units,
     * read when the materials are packed: follows the scene size) in iridescenceThicknessRange, swirl in
     * sheenRoughness (sheen off).
     */
    setSoap(on, film, swirl, scale) {
        const u = this._soap;
        u.film.value = film;
        u.swirl.value = swirl;
        u.scale.value = scale;
        if ((on > 0) !== this.soap) {
            this.soap = on > 0;
            this.iridescenceThicknessNode = this.soap ? soapThicknessNode(u) : null;
            this.side = this.soap ? THREE.DoubleSide : THREE.FrontSide;
            this.needsUpdate = true;
        }
        const pt = this.userData.ptStandIn ?? {};
        if (pt.ptVolume === 5) for (const key of ['ptVolume', 'iridescenceThicknessRange', 'sheen', 'sheenRoughness']) delete pt[key];
        if (this.soap) {
            this.iridescence = 1;
            this.iridescenceIOR = SOAP_IOR;
            this.iridescenceThicknessRange = [film, film];
            Object.assign(pt, { ptVolume: 5, sheen: 0, sheenRoughness: swirl });
            Object.defineProperty(pt, 'iridescenceThicknessRange', {
                get: () => [film, soapSceneCell() * scale], enumerable: true, configurable: true,
            });
        }
        // off: the thin film's own IOR and thickness come from the material's params (material-manager.js)
        if (Object.keys(pt).length) this.userData.ptStandIn = pt; else delete this.userData.ptStandIn;
    }

    /** Coat colour (sRGB hex – OpenPBR coat_color: what the coat lets through) and coat IOR */
    setCoat(color, ior) {
        this.coatColor.set(color);
        this._coatColor.value.copy(this.coatColor);
        this.coatIor = ior;
    }

    setupDiffuseColor(builder) {
        super.setupDiffuseColor(builder);
        // the coat's colour over the base (diffuse and, through the diffuse colour, the metal's reflection) – a
        // uniform, weighted with the coat (its map included)
        diffuseColor.rgb.mulAssign(mix(vec3(1), this._coatColor, materialClearcoat));
        // SSS with a distance field: the translucent share goes through the body instead of reflecting off the surface
        // – like the path tracer's stand-in (PT_TRANSLUCENT of the weight as transmission)
        if (this.subsurface) diffuseColor.rgb.mulAssign(mix(float(1), float(1).sub(this._sssWeight.mul(PT_TRANSLUCENT)), fieldReady));
        if (this.wool) diffuseColor.rgb.mulAssign(WOOL_SHADE.root);
        if (this.grass) diffuseColor.rgb.mulAssign(GRASS_SHADE.ground);
    }

    /**
     * Cloud (clouds.js): density (0 = off), colour of the scattered light (sRGB hex), puff (share of the size the
     * cloud swells over the shape). The meshes themselves are not drawn – a volume per cloud material stands in for
     * them (raster: invisible material; path tracer: left out of the scene, rindr-cloud in astro.config.mjs).
     */
    setCloud(density, color, puff) {
        const on = density > 0;
        this.visible = !on;
        if (on) this.userData.cloud = { density, color, puff };
        else delete this.userData.cloud;
    }

    /**
     * Glowing marble veins inside the object (marble.js): intensity (0 = off), colour (sRGB hex), scale = scene
     * units per pattern unit (mm for CAD models). Raster: added to the emission; path tracer: stand-in fields.
     * Not batched (render-batcher.js): the pattern lives in object space.
     */
    setMarble(intensity, color, scale) {
        const on = intensity > 0;
        this._marbleColor.value.set(color);
        this._marbleScale.value = Math.max(scale, 1e-3);
        this._marbleIntensity.value = intensity;
        if (on !== this.marble) {
            this.marble = on;
            this.userData.noBatch = (on || this.subsurface) || undefined;
            if (on) {
                const dirWorld = positionWorld.sub(cameraPosition).normalize();
                const dirLocal = modelWorldMatrixInverse.mul(vec4(dirWorld, 0)).xyz.normalize();
                const cos = normalView.dot(positionViewDirection).saturate();
                const fresnel = cos.oneMinus().pow(5).mul(0.96).add(0.04);   // glow seen through the surface
                this.emissiveNode = materialEmissive.add(marbleGlow(positionGeometry, dirLocal, this._marbleColor,
                    this._marbleScale, this._marbleIntensity).mul(fresnel.oneMinus()));
            } else {
                this.emissiveNode = null;
            }
            this.needsUpdate = true;
        }
        const pt = this.userData.ptStandIn ?? {};
        for (const key of ['sheen', 'sheenColor', 'sheenRoughness', 'iridescence', 'iridescenceThicknessRange', 'ptVolume']) delete pt[key];
        if (on) {
            const c = this._marbleColor.value;
            // carried in fields the path tracer does not use for this material (sheen/iridescence off)
            Object.assign(pt, { sheen: 0, sheenColor: { r: c.r, g: c.g, b: c.b }, sheenRoughness: this._marbleScale.value,
                iridescence: 0, iridescenceThicknessRange: [intensity, 0], ptVolume: 2 });
        }
        if (Object.keys(pt).length) this.userData.ptStandIn = pt; else delete this.userData.ptStandIn;
    }

    /**
     * Subsurface scattering: weight 0..1 (strength), colour (sRGB hex, the colour of the scattered light),
     * radius = scene units (mm for CAD models) after which light inside keeps that colour (thin parts glow, thick
     * ones stay dense). Mixes `color` towards the scatter colour and sets the path tracer stand-in – call after
     * colour, roughness and clearcoat are set.
     */
    setSubsurface(weight, color, radius, accurate = 0, anisotropy = 0) {
        this.subsurface = weight > 0;
        this._sssWeight.value = weight;
        this._sssColor.value.set(color);
        this._sssRadius.value = Math.max(radius, 1e-3);
        // the thickness comes from the geometry's distance field in its own space – drawn one by one (sss-field.js)
        this.userData.noBatch = (this.subsurface || this.marble) || undefined;
        if (!this.subsurface) return this._standIn('_sssKeys', null);
        const sss = this._sssColor.value;
        const base = { r: this.color.r, g: this.color.g, b: this.color.b };
        this.color.lerp(sss, weight);   // the visible colour of the scattering (raster and path tracer)
        if (accurate > 0) {
            // OpenPBR: a dielectric boundary (the material's own gloss) over the medium; the weight is the share that
            // enters it, the rest is the diffuse base in its own colour – the glass lobe does not tint (the medium does)
            return this._standIn('_sssKeys', {
                transmission: Math.max(this.transmission, weight),
                thickness: Math.max(this.thickness, 1),   // volume, not a thin wall
                color: base,
                mediumTint: 1,
                mediumAnisotropy: anisotropy,
                ...subsurfaceMedium(sss, radius, anisotropy),
            });
        }
        const gloss = this.roughness < PT_ROUGHNESS;
        this._standIn('_sssKeys', {
            transmission: Math.max(this.transmission, weight * PT_TRANSLUCENT),
            roughness: Math.max(this.roughness, PT_ROUGHNESS),
            // the material's own gloss as a clear layer over the rough translucent body
            clearcoat: gloss ? Math.max(this.clearcoat, 1) : this.clearcoat,
            clearcoatRoughness: gloss ? this.roughness : this.clearcoatRoughness,
            thickness: Math.max(this.thickness, 1),   // volume, not a thin wall
            attenuationColor: { r: sss.r, g: sss.g, b: sss.b },
            attenuationDistance: Math.max(radius, 1e-3),
        });
    }

    /**
     * OpenPBR transmission_scatter: scattering inside the glass (milk glass, juice, jade) – scatter colour (sRGB hex;
     * over the glass's absorption distance like the transmission colour), anisotropy −1..1. Call after the glass
     * params and setSubsurface (subsurface takes the medium when both are on). Path tracer: the medium walk
     * (medium.js); raster: less light through, the scattered share as the diffuse colour.
     */
    setTransmissionScatter(color, anisotropy = 0) {
        const scatter = new THREE.Color(color);
        // thin wall: no thickness and no absorption distance (the library's rule)
        const medium = this.subsurface || !Number.isFinite(this.attenuationDistance) || !(this.transmission > 0) ? null
            : transmissionMedium(this.attenuationColor, this.attenuationDistance, scatter);
        if (!medium) return this._standIn('_scatterKeys', null);
        this._standIn('_scatterKeys', {
            transmission: this.transmission,
            color: { r: this.color.r, g: this.color.g, b: this.color.b },
            mediumTint: 0,
            mediumAnisotropy: anisotropy,
            ...medium,
        });
        // raster: the scattered share over twice the depth (objects are usually thicker than the depth the colour is
        // given at) is not let through; the colour × the medium's observed colour (absorption included – jade green,
        // milk white; mixed in by the share, a white glass stayed pale grey)
        const s = medium.mediumScatter, a = medium.attenuationColor, depth = medium.attenuationDistance;
        const albedo = c => s[c] / Math.max(s[c] - Math.log(Math.max(a[c], 1e-6)) / depth, 1e-9);
        const cloudy = 1 - Math.exp(-2 * depth * (s.r + s.g + s.b) / 3);
        this.transmission *= 1 - cloudy;
        this.color.multiply(scatter.setRGB(colorFromAlbedo(albedo('r'), anisotropy), colorFromAlbedo(albedo('g'), anisotropy),
            colorFromAlbedo(albedo('b'), anisotropy), THREE.LinearSRGBColorSpace));
    }

    // path tracer stand-in fields of one feature (key: where its field names are kept) – the previous ones removed
    _standIn(key, values) {
        const pt = this.userData.ptStandIn ?? {};
        for (const name of this[key] ?? []) delete pt[name];
        this[key] = values ? Object.keys(values) : [];
        if (values) Object.assign(pt, values);
        if (Object.keys(pt).length) this.userData.ptStandIn = pt; else delete this.userData.ptStandIn;
    }

    setupLightingModel(builder) {
        if (!this.subsurface) return super.setupLightingModel(builder);
        return new SubsurfaceLightingModel(this, this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy,
            this.useTransmission, this.useDispersion, this.useRetroreflection);
    }

    setupOutput(builder, outputNode) {
        if (this.flat) {
            outputNode = vec4(materialEmissive.rgb, outputNode.a);   // material-manager.js: colour → emission
        } else if (this.toon) {
            const base = diffuseColor.rgb;
            const ratio = luminance(outputNode.rgb).div(luminance(base).max(1e-4));
            const tone = select(ratio.lessThan(TOON_STEPS.shadow), float(TOON_TONES.shadow),
                select(ratio.lessThan(TOON_STEPS.mid), float(TOON_TONES.mid), float(TOON_TONES.light)));
            outputNode = vec4(base.mul(tone), outputNode.a);
        }
        return super.setupOutput(builder, outputNode);
    }

    copy(source) {
        super.copy(source);
        this.toon = source.toon;
        this.flat = source.flat;
        this.subsurface = source.subsurface;
        this._sssWeight.value = source._sssWeight.value;
        this._sssColor.value.copy(source._sssColor.value);
        this._sssRadius.value = source._sssRadius.value;
        this._sssKeys = [...(source._sssKeys ?? [])];   // stand-in fields of subsurface / medium (userData is copied)
        this._scatterKeys = [...(source._scatterKeys ?? [])];
        this.diffuseRoughness = source.diffuseRoughness;
        this.setCoat(source.coatColor, source.coatIor);
        if (source.userData.noBatch) this.userData.noBatch = true;
        this.marble = false;
        this.setMarble(source._marbleIntensity.value * (source.marble ? 1 : 0), '#' + source._marbleColor.value.getHexString(), source._marbleScale.value);
        const cloud = source.userData.cloud;
        this.setCloud(cloud?.density ?? 0, cloud?.color ?? '#ffffff', cloud?.puff ?? 0.1);
        this.setWool(source.userData.wool ? 1 : 0, source.userData.wool?.length ?? 0.012);
        const grass = source.userData.grass;
        this.setGrass(grass ? 1 : 0, grass?.height ?? 0.03, grass?.density ?? 1, grass?.dry ?? 0);
        this.soap = false;
        const s = source._soap;
        this.setSoap(source.soap ? 1 : 0, s.film.value, s.swirl.value, s.scale.value);
        this.setEdges(source.userData.edges?.radius ?? 0, source.userData.edges?.concave ? 1 : 0);
        return this;
    }
}
