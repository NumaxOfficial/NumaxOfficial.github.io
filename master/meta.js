// ============================================================
// Numax metadata resolution  (meta.js)
//
// Nuvio's watch_progress / watched_items rows are keyed by raw IMDb ids
// (e.g. "tt0460637") and don't always carry a title. This resolves those
// ids to real names via Cinemeta (Stremio's public metadata addon — no
// key, CORS-friendly). Ported from the extension's metadata.js.
//
// Cache is in-memory only per page session. Titles for a given id never
// change, so within one session we never re-fetch the same id twice.
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NumaxMeta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';
  const IMDB_ID_RE = /^tt\d+$/i;
  const MAX_CONCURRENT = 5;

  const cache = new Map();     // id -> { name, type } | null
  const inflight = new Map();  // id -> Promise

  function isImdbId(id) {
    return typeof id === 'string' && IMDB_ID_RE.test(id.trim());
  }

  async function fetchFromCinemeta(id, type) {
    const res = await fetch(`${CINEMETA_BASE}/${type}/${id}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.meta && data.meta.name) ? data.meta.name : null;
  }

  // Try the hinted type first, then the other. Nuvio's content_type isn't
  // always reliable enough to trust outright, so cover both.
  async function resolveOne(id, hintType) {
    const order = hintType === 'series' ? ['series', 'movie'] : ['movie', 'series'];
    for (const type of order) {
      try {
        const name = await fetchFromCinemeta(id, type);
        if (name) return { name, type };
      } catch (e) { /* try the other type before giving up */ }
    }
    return null;
  }

  function resolveTitle(id, hintType) {
    if (!isImdbId(id)) return Promise.resolve(null);
    const key = id.trim().toLowerCase();
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const p = resolveOne(key, hintType).then((result) => {
      cache.set(key, result);
      inflight.delete(key);
      return result;
    });
    inflight.set(key, p);
    return p;
  }

  // Resolve a batch with bounded concurrency; onEach(id, result) fires as
  // each settles so the caller can patch the DOM incrementally.
  async function resolveBatch(items, onEach) {
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const { id, type } = items[cursor++];
        const result = await resolveTitle(id, type);
        if (onEach) onEach(id, result);
      }
    }
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, worker);
    await Promise.all(workers);
  }

  return { isImdbId, resolveTitle, resolveBatch };
});
