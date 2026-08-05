/**
 * Colour maths for the adaptive Get Tickets button.
 *
 * Three things live here:
 *   - sRGB <-> OKLab/OKLCh conversion (Bjorn Ottosson's matrices)
 *   - APCA Lc contrast (W3 0.1.9 / 0.98G-4g constants) for text-on-fill
 *   - WCAG 2.x contrast ratio for fill-vs-backdrop object separation
 *
 * The correction routine at the bottom is the point of the whole file: given an
 * accent pulled off a poster, find a button fill that is readable without
 * telling a lie about what colour the poster actually is. Hue is never rotated.
 */

// ---------------------------------------------------------------------------
// sRGB
// ---------------------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** sRGB transfer function, encoded [0,1] -> linear-light [0,1]. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse sRGB transfer function, linear-light -> encoded. */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`bad hex: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

export function rgbToHex({ r, g, b }) {
  const to = (c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// ---------------------------------------------------------------------------
// OKLab / OKLCh
// ---------------------------------------------------------------------------

export function rgbToOklab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function oklabToRgb({ L, a, b }) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Hue is returned in degrees [0,360). */
export function oklabToOklch({ L, a, b }) {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklchToOklab({ L, C, h }) {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

export const rgbToOklch = (rgb) => oklabToOklch(rgbToOklab(rgb));
export const oklchToRgb = (lch) => oklabToRgb(oklchToOklab(lch));
export const hexToOklch = (hex) => rgbToOklch(hexToRgb(hex));

/** True when an OKLCh triplet lands inside sRGB without clipping. */
export function inGamut({ L, C, h }, eps = 1e-4) {
  const { r, g, b } = oklchToRgb({ L, C, h });
  return (
    r >= -eps && r <= 1 + eps &&
    g >= -eps && g <= 1 + eps &&
    b >= -eps && b <= 1 + eps
  );
}

/**
 * Largest in-gamut chroma for a given lightness+hue.
 *
 * Binary search rather than an analytic solve: the sRGB gamut boundary in OKLCh
 * is not a nice closed form, and 24 iterations gets us well past display
 * precision.
 */
export function maxChroma(L, h, iterations = 24) {
  let lo = 0;
  let hi = 0.5; // comfortably beyond the sRGB cusp for every hue
  if (inGamut({ L, C: hi, h })) return hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ L, C: mid, h })) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Snap an OKLCh colour into sRGB by reducing chroma only — L and h survive. */
export function toHexClamped({ L, C, h }) {
  const c = Math.min(C, maxChroma(L, h));
  const { r, g, b } = oklchToRgb({ L, C: c, h });
  return rgbToHex({ r: clamp01(r), g: clamp01(g), b: clamp01(b) });
}

// ---------------------------------------------------------------------------
// APCA (Accessible Perceptual Contrast Algorithm), W3 0.1.9 / 0.98G-4g
// ---------------------------------------------------------------------------

const APCA = {
  mainTRC: 2.4,
  Sr: 0.2126729, Sg: 0.7151522, Sb: 0.072175,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414,
  scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027,
  deltaYmin: 0.0005, loClip: 0.1,
};

/** APCA screen luminance. Note: a simple 2.4 exponent, NOT the sRGB piecewise. */
function apcaY({ r, g, b }) {
  return APCA.Sr * r ** APCA.mainTRC + APCA.Sg * g ** APCA.mainTRC + APCA.Sb * b ** APCA.mainTRC;
}

const softClamp = (Y) => (Y < APCA.blkThrs ? Y + (APCA.blkThrs - Y) ** APCA.blkClmp : Y);

/**
 * APCA lightness contrast between text and background, as signed Lc.
 * Positive => dark text on light bg. Negative => light text on dark bg.
 * Callers generally want the absolute value.
 */
export function apcaContrast(textHex, bgHex) {
  const Ytxt = softClamp(apcaY(hexToRgb(textHex)));
  const Ybg = softClamp(apcaY(hexToRgb(bgHex)));

  if (Math.abs(Ybg - Ytxt) < APCA.deltaYmin) return 0;

  let out;
  if (Ybg > Ytxt) {
    // Normal polarity: dark text on a lighter background.
    const sapc = (Ybg ** APCA.normBG - Ytxt ** APCA.normTXT) * APCA.scaleBoW;
    out = sapc < APCA.loClip ? 0 : sapc - APCA.loBoWoffset;
  } else {
    // Reverse polarity: light text on a darker background.
    const sapc = (Ybg ** APCA.revBG - Ytxt ** APCA.revTXT) * APCA.scaleWoB;
    out = sapc > -APCA.loClip ? 0 : sapc + APCA.loWoBoffset;
  }
  return out * 100;
}

// ---------------------------------------------------------------------------
// WCAG 2.x contrast ratio — used only for non-text (object) separation
// ---------------------------------------------------------------------------

function relativeLuminance({ r, g, b }) {
  return (
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
  );
}

export function wcagContrast(aHex, bHex) {
  const la = relativeLuminance(hexToRgb(aHex));
  const lb = relativeLuminance(hexToRgb(bHex));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// The correction
// ---------------------------------------------------------------------------

/** Contrast floors. Lc 60 is the bare minimum for large text; 75 is comfortable. */
export const LABEL_LC_TARGET = 75;
/**
 * 3:1 is the WCAG floor for non-text objects. This is the primary call to
 * action on the page, so it is held to more than the minimum — a dark accent on
 * a black page technically passes at 3:1 while reading as dim and unclickable.
 * Raising the floor pushes lightness up, which keeps the hue faithful.
 */
export const OBJECT_RATIO_TARGET = 4.5;

/**
 * Chroma floor. Without this the solver cheats: sRGB's maximum chroma tends to
 * zero as lightness approaches 0 or 1, so it can always satisfy contrast by
 * driving the fill to near-black or near-white. Hue survives that trip, but hue
 * on a greyed-out colour is not a visible accent cue — the button stops looking
 * like the poster while the maths still reports success. So a chromatic accent
 * must retain most of its saturation, and failing that we take the ring.
 */
export const CHROMA_RETENTION = 0.6;
/** Below this, an accent is treated as achromatic and exempt from the floor. */
export const ACHROMATIC_C = 0.04;

export const LABEL_DARK = '#0a0a0a';
export const LABEL_LIGHT = '#fafafa';

/** Best label choice for a given fill, by absolute APCA. */
function bestLabelFor(fillHex) {
  const dark = Math.abs(apcaContrast(LABEL_DARK, fillHex));
  const light = Math.abs(apcaContrast(LABEL_LIGHT, fillHex));
  return dark >= light
    ? { label: LABEL_DARK, lc: dark }
    : { label: LABEL_LIGHT, lc: light };
}

/**
 * Solve a readable button fill from a poster accent.
 *
 * Hue is locked. Chroma is the accent's own chroma, reduced only where sRGB
 * cannot hold it. Lightness is the single free variable, and among all
 * lightnesses that clear both contrast floors we take the one nearest the
 * accent's original lightness — satisfy the constraint with the least
 * perceptual drift from the artwork.
 *
 * Rotating hue would trivially solve contrast and would also destroy the only
 * property that makes the button read as belonging to the poster. So we don't.
 * When no lightness works, the caller gets `needsRing: true` and should draw a
 * separating ring in the secondary accent instead.
 */
export function solveButtonFill(accentHex, backdropHex, opts = {}) {
  const labelTarget = opts.labelTarget ?? LABEL_LC_TARGET;
  const objectTarget = opts.objectTarget ?? OBJECT_RATIO_TARGET;
  const step = opts.step ?? 0.002;

  const accent = hexToOklch(accentHex);

  // Achromatic accents have no cue to protect, so they are exempt.
  const chromaFloor =
    accent.C < ACHROMATIC_C ? 0 : accent.C * (opts.chromaRetention ?? CHROMA_RETENTION);

  const candidates = [];
  for (let L = 0; L <= 1 + 1e-9; L += step) {
    const C = Math.min(accent.C, maxChroma(L, accent.h));
    const fill = toHexClamped({ L, C, h: accent.h });
    const { label, lc } = bestLabelFor(fill);
    const objectRatio = wcagContrast(fill, backdropHex);
    candidates.push({ L, C, fill, label, lc, objectRatio, keepsChroma: C >= chromaFloor });
  }

  const feasible = candidates.filter(
    (c) => c.lc >= labelTarget && c.objectRatio >= objectTarget && c.keepsChroma,
  );

  if (feasible.length > 0) {
    // Least drift from the poster's own lightness.
    const best = feasible.reduce((a, b) =>
      Math.abs(b.L - accent.L) < Math.abs(a.L - accent.L) ? b : a,
    );
    return {
      fill: best.fill,
      label: best.label,
      lc: round2(best.lc),
      objectRatio: round2(best.objectRatio),
      hueLocked: accent.h,
      lightnessShift: round3(best.L - accent.L),
      needsRing: false,
    };
  }

  // No lightness satisfies every constraint on this hue. Keep the accent honest
  // and buy the missing separation with a ring instead. Order of surrender:
  // hold chroma and the label floor first (an unreadable or greyed-out button
  // is the worse outcome), and let object contrast be the thing the ring fixes.
  const pools = [
    candidates.filter((c) => c.keepsChroma && c.lc >= labelTarget),
    candidates.filter((c) => c.keepsChroma),
    candidates.filter((c) => c.lc >= labelTarget),
    candidates,
  ];
  const fallbackPool = pools.find((p) => p.length > 0);
  const best = fallbackPool.reduce((a, b) => (b.lc > a.lc ? b : a));

  return {
    fill: best.fill,
    label: best.label,
    lc: round2(best.lc),
    objectRatio: round2(best.objectRatio),
    hueLocked: accent.h,
    lightnessShift: round3(best.L - accent.L),
    needsRing: true,
  };
}

/**
 * Ring / focus colour derived from the secondary accent: same hue, pushed to
 * whatever lightness separates it from the backdrop.
 */
export function solveRingColor(accentHex, backdropHex, opts = {}) {
  const target = opts.objectTarget ?? OBJECT_RATIO_TARGET;
  const step = opts.step ?? 0.002;
  const accent = hexToOklch(accentHex);

  let best = null;
  for (let L = 0; L <= 1 + 1e-9; L += step) {
    const C = Math.min(accent.C, maxChroma(L, accent.h));
    const hex = toHexClamped({ L, C, h: accent.h });
    const ratio = wcagContrast(hex, backdropHex);
    if (ratio >= target) {
      const drift = Math.abs(L - accent.L);
      if (!best || drift < best.drift) best = { hex, ratio, drift };
    }
  }
  if (best) return { hex: best.hex, objectRatio: round2(best.ratio) };

  // Hue cannot separate from this backdrop at any lightness — fall back to a
  // neutral that definitely can.
  const neutral = wcagContrast('#ffffff', backdropHex) >= wcagContrast('#000000', backdropHex)
    ? '#ffffff'
    : '#000000';
  return { hex: neutral, objectRatio: round2(wcagContrast(neutral, backdropHex)) };
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
