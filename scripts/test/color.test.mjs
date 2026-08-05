import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hexToRgb, rgbToHex, hexToOklch, oklchToRgb, toHexClamped, maxChroma, inGamut,
  apcaContrast, wcagContrast, solveButtonFill, solveRingColor,
  LABEL_LC_TARGET, OBJECT_RATIO_TARGET, CHROMA_RETENTION,
} from '../lib/color.mjs';

// --- conversions -----------------------------------------------------------

test('hex <-> rgb round-trips', () => {
  for (const hex of ['#000000', '#ffffff', '#00ffff', '#00ff62', '#7f3fbf']) {
    assert.equal(rgbToHex(hexToRgb(hex)), hex);
  }
});

test('sRGB -> OKLCh -> sRGB round-trips within a quantisation step', () => {
  for (const hex of ['#00ffff', '#00ff62', '#ff69b4', '#8a2be2', '#123456']) {
    const lch = hexToOklch(hex);
    const back = rgbToHex(oklchToRgb(lch));
    const a = hexToRgb(hex);
    const b = hexToRgb(back);
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(Math.abs(a[ch] - b[ch]) < 1 / 255, `${hex} channel ${ch}`);
    }
  }
});

test('OKLCh lightness matches intuition: white is 1, black is 0', () => {
  assert.ok(Math.abs(hexToOklch('#ffffff').L - 1) < 0.01);
  assert.ok(Math.abs(hexToOklch('#000000').L - 0) < 0.01);
});

test('achromatic colours have ~zero chroma', () => {
  for (const hex of ['#000000', '#808080', '#ffffff']) {
    assert.ok(hexToOklch(hex).C < 0.005, hex);
  }
});

// --- gamut -----------------------------------------------------------------

test('maxChroma stays inside sRGB and is tight', () => {
  for (const h of [0, 45, 145, 195, 260, 330]) {
    for (const L of [0.2, 0.5, 0.8]) {
      const C = maxChroma(L, h);
      assert.ok(inGamut({ L, C, h }, 1e-3), `in gamut at h=${h} L=${L}`);
      assert.ok(!inGamut({ L, C: C + 0.01, h }, 0), `tight at h=${h} L=${L}`);
    }
  }
});

test('toHexClamped preserves hue while reducing chroma to fit', () => {
  const h = 145;
  const hex = toHexClamped({ L: 0.5, C: 0.4, h }); // 0.4 is way out of gamut
  const got = hexToOklch(hex);
  assert.ok(Math.abs(got.h - h) < 1.5, `hue drift ${got.h} vs ${h}`);
});

// --- APCA ------------------------------------------------------------------

test('APCA anchors: black-on-white and white-on-black', () => {
  // Reference values from the APCA 0.98G-4g published vectors.
  assert.ok(Math.abs(apcaContrast('#000000', '#ffffff') - 106.04) < 1.5);
  assert.ok(Math.abs(apcaContrast('#ffffff', '#000000') - -107.88) < 1.5);
});

test('APCA sign encodes polarity', () => {
  assert.ok(apcaContrast('#000000', '#ffffff') > 0, 'dark on light is positive');
  assert.ok(apcaContrast('#ffffff', '#000000') < 0, 'light on dark is negative');
});

test('APCA returns 0 for identical colours', () => {
  assert.equal(apcaContrast('#00ff62', '#00ff62'), 0);
});

test('dark label beats light label on a bright accent', () => {
  const cyan = '#00ffff';
  assert.ok(
    Math.abs(apcaContrast('#0a0a0a', cyan)) > Math.abs(apcaContrast('#fafafa', cyan)),
  );
});

// --- WCAG ------------------------------------------------------------------

test('WCAG anchors', () => {
  assert.ok(Math.abs(wcagContrast('#000000', '#ffffff') - 21) < 0.01);
  assert.equal(wcagContrast('#123456', '#123456'), 1);
});

// --- the correction --------------------------------------------------------

test('poster accents on black clear both floors without moving hue', () => {
  for (const accent of ['#00ffff', '#00ff62', '#39ff14', '#12d8fa']) {
    const r = solveButtonFill(accent, '#000000');
    assert.ok(r.lc >= LABEL_LC_TARGET, `${accent} label Lc ${r.lc}`);
    assert.ok(r.objectRatio >= OBJECT_RATIO_TARGET, `${accent} object ${r.objectRatio}`);
    assert.equal(r.needsRing, false);

    const wanted = hexToOklch(accent).h;
    const got = hexToOklch(r.fill).h;
    assert.ok(Math.abs(got - wanted) < 2, `${accent} hue ${got} vs ${wanted}`);
  }
});

test('hue is never rotated, even for a hostile mid-luminance accent', () => {
  // Mid olive against a mid-grey backdrop is the case most likely to tempt a
  // hue shift. It must not happen.
  const accent = '#7a7a2e';
  const r = solveButtonFill(accent, '#808080');
  const wanted = hexToOklch(accent).h;
  const got = hexToOklch(r.fill).h;
  assert.ok(Math.abs(got - wanted) < 2, `hue ${got} vs ${wanted}`);
});

test('an achromatic accent has no cue to protect, so it need not ring', () => {
  // Grey has no hue worth preserving, so the solver is free to run lightness to
  // an extreme and simply succeed.
  const r = solveButtonFill('#808080', '#808080');
  assert.equal(r.needsRing, false);
  assert.ok(r.lc >= LABEL_LC_TARGET);
});

test('a chromatic accent never gets greyed out to win contrast', () => {
  // This is the guarantee the chroma floor exists for: locking hue is
  // meaningless if saturation is allowed to drain to zero instead.
  const backdrops = ['#000000', '#ffffff', '#808080', '#00ff62', '#004466'];
  const accents = ['#00ffff', '#00ff62', '#ff0000', '#7a7a2e', '#8a2be2'];
  for (const bg of backdrops) {
    for (const a of accents) {
      const r = solveButtonFill(a, bg);
      const want = hexToOklch(a).C;
      const got = hexToOklch(r.fill).C;
      assert.ok(
        got >= want * CHROMA_RETENTION - 0.005,
        `accent ${a} on ${bg}: chroma ${got.toFixed(3)} fell below floor of ${(want * CHROMA_RETENTION).toFixed(3)}`,
      );
    }
  }
});

test('when constraints cannot all be met, needsRing is raised', () => {
  // With the shipped floors this is rare, so drive the fallback deterministically
  // with an object target no chroma-preserving fill can reach.
  const r = solveButtonFill('#00ff62', '#0a3d20', { objectTarget: 19 });
  assert.equal(r.needsRing, true, 'must ask for a ring');

  // Surrendering object contrast must not mean surrendering the accent: hue,
  // chroma and label readability all survive the fallback.
  assert.ok(Math.abs(hexToOklch(r.fill).h - hexToOklch('#00ff62').h) < 2, 'hue held');
  assert.ok(
    hexToOklch(r.fill).C >= hexToOklch('#00ff62').C * CHROMA_RETENTION - 0.005,
    'chroma held',
  );
  assert.ok(r.lc >= LABEL_LC_TARGET, 'label still readable');
});

test('when a fill is returned the label always clears the floor', () => {
  const backdrops = ['#000000', '#ffffff', '#808080', '#0a0a0a'];
  const accents = ['#00ffff', '#00ff62', '#ff0000', '#0000ff', '#ffff00', '#7a7a2e'];
  for (const bg of backdrops) {
    for (const a of accents) {
      const r = solveButtonFill(a, bg);
      assert.ok(r.lc >= LABEL_LC_TARGET, `accent ${a} on ${bg} gave Lc ${r.lc}`);
    }
  }
});

test('reported lc and objectRatio match a fresh measurement of the returned fill', () => {
  const r = solveButtonFill('#00ff62', '#000000');
  const measuredLc = Math.abs(apcaContrast(r.label, r.fill));
  const measuredRatio = wcagContrast(r.fill, '#000000');
  assert.ok(Math.abs(measuredLc - r.lc) < 0.05, 'lc is self-consistent');
  assert.ok(Math.abs(measuredRatio - r.objectRatio) < 0.05, 'ratio is self-consistent');
});

test('ring colour separates from the backdrop', () => {
  for (const bg of ['#000000', '#ffffff', '#808080']) {
    const ring = solveRingColor('#00ffff', bg);
    assert.ok(ring.objectRatio >= OBJECT_RATIO_TARGET, `ring on ${bg}`);
  }
});
