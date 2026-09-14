// ============================================================
// Numax marketplace data layer (market.js)
//
// Read-only. Fetches the community plugin index, provider manifests,
// AIOStreams/AIOMetadata instance lists, and addon manifests. It owns NO
// application state and performs NO writes — every write still goes through
// engine.js planTarget + api.js applyPlan, exactly like Sync Desk, templates
// and restore. Delete this file and the rest of the app still works; only the
// Marketplace tab goes blank.
//
// Why there is no backend: every endpoint below was verified CORS-readable
// from a neutral third-party origin on 2026-09-02, so the browser can reach
// them directly. The one exception is Nuvio's community-collections API,
// which is NOT CORS-open (re-verified the same day, from a non-nuvio.tv
// origin: request fails before auth) — Numax's own tab can never call it.
//
// Collections install works anyway, without a relay, because of how Nuvio's
// own install already behaves: it's a one-time copy into the profile's
// collections_json, never live-synced again after (confirmed live — see
// MARKETPLACE-PLAN 0.4). That means a snapshot captured once from inside a
// real logged-in nuvio.tv session (same origin-trick verify-settings-sync.js
// uses) is exactly as good as a live read for install purposes — it's not
// "stale data standing in for live data", it's the same one-time copy Nuvio
// itself would have made, just captured up front instead of at click-time.
// Two files per collection ship from that capture: the light entry in
// community-collections-snapshot.json (repo root) for browsing, and the
// full folders/sources/required-addons payload in
// community-collections/<public_id>.json for the actual install write,
// which goes through the normal engine.planTarget + api.applyPlan path
// like everything else. Both need re-capturing by hand to pick up new or
// edited community collections — there's no live refresh.
// ============================================================
(function () {
  'use strict';

  // ---- endpoints (all live-verified CORS-open 2026-09-02) ----
  // The community plugin index is a public Notion table exposed through the
  // library site's own API route. 2 columns: Repo (name + link) and Language.
  const PLUGIN_INDEX = 'https://nuvio-plugin-library.vercel.app/api/notion/326981dcb87e80f6b9f6f23469a00fd3';
  const PLUGIN_INDEX_SITE = 'https://nuvio-plugin-library.vercel.app/';
  // IbbyLabs uptime tracker. Public JSON, no auth. Gives every hosted instance
  // of AIOStreams / AIOMetadata with its real configure URL and 30-day uptime.
  const UPTIME_API = 'https://uptime.ibbylabs.dev/v1/status';

  // ---- the optional live relay -----------------------------------------
  // Nuvio's community-collections API lives on nuvio.tv (not api.nuvio.tv),
  // needs a real Nuvio login, and sends NO CORS headers — re-verified from a
  // neutral origin. A browser tab therefore can never read it directly, which
  // is why the snapshot below exists at all.
  //
  // Deploying relay/collections.js (one Cloudflare Worker, ~2 minutes — see
  // relay/README.md) and pasting its URL here switches the Collections tab to
  // live data: the Worker forwards exactly two GETs, carrying the caller's own
  // Nuvio session token, and adds the CORS header the browser needs. Leave it
  // empty and everything below still works from the captured snapshot — the
  // tab says which of the two it is showing, either way.
  //
  // Deployed and live-verified 2026-09-13 against the real API: 104
  // collections, five more than the September snapshot holds.
  const COLLECTIONS_RELAY = 'https://crimson-field-2118.nuviobaymax.workers.dev/';

  // ---- the plugin-provider filter (relay/plugins.js) --------------------
  // Nuvio stores ONE row per plugin repository — {url, name, enabled, ...} —
  // and nothing in it can say "only these providers". The per-provider
  // switches live on the device and never reach the account, so a tick in
  // Numax has nothing to travel in. That is measured, not assumed: it is the
  // shape of a real sync_export_account_backup row.
  //
  // The only thing that CAN carry a selection is the manifest itself, because
  // the manifest is the one thing the repository row points at. So a filtered
  // repository is a manifest URL that serves the same manifest with the
  // unwanted `scrapers` removed — which is what relay/plugins.js does.
  //
  // A provider's `filename` is RELATIVE ("providers/4khdhub.js", checked live
  // against every indexed repo), so whoever serves the manifest also has to
  // serve the provider code next to it. That is the real cost of this feature
  // and the reason it is opt-in per install rather than always on: the plain
  // upstream URL is still what gets written whenever every provider is picked,
  // so the relay is only ever in the path for someone who asked for a subset.
  //
  // Empty means "not deployed" and the whole picker hides itself — a tick that
  // cannot be honoured is worse than no tick. Paste the Worker's URL here to
  // switch it on everywhere at once.
  //
  // Deployed and live-verified 2026-09-14 against the real Worker: a filtered
  // manifest returns exactly the picked providers, the provider's relative
  // filename resolves back through it and serves the real code, a
  // non-allowlisted host is refused 400, and a selection that no longer
  // matches anything upstream answers 409 rather than an empty repository.
  const PLUGIN_FILTER_RELAY = 'https://addon-review.nuviobaymax.workers.dev/';

  // base64url, because the payload rides in a PATH segment: it has to survive
  // Nuvio storing it, and `+` and `/` do not.
  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // The selection is self-contained: the Worker keeps no state, so it can be
  // redeployed or moved without breaking a repository somebody already has on
  // a profile. `/manifest.json` is the last segment on purpose — Nuvio resolves
  // a provider's relative filename against it and lands back on the Worker.
  function filteredManifestUrl(manifestUrl, ids) {
    if (!PLUGIN_FILTER_RELAY) return null;
    const u = normalizeManifestUrl(manifestUrl);
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return null;
    const payload = b64url(JSON.stringify({ u, s: list }));
    return PLUGIN_FILTER_RELAY.replace(/\/+$/, '') + '/f/' + payload + '/manifest.json';
  }
  // Reading one back, so an already-filtered repository can be recognised and
  // re-edited rather than treated as somebody else's URL.
  function readFilteredUrl(url) {
    const s = String(url || '');
    if (!PLUGIN_FILTER_RELAY || s.indexOf(PLUGIN_FILTER_RELAY.replace(/\/+$/, '') + '/f/') !== 0) return null;
    const seg = s.split('/f/')[1];
    const payload = seg ? seg.split('/')[0] : '';
    if (!payload) return null;
    try {
      const bin = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const j = JSON.parse(new TextDecoder().decode(bytes));
      return (j && j.u && Array.isArray(j.s)) ? { url: j.u, ids: j.s } : null;
    } catch (e) { return null; }
  }
  const pluginFilterReady = () => !!PLUGIN_FILTER_RELAY;

  const COLLECTIONS = {
    // Not "blocked": install works from a manually-refreshed capture even with
    // no relay. Kept as an honest caveat string, not a hard gate.
    why: 'Browsing and installing use a manually-refreshed snapshot, not a live read of Nuvio’s community-collections API (it sends no CORS headers, so Numax’s own tab can never reach it directly). New or edited community collections won’t show up until the snapshot is refreshed — or until the collections relay is deployed, which makes this tab live.',
    site: 'https://nuvio.tv/community-collections',
    detailUrl: id => 'https://nuvio.tv/community-collections/' + encodeURIComponent(id),
    relayReady: () => !!COLLECTIONS_RELAY,
  };
  // Lightweight browse-only capture — title/description/image/tags/stats and
  // required-addon list, with the heavy folders/sources payload stripped out.
  // Refreshed by hand (see repo root's community-collections-snapshot.json),
  // not live — a capturedAt timestamp ships with it so the UI can say how old
  // it is instead of pretending it's current.
  const COLLECTIONS_SNAPSHOT_URL = 'community-collections-snapshot.json';

  // ======================================================================
  // fetch helpers
  // ======================================================================
  async function fetchJson(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timed out');
      // A cross-origin refusal surfaces as an opaque TypeError with no detail.
      if (e instanceof TypeError) throw new Error('unreachable (blocked or offline)');
      throw e;
    } finally { clearTimeout(t); }
  }

  // Two fixups, both for real defects in the published index:
  //  - Codeberg's plain /raw/branch/<b>/<path> URL sends no CORS headers; its
  //    API path serves the identical file and does. Rewrite rather than relay.
  //  - A few rows link the repo directory and omit the filename. Verified: at
  //    least one of those (Michat88) has a perfectly valid manifest.json that
  //    the index renders as empty. Append the filename rather than call a live
  //    repo dead. Rows that 404 either way stay dead, correctly.
  function normalizeManifestUrl(u) {
    let s = String(u || '');
    const m = /^https:\/\/codeberg\.org\/([^/]+)\/([^/]+)\/raw\/branch\/[^/]+\/(.+)$/.exec(s);
    if (m) s = 'https://codeberg.org/api/v1/repos/' + m[1] + '/' + m[2] + '/raw/' + m[3];
    if (/\/$/.test(s)) s += 'manifest.json';
    return s;
  }

  // Nuvio's own Configure button does exactly this swap — verified live against
  // a real account: the stored manifest URL with /manifest.json -> /configure,
  // opened in a new tab. Any config blob encoded in the path carries over, so
  // the page opens pre-filled.
  function configureUrl(u) { return String(u || '').replace(/\/manifest\.json(\?[^#]*)?(#.*)?$/i, '/configure'); }

  // ======================================================================
  // who publishes a plugin repo, and its mark
  // ======================================================================
  // A plugin repo's manifest publishes NO logo of its own — checked live on
  // 2026-09-13 against the community index: the top-level keys are exactly
  // { name, version, scrapers } and nothing else. The individual scrapers
  // inside DO each carry a `logo`, and those are drawn wherever a scraper is
  // listed, but a repo row needed a mark of its own.
  //
  // The one real per-repo mark that exists is the account that publishes it.
  // Both forges serve it at a stable address, no API call and no token:
  //   github.com/<login>.png       codeberg.org/<login>.png
  // Checked 2026-09-13 against all 19 indexed repos: 18 answered 200 with a
  // real image; one (AlvitoSR) 404s because that account is gone — which is
  // exactly what the monogram underneath is for.
  //
  // The Codeberg API form has to be tested FIRST: a rewritten Codeberg URL
  // starts /api/v1/repos/<owner>/, so the plain pattern would read the owner
  // as "api".
  function pluginOwner(u) {
    const str = String(u || '');
    let m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/.exec(str)
         || /^https:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(str);
    if (m) return { forge: 'GitHub', login: m[1], repo: m[2], logo: 'https://github.com/' + encodeURIComponent(m[1]) + '.png?size=128' };
    m = /^https:\/\/codeberg\.org\/api\/v1\/repos\/([^/]+)\/([^/]+)/.exec(str)
     || /^https:\/\/codeberg\.org\/([^/]+)\/([^/]+)/.exec(str);
    if (m) return { forge: 'Codeberg', login: m[1], repo: m[2], logo: 'https://codeberg.org/' + encodeURIComponent(m[1]) + '.png' };
    return null;
  }

  // ======================================================================
  // plugin index (Notion table)
  // ======================================================================
  // A cell is [[text, [['a', href], ...]], ...]. Pull the plain text and the
  // first link out of it without assuming Notion's internal column ids.
  function cellText(cell) {
    if (!Array.isArray(cell)) return '';
    return cell.map(seg => (Array.isArray(seg) ? String(seg[0] == null ? '' : seg[0]) : '')).join('').trim();
  }
  function cellLink(cell) {
    if (!Array.isArray(cell)) return null;
    for (const seg of cell) {
      const marks = Array.isArray(seg) && seg[1];
      if (!Array.isArray(marks)) continue;
      for (const mk of marks) if (Array.isArray(mk) && mk[0] === 'a' && mk[1]) return String(mk[1]);
    }
    return null;
  }

  let _indexCache = null;
  async function loadPluginIndex(force) {
    if (_indexCache && !force) return _indexCache;
    const doc = await fetchJson(PLUGIN_INDEX);

    const blocks = [];
    for (const k of Object.keys(doc)) {
      const v = doc[k] && doc[k].value && doc[k].value.value;
      if (v && v.type) blocks.push(v);
    }
    const table = blocks.find(b => b.type === 'table');
    const rows = blocks.filter(b => b.type === 'table_row');
    if (!rows.length) throw new Error('index returned no rows');

    // Keep the table's own row order when it publishes one; otherwise take the
    // records as they came. Row 0 is the header ("Repo" / "Language").
    let ordered = rows;
    if (table && Array.isArray(table.content)) {
      const byId = new Map(rows.map(r => [r.id, r]));
      const seq = table.content.map(id => byId.get(id)).filter(Boolean);
      if (seq.length) ordered = seq;
    }

    // Map column id -> header label, so the parser survives Notion renaming or
    // reordering its internal ids.
    const header = ordered[0] || {};
    const headMap = {};
    for (const cid of Object.keys(header.properties || {})) headMap[cid] = cellText(header.properties[cid]).toLowerCase();
    const colFor = want => Object.keys(headMap).find(cid => headMap[cid] === want) || null;
    let repoCol = colFor('repo'), langCol = colFor('language');

    // Fallback: whichever column actually carries links is the repo column.
    if (!repoCol) {
      const body = ordered.slice(1);
      const cids = new Set();
      body.forEach(r => Object.keys(r.properties || {}).forEach(c => cids.add(c)));
      repoCol = [...cids].find(c => body.some(r => cellLink((r.properties || {})[c])));
      if (!langCol) langCol = [...cids].find(c => c !== repoCol) || null;
    }
    if (!repoCol) throw new Error('index format changed — no repo column found');

    const out = [];
    for (const r of ordered.slice(1)) {
      const p = r.properties || {};
      const url = cellLink(p[repoCol]);
      const name = cellText(p[repoCol]);
      if (!url || !name) continue;
      const own = pluginOwner(url);
      out.push({
        name,
        lang: (langCol && cellText(p[langCol])) || 'Unknown',
        manifestUrl: normalizeManifestUrl(url),
        rawUrl: url,
        owner: own,
        // Drawn through app.js's shared logo helper, which puts a monogram
        // underneath and drops the <img> if it fails — a gone account shows a
        // letter, never a broken-image icon.
        logo: own ? own.logo : '',
      });
    }
    if (!out.length) throw new Error('index returned no providers');
    _indexCache = out;
    return out;
  }

  // ======================================================================
  // provider manifests
  // ======================================================================
  // Shape (identical across every provider checked): { name, version,
  // scrapers: [{ id, name, description, version, author, supportedTypes,
  // enabled, hasSettings, limited, formats, logo, contentLanguage }] }
  const _manifestCache = new Map();
  async function loadManifest(url, force) {
    const u = normalizeManifestUrl(url);
    if (!force && _manifestCache.has(u)) {
      const hit = _manifestCache.get(u);
      if (hit.error) throw new Error(hit.error);
      return hit.value;
    }
    try {
      const j = await fetchJson(u);
      const value = {
        name: (j && j.name) || 'Untitled repo',
        version: (j && j.version) || '',
        scrapers: Array.isArray(j && j.scrapers) ? j.scrapers : [],
      };
      _manifestCache.set(u, { value });
      return value;
    } catch (e) {
      // A dead entry is a fact worth showing, not a crash. The community index
      // currently lists several 404s as if they were healthy.
      _manifestCache.set(u, { error: e.message });
      throw e;
    }
  }

  // ======================================================================
  // community collections snapshot (manually refreshed, not live)
  // ======================================================================
  let _collectionsSnapshot = null;
  async function loadCollectionsSnapshot(force) {
    if (_collectionsSnapshot && !force) return _collectionsSnapshot;
    const doc = await fetchJson(COLLECTIONS_SNAPSHOT_URL);
    if (!doc || !Array.isArray(doc.items)) throw new Error('snapshot file is missing or malformed');
    _collectionsSnapshot = doc;
    return doc;
  }

  // ---- live read through the relay (only when one is configured) --------
  // The Worker is a forwarder, not a store: it keeps nothing, and the token it
  // is handed is the caller's own Nuvio session access token — the same one
  // this browser already sends to api.nuvio.tv on every other call. Every
  // failure throws, so the caller can fall back to the snapshot and SAY it fell
  // back, rather than showing stale data as though it were live.
  async function relayCall(body, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(COLLECTIONS_RELAY, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (!r.ok) throw new Error((j && (j.error || j.message)) || ('relay HTTP ' + r.status));
      if (!j) throw new Error('relay sent something that is not JSON');
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timed out');
      if (e instanceof TypeError) throw new Error('relay unreachable');
      throw e;
    } finally { clearTimeout(t); }
  }
  let _liveSnapshot = null;
  // Returns the SAME shape loadCollectionsSnapshot does — {live, capturedAt,
  // total, items:[...]} — so nothing downstream needs to know which it got.
  async function loadCollectionsLive(token, force) {
    if (!COLLECTIONS_RELAY) throw new Error('no relay configured');
    if (!token) throw new Error('no Nuvio account linked');
    if (_liveSnapshot && !force) return _liveSnapshot;
    const items = [];
    const seen = new Set();
    // Paged, because the API caps a page at 60 however much is asked for
    // (live-checked: limit=100 comes back as 60). The page cap here is a
    // runaway guard, not an expected stopping point — the loop ends on
    // hasNextPage, and a partial read must never pass as the whole catalogue.
    let total = null;
    for (let page = 1; page <= 20; page++) {
      const j = await relayCall({ op: 'list', token, page, limit: 60, sort: 'installs' });
      const rows = (j && (j.items || j.collections || j.data)) || [];
      if (!Array.isArray(rows) || !rows.length) break;
      rows.forEach(r => {
        const v = normalizeLiveItem(r);
        // The API pages by offset, so an edit between two page reads can shift
        // a row across the boundary and hand it back twice.
        if (v.public_id != null && seen.has(v.public_id)) return;
        if (v.public_id != null) seen.add(v.public_id);
        items.push(v);
      });
      const pg = j && j.pagination;
      if (pg && pg.total != null) total = pg.total;
      if (!pg || !pg.hasNextPage) break;
    }
    if (!items.length) throw new Error('relay returned no collections');
    // If the API told us how many there are and we have fewer, say so rather
    // than quietly presenting a short read as the full list.
    const short = (total != null && items.length < total) ? total : null;
    _liveSnapshot = { live: true, capturedAt: new Date().toISOString(), total: items.length, short, items };
    return _liveSnapshot;
  }
  // The list endpoint and the captured snapshot name a few fields differently.
  // Normalizing here means renderMkCollCard never has to branch on the source.
  // Live-checked 2026-09-13: the API's own browse fields are named exactly as
  // the captured snapshot's are (public_id / title / description / image_url /
  // tags / likes_count / installs_count / stats{folderCount,sourceCount,
  // addonCount}), so a live row and a snapshot row render through the same
  // card with no branching. The ONE difference is the required-addon list: the
  // snapshot lifts it to the top level, while the API buries it inside each
  // row's install envelope at envelope.requirements.addons. The relay already
  // lifts it when it projects the list; both spellings are read here anyway, so
  // a raw (unprojected) response still renders correctly.
  function normalizeLiveItem(r) {
    const o = r || {};
    const stats = o.stats || {};
    const env = o.envelope || {};
    const fromEnvelope = (env.requirements && Array.isArray(env.requirements.addons)) ? env.requirements.addons : null;
    return {
      public_id: o.public_id != null ? o.public_id : (o.publicId != null ? o.publicId : o.slug),
      title: o.title || o.name || 'Untitled',
      description: o.description || '',
      image_url: o.image_url || o.imageUrl || (env.community && env.community.coverImageUrl) || null,
      tags: Array.isArray(o.tags) ? o.tags : [],
      likes_count: o.likes_count != null ? o.likes_count : (o.likesCount || 0),
      installs_count: o.installs_count != null ? o.installs_count : (o.installsCount || 0),
      requiredAddons: Array.isArray(o.requiredAddons) && o.requiredAddons.length ? o.requiredAddons
        : (fromEnvelope || (o.requirements && Array.isArray(o.requirements.addons) ? o.requirements.addons : [])),
      stats: {
        folderCount: stats.folderCount != null ? stats.folderCount : o.folder_count,
        sourceCount: stats.sourceCount != null ? stats.sourceCount : o.source_count,
        addonCount: stats.addonCount != null ? stats.addonCount : o.addon_count,
      },
    };
  }
  // One collection's full install payload, live. Same normalized return as
  // loadCollectionInstall, so the install dialog is source-blind.
  // Live-checked: detail answers with the row at the top level and the install
  // payload under `envelope` — `envelope.collection` plus
  // `envelope.requirements.addons`, the same shape the captured files hold, so
  // the install transformation and write path below are identical either way.
  async function loadCollectionInstallLive(publicId, token) {
    const j = await relayCall({ op: 'detail', token, slug: String(publicId) }, 20000);
    const envelope = (j && (j.envelope || (j.data && j.data.envelope) || j.data || j)) || null;
    let collections = null;
    if (envelope && Array.isArray(envelope.collections)) collections = envelope.collections;
    else if (envelope && envelope.collection) collections = [envelope.collection];
    if (!collections || !collections.length) throw new Error('relay sent no collection payload');
    return {
      collections,
      requiredAddons: (envelope.requirements && envelope.requirements.addons) || [],
      resources: Array.isArray(envelope.resources) ? envelope.resources : [],
    };
  }

  // ======================================================================
  // what the user actually pastes
  // ======================================================================
  // Nuvio stores an add-on as its manifest URL. What an add-on's own site
  // hands you is almost never that — it is the /configure page, a stremio://
  // deep link, or just the site root. Writing any of those produces a row
  // Nuvio accepts and then cannot load: the exact "it said it added but
  // nothing happened" report.
  //
  // resolveManifestUrl turns whatever was pasted into the candidates worth
  // trying, in order; probeManifest asks the network which one is real.
  function resolveManifestUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return [];
    s = s.replace(/^stremio:\/\//i, 'https://');          // same URL, different scheme
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    let u;
    try { u = new URL(s); } catch (e) { return []; }
    let path = u.pathname.replace(/\/+$/, '');
    const out = [];
    const push = p => {
      const c = new URL(u.toString());
      c.pathname = p || '/'; c.search = ''; c.hash = '';
      const str = c.toString();
      if (out.indexOf(str) < 0) out.push(str);
    };
    if (/\/manifest\.json$/i.test(path)) { push(path); return out; }
    if (/\/configure$/i.test(path)) path = path.replace(/\/configure$/i, '');
    push(path + '/manifest.json');
    // Some hosts put the configure page one level below the add-on root
    // (e.g. /u/<id>/configure). Try the parent rather than give up.
    const parent = path.replace(/\/[^/]*$/, '');
    if (parent && parent !== path) push(parent + '/manifest.json');
    push('/manifest.json');
    return out;
  }
  // Resolves to {ok:true, url, manifest} for the first candidate that answers
  // with something manifest-shaped; {ok:false, reason:'notfound'} when every
  // candidate answered but none was a manifest; {ok:false, reason:'blocked'}
  // when this browser could not see the answer at all. 'blocked' must NOT stop
  // the user: Nuvio's own Add Plugin dialog never validates either, and plenty
  // of add-ons refuse cross-origin reads while working perfectly in the app.
  async function probeManifest(raw) {
    const cands = resolveManifestUrl(raw);
    if (!cands.length) return { ok: false, reason: 'invalid' };
    let blocked = false;
    for (const u of cands) {
      try {
        const j = await fetchJson(u, 8000);
        // Every Stremio-protocol manifest carries an id plus at least one of
        // resources/types/name; anything else is just JSON that sits there.
        if (j && typeof j === 'object' && j.id && (j.resources || j.types || j.name)) {
          return { ok: true, url: u, manifest: j };
        }
      } catch (e) {
        if (/unreachable|timed out/.test(e.message)) blocked = true;
      }
    }
    return { ok: false, reason: blocked ? 'blocked' : 'notfound', tried: cands };
  }

  // Full per-collection install payload (folders/sources + required addons),
  // captured the same session as the snapshot but shipped as one small file
  // per collection instead of bundled into it — installing a 20-folder
  // collection shouldn't force downloading someone else's 600-folder one.
  // Same "no live sync after install" contract as Nuvio's own site (0.4):
  // this is a copy of what the creator had at capture time, not a live read.
  const COLLECTIONS_DIR = 'community-collections/';
  function collectionFileName(publicId) { return COLLECTIONS_DIR + String(publicId).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'; }
  // Two envelope shapes seen live: a plain collection (`envelope.collection`,
  // one object) and a "collection_pack" (`envelope.collections`, an array —
  // e.g. Nuvio Perfect Collections ships 8 at once). Normalize both to an
  // array so callers never need to care which one they got. Packs can also
  // carry `resources` — extra downloadable config files (e.g. an AIOMetadata
  // JSON) that aren't part of a Nuvio profile write at all; surfaced as a
  // count/name list so nothing is silently dropped, not auto-installed.
  const _collectionInstallCache = new Map();
  async function loadCollectionInstall(publicId, force) {
    if (!force && _collectionInstallCache.has(publicId)) return _collectionInstallCache.get(publicId);
    const doc = await fetchJson(collectionFileName(publicId));
    const envelope = doc && doc.envelope;
    let collections = null;
    if (envelope && Array.isArray(envelope.collections)) collections = envelope.collections;
    else if (envelope && envelope.collection) collections = [envelope.collection];
    if (!envelope || !collections || !collections.length) throw new Error('install file is missing or malformed');
    const value = {
      collections,
      requiredAddons: (envelope.requirements && envelope.requirements.addons) || [],
      resources: Array.isArray(envelope.resources) ? envelope.resources : [],
    };
    _collectionInstallCache.set(publicId, value);
    return value;
  }

  // ----------------------------------------------------------------------
  // Nuvio's own install transformation
  // ----------------------------------------------------------------------
  // Installing a community collection is NOT a straight copy of the payload.
  // Nuvio rewrites two things, and nothing else — verified 2026-09-02 by
  // diffing a collection Nuvio itself installed against that same
  // collection's raw community payload: after applying exactly this, the
  // reconstruction was byte-identical to Nuvio's own output, `community`
  // block included.
  //
  //   id  -> slugified + '-community'   (collections.genres ->
  //                                      collections-genres-community)
  //   community -> { id, version, installMode, installedAt,
  //                  packCollectionId, originalCollectionId }
  //
  // This matters because 93 of the 99 files in community-collections/ are the
  // RAW pre-install form (no `community` block, no `-community` suffix) while
  // 6 happen to be the post-install form — they were captured off a profile
  // that already had them. Writing the raw form produces a collection Nuvio
  // does not recognise as an installed community collection, which is exactly
  // the "said it applied but didn't" report. Always transform; the function is
  // idempotent so the 6 already-transformed ones pass through unchanged.
  // Suffix decided on the id ALONE. Keying it off the presence of a community
  // block instead lets a collection that carries the suffix but no block get
  // suffixed a second time — a real `-community-community` id was found on a
  // live profile, so this case is not hypothetical.
  function installedCollectionId(id) {
    const slug = String(id == null ? '' : id).replace(/[^A-Za-z0-9-]/g, '-');
    return /-community$/.test(slug) ? slug : slug + '-community';
  }
  function isInstalledForm(c) {
    return !!(c && c.community && /-community$/.test(String(c.id || '')));
  }
  // The id a community collection is published under, recovered from an id
  // that may already carry the suffix, so the community block still records
  // what it was originally called.
  function originalCollectionId(c) {
    if (c && c.community && c.community.originalCollectionId != null) return c.community.originalCollectionId;
    return String((c && c.id) || '').replace(/-community$/, '');
  }
  // packCollectionId equals originalCollectionId in every case observed live,
  // including the one pack-sourced example, so it is not derived separately.
  function toInstalledCollection(collection, opts) {
    const o = opts || {};
    if (isInstalledForm(collection)) {
      // Already Nuvio-shaped. Only refresh the install stamp, never re-slug an
      // id that has already been transformed (that would append twice).
      return { ...collection, community: { ...collection.community, installedAt: o.installedAt || Date.now() } };
    }
    const originalId = originalCollectionId(collection);
    return {
      ...collection,
      id: installedCollectionId(collection && collection.id),
      community: {
        id: o.publicId != null ? o.publicId : (collection && collection.community && collection.community.id) || null,
        version: o.version != null ? o.version : 1,
        installMode: o.installMode || 'copy',
        installedAt: o.installedAt || Date.now(),
        packCollectionId: originalId,
        originalCollectionId: originalId,
      },
    };
  }

  // ======================================================================
  // AIOStreams / AIOMetadata instances
  // ======================================================================
  let _uptimeCache = null;
  async function loadStatus(force) {
    if (_uptimeCache && !force) return _uptimeCache;
    const j = await fetchJson(UPTIME_API);
    _uptimeCache = (j && Array.isArray(j.services)) ? j.services : [];
    return _uptimeCache;
  }
  // group is the tracker's own grouping, e.g. 'AIOStreams' or 'AIOMetadata'.
  async function loadInstances(group, force) {
    const svc = await loadStatus(force);
    return svc
      .filter(s => s && s.group === group && s.url)
      .map(s => ({
        // "AIOStreams (ElfHosted Stable)" reads better as just the host label.
        name: String(s.name || '').replace(/^[^(]*\(([^)]*)\).*$/, '$1').trim() || String(s.name || ''),
        fullName: s.name || '',
        url: s.url,
        uptime: typeof s.uptimePercent === 'number' ? s.uptimePercent : null,
        up: !!(s.last && s.last.up),
      }))
      .sort((a, b) => (b.uptime == null ? -1 : b.uptime) - (a.uptime == null ? -1 : a.uptime));
  }

  // ======================================================================
  // is an installed addon configurable?
  // ======================================================================
  // Nuvio shows Configure only where the addon's manifest declares
  // behaviorHints.configurable === true. Verified live against a real account:
  // Cinemeta and OpenSubtitles v3 (no flag) get no button; TvVoo (flag true)
  // does. Manifests we cannot read cross-origin resolve to false, so Numax
  // never offers a button it cannot honour.
  const _cfgCache = new Map();
  function isConfigurable(url) {
    const u = String(url || '');
    if (!/\/manifest\.json(\?[^#]*)?(#.*)?$/i.test(u)) return Promise.resolve(false);
    if (_cfgCache.has(u)) return _cfgCache.get(u);
    const p = fetchJson(u, 9000)
      .then(j => !!(j && j.behaviorHints && j.behaviorHints.configurable === true))
      .catch(() => false);
    _cfgCache.set(u, p);
    return p;
  }

  // ======================================================================
  // curated addon list
  // ======================================================================
  // Hand-maintained, and deliberately so: this is the r/nuvioaddons community
  // list, whose ordering is itself the signal. Reliability lives in the group
  // heading, not in a per-item warning badge (MARKETPLACE-PLAN 0.5).
  //
  // `instances` marks the two addons that are run by many different hosts —
  // clicking them opens an instance picker sourced live from the uptime
  // tracker instead of going straight to one site.
  const STAPLES = [
    { name: 'AIOStreams', blurb: 'One hub for every other source', instances: 'AIOStreams' },
    { name: 'AIOMetadata', blurb: 'TMDB, TVDB, MAL, AniList, IMDb', instances: 'AIOMetadata' },
    { name: 'PenguPlay', blurb: 'No debrid needed', url: 'https://pengu.uk/configure' },
    { name: 'Xperience', blurb: '364+ curated collection rows', url: 'https://xperience-app.com/' },
    { name: 'Bingecat', blurb: 'AI search & catalog manager', url: 'https://bingecat.com/stremio/configure' },
  ];

  // Group order is the display order. `note` is context, never a warning.
  const ADDON_GROUPS = [
    {
      title: 'P2P · consistently good', tone: 'good',
      note: 'torrent / magnet only',
      items: [
        { name: 'Torrentio', url: 'https://torrentio.strem.fun/configure' },
        { name: 'StremThru Torz', url: 'https://stremthru.13377001.xyz/stremio/torz/configure' },
        { name: 'Peerflix', url: 'https://config.peerflix.mov/' },
        { name: 'TorrentsDB', url: 'https://torrentsdb.com/' },
      ],
    },
    {
      title: 'Multi-source · consistently good', tone: 'good',
      note: 'torrent plus usenet / debrid — not P2P-only',
      items: [
        { name: 'Comet', url: 'https://comet.elfhosted.com/stremio/configure' },
        { name: 'MediaFusion', url: 'https://mediafusion.elfhosted.com/app' },
        { name: 'Meteor', url: 'https://meteorfortheweebs.midnightignite.me/configure' },
        { name: 'Jackettio', url: 'https://jackettio.elfhosted.com/configure' },
      ],
    },
    {
      title: 'HTTP · consistently good', tone: 'good',
      note: 'no debrid needed',
      items: [
        { name: 'PenguPlay', url: 'https://pengu.uk/configure' },
        { name: 'Sootio', url: 'https://sooti.click/configure' },
        { name: 'WebStreamr MBG', url: 'https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club/configure' },
        { name: 'HDHub', url: 'https://hdhub.thevolecitor.qzz.io/' },
        { name: 'Flix-Streams', url: 'https://flixnest.app/flix-streams/u/o8jsvzaougx/configure' },
      ],
    },
    {
      title: 'Okay & promising', tone: 'mid',
      note: 'newer, less consistent',
      items: [
        { name: 'Filmora', url: 'https://stremio-addons.net/addons/filmora' },
        { name: 'TorrentClaw', url: 'https://torrentclaw.com/api/stremio/configure' },
        { name: 'Watcho', url: 'https://stremio-addons.net/addons/watcho' },
        { name: 'AutoStream', url: 'https://autostreamtest.onrender.com/configure' },
      ],
    },
    {
      title: 'Anime', tone: 'plain',
      note: 'worth having more than one',
      items: [
        { name: 'Nexio Torii', url: 'https://torii.nexioapp.org/configure' },
        { name: 'Dramayo', url: 'https://dramayo.stream/configure' },
        { name: 'YukiStreams', url: 'https://stremio.yukistreams.xyz/configure' },
      ],
    },
    {
      title: 'Asian content', tone: 'plain',
      note: 'usually HD or lower',
      items: [
        { name: 'YaStream', url: 'https://yastream.tamthai.de/configure' },
        { name: 'Stravo II', url: 'https://v2.stravo.site/local/configure' },
      ],
    },
    {
      title: 'Subtitles', tone: 'plain',
      note: '',
      items: [
        { name: 'OpenSubtitles v3', url: 'https://opensubtitles-v3.strem.io/' },
        { name: 'OpenSubtitles v3 PRO', url: 'https://opensubtitlesv3-pro.dexter21767.com/configure/' },
        { name: 'SubSource', url: 'https://subsource.strem.top/configure' },
        { name: 'SubMaker', url: 'https://submaker.elfhosted.com/configure' },
        { name: 'Community Subtitles', url: 'https://stremio-community-subtitles.top/configure' },
      ],
    },
  ];

  window.NumaxMarket = {
    STAPLES, ADDON_GROUPS, COLLECTIONS,
    PLUGIN_INDEX_SITE, UPTIME_SITE: 'https://uptime.ibbylabs.dev/',
    loadPluginIndex, loadManifest, loadInstances, isConfigurable,
    configureUrl, normalizeManifestUrl, loadCollectionsSnapshot, loadCollectionInstall,
    loadCollectionsLive, loadCollectionInstallLive,
    toInstalledCollection, installedCollectionId, isInstalledForm,
    resolveManifestUrl, probeManifest, pluginOwner,
    filteredManifestUrl, readFilteredUrl, pluginFilterReady,
  };
})();
