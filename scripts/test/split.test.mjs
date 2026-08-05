/**
 * The three-tier split.
 *
 * The bug being locked out: when the split was "spotlight and everything else",
 * a second future event landed in the archive and rendered under a heading that
 * says "Previously" — advertising a night that has not happened as history.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitEvents } from '../sync-events.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const at = (id, iso, endIso) => ({ id, startUtc: iso, endUtc: endIso ?? null });

test('soonest future event is the spotlight', () => {
  const { spotlight } = splitEvents(
    [at('far', '2026-09-01T00:00:00Z'), at('soon', '2026-08-09T00:00:00Z')],
    NOW,
  );
  assert.equal(spotlight.id, 'soon');
});

test('a later future event goes to upcoming, never to the archive', () => {
  const { upcoming, archive } = splitEvents(
    [at('soon', '2026-08-09T00:00:00Z'), at('later', '2026-09-01T00:00:00Z')],
    NOW,
  );
  assert.deepEqual(upcoming.map((e) => e.id), ['later']);
  assert.deepEqual(archive.map((e) => e.id), []);
});

test('upcoming is ascending and the archive is descending', () => {
  const { upcoming, archive } = splitEvents(
    [
      at('now', '2026-08-09T00:00:00Z'),
      at('future-b', '2026-10-01T00:00:00Z'),
      at('future-a', '2026-09-01T00:00:00Z'),
      at('past-old', '2026-01-01T00:00:00Z'),
      at('past-recent', '2026-07-01T00:00:00Z'),
    ],
    NOW,
  );
  assert.deepEqual(upcoming.map((e) => e.id), ['future-a', 'future-b']);
  assert.deepEqual(archive.map((e) => e.id), ['past-recent', 'past-old']);
});

test('the spotlight appears in exactly one tier', () => {
  const { spotlight, upcoming, archive } = splitEvents(
    [at('a', '2026-08-09T00:00:00Z'), at('b', '2026-09-01T00:00:00Z'), at('c', '2026-01-01T00:00:00Z')],
    NOW,
  );
  const ids = [...upcoming, ...archive].map((e) => e.id);
  assert.ok(!ids.includes(spotlight.id));
  assert.equal(ids.length + 1, 3);
});

test('with nothing upcoming the most recent past event holds the hero', () => {
  const { spotlight, upcoming, archive } = splitEvents(
    [at('old', '2026-01-01T00:00:00Z'), at('recent', '2026-07-01T00:00:00Z')],
    NOW,
  );
  assert.equal(spotlight.id, 'recent');
  assert.deepEqual(upcoming, []);
  assert.deepEqual(archive.map((e) => e.id), ['old']);
});

test('an event in progress is still upcoming, not past', () => {
  // Started two hours ago, runs another four. A night should not fall into the
  // archive the moment its doors open.
  const { spotlight } = splitEvents(
    [
      at('tonight', '2026-08-05T10:00:00Z', '2026-08-05T16:00:00Z'),
      at('yesterday', '2026-08-04T10:00:00Z', '2026-08-04T16:00:00Z'),
    ],
    NOW,
  );
  assert.equal(spotlight.id, 'tonight');
});

test('no events yields empty tiers rather than throwing', () => {
  assert.deepEqual(splitEvents([], NOW), { spotlight: null, upcoming: [], archive: [] });
});
