// ============================================================
// The plugin-provider filter (Cloudflare Worker)
//
// WHAT PROBLEM THIS SOLVES, and why nothing smaller does.
//
// Nuvio syncs a plugin repository as ONE row: { url, name, enabled,
// repo_type, sort_order, ... }. There is no per-provider field anywhere in
// it — that is the shape of a real sync_export_account_backup row, read off a
// live account, not an inference. The per-provider switches are device-local
// and never reach the account at all. So "install only these 6 of these 61
// providers" cannot be expressed by anything Numax writes to Nuvio.
//
// The one thing that CAN carry a selection is the manifest, because the
// manifest is the only thing the stored row points at. This Worker serves a
// copy of somebody else's manifest with the unwanted `scrapers` removed. To
// Nuvio it is simply a repository that happens to contain 6 providers.
//
// THE CONSEQUENCE, stated plainly because it is the whole cost of the
// feature: a provider's `filename` is relative ("providers/4khdhub.js" —
// checked against every repo in the community index), so whoever serves the
// manifest must also serve the provider code sitting next to it. A device
// using a filtered repository therefore fetches that repository's JavaScript
// through this Worker. It is a pass-through — nothing is rewritten, nothing
// is stored — but it is this account's bandwidth and this account's name on
// the request, and that is deliberate and signed off, not accidental.
//
// Numax only ever writes a filtered URL when the user picks a SUBSET. Pick
// every provider and it writes the plain upstream URL and this Worker is not
// in the path at all.
//
// STATELESS ON PURPOSE. The selection travels inside the URL, so the Worker
// can be redeployed, renamed or moved and nobody's already-installed
// repository breaks. A KV lookup would have been prettier and would have
// turned a lost namespace into somebody's plugins silently emptying out.
//
//   GET /f/<payload>/manifest.json       -> upstream manifest, scrapers filtered
//   GET /f/<payload>/<relative path>     -> that file, straight from upstream
//
// <payload> is base64url of {"u":"<upstream manifest url>","s":["id", ...]}.
//
// Deploy: see README.md. No bindings, no secrets, no configuration.
// ============================================================

// An allowlist, because without one this is an open proxy that will be found
// and used as one. These are the forges the community plugin index actually
// links to; a repository hosted anywhere else cannot be filtered, and says so
// rather than being fetched.
const HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'gist.githubusercontent.com',
  'codeberg.org',
  'gitlab.com',
  'raw.gitlab.io',
  'cdn.jsdelivr.net',
]);

// Provider code is public, immutable-ish and hot: every playback attempt on a
// device fetches it. A short edge cache keeps a popular repository from
// turning into upstream traffic per user per play, while still picking up a
// provider update within minutes.
const CODE_TTL = 300;
const MANIFEST_TTL = 120;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function fail(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

function b64urlDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The payload is the only caller-supplied thing that becomes a URL, so it is
// validated rather than trusted: https only, a host on the list above, and no
// credentials in it.
function readPayload(seg) {
  let j;
  try { j = JSON.parse(b64urlDecode(seg)); }
  catch (e) { return { error: 'That link is malformed.' }; }
  if (!j || typeof j.u !== 'string' || !Array.isArray(j.s)) return { error: 'That link is malformed.' };
  let u;
  try { u = new URL(j.u); } catch (e) { return { error: 'That link does not carry a valid manifest address.' }; }
  if (u.protocol !== 'https:') return { error: 'Only https manifests can be filtered.' };
  if (u.username || u.password) return { error: 'That manifest address is not allowed.' };
  if (!HOSTS.has(u.hostname)) return { error: 'This filter only serves repositories hosted on ' + [...HOSTS].join(', ') + '.' };
  const ids = j.s.map(String).filter(x => x && x.length <= 200).slice(0, 500);
  if (!ids.length) return { error: 'That link selects no providers.' };
  return { upstream: u, ids: new Set(ids) };
}

// A scraper is kept if its id, or its filename, was ticked. Both, because a
// manifest that omits `id` still has to be addressable — and because matching
// on array position would silently select the wrong providers the moment
// upstream adds one.
function keep(sc, ids) {
  if (!sc || typeof sc !== 'object') return false;
  return ids.has(String(sc.id || '')) || ids.has(String(sc.filename || ''));
}

// The relative path resolves against the UPSTREAM manifest, then has to still
// be under that manifest's own directory — "providers/x.js" is fine,
// "../../../etc" is not, and neither is anything that lands on another host.
function resolveAsset(upstream, rel) {
  let target;
  try { target = new URL(rel, upstream); } catch (e) { return null; }
  if (target.origin !== upstream.origin) return null;
  const base = upstream.pathname.replace(/[^/]*$/, '');
  if (target.pathname.indexOf(base) !== 0) return null;
  return target;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail('Only GET is supported.', 405);

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'f' || parts.length < 3) {
      return fail('This Worker serves filtered Nuvio plugin manifests. Numax builds the links; there is nothing to open by hand.', 404);
    }

    const read = readPayload(parts[1]);
    if (read.error) return fail(read.error, 400);

    const rest = parts.slice(2).join('/');

    // ---- anything that is not the manifest: straight through ----
    if (rest !== 'manifest.json') {
      const target = resolveAsset(read.upstream, rest);
      if (!target) return fail('That file is not part of this repository.', 400);
      let up;
      try {
        up = await fetch(target.toString(), {
          headers: { Accept: '*/*', 'User-Agent': 'Numax-Plugin-Filter/1' },
          cf: { cacheEverything: true, cacheTtl: CODE_TTL },
        });
      } catch (e) { return fail('Could not reach ' + target.hostname + '.', 502); }
      if (!up.ok) return fail('Upstream answered ' + up.status + ' for that file.', up.status);
      const h = new Headers(CORS);
      h.set('Content-Type', up.headers.get('Content-Type') || 'application/javascript; charset=utf-8');
      h.set('Cache-Control', 'public, max-age=' + CODE_TTL);
      return new Response(up.body, { status: 200, headers: h });
    }

    // ---- the manifest: the same document, minus the providers not picked ----
    let up;
    try {
      up = await fetch(read.upstream.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': 'Numax-Plugin-Filter/1' },
        cf: { cacheEverything: true, cacheTtl: MANIFEST_TTL },
      });
    } catch (e) { return fail('Could not reach ' + read.upstream.hostname + '.', 502); }
    if (!up.ok) return fail('Upstream answered ' + up.status + ' for that manifest.', up.status);

    let doc;
    try { doc = JSON.parse(await up.text()); }
    catch (e) { return fail('That manifest is not JSON.', 502); }
    if (!doc || !Array.isArray(doc.scrapers)) return fail('That manifest has no provider list.', 502);

    const scrapers = doc.scrapers.filter(sc => keep(sc, read.ids));
    // Every id in the link is gone from upstream: serving an empty repository
    // would look like a working install that finds nothing. Say what happened.
    if (!scrapers.length) return fail('None of the selected providers are in that repository any more.', 409);

    // Everything else is passed through untouched — version, name, and any
    // field this Worker has never heard of. `filename` stays relative, which
    // is what routes the provider code back through here.
    const out = { ...doc, scrapers };
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=' + MANIFEST_TTL,
        ...CORS,
      },
    });
  },
};
