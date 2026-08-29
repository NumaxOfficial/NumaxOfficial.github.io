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

// Leaves that name the ACCOUNT a profile is linked to, or hold that profile's
// own personal watch state. Never shared, even with includeSecrets on.
//
// This replaces a previous blanket "any group whose name starts with trakt_"
// rule. That rule did block these leaves, but it also swallowed ~14 pure
// display preferences that carry no account identity whatsoever (day caps,
// unaired-next-up visibility, comments on/off, more-like-this source, Simkl id
// preference) — those could never be copied and nothing told the user why.
// Worse, it only ever looked at TOP-LEVEL group names, so mobile's equivalent
// personal state — dismissedNextUpKeys, which lives *inside* the
// continue_watching_settings_payload JSON string, not in a trakt_* group —
// sailed straight through and got copied onto every target profile. Matching on
// the leaf name instead catches it in both places.
//
// Compared with underscores removed and case folded so the TV spelling
// (dismissed_next_up_keys) and the mobile payload spelling (dismissedNextUpKeys)
// both hit the same entry.
const ACCOUNT_LEAF_NAMES = new Set([
  'librarysourcemode',      // library_source_mode  / librarySourceMode
  'watchprogresssource',    // watch_progress_source / watchProgressSource
  'dismissednextupkeys',    // dismissed_next_up_keys / dismissedNextUpKeys
]);
const isAccountLeaf = (leaf) => ACCOUNT_LEAF_NAMES.has(String(leaf).replace(/_/g, '').toLowerCase());

// Groups whose credentials ARE the account link. A token/secret leaf inside one
// of these is never copyable at any opt-in level — copying a Trakt OAuth token
// would bind the target profile to the source's Trakt account, which is exactly
// what the old blanket trakt_* group block was really protecting against. Non-
// credential leaves in these groups (day caps, visibility toggles) stay
// shareable; only the credentials are pinned shut.
const ACCOUNT_AUTH_GROUPS = [/^trakt_/i];

// Groups that ARE shareable but represent personal taste (audio/subtitle
// language prefs). Only applied when the user explicitly opts them in.
const PERSONAL_OPTIN_GROUPS = [/^track_preference$/i];

const matchesAny = (name, patterns) => patterns.some((re) => re.test(name));

// Fields a Nuvio app is CONFIRMED to ignore when a synced settings blob reaches
// it. These are still written when the caller selects them — pulling them out
// would throw away data that may start working later — but each is reported
// separately so the UI never implies the field took effect.
//
// PROVENANCE RULE: only entries confirmed by direct observation on a real
// account belong here. The previous version of this table was populated by
// reading NuvioMedia's TV/Mobile source on GitHub and inferring which fields
// their sync code touched. At least one of those inferences was flatly wrong —
// mobile's MDBList key was listed as "never applies", and it demonstrably does
// apply — which meant Numax was warning users off a field that works. A false
// "won't apply" is worse than no warning: it tells someone not to bother with
// something that would have worked. So every unverified entry has been removed
// rather than left as a guess. Re-add one only after watching that specific
// field fail to take effect on a real device, and say so in the message.
//
// Confirmed so far (observed 2026-08-29 on a live account):
//   tv  mdblist_settings.mdblist_api_key — pushed successfully, TV app kept
//       using its own key; the same push DID take effect on mobile.
const PLATFORM_SYNC_GAPS = {
  tv: {
    'mdblist_settings.mdblist_api_key': 'the TV app kept its own key when this was last tested — set it in the TV app directly',
  },
  mobile: {},
};

function platformSyncGapReason(platform, group, leaf) {
  const table = PLATFORM_SYNC_GAPS[platform];
  return table ? table[group + '.' + leaf] : undefined;
}

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

/**
 * Why this (group, leaf) may not be shared — null when it may.
 * 'account'  never, at any opt-in level (account identity / personal watch state)
 * 'secret'   credential, needs opts.includeSecrets
 * 'personal' personal taste, needs opts.includePersonal
 */
function leafBlockReason(group, leaf, opts) {
  if (isAccountLeaf(leaf)) return 'account';                                    // never
  const isSecret = SECRET_LEAF.test(leaf);
  if (isSecret && matchesAny(group, ACCOUNT_AUTH_GROUPS)) return 'account';     // Trakt OAuth etc: never
  if (isSecret && !opts.includeSecrets) return 'secret';                        // opt-in only
  if (matchesAny(group, PERSONAL_OPTIN_GROUPS) && !opts.includePersonal) return 'personal';
  return null;
}

/** Should this (group, leaf) be shared? */
function leafIsShareable(group, leaf, opts) {
  return !leafBlockReason(group, leaf, opts);
}

/**
 * Sanitize a mobile "*_payload" JSON-string at the LEAF level.
 *
 * Previously this was all-or-nothing: a payload containing a single secret was
 * dropped whole (losing every unrelated visual setting in it), and one holding
 * personal state — continue_watching_settings_payload carries the profile's own
 * dismissedNextUpKeys — was copied verbatim, overwriting each target's dismissed
 * list with the source's. Now blocked leaves are removed individually and, when
 * the target already had its own value for one, that value is put back, so a
 * sync never rewrites someone else's personal state or credential.
 *
 * Returns { empty:true } (nothing set on the source), { skip:reason } (present
 * but unreadable), or { value, stripped:[{leaf,why}] }.
 */
function sanitizePayloadString(group, str, opts, targetStr) {
  if (typeof str !== 'string' || !str.trim()) return { empty: true };
  let parsed;
  try { parsed = JSON.parse(str); } catch { return { skip: 'unreadable on the source (not valid JSON)' }; }
  let tgt = null;
  if (typeof targetStr === 'string' && targetStr.trim()) { try { tgt = JSON.parse(targetStr); } catch { tgt = null; } }
  const stripped = [];
  const cleaned = scrubPayload(parsed, tgt, opts, group, '', stripped);
  return { value: JSON.stringify(cleaned), stripped };
}

// Walk a parsed payload, dropping blocked leaves at any depth and restoring the
// target's own value for each one it already had.
function scrubPayload(node, tgtNode, opts, group, path, stripped) {
  if (Array.isArray(node)) return node.map((v, i) => scrubPayload(v, null, opts, group, path + '[' + i + ']', stripped));
  if (!node || typeof node !== 'object') return node;
  const tgtObj = (tgtNode && typeof tgtNode === 'object' && !Array.isArray(tgtNode)) ? tgtNode : null;
  const out = {};
  for (const k of Object.keys(node)) {
    const here = path ? path + '.' + k : k;
    const why = leafBlockReason(group, k, { includeSecrets: opts.includeSecrets, includePersonal: true });
    if (why) {
      const keep = tgtObj ? tgtObj[k] : undefined;
      if (keep !== undefined) out[k] = keep;   // hand the target its own value back
      stripped.push({ leaf: group + '.' + here, why });
      continue;
    }
    out[k] = scrubPayload(node[k], tgtObj ? tgtObj[k] : null, opts, group, here, stripped);
  }
  return out;
}

/**
 * Overlay shareable leaves from master's blob onto a copy of target's blob.
 * Target's version and every untouched leaf (incl. its secrets) are preserved.
 * `platform` ('tv'|'mobile'), when given, flags leaves against PLATFORM_SYNC_GAPS —
 * they are still written, just also listed in wontApply so the UI can say so.
 *
 * Every leaf that does NOT get written lands in exactly one report bucket, so a
 * caller can always account for the difference between what the source had and
 * what the target received — nothing is dropped without a trace:
 *   skippedSecrets    credential, caller did not opt in
 *   skippedAccount    account identity / personal watch state, never copied
 *   skippedPersonal   personal-taste group, caller did not opt in
 *   skippedUnreadable present on the source but not valid JSON (payload groups)
 * Returns { result, report:{ changed, skippedSecrets, skippedAccount,
 *           skippedPersonal, skippedUnreadable, wontApply } }.
 */
function mergeSettingsBlob(masterBlob, targetBlob, opts = {}, platform) {
  const out = deepClone(targetBlob || { version: (masterBlob && masterBlob.version) || 1, features: {} });
  if (!out.features) out.features = {};
  const mFeat = (masterBlob && masterBlob.features) || {};
  const tFeat = (targetBlob && targetBlob.features) || {};
  const changed = [];
  const skippedSecrets = [];
  const skippedAccount = [];
  const skippedPersonal = [];
  const skippedUnreadable = [];
  const wontApply = [];

  for (const group of Object.keys(mFeat)) {
    const mGroup = mFeat[group];

    // Mobile JSON-string payload group.
    if (typeof mGroup === 'string') {
      const s = sanitizePayloadString(group, mGroup, opts, typeof tFeat[group] === 'string' ? tFeat[group] : null);
      if (s.empty) continue;  // nothing configured on the source — nothing to carry
      if (s.skip) { skippedUnreadable.push(group + ' — ' + s.skip); continue; }
      (s.stripped || []).forEach((x) => (x.why === 'secret' ? skippedSecrets : skippedAccount).push(x.leaf));
      if (out.features[group] !== s.value) { out.features[group] = s.value; changed.push(group + ' (payload)'); }
      continue;
    }

    if (!mGroup || typeof mGroup !== 'object') continue;

    for (const leaf of Object.keys(mGroup)) {
      const why = leafBlockReason(group, leaf, opts);
      if (why === 'secret') { skippedSecrets.push(group + '.' + leaf); continue; }
      if (why === 'account') { skippedAccount.push(group + '.' + leaf); continue; }
      if (why === 'personal') { skippedPersonal.push(group + '.' + leaf); continue; }

      const mLeaf = mGroup[leaf];
      const existing = out.features[group];
      const before = existing && typeof existing === 'object' ? existing[leaf] : undefined;
      if (JSON.stringify(before) !== JSON.stringify(mLeaf)) {
        // Lazy-create the group only when we actually have a leaf to write.
        if (!out.features[group] || typeof out.features[group] !== 'object') out.features[group] = {};
        out.features[group][leaf] = deepClone(mLeaf);
        const gapReason = platform && platformSyncGapReason(platform, group, leaf);
        if (gapReason) wontApply.push(group + '.' + leaf + ' — ' + gapReason);
        changed.push(group + '.' + leaf);
      }
    }
  }

  return { result: out, report: { changed, skippedSecrets, skippedAccount, skippedPersonal, skippedUnreadable, wontApply } };
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
      const { result, report: r } = mergeSettingsBlob(mBlob, tBlob, options.settings || {}, platform);
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
  SECRET_LEAF, PLATFORM_SYNC_GAPS, isAccountLeaf, leafIsShareable, // exported for tests
};
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
if (typeof window !== 'undefined') window.NumaxEngine = __api;
