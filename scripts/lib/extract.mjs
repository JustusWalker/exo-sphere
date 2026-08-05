/**
 * Pull the two accent colours out of an event poster.
 *
 * Exosphere posters are overwhelmingly near-black texture with a small amount of
 * saturated linework carrying the whole identity. A naive "most common colour"
 * pass therefore returns dark grey every single time. The two things that make
 * this work are the neutral/extreme rejection pass, and ranking clusters by
 * population *times* chroma so a small blaze of cyan outranks a large field of
 * charcoal.
 */

import sharp from 'sharp';
import { rgbToOklch, toHexClamped, ACHROMATIC_C } from './color.mjs';

/** Pixels below this chroma are texture, not identity. */
export const MIN_CHROMA = ACHROMATIC_C;
/** Reject near-black and near-blown pixels; they carry no reliable hue. */
export const MIN_L = 0.15;
export const MAX_L = 0.95;
/** Hue bucket width in degrees. */
export const HUE_BUCKET = 12;
/** Two accents whose hues are closer than this are the same accent. */
export const MIN_HUE_SEPARATION = 25;
/** Fraction of each hue cluster, taken from the saturated end, that defines it. */
export const VIVID_QUANTILE = 0.15;
/** A cluster covering at least this share is a candidate background field. */
export const FIELD_SHARE = 0.35;
/** Hues within this many degrees of the field are also field, not accent. */
export const FIELD_HUE_RADIUS = 30;

const DEFAULT_FALLBACK = ['#00e5ff', '#00ff62'];

/**
 * @param {Buffer} imageBuffer  encoded image bytes
 * @returns {Promise<{accents: string[], clusters: object[], fellBack: boolean}>}
 */
export async function extractAccents(imageBuffer, opts = {}) {
  // Wide enough that thin neon linework survives resampling rather than being
  // averaged into the black it sits on.
  const width = opts.width ?? 300;
  const fallback = opts.fallback ?? DEFAULT_FALLBACK;

  const { data, info } = await sharp(imageBuffer)
    .resize({ width, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map();
  let considered = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const rgb = { r: data[i] / 255, g: data[i + 1] / 255, b: data[i + 2] / 255 };
    const { L, C, h } = rgbToOklch(rgb);

    // The pass that makes or breaks this: drop neutrals and the extremes.
    if (C < MIN_CHROMA) continue;
    if (L < MIN_L || L > MAX_L) continue;
    considered++;

    const key = Math.floor(h / HUE_BUCKET);
    const acc = buckets.get(key) ?? { px: [], x: 0, y: 0 };
    acc.px.push({ L, C });
    // Average hue as a unit vector so the 360/0 wrap does not average to garbage.
    acc.x += Math.cos((h * Math.PI) / 180);
    acc.y += Math.sin((h * Math.PI) / 180);
    buckets.set(key, acc);
  }

  if (considered === 0) {
    return { accents: [...fallback], clusters: [], fellBack: true };
  }

  const clusters = [...buckets.values()]
    .map((acc) => {
      // Represent the cluster by its *most saturated* members, not its centroid.
      // Neon linework on a dark poster antialiases into a long tail of dim,
      // half-blended pixels; averaging over those returns mud with the right
      // hue. The top of the chroma distribution is what the eye actually reads
      // as the accent.
      const sorted = acc.px.slice().sort((p, q) => q.C - p.C);
      const keep = Math.max(1, Math.round(sorted.length * VIVID_QUANTILE));
      const top = sorted.slice(0, keep);
      const L = top.reduce((s, p) => s + p.L, 0) / top.length;
      const C = top.reduce((s, p) => s + p.C, 0) / top.length;

      let h = (Math.atan2(acc.y, acc.x) * 180) / Math.PI;
      if (h < 0) h += 360;

      return {
        hex: toHexClamped({ L, C, h }),
        L, C, h,
        population: acc.px.length,
        share: acc.px.length / considered,
        // Chroma weighting is what finds accents rather than merely common pixels.
        score: acc.px.length * C,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Drop the background before choosing accents.
  //
  // Scoring on population x chroma finds the biggest coloured region, which on
  // a poster with a *coloured* field is the field itself — a large area of
  // slightly-saturated colour outscores a small burst of vivid colour. EXO11
  // hid this because its background is near-black and the lightness filter
  // removes it; a dark green field walks straight through.
  //
  // A field is big and comparatively dull. A brand colour that happens to cover
  // a lot of the poster is big and vivid, and must survive. Comparing the
  // dominant cluster's chroma against the image's population-weighted mean
  // separates the two without hard-coding any particular hue.
  const meanChroma = clusters.reduce((s, c) => s + c.C * c.population, 0) / considered;
  const dominant = clusters.reduce((a, b) => (b.population > a.population ? b : a));

  // Remove the whole field, not just its single strongest bucket: a large flat
  // region spans several 12-degree buckets, so dropping one leaves the next one
  // (still the background) to be chosen instead. Removal is by hue radius so
  // genuinely distinct accents that merely sit near each other — EXO11's green
  // at 148 and cyan at 186 — are not swept up with it.
  let pool = clusters;
  let droppedField = null;
  if (dominant.share >= FIELD_SHARE && dominant.C < meanChroma) {
    const remaining = clusters.filter((c) => hueDistance(c.h, dominant.h) > FIELD_HUE_RADIUS);
    if (remaining.length > 0) {
      pool = remaining;
      droppedField = dominant.hex;
    }
  }

  const chosen = [pool[0]];
  const second = pool.find((c) => hueDistance(c.h, pool[0].h) >= MIN_HUE_SEPARATION);
  if (second) chosen.push(second);

  const accents = chosen.map((c) => c.hex);
  // A monochrome poster yields only one accent; reuse it rather than inventing
  // a second hue that is not in the artwork.
  let fellBack = false;
  if (accents.length === 1) accents.push(accents[0]);

  return { accents, clusters, fellBack, droppedField };
}

/** Shortest angular distance between two hues, in degrees. */
export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
