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

  const COLLECTIONS = {
    // No longer "blocked" — install works from a manually-refreshed capture,
    // not a relay. Kept as an honest caveat string, not a hard gate.
    why: 'Browsing and installing use a manually-refreshed snapshot, not a live read of Nuvio’s community-collections API (it sends no CORS headers, so Numax’s own tab can never reach it directly). New or edited community collections won’t show up until the snapshot is refreshed.',
    site: 'https://nuvio.tv/community-collections',
    detailUrl: id => 'https://nuvio.tv/community-collections/' + encodeURIComponent(id),
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
      out.push({
        name,
        lang: (langCol && cellText(p[langCol])) || 'Unknown',
        manifestUrl: normalizeManifestUrl(url),
        rawUrl: url,
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
  };
})();
