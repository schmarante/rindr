// OpenPBR in the raster view (docs/material-format.md): three.js' physical lighting with the parts it lacks – wrapped
// around PhysicalLightingModel (its terms are scaled or replaced, not copied):
//  - base_diffuse_roughness: energy-preserving Oren-Nayar (EON, like the path tracer) – per light the ratio EON /
//    Lambert on three's diffuse term; the environment keeps Lambert (EON preserves the energy – the difference is the
//    view-dependent flattening, mostly a direct-light effect)
//  - specular_color on metals: F82 edge tint (OpenPBR / the path tracer's rindr-openpbr) – ratio F82 / Schlick on the
//    metallic share of the specular term (direct: at the half vector, environment: at the view)
//  - coat_ior: the coat's reflectance from its IOR instead of three's fixed 0.04 (direct, environment, and the
//    Fresnel share the coat takes from what lies below)
//  - coat_roughness_anisotropy + geometry_coat_tangent: the coat's direct lobe anisotropic along its own tangent
//    (OpenPBR's mapping, like the path tracer), also per pixel (coatAnisotropyMap – swirl marks); the coat's
//    environment stays isotropic (three bends no coat normal)
//  - fuzz: OpenPBR's lobe (Zeltner et al. 2022, see fuzzLobe) instead of three's Charlie sheen, on top of everything
//    (three puts its sheen under the coat): what lies below × (1 − weight × E(view)), E without the fuzz colour
import * as THREE from 'three/webgpu';
import { float, vec3, mix, exp, normalView, positionViewDirection, clearcoatNormalView, diffuseContribution, diffuseColor,
    metalness, clearcoat, clearcoatRoughness, tangentView, bitangentView, materialSpecularColor, F_Schlick, EnvironmentBRDF,
    D_GGX_Anisotropic, V_GGX_SmithCorrelated_Anisotropic, sheen, sheenRoughness, materialReference, materialClearcoatRoughness } from 'three/tsl';

const COAT_F0_THREE = 0.04;   // three's clearcoatF0
const F82_MU = 1 / 7;

/** OpenPBR F82 / Schlick per channel (f0, tint: colours; mu: cosine) */
function f82Ratio(mu, f0, tint) {
    const schlick = m => f0.add(vec3(1).sub(f0).mul(float(1).sub(m).pow(5)));
    const b = schlick(float(F82_MU)).mul(vec3(1).sub(tint));
    const w = mu.mul(float(1).sub(mu).pow(6)).div(F82_MU * (1 - F82_MU) ** 6);
    const s = schlick(mu);
    return s.sub(b.mul(w)).max(0).div(s.max(1e-4));
}

/** EON / Lambert per channel (rho: albedo, sigma: diffuse roughness) – Portsmouth et al. 2024, as eon.wgsl.js */
function eonRatio(lightDirection, rho, sigma) {
    const nv = normalView.dot(positionViewDirection).clamp(1e-4, 1);
    const nl = normalView.dot(lightDirection).clamp(1e-4, 1);
    const vl = positionViewDirection.dot(lightDirection);
    const A = float(1).div(sigma.mul(0.5 - 2 / (3 * Math.PI)).add(1));
    const s = vl.sub(nv.mul(nl));
    const sOverT = s.greaterThan(0).select(s.div(nv.max(nl)), s);
    const single = A.mul(sigma.mul(sOverT).add(1));
    const albedo = mu => {
        const c = float(1).sub(mu);
        const g = c.mul(c.mul(c.mul(c.mul(0.0714429953).add(-0.332181442)).add(0.491881867)).add(0.0571085289));
        return A.mul(sigma.mul(g).add(1));
    };
    const avg = A.mul(sigma.mul(2 / 3 - 28 / (15 * Math.PI)).add(1));
    // multiple scattering: ρ_ms / ρ = ρ Ē / (1 − ρ (1 − Ē)) – no division by ρ
    const msOverRho = rho.mul(avg).div(vec3(1).sub(rho.mul(float(1).sub(avg))).max(1e-6));
    const ms = msOverRho.mul(float(1).sub(albedo(nv)).max(1e-6)).mul(float(1).sub(albedo(nl)).max(1e-6)).div(float(1).sub(avg).max(1e-6));
    return vec3(single).add(ms);
}

// OpenPBR fuzz: Zeltner, Burley, Chiang 2022, "Practical Multiple-Scattering Sheen Using Linearly Transformed Cosines" –
// a clamped cosine transformed per view angle and roughness, fitted to a volumetric fibre layer. The fits of the
// transform and of the directional albedo after MaterialX (mx_microfacet_sheen.glsl, Apache-2.0, adapted from
// github.com/tizian/ltc-sheen); the path tracer uses the same (astro.config.mjs, fuzz.patch.js).
const max3 = c => c.r.max(c.g).max(c.b);

/** directional albedo E(mu, r) of the fuzz lobe (Gaussian fit) */
function fuzzAlbedo(mu, r) {
    const s = r.mul(r.mul(1.58491).add(0.0206607)).div(r.mul(r.add(1.32227)).add(0.0379424));
    const m = r.mul(r.mul(r.mul(r.mul(r).mul(-0.95943).add(1.7932)).add(-1.14885)).add(-0.193854)).div(r.add(0.046391));
    const o = r.mul(r.mul(r.mul(0.119681).add(-0.0207818)).add(0.000654023)).div(r.mul(r.add(-1.92021)).add(1.26264));
    const d = mu.sub(m).div(s);
    return exp(d.mul(d).mul(-0.5)).div(s.mul(Math.sqrt(2 * Math.PI))).add(o).clamp(0, 1);
}

/** the fuzz lobe D(l) (normalised, includes the cosine): BRDF × cos = colour × E × D */
function fuzzLobe(l, mu, r) {
    const n = normalView, v = positionViewDirection;
    // frame: x in the plane of normal and view; y only by its length (the lobe is symmetric about that plane; at
    // normal view bInv = 0 and the lobe is round – no basis needed there)
    const xRaw = v.sub(n.mul(n.dot(v)));
    const x = xRaw.mul(xRaw.dot(xRaw).max(1e-12).inverseSqrt());
    const wz = n.dot(l), wx = x.dot(l);
    const wy2 = float(1).sub(wz.mul(wz)).sub(wx.mul(wx)).max(0);
    const aInv = mu.mul(2.58126).add(r.mul(0.813703)).mul(r).div(mu.mul(mu).mul(0.310327).add(mu.mul(r).mul(2.60994)).add(1));
    const bInv = float(1).sub(mu).sqrt().mul(r.sub(1)).mul(r.mul(r).mul(r))
        .div(mu.mul(1.71228).sub(mu.mul(r).mul(1.71506)).add(r.mul(r).mul(1.34174)).add(0.0000254053));
    const ox = aInv.mul(wx).add(bInv.mul(wz));
    const len2 = ox.mul(ox).add(aInv.mul(aInv).mul(wy2)).add(wz.mul(wz));
    const k = aInv.div(len2);
    return wz.max(0).mul(1 / Math.PI).mul(k).mul(k);
}

export class OpenPbrLightingModel extends THREE.PhysicalLightingModel {
    /** material: a RindrMaterial (its flags eon / f82 / coatExtra pick the terms, its uniforms carry the values) */
    constructor(material, ...flags) {
        // flags[1]: sheen – three's own sheen off, the fuzz below replaces it
        super(flags[0], false, ...flags.slice(2));
        this.fuzz = !!flags[1];
        this.eon = material.eon;
        this.f82 = material.f82;
        this.coatExtra = material.coatExtra && flags[0];   // flags[0]: clearcoat
        this.sigma = material._diffRough;
        this.coatF0 = vec3(material._coatKs);
        this.coatAniso = material._coatAniso;
        this.coatRot = material._coatRot;
        // per pixel: RG = direction in the tangent frame (turns the material's rotation), B = strength (multiplies it)
        this.coatMap = material.coatAnisotropyMap ? materialReference('coatAnisotropyMap', 'texture') : null;
    }

    start(builder) {
        if (this.fuzz) {
            this.fuzzMu = normalView.dot(positionViewDirection).clamp(1e-4, 1);
            this.fuzzR = sheenRoughness.clamp(0.01, 1);
            this.fuzzDirect = vec3(0).toVar('fuzzDirect');
            this.fuzzIndirect = vec3(0).toVar('fuzzIndirect');
        }
        super.start(builder);   // three's start runs the environment already
    }

    direct(data, builder) {
        const { lightDirection, lightColor, reflectedLight } = data;
        if (this.fuzz) this.fuzzDirect.addAssign(lightColor.mul(fuzzLobe(lightDirection, this.fuzzMu, this.fuzzR)));
        const wrap = this.eon || this.f82;
        const target = wrap ? { ...reflectedLight, directDiffuse: vec3(0).toVar(), directSpecular: vec3(0).toVar() } : reflectedLight;
        const coatDirect = this.clearcoatSpecularDirect;
        if (this.coatExtra) this.clearcoatSpecularDirect = vec3(0).toVar();   // three's coat lobe (0.04, isotropic) – replaced below
        super.direct({ ...data, reflectedLight: target }, builder);
        if (this.coatExtra) {
            this.clearcoatSpecularDirect = coatDirect;
            this.clearcoatSpecularDirect.addAssign(this._coatDirect(lightDirection, lightColor));
        }
        if (!wrap) return;
        reflectedLight.directDiffuse.addAssign(this.eon ? target.directDiffuse.mul(eonRatio(lightDirection, diffuseContribution.rgb, this.sigma)) : target.directDiffuse);
        if (this.f82) {
            const vh = positionViewDirection.dot(lightDirection.add(positionViewDirection).normalize()).clamp();
            reflectedLight.directSpecular.addAssign(target.directSpecular.mul(mix(vec3(1), f82Ratio(vh, diffuseColor.rgb, materialSpecularColor), metalness)));
        } else reflectedLight.directSpecular.addAssign(target.directSpecular);
    }

    // the coat's direct lobe: GGX with the coat IOR, anisotropic along the coat's tangent (OpenPBR: α_t = r² √(2 /
    // (1 + (1 − a)²)), α_b = (1 − a) α_t)
    _coatDirect(lightDirection, lightColor) {
        const n = clearcoatNormalView, v = positionViewDirection, l = lightDirection;
        const h = l.add(v).normalize();
        const nl = n.dot(l).clamp(), nv = n.dot(v).clamp(1e-4, 1), nh = n.dot(h).clamp(), vh = v.dot(h).clamp();
        let a = this.coatAniso.clamp(0, 1);
        let rc = this.coatRot.cos(), rs = this.coatRot.sin();
        if (this.coatMap) {
            const md = this.coatMap.rg.mul(2).sub(1);
            const d = md.div(md.length().max(1e-5));
            a = a.mul(this.coatMap.b);
            [rc, rs] = [rc.mul(d.x).sub(rs.mul(d.y)), rs.mul(d.x).add(rc.mul(d.y))];
        }
        // with a coat anisotropy map the property holds the roughness along the scratches (RindrMaterial.setupVariants
        // – for the environment); the lobe takes the material's own
        const r2 = (this.coatMap ? materialClearcoatRoughness.clamp(0.0525, 1) : clearcoatRoughness).pow2();
        const at = r2.mul(float(2).div(float(1).sub(a).pow2().add(1)).sqrt()).min(1).max(1e-4);
        const ab = float(1).sub(a).mul(at).max(1e-4);
        // tangent frame of the coat: the surface tangent turned by the coat's rotation, kept orthogonal to its normal
        // (tangentView/bitangentView directly – three's TBNViewMatrix is a shared variable declared where it is first used)
        const dir = tangentView.mul(rc).add(bitangentView.mul(rs));
        const tRaw = dir.sub(n.mul(n.dot(dir)));
        const t = tRaw.length().greaterThan(1e-5).select(tRaw, n.cross(vec3(0, 0, 1)).add(vec3(0.001, 0, 0))).normalize();
        const b = n.cross(t);
        const D = D_GGX_Anisotropic({ alphaT: at, alphaB: ab, dotNH: nh, dotTH: t.dot(h), dotBH: b.dot(h) });
        const V = V_GGX_SmithCorrelated_Anisotropic({ alphaT: at, alphaB: ab, dotTV: t.dot(v), dotBV: b.dot(v), dotTL: t.dot(l), dotBL: b.dot(l), dotNV: nv, dotNL: nl });
        const F = F_Schlick({ f0: this.coatF0, f90: float(1), dotVH: vh });
        return lightColor.mul(nl).mul(F.mul(D).mul(V));
    }

    indirectDiffuse(builder) {
        super.indirectDiffuse(builder);
        // the fuzz in the environment: irradiance × colour × E (as three's sheen, with its 1 / π)
        if (this.fuzz) this.fuzzIndirect.addAssign(builder.context.irradiance.mul(1 / Math.PI));
    }

    indirectSpecular(builder) {
        if (this.fuzz) this.fuzzIndirect.addAssign(builder.context.iblIrradiance.mul(1 / Math.PI));
        const coatIndirect = this.clearcoatSpecularIndirect;
        if (this.coatExtra) this.clearcoatSpecularIndirect = vec3(0).toVar();
        let context = builder.context, temp = null;
        if (this.f82) {
            temp = { indirectSpecular: vec3(0).toVar() };
            builder.context = { ...context, reflectedLight: { ...context.reflectedLight, indirectSpecular: temp.indirectSpecular } };
        }
        super.indirectSpecular(builder);
        builder.context = context;
        if (temp) {
            const nv = normalView.dot(positionViewDirection).clamp();
            context.reflectedLight.indirectSpecular.addAssign(temp.indirectSpecular.mul(mix(vec3(1), f82Ratio(nv, diffuseColor.rgb, materialSpecularColor), metalness)));
        }
        if (this.coatExtra) {
            this.clearcoatSpecularIndirect = coatIndirect;
            const nvcc = clearcoatNormalView.dot(positionViewDirection).clamp();
            const env = EnvironmentBRDF({ dotNV: nvcc, specularColor: this.coatF0, specularF90: float(1), roughness: clearcoatRoughness });
            this.clearcoatSpecularIndirect.addAssign(this.clearcoatRadiance.mul(env));
        }
    }

    ambientOcclusion(builder) {
        super.ambientOcclusion(builder);
        if (this.fuzz) this.fuzzIndirect.mulAssign(builder.context.ambientOcclusion);
    }

    finish(builder) {
        if (this.coatExtra) {
            // three takes the coat's Fresnel share with 0.04 from what lies below – correct it to the coat IOR
            const { outgoingLight } = builder.context;
            const nvcc = clearcoatNormalView.dot(positionViewDirection).clamp();
            const fThree = F_Schlick({ f0: vec3(COAT_F0_THREE), f90: float(1), dotVH: nvcc });
            const fOwn = F_Schlick({ f0: this.coatF0, f90: float(1), dotVH: nvcc });
            outgoingLight.mulAssign(vec3(1).sub(clearcoat.mul(fOwn)).div(vec3(1).sub(clearcoat.mul(fThree)).max(1e-4)));
        }
        super.finish(builder);
        if (this.fuzz) {
            // on top of the coat: weight × colour × E; the weight alone from the sheen node over the material's sheen
            // colour (a node graph drives the weight through sheenColorMap)
            const { outgoingLight } = builder.context;
            const e = fuzzAlbedo(this.fuzzMu, this.fuzzR);
            const base = max3(materialReference('sheenColor', 'color'));
            const weight = base.greaterThan(1e-4).select(max3(sheen).div(base.max(1e-4)), max3(sheen)).clamp(0, 1);
            outgoingLight.assign(outgoingLight.mul(float(1).sub(weight.mul(e))).add(this.fuzzDirect.add(this.fuzzIndirect).mul(sheen).mul(e)));
        }
    }
}
