/**
 * Numax -> AIOStreams config relay (Cloudflare Worker)
 * =====================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * AIOStreams' own API can build a finished configuration from a JSON config and
 * hand back a working manifest URL:
 *
 *   POST <instance>/api/v1/user   {config, password}
 *     -> 201 {data:{uuid, encryptedPassword}}
 *   manifest = <instance>/stremio/<uuid>/<encryptedPassword>/manifest.json
 *
 * Verified live 2026-09-10 against aiostreams.viren070.me with the Numax
 * template: created, manifest loaded, then deleted again.
 *
 * A browser cannot make that call. AIOStreams only mounts its CORS middleware on
 * the /api routes when NODE_ENV is development (packages/server/src/app.ts), so
 * every public instance answers the preflight with no Access-Control-Allow-Origin
 * at all. Checked against all 12 instances on the uptime tracker 2026-09-10:
 * none of them allow it. That is why the Setup Wizard's "Do it all for me" path
 * goes through here instead - it is the one step the page itself cannot do.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * Not a general-purpose CORS proxy. It will only POST to /api/v1/user on a
 * hostname that the IbbyLabs uptime tracker currently lists in its AIOStreams
 * group, so it cannot be pointed at an arbitrary server. It stores nothing,
 * and it never logs a request body - that body carries the user's TorBox key.
 *
 * IT ALSO CHECKS THE TORBOX KEY FIRST, ON PURPOSE
 * -----------------------------------------------
 * AIOStreams does NOT validate debrid credentials on create (verified: a config
 * carrying the key "FAKE-TORBOX-KEY-0000" was accepted and returned a live
 * manifest). A typo would therefore produce an add-on that installs fine and
 * silently finds nothing - exactly the kind of silent failure Numax does not
 * ship. So the key is checked against TorBox before anything is created.
 *
 * IT ALSO ANSWERS A BARE "IS THIS TORBOX KEY REAL?" (added 2026-09-13)
 * -------------------------------------------------------------------
 * POST {op:'verify', provider:'torbox', key:'...'} -> {ok:true|false}
 *
 * The wizard's Nuvio+TorBox path writes a TorBox key straight into Nuvio, with
 * no AIOStreams anywhere, and wants the same live tick the TMDB/MDBList boxes
 * have. It cannot do that itself: api.torbox.app runs an origin ALLOWLIST that
 * contains only https://torbox.app, so every other origin gets 400 "Disallowed
 * CORS origin" on the preflight (measured 2026-09-13). Premiumize, by contrast,
 * answers any origin, so the page checks that one directly and never comes here.
 *
 * This op reuses torboxKeyOk() unchanged and writes nothing anywhere. A relay
 * deployed before this op existed answers 400 "No instance was given.", which
 * the page reads as "couldn't check" - it never turns into a cross.
 *
 * DEPLOYING IT: see relay/README.md
 */

// The page that is allowed to call this. localhost is included so the wizard can
// be driven against the real relay from `python -m http.server` during testing.
const ORIGIN_OK = (o) =>
  o === 'https://numaxofficial.website' ||
  o === 'https://www.numaxofficial.website' ||
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const UPTIME_URL = 'https://uptime.ibbylabs.dev/v1/status';
const TORBOX_URL = 'https://api.torbox.app/v1/api/user/me?settings=false';
const HOSTS_TTL = 10 * 60 * 1000;   // the tracker moves far slower than this
const MAX_BODY = 512 * 1024;        // a full config is ~15KB; this is generous
const UPSTREAM_TIMEOUT = 25000;

/** Message carried back to the user verbatim, so nothing fails anonymously. */
class Fail extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let hostCache = { at: 0, set: null };

function timed(url, init, ms) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Hostnames the uptime tracker currently lists under its AIOStreams group. */
async function allowedHosts() {
  if (hostCache.set && Date.now() - hostCache.at < HOSTS_TTL) return hostCache.set;
  let json;
  try {
    // A named User-Agent on purpose: the tracker answers 403 to some default
    // client agents, which looked exactly like "that instance is not real".
    const r = await timed(UPTIME_URL, { headers: { accept: 'application/json', 'user-agent': 'Numax/1.0 (+https://numaxofficial.website)' } }, 12000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    json = await r.json();
  } catch (e) {
    // Serve a stale list rather than block a setup over a tracker blip.
    if (hostCache.set) return hostCache.set;
    throw new Fail(502, 'The uptime tracker is not answering, so I cannot confirm that instance is a real AIOStreams host. Try again in a minute.');
  }
  const set = new Set();
  for (const s of json.services || []) {
    if (!s || s.group !== 'AIOStreams' || !s.url) continue;
    try { set.add(new URL(s.url).host.toLowerCase()); } catch { /* skip a malformed row */ }
  }
  if (!set.size) throw new Fail(502, 'The uptime tracker listed no AIOStreams instances, so I have nothing to check that instance against.');
  hostCache = { at: Date.now(), set };
  return set;
}

/** true = key works, false = key rejected, null = TorBox could not be reached. */
async function torboxKeyOk(key) {
  let r;
  try {
    r = await timed(TORBOX_URL, {
      // Named on purpose. TorBox sits behind a WAF that answers some default
      // client agents with a plain-text "error code: 1010" and a 403 - which is
      // the WAF's opinion of the caller, not TorBox's opinion of the key.
      headers: { authorization: 'Bearer ' + key, accept: 'application/json', 'user-agent': 'Numax/1.0 (+https://numaxofficial.website)' },
    }, 12000);
  } catch { return null; }
  let body = null;
  try { body = await r.json(); } catch { /* not TorBox's JSON - see below */ }
  if (body && typeof body.success === 'boolean') {
    if (body.success) return true;
    // BAD_TOKEN is the documented rejection; anything else is TorBox's problem.
    return body.error === 'BAD_TOKEN' || body.error === 'AUTH_ERROR' ? false : null;
  }
  // Anything that is not TorBox's own JSON is "could not check", never "bad
  // key". Reading a WAF block as a rejection would tell a user with a perfectly
  // good key to go and fetch it again.
  return null;
}

/** The TorBox key out of the config the page built, if that service is on. */
function torboxKeyOf(config) {
  const svc = (config.services || []).find((s) => s && s.id === 'torbox' && s.enabled);
  const key = svc && svc.credentials && svc.credentials.apiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

const reply = (status, body, cors) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': ORIGIN_OK(origin) ? origin : 'https://numaxofficial.website',
      'vary': 'Origin',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'Send a POST.' }, cors);
    // A browser always sends Origin on a cross-origin POST. An absent one is a
    // non-browser caller, which is allowed - the host allowlist is the real guard.
    if (origin && !ORIGIN_OK(origin)) return reply(403, { error: 'This relay only answers the Numax setup wizard.' }, cors);

    let keyUnchecked = false;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) throw new Fail(413, 'That configuration is too large.');
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Fail(400, 'The request body was not valid JSON.'); }

      // The bare key check. Deliberately first and deliberately tiny: it reaches
      // no AIOStreams instance, needs no host allowlist, and creates nothing.
      if (payload && payload.op === 'verify') {
        if (payload.provider !== 'torbox') throw new Fail(400, 'Only TorBox keys are checked here.');
        const k = typeof payload.key === 'string' ? payload.key.trim() : '';
        if (!k) throw new Fail(400, 'No key was given.');
        const ok = await torboxKeyOk(k);
        // null is "TorBox did not answer", which is not the same as a bad key
        // and must never be reported as one.
        if (ok === null) throw new Fail(502, 'TorBox did not answer, so the key could not be checked.');
        return reply(200, { ok }, cors);
      }

      const { instance, config, password } = payload || {};
      if (typeof instance !== 'string' || !instance) throw new Fail(400, 'No instance was given.');
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Fail(400, 'No configuration was given.');
      if (typeof password !== 'string' || password.length < 6) throw new Fail(400, 'The password must be at least 6 characters.');

      let base;
      try { base = new URL(instance); } catch { throw new Fail(400, 'That instance address is not a URL.'); }
      if (base.protocol !== 'https:') throw new Fail(400, 'The instance must be an https address.');

      const hosts = await allowedHosts();
      if (!hosts.has(base.host.toLowerCase())) {
        throw new Fail(403, base.host + ' is not on the public AIOStreams instance list, so this relay will not send anything to it.');
      }

      // Checked before creating anything, because AIOStreams will happily store
      // a wrong one and the add-on then finds nothing, with no error anywhere.
      const key = torboxKeyOf(config);
      if (key) {
        const ok = await torboxKeyOk(key);
        if (ok === false) throw new Fail(400, 'TorBox rejected that API key. Copy it again from torbox.app/settings - nothing has been created.');
        // null = TorBox itself is unreachable. Carry on rather than block a setup
        // on a third party being down; the reply says the check was skipped.
        keyUnchecked = ok === null;
      }

      const created = await timed(
        'https://' + base.host + '/api/v1/user',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ config, password }),
        },
        UPSTREAM_TIMEOUT
      ).catch(() => { throw new Fail(502, base.host + ' did not answer. Pick a different instance and try again.'); });

      let body = null;
      try { body = await created.json(); } catch { /* handled just below */ }
      if (!created.ok || !body || !body.success) {
        const detail = (body && body.error && (body.error.message || body.error.code))
          || (body && body.detail) || ('HTTP ' + created.status);
        throw new Fail(created.status === 429 ? 429 : 502, base.host + ' refused the configuration: ' + detail);
      }
      const { uuid, encryptedPassword } = body.data || {};
      if (!uuid || !encryptedPassword) throw new Fail(502, base.host + ' created the configuration but did not return what is needed to build its link.');

      return reply(200, {
        uuid,
        encryptedPassword,
        manifestUrl: 'https://' + base.host + '/stremio/' + uuid + '/' + encryptedPassword + '/manifest.json',
        configureUrl: 'https://' + base.host + '/stremio/configure',
        keyUnchecked,
      }, cors);
    } catch (e) {
      if (e instanceof Fail) return reply(e.status, { error: e.message }, cors);
      // Deliberately not echoing an unexpected error's text: it can quote the
      // request, and the request holds the user's key.
      return reply(500, { error: 'The relay hit an unexpected problem. Nothing was created.' }, cors);
    }
  },
};
