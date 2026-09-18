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
//
// This list is now exactly Nuvio's own. Their account bundle carries a per-platform
// map of fields it deliberately leaves out (tp for TV, tN for mobile); the only
// watch-related entries in either are dismissed_next_up_keys / dismissedNextUpKeys.
// library_source_mode and watch_progress_source appear in NEITHER, and are ordinary
// settings on their Integrations > Trakt panel ("Library Source", "Watch Progress",
// whose value can be Nuvio Sync). They were wrongly blocked here as account identity,
// which is precisely why choosing Nuvio Sync never copied to another profile.
const ACCOUNT_LEAF_NAMES = new Set([
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

// The three platforms a profile can hold a settings blob for. 'desktop' is real:
// Nuvio's own sync_copy_profile_setup takes a p_copy_desktop flag, and the
// profile_settings_blobs.platform column is free text (<=80 chars, no enum), so
// it stores whatever a client writes. There is no desktop entry in
// nuvio-settings-schema.js, which is exactly why the copy UI is driven by the
// blocks found in the live blob rather than by the schema — see listSettingsBlocks.
const PLATFORMS = ['tv', 'mobile', 'desktop'];

// Friendly names for the top-level feature groups a settings blob is built from.
// These groups ARE the copy unit: a block is moved verbatim, so nothing has to be
// mapped field-by-field and nothing can land in the wrong place. Unknown groups
// (anything desktop-only, or added by a future Nuvio release) fall back to a
// prettified version of their own name, so the UI never hides a block it cannot name.
const GROUP_LABELS = {
  theme_settings: 'Appearance & theme',
  layout_settings: 'Layout',
  player_settings: 'Playback',
  debrid_settings: 'Debrid & stream selection',
  stream_badge_settings: 'Stream badges',
  tmdb_settings: 'TMDB',
  mdblist_settings: 'MDBList ratings',
  animeskip_settings: 'Anime Skip',
  trakt_settings: 'Trakt',
  trakt_comments_settings: 'Trakt comments',
  notifications_settings: 'Notifications',
  experience_settings: 'Experience mode',
  trailer_settings: 'Trailers',
  track_preference: 'Audio & subtitle track preferences',
  trakt_settings_payload: 'Trakt',
  meta_screen_settings_payload: 'Detail screen',
  card_depth_style_settings_payload: 'Card depth style',
  collection_mobile_settings_payload: 'Collections layout',
  continue_watching_settings_payload: 'Continue watching',
  poster_card_style_settings_payload: 'Poster card style',
};
function prettifyGroup(group) {
  return String(group)
    .replace(/_payload$/, '')
    .replace(/_settings$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim() || String(group);
}
function groupLabel(group) { return GROUP_LABELS[group] || prettifyGroup(group); }

/**
 * The selectable blocks in one platform's blob, derived from live data rather
 * than a schema so it works for desktop too. Blocks holding nothing copyable
 * (a Trakt group that is only an OAuth token, say) are reported with count 0 so
 * the UI can show them as unavailable instead of pretending they will copy.
 */
function listSettingsBlocks(blob, opts = {}) {
  const feat = (blob && blob.features) || {};
  return Object.keys(feat).map((group) => {
    const gv = feat[group];
    if (typeof gv === 'string') {
      return { group, label: groupLabel(group), payload: true, total: gv.trim() ? 1 : 0, copyable: gv.trim() ? 1 : 0, secrets: 0 };
    }
    if (!gv || typeof gv !== 'object') return { group, label: groupLabel(group), payload: false, total: 0, copyable: 0, secrets: 0 };
    const leaves = Object.keys(gv);
    let copyable = 0, secrets = 0;
    leaves.forEach((leaf) => {
      if (SECRET_LEAF.test(leaf)) secrets++;
      if (!leafBlockReason(group, leaf, opts)) copyable++;
    });
    return { group, label: groupLabel(group), payload: false, total: leaves.length, copyable, secrets };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

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
// Now empty, and the reason is worth keeping: the one entry that used to live here
// (an API key "not applying") turned out not to be a per-field quirk at all. Nuvio's
// apps strip EVERY credential out of the settings blob before pushing and keep their
// own local value when a blob comes down — NuvioDesktop's
// ProfileSettingsCredentialPolicy.kt does exactly that via withoutProfileCredentials
// and preservingLocalProfileCredentials. So no API key has ever travelled inside a
// settings blob, for any field, on any platform. Keys move through the
// provider_credentials table instead, which is how Numax now copies them. A warning
// on individual fields would have been describing the wrong mechanism entirely.
const PLATFORM_SYNC_GAPS = { tv: {}, mobile: {}, desktop: {} };

function platformSyncGapReason(platform, group, leaf) {
  const table = PLATFORM_SYNC_GAPS[platform];
  return table ? table[group + '.' + leaf] : undefined;
}

// ---------- list surfaces (addons / plugins), identity by url ----------

/**
 * Reconcile a target list against master for a url-keyed list surface.
 * mode 'mirror' -> target becomes exactly master (extras deleted), in master's order.
 * mode 'merge'  -> master items added, target extras kept, target's order kept and
 *                  anything new appended after it.
 * opts.order 'source' (merge only) -> order by the sort_order the caller put on master's
 *                  rows instead (the wizard's "put this at the top" builds the whole
 *                  list itself); a target-only row keeps its own sort_order.
 * Returns { result, report } where result is the complete list to push.
 *
 * WHAT MERGE CAN AND CANNOT KEEP (release sweep, 2026-09-17). Two different add-ons
 * always both survive a merge. The SAME add-on on both sides can only be one thing:
 * if the source has it switched off and the target on, or named differently, the
 * source's version wins. Those are listed in report.replaced with each field's before
 * and after, so the UI can say exactly what a merge overwrites instead of implying it
 * kept everything. Position is NOT one of those fields in merge — a merge never moves
 * something already on the target.
 *
 * Every result is renumbered 0..n-1. Before this, merge kept each row's own
 * sort_order: the source's for copied rows, the target's for the rest, so two add-ons
 * could share a slot and an add-on the target already had jumped to wherever it sat on
 * the source (found live: Cinemeta went from first to last on a merge).
 */
const ITEM_FIELDS = [['enabled', 'On/off'], ['name', 'Name'], ['repo_type', 'Type']];

function byOrder(list) {
  return list.map((x, i) => [x, i])
    .sort((a, b) => ((Number(a[0].sort_order) || 0) - (Number(b[0].sort_order) || 0)) || (a[1] - b[1]))
    .map((p) => p[0]);
}

// The source's row for an item the target already has. The name falls back to the
// target's: Nuvio stores some add-ons with an empty name, and an empty name on the
// source is "unknown", not "rename it to nothing".
function mergedItem(tItem, mItem) {
  const out = Object.assign({}, tItem, mItem);
  out.name = (mItem.name != null && String(mItem.name).trim() !== '') ? mItem.name : (tItem.name ?? null);
  if (mItem.repo_type === undefined && tItem.repo_type !== undefined) out.repo_type = tItem.repo_type;
  return out;
}

function itemDiffs(tItem, merged) {
  const out = [];
  for (const [k, label] of ITEM_FIELDS) {
    const a = k === 'enabled' ? (tItem[k] ?? true) : (tItem[k] ?? null);
    const b = k === 'enabled' ? (merged[k] ?? true) : (merged[k] ?? null);
    if (a !== b) out.push({ field: k, label, from: a, to: b });
  }
  return out;
}

function reconcileList(masterList, targetList, mode, opts = {}) {
  const M = byOrder(Array.isArray(masterList) ? masterList : []);
  const T = byOrder(Array.isArray(targetList) ? targetList : []);
  const byUrl = (arr) => new Map(arr.map((x) => [x.url, x]));
  const mMap = byUrl(M);
  const tMap = byUrl(T);

  const added = [];
  const updated = [];
  const removed = [];

  // Items master defines: add if missing, replace if present-but-different.
  for (const [url, mItem] of mMap) {
    const tItem = tMap.get(url);
    if (!tItem) { added.push(mItem); continue; }
    const diffs = itemDiffs(tItem, mergedItem(tItem, mItem));
    if (diffs.length) updated.push({ url, from: tItem, to: mItem, diffs });
  }
  // Items only the target has.
  for (const [url, tItem] of tMap) {
    if (!mMap.has(url)) removed.push(tItem);
  }

  let result;
  if (mode === 'mirror') {
    result = M.map((m) => (tMap.has(m.url) ? mergedItem(tMap.get(m.url), m) : Object.assign({}, m)));
  } else {
    result = T.map((t) => (mMap.has(t.url) ? mergedItem(t, mMap.get(t.url)) : Object.assign({}, t)))
      .concat(added.map((m) => Object.assign({}, m)));
    if (opts.order === 'source') {
      const want = (x) => (mMap.has(x.url) ? mMap.get(x.url).sort_order : x.sort_order);
      result = result.map((x, i) => [x, i])
        .sort((a, b) => ((Number(want(a[0])) || 0) - (Number(want(b[0])) || 0)) || (a[1] - b[1]))
        .map((p) => p[0]);
    }
  }
  result.forEach((x, i) => { x.sort_order = i; });

  // A different sequence of the rows both sides keep is a real change (mirror, or a
  // merge ordered by the source). Merge in the target's own order never reorders.
  const seq = (list) => list.map((x) => x.url).filter((u) => tMap.has(u) && result.some((r) => r.url === u)).join('\n');
  const reordered = seq(result) !== seq(T);

  const nm = (x) => x.name || x.url;
  return {
    result,
    report: {
      added: added.map(nm),
      updated: updated.map((x) => x.to.name || x.from.name || x.url),
      replaced: updated.map((x) => ({ name: x.to.name || x.from.name || x.url, diffs: x.diffs })),
      removed: mode === 'mirror' ? removed.map(nm) : [],
      keptLocal: mode === 'merge' ? removed.map(nm) : [],
      reordered,
    },
  };
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

// Merge keeps every collection either side has. A collection BOTH sides have (same
// id) can only be one version: it used to silently keep the target's, so a merge
// never delivered an updated collection and never said so. Now the source's version
// replaces it in place and it is listed in report.replaced, same rule as add-ons.
function collectionShape(c) {
  const folders = c && Array.isArray(c.folders) ? c.folders : null;
  if (!folders) return null;
  const sources = folders.reduce((n, f) => n + (f && Array.isArray(f.sources) ? f.sources.length : 0), 0);
  return folders.length + ' folder' + (folders.length === 1 ? '' : 's') + ', ' + sources + ' source' + (sources === 1 ? '' : 's');
}

function reconcileCollections(masterArr, targetArr, mode) {
  const M = Array.isArray(masterArr) ? masterArr : [];
  const T = Array.isArray(targetArr) ? targetArr : [];
  const mKeys = new Map(M.map((c) => [collectionKey(c), c]));
  const tKeys = new Map(T.map((c) => [collectionKey(c), c]));

  const added = [...mKeys].filter(([k]) => !tKeys.has(k)).map(([, c]) => c);
  const removed = [...tKeys].filter(([k]) => !mKeys.has(k)).map(([, c]) => c);
  const updated = [...mKeys].filter(([k, c]) => tKeys.has(k) && JSON.stringify(tKeys.get(k)) !== JSON.stringify(c))
    .map(([k, c]) => ({ from: tKeys.get(k), to: c }));

  let result;
  if (mode === 'mirror') result = M.slice();
  else result = T.map((c) => (mKeys.has(collectionKey(c)) ? mKeys.get(collectionKey(c)) : c)).concat(added);

  const label = (c) => (c && (c.title ?? c.name ?? c.id)) || '(unnamed collection)';
  return {
    result,
    report: {
      added: added.map(label),
      updated: updated.map((u) => label(u.to)),
      replaced: updated.map((u) => {
        const a = collectionShape(u.from), b = collectionShape(u.to);
        return { name: label(u.to), diffs: [{ field: 'contents', label: 'Contents', from: a && a !== b ? a : 'this profile\u2019s version', to: b && a !== b ? b : 'the source\u2019s version' }] };
      }),
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
  // Merge mode overlays only the keys the caller actually selected onto the target's
  // own payload, so picking one tab out of a payload group (mobile/desktop keep whole
  // screens in a single JSON string) copies just that tab's fields and leaves the rest
  // of the target's screen alone. Replace mode takes the sanitized payload as-is.
  if (opts.blockMode !== 'replace' && tgt && typeof tgt === 'object' && !Array.isArray(tgt)
      && cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    return { value: JSON.stringify(Object.assign({}, tgt, cleaned)), stripped };
  }
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
  const removed = [];
  const wontApply = [];
  // Every value this write puts in place of one the target already shows: a setting
  // holds one value, so a merge cannot keep both. `from` is undefined when the target
  // was still on Nuvio's default. The UI lists these as "what Merge replaces".
  const replaced = [];
  const leafValue = (x) => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x ? x.value : x);

  for (const group of Object.keys(mFeat)) {
    const mGroup = mFeat[group];

    // Mobile JSON-string payload group.
    if (typeof mGroup === 'string') {
      const s = sanitizePayloadString(group, mGroup, opts, typeof tFeat[group] === 'string' ? tFeat[group] : null);
      if (s.empty) continue;  // nothing configured on the source — nothing to carry
      if (s.skip) { skippedUnreadable.push(group + ' — ' + s.skip); continue; }
      (s.stripped || []).forEach((x) => (x.why === 'secret' ? skippedSecrets : skippedAccount).push(x.leaf));
      if (out.features[group] !== s.value) {
        let before = {}, after = {};
        try { before = typeof out.features[group] === 'string' && out.features[group].trim() ? JSON.parse(out.features[group]) : {}; } catch { before = {}; }
        try { after = JSON.parse(s.value); } catch { after = {}; }
        if (after && typeof after === 'object' && !Array.isArray(after)) {
          Object.keys(after).forEach((k) => {
            if (JSON.stringify(before && before[k]) !== JSON.stringify(after[k])) replaced.push({ group, leaf: k, from: before ? before[k] : undefined, to: after[k], payload: true });
          });
          if (opts.blockMode === 'replace' && before && typeof before === 'object') {
            Object.keys(before).forEach((k) => { if (!(k in after)) replaced.push({ group, leaf: k, from: before[k], to: undefined, payload: true }); });
          }
        }
        out.features[group] = s.value; changed.push(group + ' (payload)');
      }
      continue;
    }

    if (!mGroup || typeof mGroup !== 'object') continue;

    // Overwrite mode: the block becomes exactly the source's block. Anything the
    // target had in it that the source doesn't is dropped — a real removal, reported
    // so the UI can demand confirmation before it runs. Blocked leaves are the one
    // exception: the target keeps its own account identity and its own credentials,
    // because a copy must never delete or leak those.
    if (opts.blockMode === 'replace') {
      const tGroup = (tFeat[group] && typeof tFeat[group] === 'object') ? tFeat[group] : {};
      const built = {};
      for (const leaf of Object.keys(mGroup)) {
        const why = leafBlockReason(group, leaf, opts);
        if (why) {
          (why === 'secret' ? skippedSecrets : why === 'account' ? skippedAccount : skippedPersonal).push(group + '.' + leaf);
          if (tGroup[leaf] !== undefined) built[leaf] = deepClone(tGroup[leaf]);
          continue;
        }
        built[leaf] = deepClone(mGroup[leaf]);
      }
      for (const leaf of Object.keys(tGroup)) {
        if (leaf in built) continue;
        if (leafBlockReason(group, leaf, opts)) { built[leaf] = deepClone(tGroup[leaf]); continue; } // target's own, kept
        removed.push(group + '.' + leaf);
      }
      if (JSON.stringify(out.features[group]) !== JSON.stringify(built)) {
        const was = (out.features[group] && typeof out.features[group] === 'object') ? out.features[group] : {};
        new Set([...Object.keys(was), ...Object.keys(built)]).forEach((leaf) => {
          if (JSON.stringify(was[leaf]) !== JSON.stringify(built[leaf])) replaced.push({ group, leaf, from: leafValue(was[leaf]), to: leafValue(built[leaf]) });
        });
        out.features[group] = built;
        changed.push(group + ' (block)');
        const gapReason = platform && Object.keys(mGroup).map((l) => platformSyncGapReason(platform, group, l)).find(Boolean);
        if (gapReason) wontApply.push(group + ' — ' + gapReason);
      }
      continue;
    }

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
        replaced.push({ group, leaf, from: leafValue(before), to: leafValue(mLeaf) });
        const gapReason = platform && platformSyncGapReason(platform, group, leaf);
        if (gapReason) wontApply.push(group + '.' + leaf + ' — ' + gapReason);
        changed.push(group + '.' + leaf);
      }
    }
  }

  return { result: out, report: { changed, replaced, skippedSecrets, skippedAccount, skippedPersonal, skippedUnreadable, removed, wontApply } };
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
 *   listOrder: 'source' (optional) — merge add-ons/plugins in the sort_order the
 *     caller put on master's rows rather than the target's own order,
 *   settings: { includePersonal?: bool, includeSecrets?: bool },
 *   profileId: number, originClientId: string,
 * }
 * settingsUpdatedAt: { tv?, mobile?, desktop? } — the updated_at read alongside each
 * target blob. When a platform's key is present the push uses the guarded RPC and
 * fails with 40001 rather than clobbering a concurrent change.
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
    const { result, report: r } = reconcileList(master.addons, target.addons, modes.addons || 'merge', { order: options.listOrder });
    report.addons = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.updated.length || r.removed.length || r.reordered) {
      ops.push({ surface: 'addons', rpc: 'sync_push_addons',
        params: { p_addons: stripListForPush(result), p_profile_id: options.profileId, p_origin_client_id: origin } });
    }
  }

  if (cats.plugins && master.plugins) {
    const { result, report: r } = reconcileList(master.plugins, target.plugins, modes.plugins || 'merge', { order: options.listOrder });
    report.plugins = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.updated.length || r.removed.length || r.reordered) {
      ops.push({ surface: 'plugins', rpc: 'sync_push_plugins',
        params: { p_plugins: stripListForPush(result, true), p_profile_id: options.profileId, p_origin_client_id: origin } });
    }
  }

  if (cats.collections && master.collections) {
    const { result, report: r } = reconcileCollections(master.collections, target.collections, modes.collections || 'merge');
    report.collections = r;
    if (r.removed.length) hasRemovals = true;
    if (r.added.length || r.updated.length || r.removed.length) {
      ops.push({ surface: 'collections', rpc: 'sync_push_collections',
        params: { p_profile_id: options.profileId, p_collections_json: result, p_origin_client_id: origin } });
    }
  }

  if (cats.settings && master.settings) {
    report.settings = {};
    const upd = options.settingsUpdatedAt || {};
    for (const platform of PLATFORMS) {
      const mBlob = master.settings[platform];
      const tBlob = target.settings ? target.settings[platform] : null;
      if (!mBlob) continue;
      const { result, report: r } = mergeSettingsBlob(mBlob, tBlob, options.settings || {}, platform);
      report.settings[platform] = r;
      if (r.removed.length) hasRemovals = true;   // overwrite mode dropped target-only settings
      if (r.changed.length) {
        // Guarded write when we know what the target's blob looked like when we read
        // it: sync_push_profile_settings_blob_guarded rejects with 40001 if anything
        // saved in between, instead of silently overwriting another device's change.
        // (This variant does exist on the live API and in the self-host migration
        // 00000000000009_guard_profile_settings_writes, despite older notes saying otherwise.)
        const expected = Object.prototype.hasOwnProperty.call(upd, platform) ? (upd[platform] || null) : undefined;
        const guarded = expected !== undefined;
        // The two RPCs take DIFFERENT parameter lists, and PostgREST resolves a function
        // by name AND signature — passing p_origin_client_id to the guarded one is a
        // 404/PGRST202, not an ignored extra. Verified against the live API: guarded
        // accepts exactly (p_profile_id, p_settings_json, p_platform,
        // p_expected_updated_at) and nothing else, which is also the shape Nuvio's own
        // client sends. The trade-off is theirs: a guarded write carries no origin tag.
        ops.push({
          surface: 'settings:' + platform,
          rpc: guarded ? 'sync_push_profile_settings_blob_guarded' : 'sync_push_profile_settings_blob',
          params: guarded ? {
            p_profile_id: options.profileId,
            p_settings_json: result,
            p_platform: platform,
            p_expected_updated_at: expected,
          } : {
            p_profile_id: options.profileId,
            p_settings_json: result,
            p_platform: platform,
            p_origin_client_id: origin,
          },
        });
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
  listSettingsBlocks, groupLabel, PLATFORMS, GROUP_LABELS,
  SECRET_LEAF, PLATFORM_SYNC_GAPS, isAccountLeaf, leafIsShareable, // exported for tests
};
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
if (typeof window !== 'undefined') window.NumaxEngine = __api;
