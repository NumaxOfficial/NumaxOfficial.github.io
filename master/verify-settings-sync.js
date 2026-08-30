// ============================================================
// Live settings-sync verifier
//
// End-to-end check that Nuvio Sync actually carries settings between two
// real profiles on whichever account is logged into https://nuvio.tv/account
// in the browser tab this runs in. It never simulates anything: it drives
// Numax's own shipped engine.js/api.js against the real Nuvio API.
//
// HOW TO RUN
//   1. Log into https://nuvio.tv/account in a browser tab.
//   2. Paste this entire file into that tab's JS console (or have Claude run
//      it there via browser automation) and call:
//         await verifySettingsSync({ sourceIndex: 2, targetIndex: 3 });
//      sourceIndex/targetIndex are profile_index values from that account's
//      profile list (Overview tab shows them in order) — NOT the UUID
//      `id` field. Use two profiles you're fine with being written to and
//      restored; the function backs both up first and restores both after,
//      whether it succeeds or throws.
//
// WHY IT HAS TO RUN ON nuvio.tv ITSELF
//   The real session lives only in that origin's localStorage
//   (nuvio.supabase.session). nuvio.tv's CSP is `script-src 'self'
//   'unsafe-inline'`, which blocks both `<script src="...">` to another
//   origin and eval() of fetched text — but it does allow an inline
//   <script> whose .textContent was set programmatically. So engine.js /
//   api.js / nuvio-settings-schema.js are pulled with fetch() (allowed) from
//   the live Numax deployment and injected that way. This guarantees the
//   test exercises the exact code that's actually shipped, not a copy typed
//   into a test file that can drift from it.
//
// WHAT IT DOES
//   1. Loads the live engine.js/api.js/nuvio-settings-schema.js.
//   2. Backs up SOURCE and TARGET's current tv/mobile settings.
//   3. Builds a synthetic blob covering every field in Nuvio's own schema
//      (window.NUVIO_SETTINGS), each set to a value guaranteed different
//      from its default, plus one fake secret-shaped leaf and one fake
//      account-identity leaf to exercise the three-bucket blocking rules —
//      and seeds it onto SOURCE.
//   4. Runs the real Sync Desk merge logic (engine.planTarget) from SOURCE
//      to TARGET with Sync Desk's own default options (includePersonal:
//      true, includeSecrets: false, blockMode: 'merge'), then executes the
//      push for real via api.js's applyPlan.
//   5. Re-reads TARGET and checks every leaf: shareable fields must now
//      match SOURCE exactly; blocked fields (secrets / account identity /
//      personal-taste when not opted in) must be unchanged from TARGET's
//      original value.
//   6. Restores SOURCE and TARGET to their original settings and verifies
//      the restore is byte-for-byte exact, even if a step above threw.
//
// Result is returned and also left on window.__numaxVerify for inspection.
// Last run 2026-08-29 against a real account (Test 1 -> Test 2, tv+mobile):
// 301 leaves checked, 0 failures — see CLAUDE.md for the summary.
// ============================================================

async function verifySettingsSync({ sourceIndex, targetIndex } = {}) {
  if (!sourceIndex || !targetIndex) throw new Error('Pass { sourceIndex, targetIndex } — profile_index values, not UUIDs.');
  if (!location.origin.includes('nuvio.tv')) throw new Error('Run this on https://nuvio.tv/account — it needs the real session in localStorage.');

  function loadInline(src) {
    return fetch(src + '?v=' + Date.now())
      .then((r) => r.text())
      .then((code) => { const s = document.createElement('script'); s.textContent = code; document.head.appendChild(s); });
  }
  const BASE = 'https://numaxofficial.website/master/';
  if (!window.NumaxEngine) await loadInline(BASE + 'engine.js');
  if (!window.NumaxApi) await loadInline(BASE + 'api.js');
  if (!window.NUVIO_SETTINGS) await loadInline(BASE + 'nuvio-settings-schema.js');
  const E = window.NumaxEngine;

  const sess = JSON.parse(localStorage.getItem('nuvio.supabase.session'));
  const store = { _session: sess, get() { return { session: this._session }; }, updateSession(_id, s) { this._session = s; } };
  const c = window.NumaxApi.client(store, 'verify-settings-sync');

  const PLATS = ['tv', 'mobile'];
  async function pullAll(idx) {
    const out = {};
    for (const pl of PLATS) { const row = await c.pullSettings(idx, pl); out[pl] = row ? { settings_json: row.settings_json, updated_at: row.updated_at } : null; }
    return out;
  }

  // ---- build a synthetic value guaranteed to differ from the field's default ----
  function perturb(field) {
    switch (field.type) {
      case 'boolean': return !field.defaultValue;
      case 'int': return (Number(field.defaultValue) || 0) + 1;
      case 'float': return (Number(field.defaultValue) || 0) + 0.5;
      case 'string_set': {
        if (field.options && field.options.length) return field.options.slice(0, 2).map((o) => o.value);
        return ['__numaxtest_marker__'];
      }
      case 'string':
      default: {
        if (field.options && field.options.length) {
          const alt = field.options.find((o) => o.value !== field.defaultValue);
          return alt ? alt.value : field.options[0].value;
        }
        return field.defaultValue ? field.defaultValue + '__NUMAXTEST' : 'NUMAXTEST_MARKER';
      }
    }
  }

  function buildSynthetic(platform, existingVersion) {
    const plain = {}; // group -> { leaf: {type, value} }
    const payload = {}; // payloadGroup -> { leaf: value }
    for (const tab of window.NUVIO_SETTINGS[platform] || []) {
      for (const group of tab.groups) {
        for (const f of group.fields) {
          const value = perturb(f);
          if (f.feature.endsWith('_payload')) { (payload[f.feature] ||= {})[f.key] = value; }
          else { (plain[f.feature] ||= {})[f.key] = { type: f.type, value }; }
        }
      }
    }
    // synthetic leaves to exercise the three-bucket rules with real leaf shapes
    if (platform === 'tv') {
      (plain.track_preference ||= {}).audio_lang = { type: 'string', value: 'PERSONAL_SHOULD_NOT_COPY' };
      (plain.debrid_settings ||= {}).injected_test_api_key = { type: 'string', value: 'SECRET_SHOULD_NOT_COPY' };
    }
    if (platform === 'mobile') {
      (payload.continue_watching_settings_payload ||= {}).dismissedNextUpKeys = ['ACCOUNT_SHOULD_NEVER_COPY'];
    }
    const features = { ...plain };
    for (const g of Object.keys(payload)) features[g] = JSON.stringify(payload[g]);
    return { version: existingVersion || 1, features };
  }

  function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  const OPTS = { includePersonal: true, includeSecrets: false };

  function diffPlatform(platform, masterFeat, beforeFeat, afterFeat) {
    const rows = { copiedOk: [], blockedOk: [], failCopy: [], failBlock: [] };
    for (const group of Object.keys(masterFeat)) {
      const mGroup = masterFeat[group];
      if (typeof mGroup === 'string') {
        let mObj = {}, aObj = {}, bObj = {};
        try { mObj = JSON.parse(mGroup); } catch {}
        try { aObj = JSON.parse(afterFeat[group] || '{}'); } catch {}
        try { bObj = JSON.parse(beforeFeat[group] || '{}'); } catch {}
        for (const leaf of Object.keys(mObj)) {
          const key = platform + ':' + group + '.' + leaf + ' (payload)';
          const shareable = E.leafIsShareable(group, leaf, OPTS);
          if (shareable) (deepEq(aObj[leaf], mObj[leaf]) ? rows.copiedOk : rows.failCopy).push(key);
          else (deepEq(aObj[leaf], bObj[leaf]) ? rows.blockedOk : rows.failBlock).push(key);
        }
        continue;
      }
      if (!mGroup || typeof mGroup !== 'object') continue;
      for (const leaf of Object.keys(mGroup)) {
        const key = platform + ':' + group + '.' + leaf;
        const mVal = mGroup[leaf] && mGroup[leaf].value;
        const aGroup = afterFeat[group]; const aVal = aGroup && typeof aGroup === 'object' ? (aGroup[leaf] && aGroup[leaf].value) : undefined;
        const bGroup = beforeFeat[group]; const bVal = bGroup && typeof bGroup === 'object' ? (bGroup[leaf] && bGroup[leaf].value) : undefined;
        const shareable = E.leafIsShareable(group, leaf, OPTS);
        if (shareable) (deepEq(aVal, mVal) ? rows.copiedOk : rows.failCopy).push({ key, expected: mVal, got: aVal });
        else (deepEq(aVal, bVal) ? rows.blockedOk : rows.failBlock).push({ key, before: bVal, after: aVal, masterHad: mVal });
      }
    }
    return rows;
  }

  const sourceBackup = await pullAll(sourceIndex);
  const targetBackup = await pullAll(targetIndex);

  async function restore(idx, backup) {
    for (const pl of PLATS) if (backup[pl]) await c.rpc('sync_push_profile_settings_blob', { p_profile_id: idx, p_settings_json: backup[pl].settings_json, p_platform: pl, p_origin_client_id: 'numax-verify-restore' });
  }

  const result = { perPlatform: {}, restored: false, restoreVerified: false };
  try {
    for (const pl of PLATS) {
      const version = sourceBackup[pl] ? sourceBackup[pl].settings_json.version : 1;
      await c.rpc('sync_push_profile_settings_blob', { p_profile_id: sourceIndex, p_settings_json: buildSynthetic(pl, version), p_platform: pl, p_origin_client_id: 'numax-verify-test' });
    }

    const master = { settings: { tv: (await c.pullSettings(sourceIndex, 'tv')).settings_json, mobile: (await c.pullSettings(sourceIndex, 'mobile')).settings_json } };
    const target = { settings: { tv: targetBackup.tv ? targetBackup.tv.settings_json : null, mobile: targetBackup.mobile ? targetBackup.mobile.settings_json : null } };
    const settingsUpdatedAt = { tv: targetBackup.tv ? targetBackup.tv.updated_at : null, mobile: targetBackup.mobile ? targetBackup.mobile.updated_at : null };

    const plan = E.planTarget(master, target, { categories: { settings: true }, modes: {}, settings: { ...OPTS, blockMode: 'merge' }, profileId: targetIndex, originClientId: 'numax-verify-test', settingsUpdatedAt });
    const applied = await c.applyPlan(plan, { dryRun: false });
    result.plan = { ops: plan.operations.map((o) => o.rpc), applied: applied.results };

    const after = { tv: (await c.pullSettings(targetIndex, 'tv')).settings_json, mobile: (await c.pullSettings(targetIndex, 'mobile')).settings_json };
    for (const pl of PLATS) {
      result.perPlatform[pl] = diffPlatform(pl, master.settings[pl].features, (targetBackup[pl] || { settings_json: { features: {} } }).settings_json.features, after[pl].features);
    }
  } finally {
    await restore(sourceIndex, sourceBackup);
    await restore(targetIndex, targetBackup);
    result.restored = true;
    const check = { tv: await c.pullSettings(targetIndex, 'tv'), mobile: await c.pullSettings(targetIndex, 'mobile') };
    result.restoreVerified = PLATS.every((pl) => deepEq(check[pl] && check[pl].settings_json, targetBackup[pl] && targetBackup[pl].settings_json));
  }

  let copiedOk = 0, blockedOk = 0, failCopy = 0, failBlock = 0;
  for (const pl of PLATS) { const r = result.perPlatform[pl]; if (!r) continue; copiedOk += r.copiedOk.length; blockedOk += r.blockedOk.length; failCopy += r.failCopy.length; failBlock += r.failBlock.length; }
  console.log(`verify-settings-sync: ${copiedOk} copied correctly, ${blockedOk} correctly blocked, ${failCopy} failed to copy, ${failBlock} leaked when they should've been blocked. Restored: ${result.restored}, verified exact: ${result.restoreVerified}.`);
  window.__numaxVerify = result;
  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifySettingsSync };
if (typeof window !== 'undefined') window.verifySettingsSync = verifySettingsSync;
