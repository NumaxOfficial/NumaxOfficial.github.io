// ============================================================
// Numax app controller  (app.js)
// Vault (store) + client (api) + engine, wired to the two-pane UI with a
// live before/after preview. Nothing writes until Preview -> (confirm) -> Apply.
// ============================================================
(function () {
  const E = window.NumaxEngine, A = window.NumaxApi, S = window.NumaxStore;
  const store = S.makeStore(window.localStorage);
  const $ = (id) => document.getElementById(id);

  const cache = {};        // accountId -> { backup, profiles:[{index,name}] }
  const masterCache = {};  // "acct:idx" -> master snapshot
  let currentMaster = null;
  let lastPlans = null;    // [{ accountId, tid, plan }]
  let previewMode = 'current';

  const setStatus = (el, m, c) => { el.textContent = m || ''; el.className = 'status' + (c ? ' ' + c : ''); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
  const CAT_COLOR = { addons: 'var(--blue)', plugins: 'var(--purple)', collections: 'var(--teal)', settings: 'var(--amber)' };

  const accountEmail = (id) => { const r = store.get(id); return (r && r.email) || (id.slice(0, 8) + '\u2026'); };
  const profileName = (id, idx) => { const c = cache[id]; const p = c && c.profiles.find((x) => x.index === idx); return p ? p.name : ('Profile ' + idx); };
  const labelForTid = (tid) => { const [id, i] = tid.split(':'); return profileName(id, parseInt(i, 10)) + ' \u2014 ' + accountEmail(id); };

  // ---------- linking ----------
  async function linkWithPassword() {
    const email = $('link-email').value.trim(), password = $('link-password').value;
    if (!email || !password) return setStatus($('link-status'), 'Enter email and password.', 'err');
    setStatus($('link-status'), 'Signing in\u2026');
    try {
      const session = await A.signIn(email, password);
      store.add(session, { email });
      $('link-email').value = ''; $('link-password').value = '';
      setStatus($('link-status'), 'Linked ' + email + '.', 'ok');
      await refreshAccounts();
    } catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }
  async function linkWithPaste() {
    let raw; try { raw = JSON.parse($('paste-json').value); } catch { return setStatus($('link-status'), 'That is not valid JSON.', 'err'); }
    try { store.add(raw, {}); $('paste-json').value = ''; setStatus($('link-status'), 'Linked from token.', 'ok'); await refreshAccounts(); }
    catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }

  // ---------- data ----------
  async function loadAccount(accountId) {
    if (cache[accountId]) return cache[accountId];
    const c = A.client(store, accountId);
    const backup = await c.exportBackup();
    const profiles = (backup.profiles || [])
      .map((p) => ({ index: p.profile_index, name: p.name || ('Profile ' + p.profile_index) }))
      .sort((a, b) => a.index - b.index);
    cache[accountId] = { backup, profiles };
    return cache[accountId];
  }

  // synchronous slice for display (from cached backup; no network)
  function displayState(accountId, idx) {
    const backup = (cache[accountId] || {}).backup || {};
    const pick = (arr) => (Array.isArray(arr) ? arr.filter((r) => r.profile_id === idx) : []);
    const collRow = pick(backup.collections)[0];
    const sBlobs = {};
    pick(backup.profile_settings_blobs).forEach((r) => { if (r.settings_json) sBlobs[r.platform] = r.settings_json; });
    const groups = new Set();
    Object.values(sBlobs).forEach((b) => Object.keys((b && b.features) || {}).forEach((g) => groups.add(g)));
    return {
      addons: pick(backup.addons), plugins: pick(backup.plugins),
      collections: (collRow && collRow.collections_json) || [],
      settingGroups: [...groups].sort(),
    };
  }

  async function buildMaster(accountId, profileIndex) {
    const key = accountId + ':' + profileIndex;
    if (masterCache[key]) return masterCache[key];
    const c = A.client(store, accountId);
    const { backup } = await loadAccount(accountId);
    const base = c.sliceProfile(backup, profileIndex);
    const settings = {};
    for (const platform of ['tv', 'mobile']) { const row = await c.pullSettings(profileIndex, platform); if (row && row.settings_json) settings[platform] = row.settings_json; }
    const snap = { addons: base.addons, plugins: base.plugins, collections: base.collections, settings };
    masterCache[key] = snap; return snap;
  }

  // ---------- accounts ----------
  async function refreshAccounts() {
    const list = store.list();
    $('acct-count').textContent = list.length;
    const box = $('accounts');
    if (!list.length) box.innerHTML = '<p class="pv-empty">No accounts linked yet.</p>';
    else {
      box.innerHTML = '';
      list.forEach((rec) => {
        const div = document.createElement('div'); div.className = 'acct';
        div.innerHTML = '<span class="em">' + esc(rec.email || rec.accountId.slice(0, 10)) + '</span>';
        const rm = document.createElement('button'); rm.className = 'ghost sm'; rm.textContent = 'Unlink';
        rm.onclick = () => { store.remove(rec.accountId); delete cache[rec.accountId]; refreshAccounts(); };
        div.appendChild(rm); box.appendChild(div);
      });
    }
    await rebuildMasterAccountOptions();
  }

  async function rebuildMasterAccountOptions() {
    const list = store.list(); const ma = $('master-account'); const prev = ma.value;
    ma.innerHTML = list.map((r) => '<option value="' + esc(r.accountId) + '">' + esc(r.email || r.accountId.slice(0, 10)) + '</option>').join('');
    if (prev && list.some((r) => r.accountId === prev)) ma.value = prev;
    await onMasterChanged(true);
  }

  async function onMasterChanged(resetProfile) {
    const accountId = $('master-account').value; const mp = $('master-profile');
    if (!accountId) { mp.innerHTML = ''; currentMaster = null; await rebuildTargets(); await populatePreview(); return; }
    let profiles = [];
    try { profiles = (await loadAccount(accountId)).profiles; } catch (e) { setStatus($('global-status'), 'Could not load profiles: ' + e.message, 'err'); }
    const prev = mp.value;
    mp.innerHTML = profiles.map((p) => '<option value="' + p.index + '">' + esc(p.name) + '</option>').join('');
    if (!resetProfile && prev && profiles.some((p) => String(p.index) === prev)) mp.value = prev;
    else if (profiles.length) mp.selectedIndex = 0;
    await renderMaster(); await rebuildTargets(); await populatePreview();
  }

  async function renderMaster() {
    const accountId = $('master-account').value, profileIndex = parseInt($('master-profile').value, 10);
    if (!accountId || isNaN(profileIndex)) { currentMaster = null; return; }
    setStatus($('global-status'), 'Reading master\u2026');
    try {
      const snap = await buildMaster(accountId, profileIndex);
      currentMaster = { accountId, profileIndex, snapshot: snap };
      let sShared = 0; const incP = $('settings-personal').checked;
      for (const plat of Object.keys(snap.settings || {}))
        sShared += E.mergeSettingsBlob(snap.settings[plat], { version: 1, features: {} }, { includePersonal: incP }).report.changed.length;
      $('cnt-addons').textContent = (snap.addons || []).length;
      $('cnt-plugins').textContent = (snap.plugins || []).length;
      $('cnt-collections').textContent = (snap.collections || []).length;
      $('cnt-settings').textContent = sShared;
      setStatus($('global-status'), '', '');
    } catch (e) { setStatus($('global-status'), 'Could not read master: ' + e.message, 'err'); }
  }

  // ---------- targets ----------
  async function rebuildTargets() {
    const box = $('targets'); const list = store.list();
    if (!list.length) { box.innerHTML = '<p class="pv-empty">Link an account and pick a master first.</p>'; return; }
    const mAcct = $('master-account').value, mIdx = parseInt($('master-profile').value, 10);
    box.innerHTML = '';
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const g = document.createElement('div'); g.className = 'tgroup';
      g.innerHTML = '<div class="ghead">' + esc(rec.email || rec.accountId.slice(0, 10)) + '</div>';
      let any = false;
      profiles.forEach((p) => {
        if (rec.accountId === mAcct && p.index === mIdx) return; any = true;
        const div = document.createElement('div'); div.className = 'target';
        div.innerHTML = '<input type="checkbox" class="tgt" value="' + esc(rec.accountId + ':' + p.index) + '" checked /><span class="nm">' + esc(p.name) + '</span>';
        g.appendChild(div);
      });
      if (any) box.appendChild(g);
    }
    if (!box.children.length) box.innerHTML = '<p class="pv-empty">No other profiles to apply to yet.</p>';
  }

  function readOptions() {
    return {
      categories: { addons: $('cat-addons').checked, plugins: $('cat-plugins').checked, collections: $('cat-collections').checked, settings: $('cat-settings').checked },
      modes: { addons: $('mode-addons').value, plugins: $('mode-plugins').value, collections: $('mode-collections').value },
      settings: { includePersonal: $('settings-personal').checked }, originClientId: 'numax-web',
    };
  }

  // ---------- live preview ----------
  async function populatePreview() {
    const sel = $('preview-profile'); const list = store.list();
    const opts = [];
    for (const rec of list) { let ps; try { ps = (await loadAccount(rec.accountId)).profiles; } catch { continue; } ps.forEach((p) => opts.push(rec.accountId + ':' + p.index)); }
    const prev = sel.value;
    sel.innerHTML = opts.map((tid) => '<option value="' + esc(tid) + '">' + esc(labelForTid(tid)) + '</option>').join('');
    if (prev && opts.includes(prev)) sel.value = prev;
    else if (currentMaster) sel.value = currentMaster.accountId + ':' + currentMaster.profileIndex;
    renderPreview();
  }

  function planForTid(tid) { return lastPlans && lastPlans.find((p) => p.tid === tid); }

  function afterListFrom(plan, surface, current) {
    if (!plan) return current;
    const op = plan.plan.operations.find((o) => o.surface === surface);
    if (!op) return current;
    if (surface === 'addons') return op.params.p_addons;
    if (surface === 'plugins') return op.params.p_plugins;
    if (surface === 'collections') return op.params.p_collections_json;
    return current;
  }

  function diffRows(current, after, keyFn, labelFn, subFn) {
    const cur = new Map((current || []).map((x) => [keyFn(x), x]));
    const aft = new Map((after || []).map((x) => [keyFn(x), x]));
    const rows = [];
    (after || []).forEach((x) => rows.push({ label: labelFn(x), sub: subFn ? subFn(x) : '', enabled: x.enabled !== false, state: cur.has(keyFn(x)) ? 'same' : 'added' }));
    (current || []).forEach((x) => { if (!aft.has(keyFn(x))) rows.push({ label: labelFn(x), sub: subFn ? subFn(x) : '', enabled: x.enabled !== false, state: 'removed' }); });
    return rows;
  }

  function rowHtml(r) {
    const mk = r.state === 'added' ? '+' : r.state === 'removed' ? '\u2212' : '';
    return '<div class="pv-item ' + r.state + '"><span class="mk">' + mk + '</span>' +
      (r.state === 'removed' ? '' : '<span class="dot' + (r.enabled ? '' : ' off') + '"></span>') +
      '<span class="txt">' + esc(r.label) + '</span>' + (r.sub ? '<span class="sub">' + esc(r.sub) + '</span>' : '') + '</div>';
  }

  function pvCard(title, color, count, rowsHtml, emptyMsg) {
    return '<div class="pv-card"><div class="h"><span class="dotc" style="background:' + color + '"></span>' + esc(title) +
      '<span class="n">' + count + '</span></div><div class="pv-list">' +
      (rowsHtml || '<div class="pv-empty">' + esc(emptyMsg) + '</div>') + '</div></div>';
  }

  function renderPreview() {
    const body = $('preview-body'); const tid = $('preview-profile').value;
    if (!tid) { body.innerHTML = '<div class="pv-blank">Link an account to preview a profile.</div>'; return; }
    const [accountId, idxStr] = tid.split(':'); const idx = parseInt(idxStr, 10);
    const st = displayState(accountId, idx);
    const after = previewMode === 'after';
    const plan = after ? planForTid(tid) : null;

    if (after && !plan) {
      body.innerHTML = '<p class="pv-note">Showing <b>' + esc(labelForTid(tid)) + '</b>. No projected changes yet \u2014 run <b>Preview</b> with this profile selected as a target.</p>' + renderCards(st, null);
      return;
    }
    const note = after
      ? '<p class="pv-note">Projected state of <b>' + esc(labelForTid(tid)) + '</b> after applying the master. <span class="tag-a">green = added</span>, <span class="tag-r">red = removed</span>.</p>'
      : '<p class="pv-note">Current state of <b>' + esc(labelForTid(tid)) + '</b>.</p>';
    body.innerHTML = note + renderCards(st, plan);
  }

  function renderCards(st, plan) {
    const aA = afterListFrom(plan, 'addons', st.addons);
    const aP = afterListFrom(plan, 'plugins', st.plugins);
    const aC = afterListFrom(plan, 'collections', st.collections);
    const addonRows = diffRows(st.addons, aA, (x) => x.url, (x) => x.name || host(x.url), (x) => host(x.url));
    const pluginRows = diffRows(st.plugins, aP, (x) => x.url, (x) => x.name || host(x.url), (x) => host(x.url));
    const collRows = diffRows(st.collections, aC, (x) => x.id != null ? 'id:' + x.id : 'n:' + (x.title || x.name), (x) => x.title || x.name || x.id);

    let settingsCard;
    if (plan && plan.plan.report.settings) {
      const s = plan.plan.report.settings; const parts = [];
      for (const plat of Object.keys(s)) parts.push('<div class="pv-item"><span class="mk">+</span><span class="txt">' + plat + ': <span class="tag-u">' + s[plat].changed.length + ' changed</span>' + (s[plat].skippedSecrets.length ? ' &middot; <span class="tag-h">' + s[plat].skippedSecrets.length + ' held back</span>' : '') + '</span></div>');
      settingsCard = pvCard('Settings', CAT_COLOR.settings, '', parts.join(''), 'No settings changes.');
    } else {
      const rows = st.settingGroups.map((g) => '<div class="pv-item"><span class="mk"></span><span class="dot"></span><span class="txt">' + esc(g) + '</span></div>').join('');
      settingsCard = pvCard('Settings groups', CAT_COLOR.settings, st.settingGroups.length, rows, 'No settings configured.');
    }

    return '<div class="pv-cols">' +
      pvCard('Addons', CAT_COLOR.addons, (st.addons || []).length, addonRows.map(rowHtml).join(''), 'No addons.') +
      pvCard('Plugins', CAT_COLOR.plugins, (st.plugins || []).length, pluginRows.map(rowHtml).join(''), 'No plugins.') +
      pvCard('Collections', CAT_COLOR.collections, (st.collections || []).length, collRows.map(rowHtml).join(''), 'No collections.') +
      settingsCard + '</div>';
  }

  function setPreviewMode(mode) {
    previewMode = mode;
    $('pv-current').classList.toggle('on', mode === 'current');
    $('pv-after').classList.toggle('on', mode === 'after');
    renderPreview();
  }

  // ---------- preview (plan) / apply ----------
  async function preview() {
    setStatus($('global-status'), 'Reading profiles\u2026');
    $('results').innerHTML = ''; $('btn-apply').disabled = true;
    $('confirm-wrap').style.display = 'none'; $('confirm-removals').checked = false; lastPlans = null;
    if (!currentMaster) return setStatus($('global-status'), 'Pick a master profile.', 'err');
    const targets = Array.from(document.querySelectorAll('.tgt:checked')).map((c) => c.value);
    if (!targets.length) return setStatus($('global-status'), 'Pick at least one target profile.', 'err');
    const opts = readOptions();
    try {
      const master = currentMaster.snapshot; const plans = []; let anyRemovals = false;
      for (const tid of targets) {
        const [accountId, idxStr] = tid.split(':'); const profileIndex = parseInt(idxStr, 10);
        const c = A.client(store, accountId); const { backup } = await loadAccount(accountId);
        const state = c.sliceProfile(backup, profileIndex); state.settings = {}; const updatedAt = {};
        if (opts.categories.settings) for (const platform of ['tv', 'mobile']) {
          const row = await c.pullSettings(profileIndex, platform);
          if (row && row.settings_json) { state.settings[platform] = row.settings_json; updatedAt[platform] = row.updated_at; }
        }
        const plan = E.planTarget(master, state, { ...opts, profileId: profileIndex, settingsUpdatedAt: updatedAt });
        if (plan.hasRemovals) anyRemovals = true;
        plans.push({ accountId, tid, plan });
      }
      lastPlans = plans; renderReports(plans);
      if (anyRemovals) $('confirm-wrap').style.display = 'block';
      setStatus($('global-status'), 'Preview ready \u2014 review, then Apply.', 'ok');
      updateApplyGate();
      // jump the live preview to the first changed target, in After mode
      const firstChanged = plans.find((p) => p.plan.hasChanges) || plans[0];
      if (firstChanged) { $('preview-profile').value = firstChanged.tid; setPreviewMode('after'); }
    } catch (e) { setStatus($('global-status'), e.message, 'err'); }
  }

  function chgTag(cls, sign, arr) { return (arr && arr.length) ? '<span class="' + cls + '">' + sign + arr.length + '</span>' : ''; }

  function renderReports(plans) {
    const box = $('results'); box.innerHTML = '';
    plans.forEach(({ tid, plan }) => {
      const r = plan.report; const div = document.createElement('div'); div.className = 'report';
      let html = '<h3>' + esc(labelForTid(tid)) + (plan.hasChanges ? '<span class="badge chg">changes</span>' : '<span class="badge no">no changes</span>') + '</h3>';
      const catLine = (name, o) => {
        if (!o) return '';
        const bits = [chgTag('tag-a', '+', o.added), chgTag('tag-u', '~', o.updated), chgTag('tag-r', '\u2212', o.removed),
          (o.keptLocal && o.keptLocal.length ? '<span class="tag-k">keep ' + o.keptLocal.length + '</span>' : '')].filter(Boolean);
        return bits.length ? '<div class="sumline"><span class="k">' + name + '</span>' + bits.join(' &middot; ') + '</div>' : '';
      };
      html += catLine('Addons', r.addons) + catLine('Plugins', r.plugins) + catLine('Collections', r.collections);
      if (r.settings) {
        let ch = 0, held = 0; for (const p of Object.keys(r.settings)) { ch += r.settings[p].changed.length; held += r.settings[p].skippedSecrets.length; }
        if (ch || held) html += '<div class="sumline"><span class="k">Settings</span>' +
          (ch ? '<span class="tag-u">' + ch + ' fields</span>' : '') + (held ? '<span class="tag-h">' + held + ' held back</span>' : '') + '</div>';
      }
      div.innerHTML = html; box.appendChild(div);
    });
  }

  function updateApplyGate() {
    const needs = $('confirm-wrap').style.display === 'block';
    $('btn-apply').disabled = !lastPlans || (needs && !$('confirm-removals').checked);
  }

  async function apply() {
    if (!lastPlans) return;
    $('btn-apply').disabled = true; setStatus($('global-status'), 'Applying\u2026');
    let ok = 0, fail = 0;
    for (const { accountId, plan } of lastPlans) {
      if (!plan.hasChanges) continue;
      const res = await A.client(store, accountId).applyPlan(plan, { dryRun: false });
      (res.results || []).forEach((r) => { r.ok ? ok++ : fail++; });
    }
    Object.keys(cache).forEach((k) => delete cache[k]);
    Object.keys(masterCache).forEach((k) => delete masterCache[k]);
    setStatus($('global-status'), 'Done. ' + ok + ' change(s) applied' + (fail ? ', ' + fail + ' failed (see console).' : '.'), fail ? 'err' : 'ok');
    lastPlans = null;
    await rebuildTargets(); await renderMaster(); await populatePreview();
  }

  // ---------- wire ----------
  window.addEventListener('DOMContentLoaded', () => {
    $('btn-link').onclick = linkWithPassword;
    $('btn-link-paste').onclick = linkWithPaste;
    $('master-account').addEventListener('change', () => onMasterChanged(true));
    $('master-profile').addEventListener('change', () => onMasterChanged(false));
    $('settings-personal').addEventListener('change', renderMaster);
    $('preview-profile').addEventListener('change', renderPreview);
    $('pv-current').onclick = () => setPreviewMode('current');
    $('pv-after').onclick = () => setPreviewMode('after');
    $('btn-preview').onclick = preview;
    $('btn-apply').onclick = apply;
    $('confirm-removals').onchange = updateApplyGate;
    refreshAccounts();
  });
})();
