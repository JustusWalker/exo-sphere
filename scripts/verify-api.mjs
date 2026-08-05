#!/usr/bin/env node
/**
 * Verify the Eventbrite credential and find the right organisation.
 *
 * Deliberately does not test the hardcoded org ID in isolation: a zero-event
 * response there is ambiguous (wrong ID, or right ID with nothing published).
 * Instead it asks the token what it can actually see, which answers the
 * question outright.
 *
 * Usage:
 *   EVENTBRITE_TOKEN=... node scripts/verify-api.mjs
 *   node scripts/verify-api.mjs            # reads .env if present
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_ORG = process.env.EVENTBRITE_ORG_ID || '2988846143592';
const API = 'https://www.eventbriteapi.com/v3';

// Allow a gitignored .env so the token never has to be pasted into a shell that
// records history.
function loadEnvFile() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}
loadEnvFile();

const token = process.env.EVENTBRITE_TOKEN;

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;

if (!token) {
    console.error(bad('EVENTBRITE_TOKEN is not set.'));
    console.error('');
    console.error('Get one at: https://www.eventbrite.com/account-settings/apps');
    console.error('  → your app → "Private token"');
    console.error('');
    console.error('Then either:');
    console.error('  echo "EVENTBRITE_TOKEN=xxxx" > .env        # gitignored');
    console.error('  EVENTBRITE_TOKEN=xxxx node scripts/verify-api.mjs');
    process.exit(1);
}

async function api(pathname, params = {}) {
    const url = new URL(`${API}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

// --- 1. Is the token valid at all? ----------------------------------------

console.log('1. Checking the token ...');
const me = await api('/users/me/');
if (!me.ok) {
    console.log(bad(`token rejected (HTTP ${me.status})`));
    console.log(`   ${me.body?.error_description || JSON.stringify(me.body).slice(0, 200)}`);
    if (me.status === 401) console.log('   → the token is wrong, expired, or revoked.');
    process.exit(1);
}
console.log(ok(`token valid — ${me.body.name || me.body.emails?.[0]?.email || me.body.id}`));

// --- 2. Which organisations can it see? ------------------------------------

console.log('\n2. Listing organisations this token can reach ...');
const orgs = await api('/users/me/organizations/');
if (!orgs.ok) {
    console.log(bad(`could not list organisations (HTTP ${orgs.status})`));
    process.exit(1);
}

const list = orgs.body.organizations || [];
if (list.length === 0) {
    console.log(bad('this token has no organisations.'));
    console.log('   → it likely belongs to a different Eventbrite account than the one');
    console.log('     that posts Exosphere events.');
    process.exit(1);
}

for (const o of list) {
    const marker = o.id === EXPECTED_ORG ? ' \x1b[32m<- matches the configured ID\x1b[0m' : '';
    console.log(`   ${o.id}  ${o.name || '(unnamed)'}${marker}`);
}

const matched = list.find((o) => o.id === EXPECTED_ORG);
if (!matched) {
    console.log('');
    console.log(warn(`configured ORG_ID ${EXPECTED_ORG} is NOT in that list.`));
    console.log('   → update ORG_ID in scripts/sync-events.mjs, or set EVENTBRITE_ORG_ID,');
    console.log('     to one of the IDs above.');
}

// --- 3. Do those organisations actually hold events? -----------------------

console.log('\n3. Counting events per organisation ...');
let totalEvents = 0;

for (const o of list) {
    const evs = await api(`/organizations/${o.id}/events/`, {
        status: 'live,started,ended,completed',
        order_by: 'start_desc',
        expand: 'venue',
    });

    if (!evs.ok) {
        console.log(bad(`${o.id}: HTTP ${evs.status}`));
        continue;
    }

    const events = evs.body.events || [];
    totalEvents += events.length;
    const more = evs.body.pagination?.has_more_items ? '+' : '';
    console.log(`   ${o.id} (${o.name}): ${events.length}${more} event(s)`);

    for (const e of events.slice(0, 6)) {
        const when = e.start?.local?.slice(0, 10) || '????-??-??';
        const past = new Date(e.end?.utc || e.start?.utc) < new Date() ? 'past    ' : 'upcoming';
        const logo = e.logo_id ? '' : '  \x1b[33m(no poster image)\x1b[0m';
        console.log(`       ${when}  ${past}  ${e.name?.text || '(untitled)'}${logo}`);
    }
    if (events.length > 6) console.log(`       ... and ${events.length - 6} more`);
}

// --- verdict ---------------------------------------------------------------

console.log('');
if (totalEvents === 0) {
    console.log(bad('No events found under any organisation this token can see.'));
    console.log('   The pipeline has nothing to sync yet. Either the events live on a');
    console.log('   different account, or none have been published.');
    process.exit(1);
}

if (matched) {
    console.log(ok('Ready. Run: npm run sync'));
} else {
    console.log(warn('Ready, but fix the org ID first — see step 2 above.'));
}
