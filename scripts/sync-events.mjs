#!/usr/bin/env node
/**
 * Pull Exosphere's events off Eventbrite and write the static events.json the
 * site reads.
 *
 * This runs in CI, never in the browser. That is not a stylistic choice:
 *
 *   - The Eventbrite token can edit and delete events, so it must never ship to
 *     a client. Here it only ever exists inside a GitHub Actions runner.
 *   - Eventbrite killed the public event-search API in Dec 2019, so there is no
 *     way to "find events by organiser" — only the by-organisation endpoint,
 *     which is authenticated.
 *   - Poster colours are solved here too. Doing it client-side would taint the
 *     canvas under CORS on Eventbrite's image host, and would flash the wrong
 *     colour before settling.
 *
 * Usage:
 *   EVENTBRITE_TOKEN=... node scripts/sync-events.mjs
 *   node scripts/sync-events.mjs --dry-run     # print, do not write
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractAccents } from './lib/extract.mjs';
import { solveButtonFill, solveRingColor, hexToOklch, toHexClamped } from './lib/color.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'events.json');
const POSTER_DIR = path.join(ROOT, 'posters');

/**
 * The Exosphere Eventbrite organisation (account media.exosphere@gmail.com).
 * Confirmed via /users/me/organizations/ — the public /o/justus-walker-...
 * organiser page is a *different*, empty org, so do not take an ID from a URL.
 * Run `npm run verify` if this ever looks wrong.
 */
const ORG_ID = process.env.EVENTBRITE_ORG_ID || '2988846143592';
const API = 'https://www.eventbriteapi.com/v3';

/** The page background the button sits on. Keep in sync with --bg in styles.css. */
const BACKDROP = '#000000';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

// ---------------------------------------------------------------------------
// Eventbrite
// ---------------------------------------------------------------------------

async function eventbrite(pathname, token, params = {}) {
    const url = new URL(`${API}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Eventbrite ${res.status} ${res.statusText} for ${pathname}\n${body.slice(0, 400)}`);
    }
    return res.json();
}

/** Walk every page of the organisation's events. */
async function fetchAllEvents(token) {
    const events = [];
    let continuation;

    for (let page = 1; ; page++) {
        const params = {
            status: 'live,started,ended,completed',
            order_by: 'start_desc',
            expand: 'logo,venue,ticket_availability',
        };
        if (continuation) params.continuation = continuation;

        const data = await eventbrite(`/organizations/${ORG_ID}/events/`, token, params);
        events.push(...(data.events || []));

        if (!data.pagination?.has_more_items) break;
        continuation = data.pagination.continuation;
        if (!continuation || page > 50) break; // guard against a runaway loop
    }
    return events;
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/**
 * Eventbrite serves the highest-resolution crop behind a query string. Ask for
 * something big enough that accent extraction sees real linework.
 */
function posterUrlFor(ev) {
    const logo = ev.logo;
    if (!logo) return null;
    return logo.original?.url || logo.url || null;
}

function normalise(ev) {
    const name = ev.name?.text?.trim() || 'Untitled';
    // "EXOSPHERE 001: Future Sounds" -> title + subtitle
    const [, head, tail] = name.match(/^(.*?:)\s*(.*)$/) || [];

    return {
        id: ev.id,
        name: head ? head.trim() : name,
        subtitle: tail ? tail.trim() : '',
        fullName: name,
        startUtc: ev.start?.utc || null,
        startLocal: ev.start?.local || null,
        endUtc: ev.end?.utc || null,
        url: ev.url || null,
        venue: ev.venue?.name || ev.venue?.address?.localized_address_display || '',
        isSoldOut: Boolean(ev.ticket_availability?.is_sold_out),
        status: ev.status || null,
        remotePoster: posterUrlFor(ev),
    };
}

/**
 * Sort events into the three tiers the page renders.
 *
 * Three, not two. The spotlight is the event we are actively selling; anything
 * else in the future is still on sale and must not be filed under a heading
 * that reads "Previously", which is where it landed when the split was simply
 * "spotlight and everything else".
 *
 *   spotlight — soonest upcoming; falls back to the most recent past event when
 *               nothing is upcoming, so the hero is never empty
 *   upcoming  — remaining future events, ascending (the nearest matters most)
 *   archive   — past events only, descending (the newest matters most)
 *
 * An event is "past" once it has ended, not once it has started, so a night in
 * progress stays the spotlight instead of dropping into the archive at 10pm.
 *
 * @param {object[]} events  normalised events
 * @param {number} now       epoch ms
 */
export function splitEvents(events, now = Date.now()) {
    const endOf = (e) => new Date(e.endUtc || e.startUtc).getTime();
    const byDateDesc = (a, b) => new Date(b.startUtc) - new Date(a.startUtc);
    const byDateAsc = (a, b) => new Date(a.startUtc) - new Date(b.startUtc);

    const future = events.filter((e) => endOf(e) >= now).sort(byDateAsc);
    const past = events.filter((e) => endOf(e) < now).sort(byDateDesc);

    const spotlight = future[0] || past[0] || null;
    if (!spotlight) return { spotlight: null, upcoming: [], archive: [] };

    return {
        spotlight,
        upcoming: future.filter((e) => e.id !== spotlight.id),
        archive: past.filter((e) => e.id !== spotlight.id),
    };
}

// ---------------------------------------------------------------------------
// Posters + palette
// ---------------------------------------------------------------------------

/**
 * Mirror the poster into the repo. Eventbrite's CDN URLs rotate, which would
 * quietly break the archive over time.
 */
async function mirrorPoster(ev) {
    if (!ev.remotePoster) return null;

    const res = await fetch(ev.remotePoster);
    if (!res.ok) {
        console.warn(`  ! poster fetch failed for ${ev.id}: ${res.status}`);
        return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    const ext = (new URL(ev.remotePoster).pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg').toLowerCase();
    const rel = path.join('posters', `${ev.id}.${ext}`);

    await fs.mkdir(POSTER_DIR, { recursive: true });
    await fs.writeFile(path.join(ROOT, rel), buf);

    return { rel, buf };
}

/**
 * Solve the button palette for one poster.
 *
 * The two accents come off the artwork; accent A becomes the fill and accent B
 * stays a cue (ring, focus, eyebrow). See scripts/lib/color.mjs for why hue is
 * never rotated and why chroma has a floor.
 */
export async function solveTheme(posterBuffer, backdrop = BACKDROP) {
    const { accents, fellBack } = await extractAccents(posterBuffer);

    // Which of the two accents should carry the fill is not obvious from the
    // poster alone. A saturated mid-luminance hue (a Jamaican red, say) cannot
    // reach the label floor without going dark, at which point it stops
    // separating from a black page — while the gold beside it makes an
    // excellent button. Both are genuinely the poster's colours, so let the
    // contrast maths choose, and the loser becomes the cue.
    const candidates = accents.map((hex) => ({ hex, solved: solveButtonFill(hex, backdrop) }));
    candidates.sort((a, b) => {
        // Prefer a solution that needs no rescue ring, then real separation,
        // then label readability.
        if (a.solved.needsRing !== b.solved.needsRing) return a.solved.needsRing ? 1 : -1;
        if (Math.abs(a.solved.objectRatio - b.solved.objectRatio) > 0.5) {
            return b.solved.objectRatio - a.solved.objectRatio;
        }
        return b.solved.lc - a.solved.lc;
    });

    const accentA = candidates[0].hex;
    const accentB = accents.find((h) => h !== accentA) || accents[1];

    const fill = candidates[0].solved;
    const ring = solveRingColor(accentB, backdrop);

    // Hover is the same colour nudged in lightness — not a second hue.
    const lch = hexToOklch(fill.fill);
    const hoverL = lch.L > 0.5 ? Math.max(0, lch.L - 0.06) : Math.min(1, lch.L + 0.06);
    const fillHover = toHexClamped({ ...lch, L: hoverL });

    return {
        fill: fill.fill,
        fillHover,
        label: fill.label,
        accent: accentB,
        ring: ring.hex,
        needsRing: fill.needsRing,
        // Kept in the payload so a bad palette is visible in the diff, not just
        // on the page.
        measured: {
            labelLc: fill.lc,
            objectRatio: fill.objectRatio,
            ringRatio: ring.objectRatio,
            hue: Math.round(fill.hueLocked * 10) / 10,
            lightnessShift: fill.lightnessShift,
            sourceAccents: accents,
            extractionFellBack: fellBack,
        },
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const token = process.env.EVENTBRITE_TOKEN;
    if (!token) {
        console.error('EVENTBRITE_TOKEN is not set.');
        console.error('This script cannot run without it — Eventbrite has no public event API.');
        process.exit(1);
    }

    console.log(`Fetching events for organisation ${ORG_ID} ...`);
    const raw = await fetchAllEvents(token);
    console.log(`  ${raw.length} event(s) returned`);

    if (raw.length === 0) {
        console.error('No events returned. Check that EVENTBRITE_ORG_ID is the right organisation.');
        process.exit(1);
    }

    const events = raw.map(normalise).filter((e) => e.startUtc);
    const now = Date.now();
    const {
        spotlight: spotlightSource,
        upcoming: upcomingSource,
        archive: archiveSource,
    } = splitEvents(events, now);

    async function build(ev, { isSpotlight = false } = {}) {
        console.log(`  · ${ev.fullName}`);

        const poster = await mirrorPoster(ev);
        const record = {
            id: ev.id,
            name: ev.name,
            subtitle: ev.subtitle,
            startUtc: ev.startUtc,
            startLocal: ev.startLocal,
            url: ev.url,
            venue: ev.venue,
            poster: poster?.rel || null,
            isSoldOut: ev.isSoldOut,
            isPast: new Date(ev.endUtc || ev.startUtc).getTime() < now,
        };

        // Only the spotlight drives the button palette — the CTA should follow
        // the event you can actually buy into right now.
        if (isSpotlight && poster) {
            record.theme = await solveTheme(poster.buf);
            const m = record.theme.measured;
            console.log(`    palette ${record.theme.fill} on ${record.theme.label} — Lc ${m.labelLc}, ${m.objectRatio}:1`);
            if (m.extractionFellBack) console.warn('    ! extraction fell back to defaults');
            if (record.theme.needsRing) console.warn('    ! object contrast needed a ring');
        }

        return record;
    }

    const spotlight = await build(spotlightSource, { isSpotlight: true });
    const upcomingOut = [];
    for (const ev of upcomingSource) upcomingOut.push(await build(ev));
    const archiveOut = [];
    for (const ev of archiveSource) archiveOut.push(await build(ev));

    console.log(`  ${upcomingOut.length} upcoming, ${archiveOut.length} past`);

    const payload = {
        generatedAt: new Date().toISOString(),
        source: 'eventbrite',
        organizationId: ORG_ID,
        spotlight,
        upcoming: upcomingOut,
        archive: archiveOut,
    };

    const json = `${JSON.stringify(payload, null, 2)}\n`;

    if (DRY_RUN) {
        console.log(json);
        return;
    }

    // Write only on a real change, so the hourly cron does not produce an empty
    // commit every time it runs.
    const previous = await fs.readFile(OUT_FILE, 'utf8').catch(() => null);
    if (previous && stripTimestamp(previous) === stripTimestamp(json)) {
        console.log('No change — events.json left alone.');
        return;
    }

    await fs.writeFile(OUT_FILE, json);
    console.log(`Wrote ${OUT_FILE}`);
}

/** generatedAt changes every run; ignore it when deciding whether to commit. */
function stripTimestamp(json) {
    return json.replace(/"generatedAt":\s*"[^"]*",?\n?/, '');
}

// Only run when invoked directly, so tests can import solveTheme.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
