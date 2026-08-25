// ============================================================
// Numax app controller  (app.js)
// Wires the vault (store), the client (api), and the engine to the UI.
// Nothing writes until Preview -> (confirm if removals) -> Apply.
// ============================================================
(function () {
  const E = window.NumaxEngine, A = window.NumaxApi, S = window.NumaxStore;
  const store = S.makeStore(window.localStorage);
  const $ = (id) => document.getElementById(id);

  const cache = {};        // accountId -> { backup, profiles:[{index,name}] }
  const masterCache = {};  // "acct:idx" -> master snapshot
  let currentMaster = null; // { accountId, profileIndex, snapshot }
  let lastPlans = null;

  const setStatus = (el, msg, cls) => { el.textContent = msg || ''; el.className = 'status' + (cls ? ' ' + cls : ''); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };

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

  // ---------- data loading ----------
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

  async function buildMaster(accountId, profileIndex) {
    const key = accountId + ':' + profileIndex;
    if (masterCache[key]) return masterCache[key];
    const c = A.client(store, accountId);
    const { backup } = await loadAccount(accountId);
    const base = c.sliceProfile(backup, profileIndex);
    const settings = {};
    for (const platform of ['tv', 'mobile']) {
      const row = await c.pullSettings(profileIndex, platform);
      if (row && row.settings_json) settings[platform] = row.settings_json;
    }
    const snap = { addons: base.addons, plugins: base.plugins, collections: base.collections, settings };
    masterCache[key] = snap;
    return snap;
  }

  // ---------- accounts render ----------
  async function refreshAccounts() {
    const list = store.list();
    $('acct-count').textContent = list.length;
    const box = $('accounts');
    if (!list.length) { box.innerHTML = '<p class="empty">No accounts linked yet.</p>'; }
    else {
      box.innerHTML = '';
      list.forEach((rec) => {
        const div = document.createElement('div');
        div.className = 'acct';
        div.innerHTML = '<span class="em">' + esc(rec.email || rec.accountId.slice(0, 10)) + '</span>' +
          '<span class="idpill">' + esc(rec.accountId.slice(0, 8)) + '\u2026</span>';
        const rm = document.createElement('button');
        rm.className = 'ghost sm'; rm.textContent = 'Unlink';
        rm.onclick = () => { store.remove(rec.accountId); delete cache[rec.accountId]; refreshAccounts(); };
        div.appendChild(rm);
        box.appendChild(div);
      });
    }
    await rebuildMasterAccountOptions();
  }

  async function rebuildMasterAccountOptions() {
    const list = store.list();
    const ma = $('master-account');
    const prev = ma.value;
    ma.innerHTML = list.map((r) => '<option value="' + esc(r.accountId) + '">' + esc(r.email || r.accountId.slice(0, 10)) + '</option>').join('');
    if (prev && list.some((r) => r.accountId === prev)) ma.value = prev;
    await onMasterChanged(true); // account (re)selected -> reset profile list
  }

  // ---------- master selection ----------
  async function onMasterChanged(resetProfile) {
    const accountId = $('master-account').value;
    const mp = $('master-profile');
    if (!accountId) { mp.innerHTML = ''; $('master-contents').innerHTML = ''; await rebuildTargets(); return; }
    let profiles = [];
    try { profiles = (await loadAccount(accountId)).profiles; }
    catch (e) { setStatus($('global-status'), 'Could not load profiles: ' + e.message, 'err'); }
    const prev = mp.value;
    mp.innerHTML = profiles.map((p) => '<option value="' + p.index + '">' + esc(p.name) + '</option>').join('');
    // Only keep the previous profile when staying on the same account; on an
    // account switch, default to that account's first profile.
    if (!resetProfile && prev && profiles.some((p) => String(p.index) === prev)) mp.value = prev;
    else if (profiles.length) mp.selectedIndex = 0;
    await renderMaster();
    await rebuildTargets();
  }

  async function renderMaster() {
    const accountId = $('master-account').value;
    const profileIndex = parseInt($('master-profile').value, 10);
    const box = $('master-contents');
    if (!accountId || isNaN(profileIndex)) { box.innerHTML = ''; currentMaster = null; return; }
    setStatus($('global-status'), 'Reading master profile\u2026');
    try {
      const snap = await buildMaster(accountId, profileIndex);
      currentMaster = { accountId, profileIndex, snapshot: snap };
      const incPersonal = $('settings-personal').checked;

      // settings: what would actually be shared (reuse the engine against an empty target)
      let settingsShared = 0, settingsHeld = 0; const settingGroups = new Set();
      for (const plat of Object.keys(snap.settings || {})) {
        const r = E.mergeSettingsBlob(snap.settings[plat], { version: 1, features: {} }, { includePersonal: incPersonal }).report;
        settingsShared += r.changed.length; settingsHeld += r.skippedSecrets.length;
        r.changed.forEach((c) => settingGroups.add(plat + '/' + c.split('.')[0]));
      }

      $('cnt-addons').textContent = (snap.addons || []).length;
      $('cnt-plugins').textContent = (snap.plugins || []).length;
      $('cnt-collections').textContent = (snap.collections || []).length;
      $('cnt-settings').textContent = settingsShared;

      const addonItems = (snap.addons || []).map((a) =>
        '<div class="item"><span class="dot' + (a.enabled ? '' : ' off') + '"></span><span class="txt">' + esc(a.name || host(a.url)) + '</span><span class="sub">' + esc(host(a.url)) + '</span></div>').join('');
      const pluginItems = (snap.plugins || []).map((p) =>
        '<div class="item"><span class="dot' + (p.enabled ? '' : ' off') + '"></span><span class="txt">' + esc(p.name || host(p.url)) + '</span><span class="sub">' + esc(host(p.url)) + '</span></div>').join('');
      const collItems = (snap.collections || []).map((c) =>
        '<div class="item"><span class="dot"></span><span class="txt">' + esc(c.title || c.name || c.id) + '</span></div>').join('');
      const settingItems = [...settingGroups].sort().map((g) =>
        '<div class="item"><span class="dot"></span><span class="txt">' + esc(g) + '</span></div>').join('');

      box.innerHTML =
        cbox('Addons', (snap.addons || []).length, addonItems, 'No addons on this profile.') +
        cbox('Plugins', (snap.plugins || []).length, pluginItems, 'No plugins on this profile.') +
        cbox('Collections', (snap.collections || []).length, collItems, 'No collections on this profile.') +
        cbox('Settings (shareable)', settingsShared, settingItems, 'No shareable settings.',
          settingsHeld ? '<div class="held">&#9888; ' + settingsHeld + ' secret / account field(s) will never be copied.</div>' : '');
      setStatus($('global-status'), '', '');
    } catch (e) { setStatus($('global-status'), 'Could not read master: ' + e.message, 'err'); }
  }

  function cbox(title, count, itemsHtml, emptyMsg, footer) {
    return '<details class="cbox"><summary><span class="chev">&#9656;</span>' + esc(title) +
      '<span class="chip">' + count + '</span></summary><div class="items">' +
      (itemsHtml || '<div class="empty">' + esc(emptyMsg) + '</div>') + '</div>' + (footer || '') + '</details>';
  }

  // ---------- targets ----------
  async function rebuildTargets() {
    const box = $('targets'); const list = store.list();
    if (!list.length) { box.innerHTML = '<p class="empty">Link an account and pick a master first.</p>'; return; }
    const mAcct = $('master-account').value, mIdx = parseInt($('master-profile').value, 10);
    box.innerHTML = '';
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const group = document.createElement('div'); group.className = 'tgroup';
      group.innerHTML = '<div class="ghead">' + esc(rec.email || rec.accountId.slice(0, 10)) + '</div>';
      let any = false;
      profiles.forEach((p) => {
        if (rec.accountId === mAcct && p.index === mIdx) return;
        any = true;
        const id = rec.accountId + ':' + p.index;
        const div = document.createElement('div'); div.className = 'target';
        div.innerHTML = '<input type="checkbox" class="tgt" value="' + esc(id) + '" checked />' +
          '<span class="nm">' + esc(p.name) + '</span>';
        group.appendChild(div);
      });
      if (any) box.appendChild(group);
    }
    if (!box.children.length) box.innerHTML = '<p class="empty">No other profiles to apply to yet.</p>';
  }

  function readOptions() {
    return {
      categories: { addons: $('cat-addons').checked, plugins: $('cat-plugins').checked, collections: $('cat-collections').checked, settings: $('cat-settings').checked },
      modes: { addons: $('mode-addons').value, plugins: $('mode-plugins').value, collections: $('mode-collections').value },
      settings: { includePersonal: $('settings-personal').checked },
      originClientId: 'numax-web',
    };
  }

  // ---------- preview / apply ----------
  async function preview() {
    setStatus($('global-status'), 'Reading profiles\u2026');
    $('results').innerHTML = ''; $('btn-apply').disabled = true;
    $('confirm-wrap').style.display = 'none'; $('confirm-removals').checked = false; lastPlans = null;
    if (!currentMaster) return setStatus($('global-status'), 'Pick a master profile.', 'err');
    const targets = Array.from(document.querySelectorAll('.tgt:checked')).map((c) => c.value);
    if (!targets.length) return setStatus($('global-status'), 'Pick at least one target profile.', 'err');
    const opts = readOptions();
    try {
      const master = currentMaster.snapshot;
      const plans = []; let anyRemovals = false;
      for (const tid of targets) {
        const [accountId, idxStr] = tid.split(':'); const profileIndex = parseInt(idxStr, 10);
        const c = A.client(store, accountId); const { backup } = await loadAccount(accountId);
        const state = c.sliceProfile(backup, profileIndex); state.settings = {}; const updatedAt = {};
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
      lastPlans = plans; renderReports(plans);
      if (anyRemovals) $('confirm-wrap').style.display = 'block';
      setStatus($('global-status'), 'Preview ready \u2014 review below, then Apply.', 'ok');
      updateApplyGate();
    } catch (e) { setStatus($('global-status'), e.message, 'err'); }
  }

  const line = (cls, label, arr) => (!arr || !arr.length) ? '' :
    '<div class="chg"><span class="' + cls + '">' + label + ' (' + arr.length + '):</span> ' + esc(arr.join(', ')) + '</div>';

  function renderReports(plans) {
    const box = $('results'); box.innerHTML = '';
    plans.forEach(({ tid, plan }) => {
      const r = plan.report; const div = document.createElement('div'); div.className = 'report';
      let html = '<h3>' + esc(tid) + (plan.hasChanges ? '' : ' <span class="nochg">no changes</span>') + '</h3>';
      ['addons', 'plugins'].forEach((k) => { if (r[k]) html += line('add', k + ' add', r[k].added) + line('upd', k + ' update', r[k].updated) + line('rem', k + ' REMOVE', r[k].removed) + line('kep', k + ' keep-local', r[k].keptLocal); });
      if (r.collections) html += line('add', 'collections add', r.collections.added) + line('rem', 'collections REMOVE', r.collections.removed) + line('kep', 'collections keep-local', r.collections.keptLocal);
      if (r.settings) for (const plat of Object.keys(r.settings)) {
        const s = r.settings[plat]; html += line('upd', 'settings/' + plat + ' change', s.changed);
        if (s.skippedSecrets && s.skippedSecrets.length) html += '<div class="chg kep">held back ' + s.skippedSecrets.length + ' secret/identity field(s)</div>';
      }
      div.innerHTML = html; box.appendChild(div);
    });
  }

  function updateApplyGate() {
    const needsConfirm = $('confirm-wrap').style.display === 'block';
    $('btn-apply').disabled = !lastPlans || (needsConfirm && !$('confirm-removals').checked);
  }

  async function apply() {
    if (!lastPlans) return;
    $('btn-apply').disabled = true; setStatus($('global-status'), 'Applying\u2026');
    let ok = 0, fail = 0;
    for (const { accountId, plan } of lastPlans) {
      if (!plan.hasChanges) continue;
      const c = A.client(store, accountId);
      const res = await c.applyPlan(plan, { dryRun: false });
      (res.results || []).forEach((r) => { r.ok ? ok++ : fail++; });
    }
    Object.keys(cache).forEach((k) => delete cache[k]);
    Object.keys(masterCache).forEach((k) => delete masterCache[k]);
    setStatus($('global-status'), 'Done. ' + ok + ' change(s) applied' + (fail ? ', ' + fail + ' failed (see console).' : '.'), fail ? 'err' : 'ok');
    lastPlans = null; await rebuildTargets();
  }

  // ---------- wire ----------
  window.addEventListener('DOMContentLoaded', () => {
    $('btn-link').onclick = linkWithPassword;
    $('btn-link-paste').onclick = linkWithPaste;
    $('master-account').addEventListener('change', () => onMasterChanged(true));
    $('master-profile').addEventListener('change', () => onMasterChanged(false));
    $('settings-personal').addEventListener('change', renderMaster);
    $('btn-preview').onclick = preview;
    $('btn-apply').onclick = apply;
    $('confirm-removals').onchange = updateApplyGate;
    refreshAccounts();
  });
})();
