// ============================================================
// The community-collections relay (Cloudflare Worker)
//
// Nuvio's community-collections API lives on nuvio.tv, requires a real Nuvio
// login, and sends no CORS headers at all — verified from a neutral origin, a
// cross-origin request fails before it even reaches the auth check. So Numax's
// own tab can never read it. This Worker is the one hop that makes it
// readable, and it does nothing else.
//
// It forwards exactly two GETs:
//   { op:'list',   token, page, limit, sort }  -> GET /api/community-collections?...
//   { op:'detail', token, slug }               -> GET /api/community-collections/<slug>
//
// It has no KV, no database, no secrets and no configuration. It keeps nothing
// and it never logs a request body, because that body carries the caller's own
// Nuvio session token. Deploy instructions: see README.md.
//
// The one thing it does to a payload is shrink the LIST response, and that is
// not a nicety. Measured live 2026-09-13: the list endpoint embeds each
// collection's ENTIRE install envelope — every folder, every source — in every
// row, so one page of 60 is 4.93 MB and the full 104-collection catalogue is
// about 8.5 MB. Browsing needs a title, an image, some counts and the names of
// the add-ons a collection needs; projecting to exactly that takes the same
// page to 60 KB, an 84x reduction, and the whole catalogue to ~104 KB.
// `detail` — the call that actually installs something — is passed through
// completely untouched, so nothing the write path depends on is filtered here.
// ============================================================

const API = 'https://nuvio.tv/api/community-collections';
// Live-checked: the API caps its own page size at 60 however much you ask for.
const MAX_LIMIT = 60;
const SORTS = new Set(['installs', 'likes', 'recent', 'title']);

// Exactly the fields a browse card draws, and nothing else. Anything Numax
// needs later must be added here deliberately rather than arriving by accident
// inside a multi-megabyte envelope.
function projectRow(it) {
  const o = it || {};
  const env = o.envelope || {};
  const addons = ((env.requirements || {}).addons) || [];
  return {
    public_id: o.public_id,
    title: o.title,
    description: o.description,
    image_url: o.image_url,
    tags: Array.isArray(o.tags) ? o.tags : [],
    likes_count: o.likes_count || 0,
    installs_count: o.installs_count || 0,
    updated_at: o.updated_at,
    stats: o.stats || {},
    requiredAddons: addons.map(a => ({ addonId: a && a.addonId, addonName: a && a.addonName })),
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

// A slug is a path segment, and it is the only caller-supplied value that ever
// reaches a URL path. Anything outside this set is rejected rather than
// escaped, so there is no way to steer the request at another endpoint.
function cleanSlug(v) {
  const s = String(v == null ? '' : v);
  return /^[A-Za-z0-9._-]{1,120}$/.test(s) ? s : null;
}

// A bearer token, shape-checked only. The Worker never inspects, stores or
// logs it — it exists in memory for the length of one forwarded request.
function cleanToken(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9._-]{20,4096}$/.test(s) ? s : null;
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST a JSON body to this Worker.' }, 405);

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ error: 'Body was not JSON.' }, 400); }

    const token = cleanToken(body && body.token);
    if (!token) return json({ error: 'Missing or malformed Nuvio session token.' }, 400);

    const op = String((body && body.op) || '');
    let url, projectList = false;
    if (op === 'list') {
      const sort = SORTS.has(String(body.sort)) ? String(body.sort) : 'installs';
      const page = clampInt(body.page, 1, 50, 1);
      const limit = clampInt(body.limit, 1, MAX_LIMIT, MAX_LIMIT);
      url = API + '?sort=' + sort + '&page=' + page + '&limit=' + limit;
      projectList = true;
    } else if (op === 'detail') {
      const slug = cleanSlug(body && body.slug);
      if (!slug) return json({ error: 'Missing or malformed collection id.' }, 400);
      url = API + '/' + slug;
    } else {
      return json({ error: 'Unknown op — expected "list" or "detail".' }, 400);
    }

    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          // Nuvio's site API answers differently to an unrecognised client.
          'User-Agent': 'Numax-Collections-Relay/1',
        },
        // Everything here is per-user and auth-scoped; caching it would be a
        // cross-user data leak, not a speed-up.
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (e) {
      return json({ error: 'Could not reach nuvio.tv.' }, 502);
    }

    const text = await upstream.text();
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ error: 'Nuvio rejected that session — re-link the account in Numax.' }, upstream.status);
    }
    if (!upstream.ok) {
      return json({ error: 'Nuvio answered ' + upstream.status + '.' }, upstream.status);
    }
    // `detail` goes through untouched: it is what the install writes from, and
    // a shape change upstream must surface in Numax rather than be quietly
    // reinterpreted here. Only `list` is projected, and only to the browse
    // fields — see the note at the top for why that is not optional.
    if (!projectList) {
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
      });
    }
    let doc;
    try { doc = JSON.parse(text); }
    catch (e) { return json({ error: 'Nuvio sent something that is not JSON.' }, 502); }
    const rows = (doc && (doc.items || doc.collections || doc.data)) || [];
    if (!Array.isArray(rows)) return json({ error: 'Nuvio sent a list in an unexpected shape.' }, 502);
    return json({ items: rows.map(projectRow), pagination: (doc && doc.pagination) || null });
  },
};
