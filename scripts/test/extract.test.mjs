import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { extractAccents, hueDistance, MIN_HUE_SEPARATION } from '../lib/extract.mjs';
import { hexToOklch, solveButtonFill, LABEL_LC_TARGET } from '../lib/color.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Build a synthetic poster: a background with thin bright strokes over it. */
async function poster({ bg, strokes = [], size = 400 }) {
  const rects = strokes
    .map((s, i) => `<rect x="${20 + i * 45}" y="40" width="14" height="${size - 80}" fill="${s}"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="${bg}"/>${rects}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('the real EXO11 poster yields its neon green and cyan, not grey', async () => {
  const buf = fs.readFileSync(path.join(repoRoot, 'EXO11.png'));
  const { accents, fellBack } = await extractAccents(buf);

  assert.equal(fellBack, false);
  const hues = accents.map((a) => hexToOklch(a).h);

  // Poster identity is a green around 145 deg and a cyan around 190 deg.
  assert.ok(
    hues.some((h) => hueDistance(h, 147) < 20),
    `expected a green near 147deg, got ${hues.map((h) => h.toFixed(0))}`,
  );
  assert.ok(
    hues.some((h) => hueDistance(h, 190) < 25),
    `expected a cyan near 190deg, got ${hues.map((h) => h.toFixed(0))}`,
  );

  // The regression that matters: mud. Both accents must be genuinely saturated.
  for (const a of accents) {
    assert.ok(hexToOklch(a).C > 0.1, `${a} is too desaturated to be an accent`);
  }
});

test('a near-black poster does not return dark grey as the accent', async () => {
  const buf = await poster({ bg: '#050505', strokes: ['#00ff62', '#00ffff'] });
  const { accents } = await extractAccents(buf);
  for (const a of accents) {
    assert.ok(hexToOklch(a).C > 0.08, `${a} came back as near-neutral`);
  }
});

test('a near-white poster still finds its accents', async () => {
  const buf = await poster({ bg: '#fbfbfb', strokes: ['#d10a3c', '#0a3cd1'] });
  const { accents, fellBack } = await extractAccents(buf);
  assert.equal(fellBack, false);
  for (const a of accents) {
    assert.ok(hexToOklch(a).C > 0.05, `${a} came back as near-neutral`);
  }
});

test('a monochrome poster returns a usable accent rather than inventing a hue', async () => {
  const buf = await poster({ bg: '#0a0a0a', strokes: ['#ff7a00', '#ff8c1a'] });
  const { accents } = await extractAccents(buf);
  assert.equal(accents.length, 2);
  // Both accents should sit on the one hue actually present — no fabrication.
  const hues = accents.map((a) => hexToOklch(a).h);
  assert.ok(hueDistance(hues[0], hues[1]) < MIN_HUE_SEPARATION || accents[0] === accents[1]);
  for (const a of accents) {
    assert.ok(hueDistance(hexToOklch(a).h, hexToOklch('#ff7a00').h) < 30, `${a} drifted off the source hue`);
  }
});

test('a fully achromatic poster falls back rather than emitting grey accents', async () => {
  const buf = await poster({ bg: '#101010', strokes: ['#888888', '#cccccc'] });
  const { accents, fellBack } = await extractAccents(buf);
  assert.equal(fellBack, true, 'should have declared a fallback');
  for (const a of accents) {
    assert.ok(hexToOklch(a).C > 0.08, `fallback ${a} must still be a real accent`);
  }
});

test('every hostile fixture still produces a readable button', async () => {
  const fixtures = [
    { bg: '#050505', strokes: ['#00ff62', '#00ffff'] },
    { bg: '#fbfbfb', strokes: ['#d10a3c', '#0a3cd1'] },
    { bg: '#0a0a0a', strokes: ['#ff7a00'] },
    { bg: '#101010', strokes: ['#888888'] },
    { bg: '#404040', strokes: ['#4a4a20', '#204a4a'] },
  ];
  for (const f of fixtures) {
    const { accents } = await extractAccents(await poster(f));
    const r = solveButtonFill(accents[0], '#000000');
    assert.ok(r.lc >= LABEL_LC_TARGET, `fixture ${f.bg} gave Lc ${r.lc}`);
  }
});
