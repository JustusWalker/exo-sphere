/**
 * Cloudflare Worker: Eventbrite webhook -> GitHub repository_dispatch.
 *
 * Why this exists at all: Eventbrite's webhook payload is deliberately thin. It
 * carries `api_url` and `config.action`, not the event itself, and the delivery
 * cannot be given custom headers — so it can neither tell GitHub what changed
 * nor present GitHub's required `Authorization: Bearer`. Something in the
 * middle has to hold the credential and translate. That is all this does.
 *
 * Deploy:
 *   npx wrangler deploy worker/eventbrite-relay.js --name exosphere-relay
 *   npx wrangler secret put GITHUB_PAT        # fine-grained, contents:write on the repo
 *   npx wrangler secret put EB_WEBHOOK_SECRET # any long random string
 *
 * Then register the webhook in Eventbrite pointing at:
 *   https://<worker>.workers.dev/?s=<EB_WEBHOOK_SECRET>
 * subscribed to event.published and event.updated.
 */

const REPO = 'JustusWalker/exo-sphere';
const ALLOWED_ACTIONS = new Set(['event.published', 'event.updated', 'event.unpublished']);

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Eventbrite cannot send an auth header, so the shared secret rides in the
    // query string. Without this the endpoint is an open rebuild trigger.
    const secret = new URL(request.url).searchParams.get('s');
    if (!env.EB_WEBHOOK_SECRET || !timingSafeEqual(secret || '', env.EB_WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    let action = null;
    try {
      const body = await request.json();
      action = body?.config?.action ?? null;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Acknowledge anything we understand but do not act on, so Eventbrite does
    // not retry it.
    if (action && !ALLOWED_ACTIONS.has(action)) {
      return new Response('Ignored', { status: 200 });
    }

    // Respond immediately and dispatch in the background: Eventbrite times out
    // slow endpoints and will retry, which would queue duplicate builds.
    ctx.waitUntil(dispatch(env, action));
    return new Response('OK', { status: 200 });
  },
};

async function dispatch(env, action) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'exosphere-relay',
    },
    body: JSON.stringify({
      event_type: 'eventbrite-event',
      client_payload: { action, at: new Date().toISOString() },
    }),
  });

  if (!res.ok) {
    console.error('repository_dispatch failed', res.status, await res.text());
  }
}

/** Constant-time compare, so the secret cannot be recovered by timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
