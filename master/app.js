// ============================================================
// Numax app controller  (app.js)
// Wires the vault (store), the client (api), and the engine to the UI.
// Nothing writes until Preview -> (confirm if removals) -> Apply.
// ============================================================
(function () {
  const E = window.NumaxEngine, A = window.NumaxApi, S = window.NumaxStore;
  const store = S.makeStore(window.localStorage);
  const $ = (id) => document.getElementById(id);

  // cache per account: { backup, profiles:[{index,name}] }
  const cache = {};
  let lastPlans = null; // array of { accountId, plan }

  function setStatus(el, msg, cls) { el.textContent = msg || ''; el.className = 'status' + (cls ? ' ' + cls : ''); }

  // ---------- linking ----------
  async function linkWithPassword() {
    const email = $('link-email').value.trim();
    const password = $('link-password').value;
    if (!email || !password) return setStatus($('link-status'), 'Enter email and password.', 'err');
    setStatus($('link-status'), 'Signing in…');
    try {
      const session = await A.signIn(email, password);
      store.add(session, { email });
      $('link-email').value = ''; $('link-password').value = '';
      setStatus($('link-status'), 'Linked ' + email + '.', 'ok');
      await refreshAccounts();
    } catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }

  async function linkWithPaste() {
    let raw;
    try { raw = JSON.parse($('paste-json').value); } catch { return setStatus($('link-status'), 'That is not valid JSON.', 'err'); }
    try {
      store.add(raw, {});
      $('paste-json').value = '';
      setStatus($('link-status'), 'Linked from token.', 'ok');
      await refreshAccounts();
    } catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }

  // ---------- account + profile loading ----------
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

  async function refreshAccounts() {
    const list = store.list();
    const box = $('accounts');
    if (!list.length) { box.innerHTML = '<p class="muted">No accounts linked yet.</p>'; }
    else {
      box.innerHTML = '';
      list.forEach((rec) => {
        const div = document.createElement('div');
        div.className = 'acct';
        div.innerHTML = '<span style="flex:1">' + (rec.email || rec.accountId.slice(0, 8) + '…') +
          '</span><span class="pill">' + rec.accountId.slice(0, 8) + '…</span>';
        const rm = document.createElement('button');
        rm.className = 'ghost'; rm.textContent = 'Unlink'; rm.style.flex = '0 0 auto';
        rm.onclick = () => { store.remove(rec.accountId); delete cache[rec.accountId]; refreshAccounts(); };
        div.appendChild(rm);
        box.appendChild(div);
      });
    }
    await rebuildMasterAndTargets();
  }

  async function rebuildMasterAndTargets() {
    const list = store.list();
    // master account dropdown
    const ma = $('master-account');
    const prevAcct = ma.value;
    ma.innerHTML = list.map((r) => '<option value="' + r.accountId + '">' + (r.email || r.accountId.slice(0, 8) + '…') + '</option>').join('');
    if (prevAcct && list.some((r) => r.accountId === prevAcct)) ma.value = prevAcct;
    await populateMasterProfiles();
    await rebuildTargets();
  }

  async function populateMasterProfiles() {
    const mp = $('master-profile');
    const accountId = $('master-account').value;
    if (!accountId) { mp.innerHTML = ''; return; }
    try {
      const { profiles } = await loadAccount(accountId);
      const prev = mp.value;
      mp.innerHTML = profiles.map((p) => '<option value="' + p.index + '">' + p.name + '</option>').join('');
      if (prev) mp.value = prev;
    } catch (e) { setStatus($('global-status'), 'Could not load profiles: ' + e.message, 'err'); }
  }

  async function rebuildTargets() {
    const box = $('targets');
    const list = store.list();
    if (!list.length) { box.innerHTML = '<p class="muted">Link an account and pick a master first.</p>'; return; }
    const masterAcct = $('master-account').value;
    const masterIdx = parseInt($('master-profile').value, 10);
    box.innerHTML = '';
    for (const rec of list) {
      let profiles;
      try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      profiles.forEach((p) => {
        if (rec.accountId === masterAcct && p.index === masterIdx) return; // skip the master itself
        const id = rec.accountId + ':' + p.index;
        const div = document.createElement('div');
        div.className = 'target';
        div.innerHTML = '<input type="checkbox" class="tgt" value="' + id + '" checked /> ' +
          '<span style="flex:1">' + p.name + '</span><span class="pill">' + (rec.email || rec.accountId.slice(0, 6)) + '</span>';
        box.appendChild(div);
      });
    }
    if (!box.children.length) box.innerHTML = '<p class="muted">No other profiles to apply to yet.</p>';
  }

  // ---------- master snapshot ----------
  async function buildMaster(accountId, profileIndex) {
    const c = A.client(store, accountId);
    const { backup } = await loadAccount(accountId);
    const base = c.sliceProfile(backup, profileIndex);
    const settings = {};
    for (const platform of ['tv', 'mobile']) {
      const row = await c.pullSettings(profileIndex, platform);
      if (row && row.settings_json) settings[platform] = row.settings_json;
    }
    return { addons: base.addons, plugins: base.plugins, collections: base.collections, settings };
  }

  function readOptions() {
    return {
      categories: {
        addons: $('cat-addons').checked, plugins: $('cat-plugins').checked,
        collections: $('cat-collections').checked, settings: $('cat-settings').checked,
      },
      modes: { addons: $('mode-addons').value, plugins: $('mode-plugins').value, collections: $('mode-collections').value },
      settings: { includePersonal: $('settings-personal').checked },
      originClientId: 'numax-web',
    };
  }

  // ---------- preview (dry-run) ----------
  async function preview() {
    setStatus($('global-status'), 'Reading profiles…');
    $('results').innerHTML = ''; $('btn-apply').disabled = true;
    $('confirm-wrap').style.display = 'none'; $('confirm-removals').checked = false;
    lastPlans = null;

    const masterAcct = $('master-account').value;
    const masterIdx = parseInt($('master-profile').value, 10);
    if (!masterAcct || isNaN(masterIdx)) return setStatus($('global-status'), 'Pick a master profile.', 'err');

    const targets = Array.from(document.querySelectorAll('.tgt:checked')).map((c) => c.value);
    if (!targets.length) return setStatus($('global-status'), 'Pick at least one target profile.', 'err');

    const opts = readOptions();
    try {
      const master = await buildMaster(masterAcct, masterIdx);
      const plans = [];
      let anyRemovals = false;

      for (const tid of targets) {
        const [accountId, idxStr] = tid.split(':');
        const profileIndex = parseInt(idxStr, 10);
        const c = A.client(store, accountId);
        const { backup } = await loadAccount(accountId);
        const state = c.sliceProfile(backup, profileIndex);
        // live settings pull for real values + updated_at
        state.settings = {}; const updatedAt = {};
        if (opts.categories.settings) {
          for (const platform of ['tv', 'mobile']) {
            const row = await c.pullSettings(profileIndex, platform);
            if (row && row.settings_json) { state.settings[platform] = row.settings_json; updatedAt[platform] = row.updated_at; }
          }
        }
        const plan = E.planTarget(master, state, { ...opts, profileId: profileIndex, settingsUpdatedAt: updatedAt });
        if (plan.hasRemovals) anyRemovals = true;
        plans.push({ accountId, tid, plan });
      }

      lastPlans = plans;
      renderReports(plans);
      if (anyRemovals) $('confirm-wrap').style.display = 'block';
      $('btn-apply').disabled = false;
      setStatus($('global-status'), 'Preview ready — review below, then Apply.', 'ok');
      updateApplyGate();
    } catch (e) { setStatus($('global-status'), e.message, 'err'); }
  }

  function line(cls, label, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="chg"><span class="' + cls + '">' + label + ' (' + arr.length + '):</span> ' + arr.join(', ') + '</div>';
  }

  function renderReports(plans) {
    const box = $('results'); box.innerHTML = '';
    plans.forEach(({ tid, plan }) => {
      const r = plan.report;
      const div = document.createElement('div'); div.className = 'report';
      let html = '<h3>' + tid + (plan.hasChanges ? '' : ' — no changes') + '</h3>';
      ['addons', 'plugins'].forEach((k) => {
        if (r[k]) html += line('add', k + ' add', r[k].added) + line('upd', k + ' update', r[k].updated) +
          line('rem', k + ' REMOVE', r[k].removed) + line('kep', k + ' keep-local', r[k].keptLocal);
      });
      if (r.collections) html += line('add', 'collections add', r.collections.added) +
        line('rem', 'collections REMOVE', r.collections.removed) + line('kep', 'collections keep-local', r.collections.keptLocal);
      if (r.settings) {
        for (const plat of Object.keys(r.settings)) {
          const s = r.settings[plat];
          html += line('upd', 'settings/' + plat + ' change', s.changed);
          if (s.skippedSecrets && s.skippedSecrets.length)
            html += '<div class="chg muted">held back ' + s.skippedSecrets.length + ' secret/identity field(s)</div>';
        }
      }
      div.innerHTML = html;
      box.appendChild(div);
    });
  }

  function updateApplyGate() {
    const needsConfirm = $('confirm-wrap').style.display === 'block';
    $('btn-apply').disabled = !lastPlans || (needsConfirm && !$('confirm-removals').checked);
  }

  // ---------- apply ----------
  async function apply() {
    if (!lastPlans) return;
    $('btn-apply').disabled = true;
    setStatus($('global-status'), 'Applying…');
    let ok = 0, fail = 0;
    for (const { accountId, tid, plan } of lastPlans) {
      if (!plan.hasChanges) continue;
      const c = A.client(store, accountId);
      const res = await c.applyPlan(plan, { dryRun: false });
      (res.results || []).forEach((r) => { r.ok ? ok++ : fail++; });
    }
    // invalidate caches (state changed) and re-read
    Object.keys(cache).forEach((k) => delete cache[k]);
    setStatus($('global-status'), 'Done. ' + ok + ' change(s) applied' + (fail ? ', ' + fail + ' failed (see console).' : '.'), fail ? 'err' : 'ok');
    lastPlans = null;
    await rebuildTargets();
  }

  // ---------- wire up ----------
  window.addEventListener('DOMContentLoaded', () => {
    $('btn-link').onclick = linkWithPassword;
    $('btn-link-paste').onclick = linkWithPaste;
    $('master-account').onchange = async () => { await populateMasterProfiles(); await rebuildTargets(); };
    $('master-profile').onchange = rebuildTargets;
    $('btn-preview').onclick = preview;
    $('btn-apply').onclick = apply;
    $('confirm-removals').onchange = updateApplyGate;
    refreshAccounts();
  });
})();
