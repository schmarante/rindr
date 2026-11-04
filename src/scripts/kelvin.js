// Colour of light by colour temperature – pure function (MAX lights, pbrt blackbody spectra).

/**
 * Colour of light at T kelvin, white at 6500 K as in MAX (its colours for 1000–20 000 K are the black body's in its
 * working space divided by 6500 K's). Planckian locus after Kim et al. (1667–25 000 K), XYZ → linear sRGB; very warm
 * light lies outside sRGB – negative components are cut.
 */
export function kelvinRgb(T) {
    const rgb = t => {
        const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
            : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
        const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
            : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
                : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
        const X = x / y, Z = (1 - x - y) / y;
        return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z];
    };
    const white = rgb(6500), c = rgb(Math.min(Math.max(T, 1667), 25000));
    return c.map((v, i) => Math.max(v / white[i], 0));
}
