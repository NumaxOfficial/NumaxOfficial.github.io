// ============================================================
// Numax master-profile propagation engine  (engine.js)
//
// Pure logic. No network, no DOM. Given a MASTER snapshot and a TARGET's
// current state, it computes (a) the exact full-replace payloads to push and
// (b) a human-readable report of what will change — including removals, so the
// UI can confirm before anything destructive runs.
//
// Everything here is derived from the verified Nuvio contract:
//   - addons/plugins push = FULL REPLACE (send the complete desired list)
//   - collections push     = FULL REPLACE (whole blob)
//   - settings push        = FULL REPLACE per (profile, platform) via
//     sync_push_profile_settings_blob (no "_guarded" variant/conflict param exists)
//   - settings blob embeds LIVE API KEYS -> strip at the leaf level unless the
//     caller explicitly opts in via settings.includeSecrets (off by default)
//   - settings blob shape  = { version, features: { group: { leaf:{type,value} } } }
//   - mobile has JSON-string "*_payload" groups
//   - version differs by platform -> never copy master's version onto a target
// ============================================================

// Leaf names that carry secrets or per-account identity. Matched in ANY group
// (animeskip_client_id is duplicated into player_settings on mobile), so we
// key off the leaf name, not the group.
const SECRET_LEAF = /(api_?key|client_id|token|secret|access_token|refresh|password)/i;

// Whole settings groups that are account-linked / personal state. Never shared
// regardless of leaf names (Trakt account + this profile's dismissed items).
const ACCOUNT_GROUPS = [/^trakt_/i];

// Groups that ARE shareable but represent personal taste (audio/subtitle
// language prefs). Only applied when the user explicitly opts them in.
const PERSONAL_OPTIN_GROUPS = [/^track_preference$/i];

const matchesAny = (name, patterns) => patterns.some((re) => re.test(name));

// ---------- list surfaces (addons / plugins), identity by url ----------

/**
 * Reconcile a target list against master for a url-keyed list surface.
 * mode 'mirror' -> target becomes exactly master (extras deleted).
 * mode 'merge'  -> master items added/updated, target extras kept.
 * Returns { result, report } where result is the complete list to push.
 */
function reconcileList(masterList, targetList, mode) {
  const M = Array.isArray(masterList) ? masterList : [];
  const T = Array.isArray(targetList) ? targetList : [];
  const byUrl = (arr) => new Map(arr.map((x) => [x.url, x]));
  const mMap = byUrl(M);
  const tMap = byUrl(T);

  const added = [];
  const updated = [];
  const removed = [];

  // Items master defines: add if missing, update if present-but-different.
  for (const [url, mItem] of mMap) {
    const tItem = tMap.get(url);
    if (!tItem) added.push(mItem);
    else if (!shallowEqualItem(mItem, tItem)) updated.push({ url, from: tItem, to: mItem });
  }
  // Items only the target has.
  for (const [url, tItem] of tMap) {
    if (!mMap.has(url)) removed.push(tItem);
  }

  let result;
  if (mode === 'mirror') {
    result = M.slice(); // exact master
  } else {
    // merge: keep target extras, take master's version of shared items, append master-only.
    result = T.map((t) => (mMap.has(t.url) ? mMap.get(t.url) : t))
      .concat(added);
  }

  return {
    result,
    report: {
      added: added.map((x) => x.name || x.url),
      updated: updated.map((x) => x.to.name || x.url),
      removed: mode === 'mirror' ? removed.map((x) => x.name || x.url) : [],
      keptLocal: mode === 'merge' ? removed.map((x) => x.name || x.url) : [],
    },
  };
}

function shallowEqualItem(a, b) {
  // Compare the fields Nuvio stores for addons/plugins.
  const keys = ['url', 'name', 'enabled', 'sort_order', 'repo_type'];
  return keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

// ---------- collections (single jsonb array blob) ----------
// Collection item identity is not yet confirmed (collections_json shape is
// opaque). We identify by 'id' if present, else 'name', else deep-equality.
function collectionKey(c) {
  if (c && typeof c === 'object') {
    if (c.id != null) return 'id:' + c.id;
    if (c.name != null) return 'name:' + c.name;
  }
  return 'json:' + JSON.stringify(c);
}

function reconcileCollections(masterArr, targetArr, mode) {
  const M = Array.isArray(masterArr) ? masterArr : [];
  const T = Array.isArray(targetArr) ? targetArr : [];
  const mKeys = new Map(M.map((c) => [collectionKey(c), c]));
  const tKeys = new Map(T.map((c) => [collectionKey(c), c]));

  const added = [...mKeys].filter(([k]) => !tKeys.has(k)).map(([, c]) => c);
  const removed = [...tKeys].filter(([k]) => !mKeys.has(k)).map(([, c]) => c);

  let result;
  if (mode === 'mirror') result = M.slice();
  else result = T.concat(added);

  const label = (c) => (c && (c.title ?? c.name ?? c.id)) || '(unnamed collection)';
  return {
    result,
    report: {
      added: added.map(label),
      removed: mode === 'mirror' ? removed.map(label) : [],
      keptLocal: mode === 'merge' ? removed.map(label) : [],
    },
  };
}

// ---------- settings blob (leaf-level, secret-stripped) ----------

/** Should this (group, leaf) be shared? */
function leafIsShareable(group, leaf, opts) {
  if (SECRET_LEAF.test(leaf) && !opts.includeSecrets) return false;  // secrets: opt-in only
  if (matchesAny(group, ACCOUNT_GROUPS)) return false;   // account-linked group: never
  if (matchesAny(group, PERSONAL_OPTIN_GROUPS)) return !!opts.includePersonal; // opt-in only
  return true;                                           // everything else: share
}

/** Try to parse a mobile "*_payload" JSON-string; return null if not shareable. */
function sanitizePayloadString(group, str, opts) {
  if (matchesAny(group, ACCOUNT_GROUPS)) return { skip: 'account-linked' };
  let parsed;
  try { parsed = JSON.parse(str); } catch { return { skip: 'unparseable' }; }
  if (!opts.includeSecrets) {
    const secretHit = findSecretKey(parsed);
    if (secretHit) return { skip: 'contains secret: ' + secretHit };
  }
  return { value: str }; // clean -> copy verbatim
}

function findSecretKey(obj, path = '') {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (SECRET_LEAF.test(k)) return path + k;
      const deeper = findSecretKey(obj[k], path + k + '.');
      if (deeper) return deeper;
    }
  }
  return null;
}

/**
 * Overlay shareable leaves from master's blob onto a copy of target's blob.
 * Target's version and every untouched leaf (incl. its secrets) are preserved.
 * Returns { result, report:{ changed:[...], skippedSecrets:[...], skippedPersonal:[...] } }.
 */
function mergeSettingsBlob(masterBlob, targetBlob, opts = {}) {
  const out = deepClone(targetBlob || { version: (masterBlob && masterBlob.version) || 1, features: {} });
  if (!out.features) out.features = {};
  const mFeat = (masterBlob && masterBlob.features) || {};
  const changed = [];
  const skippedSecrets = [];
  const skippedPersonal = [];

  for (const group of Object.keys(mFeat)) {
    const mGroup = mFeat[group];

    // Mobile JSON-string payload group.
    if (typeof mGroup === 'string') {
      const s = sanitizePayloadString(group, mGroup, opts);
      if (s.skip) { if (/secret/.test(s.skip)) skippedSecrets.push(group + ' (' + s.skip + ')'); continue; }
      if (out.features[group] !== s.value) { out.features[group] = s.value; changed.push(group + ' (payload)'); }
      continue;
    }

    if (!mGroup || typeof mGroup !== 'object') continue;

    for (const leaf of Object.keys(mGroup)) {
      if (SECRET_LEAF.test(leaf) && !opts.includeSecrets) { skippedSecrets.push(group + '.' + leaf); continue; }
      if (matchesAny(group, ACCOUNT_GROUPS)) { skippedPersonal.push(group + '.' + leaf); continue; }
      if (matchesAny(group, PERSONAL_OPTIN_GROUPS) && !opts.includePersonal) { skippedPersonal.push(group + '.' + leaf); continue; }

      const mLeaf = mGroup[leaf];
      const existing = out.features[group];
      const before = existing && typeof existing === 'object' ? existing[leaf] : undefined;
      if (JSON.stringify(before) !== JSON.stringify(mLeaf)) {
        // Lazy-create the group only when we actually have a leaf to write.
        if (!out.features[group] || typeof out.features[group] !== 'object') out.features[group] = {};
        out.features[group][leaf] = deepClone(mLeaf);
        changed.push(group + '.' + leaf);
      }
    }
  }

  return { result: out, report: { changed, skippedSecrets, skippedPersonal } };
}

// ---------- top-level: plan one target ----------

/**
 * Build the apply plan for a single target profile.
 *
 * master: { addons?, plugins?, collections?, settings?:{ tv?, mobile? } }
 * target: same shape, current live state.
 * options: {
 *   categories: { addons?, plugins?, collections?, settings? } (booleans),
 *   modes: { addons:'merge'|'mirror', plugins:..., collections:... },
 *   settings: { includePersonal?: bool, includeSecrets?: bool },
 *   profileId: number, originClientId: string,
 * }
 * (settingsUpdatedAt, if passed, is accepted but unused — sync_push_profile_settings_blob
 * has no optimistic-concurrency guard; there's no server-side "_guarded" variant.)
 *
 * Returns { operations:[...], report:{...}, hasChanges:bool, hasRemovals:bool }.
 * Nothing is executed — the caller sends `operations` and shows `report`.
 */
function planTarget(master, target, options) {
  const ops = [];
  const report = { profileId: options.profileId };
  const cats = options.categories || {};
  const modes = options.modes || {};
  const origin = options.originClientId;
  let hasRemovals = false;

  if (cats.addons && master.addons) {
    const { result, report: r } = reconcileList(master.addons, target.addons, modes.addons || 'merge');
    report.addons = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.updated.length || r.removed.length) {
      ops.push({ surface: 'addons', rpc: 'sync_push_addons',
        params: { p_addons: stripListForPush(result), p_profile_id: options.profileId, p_origin_client_id: origin } });
    }
  }

  if (cats.plugins && master.plugins) {
    const { result, report: r } = reconcileList(master.plugins, target.plugins, modes.plugins || 'merge');
    report.plugins = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.updated.length || r.removed.length) {
      ops.push({ surface: 'plugins', rpc: 'sync_push_plugins',
        params: { p_plugins: stripListForPush(result, true), p_profile_id: options.profileId, p_origin_client_id: origin } });
    }
  }

  if (cats.collections && master.collections) {
    const { result, report: r } = reconcileCollections(master.collections, target.collections, modes.collections || 'merge');
    report.collections = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.removed.length) {
      ops.push({ surface: 'collections', rpc: 'sync_push_collections',
        params: { p_profile_id: options.profileId, p_collections_json: result, p_origin_client_id: origin } });
    }
  }

  if (cats.settings && master.settings) {
    report.settings = {};
    for (const platform of ['tv', 'mobile']) {
      const mBlob = master.settings[platform];
      const tBlob = target.settings ? target.settings[platform] : null;
      if (!mBlob) continue;
      const { result, report: r } = mergeSettingsBlob(mBlob, tBlob, options.settings || {});
      report.settings[platform] = r;
      if (r.changed.length) {
        ops.push({ surface: 'settings:' + platform, rpc: 'sync_push_profile_settings_blob',
          params: {
            p_profile_id: options.profileId,
            p_settings_json: result,
            p_platform: platform,
            p_origin_client_id: origin,
          } });
      }
    }
  }

  return { operations: ops, report, hasChanges: ops.length > 0, hasRemovals, profileId: options.profileId };
}

// addons/plugins rows for push carry only the storable fields.
function stripListForPush(list, isPlugin = false) {
  return list.map((x) => {
    const row = { url: x.url, name: x.name ?? null, enabled: x.enabled ?? true, sort_order: x.sort_order ?? 0 };
    if (isPlugin && x.repo_type !== undefined) row.repo_type = x.repo_type;
    return row;
  });
}

function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

// Plan every target at once (convenience).
function planAll(master, targets, baseOptions) {
  return targets.map((t) =>
    planTarget(master, t.state, { ...baseOptions, profileId: t.profileId, settingsUpdatedAt: t.settingsUpdatedAt }));
}

const __api = {
  planTarget, planAll, reconcileList, reconcileCollections, mergeSettingsBlob,
  SECRET_LEAF, // exported for tests
};
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
if (typeof window !== 'undefined') window.NumaxEngine = __api;
