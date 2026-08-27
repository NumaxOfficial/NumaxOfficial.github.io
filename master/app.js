// ============================================================
// Numax website controller  (app.js)
//
// One cohesive app over the audited core modules (api / store / engine /
// meta), which are UNCHANGED. Nothing here reaches into their internals.
//
// Tabs:  Nuvio accounts · Profile · Sync desk · Google Drive · Activity · Settings
//   - Accounts : link several accounts (additive), rename / unlink, preview
//   - Profile  : load ONE profile and edit it in place (rename, add-ons,
//                plugins, collections, settings) then save to that profile
//   - Sync desk: pick a source profile, choose exactly what to carry, pick
//                target profiles, Merge or Overwrite, preview, apply
//   - Drive    : name + choose what to back up; list + restore backups
//   - Activity : a plain running log of everything that happened
//   - Settings : read-keys default, clear local data
//
// Every network failure is shown, never swallowed.
// ============================================================
(function () {
  'use strict';

  const A = window.NumaxApi, S = window.NumaxStore, E = window.NumaxEngine, M = window.NumaxMeta;
  const store = S.makeStore(window.localStorage);
  const $ = (id) => document.getElementById(id);

  // ---- read-time key stripping (ported verbatim from the extension) ----
  // Only strips leaves whose name pairs a known provider with key/token/secret/
  // client_id, so unrelated "*_id" leaves (preferred_resolver_provider_id) stay.
  const API_KEY_FIELD_STRIP = /(mdblist|tmdb|torbox|premiumize|animeskip|debrid).*(api_?key|token|secret|client_?id)/i;
  function stripKeyFields(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(stripKeyFields);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (API_KEY_FIELD_STRIP.test(k)) continue;
      out[k] = (v && typeof v === 'object') ? stripKeyFields(v) : v;
    }
    return out;
  }

  // secret / account / personal classification for the settings tree + engine.
  const SECRET_LEAF = (E && E.SECRET_LEAF) || /(api_?key|client_id|token|secret|access_token|refresh|password)/i;
  const ACCOUNT_GROUP = /^trakt_/i;              // account-linked, never shared
  const PERSONAL_GROUP = /^track_preference$/i;   // personal taste, opt-in

  const CAT_COLOR = { addons: 'var(--violet)', plugins: 'var(--teal)', collections: 'var(--marigold)', settings: 'var(--amber)' };

  // ======================================================================
  // state
  // ======================================================================
  const accountCache = {};   // accountId -> { backup, profiles:[...], keysLoaded }
  let readKeys = loadPref('numax.readKeys', false);   // "Read API keys" (display) toggle

  let pfAccount = null, pfIndex = null;   // Profile tab: current account + profile
  let pfEdit = null;                      // working copy being edited
  let pfDirty = { identity: false, addons: false, plugins: false, collections: false, settingsTv: false, settingsMobile: false };

  // Sync desk
  let syAccount = null, syIndex = null, sySnapshot = null;
  let sySel = { addons: new Set(), plugins: new Set(), collections: new Set(), settings: new Set() };
  const syTargets = new Set();
  let syPlans = null;

  // Drive
  let googleToken = null, googleClient = null, googleUser = null;

  // ======================================================================
  // small utilities
  // ======================================================================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
  const clear = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild); };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const status = (node, msg, cls) => { if (!node) return; node.textContent = msg || ''; node.className = 'inline-status' + (cls ? ' ' + cls : ''); };

  function loadPref(key, dflt) { try { const v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } }
  function savePref(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

  const humanize = (k) => (k || '')
    .replace(/_v\d+$/i, '').replace(/_settings$/i, '').replace(/_payload$/i, '')
    .replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase()).trim() || k;

  const leafType = (l) => (l && typeof l === 'object' && 'value' in l) ? (l.type || typeof l.value) : typeof l;
  const leafValue = (l) => (l && typeof l === 'object' && 'value' in l) ? l.value : l;
  function formatVal(l) {
    const v = leafValue(l);
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v === '' ? '(empty)' : (v.length > 44 ? v.slice(0, 41) + '…' : v);
    if (Array.isArray(v)) return v.length + ' item' + (v.length === 1 ? '' : 's');
    return JSON.stringify(v).slice(0, 44);
  }

  const collKey = (c) => (c && typeof c === 'object')
    ? (c.id != null ? 'id:' + c.id : (c.title != null ? 'title:' + c.title : (c.name != null ? 'name:' + c.name : 'json:' + JSON.stringify(c))))
    : 'json:' + JSON.stringify(c);
  const collLabel = (c) => (c && (c.title || c.name || (c.id != null ? 'Collection ' + c.id : null))) || 'Untitled collection';

  const accountName = (id) => { const r = store.get(id); return (r && (r.label || r.email)) || (id ? id.slice(0, 8) + '…' : ''); };

  function normalizeProfiles(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
    return list.map((p, i) => ({
      index: p.profile_index != null ? p.profile_index : (i + 1),
      name: p.name || p.display_name || ('Profile ' + (p.profile_index != null ? p.profile_index : i + 1)),
      avatarUrl: p.avatar_url || null,
      color: p.avatar_color_hex || null,
      avatarId: p.avatar_id || null,
      usesPrimaryAddons: !!p.uses_primary_addons,
      usesPrimaryPlugins: !!p.uses_primary_plugins,
      pinEnabled: !!p.pin_enabled,
    })).sort((a, b) => a.index - b.index);
  }

  function avatar(p, size) {
    const s = el('span', 'avatar');
    s.style.width = size + 'px'; s.style.height = size + 'px';
    s.style.fontSize = Math.round(size * 0.4) + 'px';
    s.style.background = (p && p.color) || 'linear-gradient(135deg,var(--amber),var(--marigold))';
    s.textContent = ((p && p.name) ? p.name.trim().charAt(0) : '?').toUpperCase() || '?';
    if (p && p.avatarUrl) { const img = document.createElement('img'); img.src = p.avatarUrl; img.alt = ''; img.onerror = () => img.remove(); s.appendChild(img); }
    return s;
  }

  // ======================================================================
  // activity log
  // ======================================================================
  const activity = [];
  function logAct(msg, level) {
    const entry = { t: Date.now(), msg, level: level || 'info' };
    activity.unshift(entry);
    if (activity.length > 300) activity.pop();
    (level === 'err' ? console.error : level === 'ok' ? console.log : console.info)('[Numax] ' + msg);
    if ($('act-list')) renderActivity();
  }
  function renderActivity() {
    const box = $('act-list'); clear(box);
    if (!activity.length) { box.appendChild(el('p', 'empty', 'Nothing has happened yet. Link an account to get started.')); return; }
    activity.forEach((a) => {
      const row = el('div', 'act-row ' + a.level);
      const time = new Date(a.t);
      row.appendChild(el('span', 'act-time', time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      row.appendChild(el('span', 'act-msg', a.msg));
      box.appendChild(row);
    });
  }

  // ======================================================================
  // toucan flight — one mascot that perches by the active tab and flies
  // to the tab you switch to.
  // ======================================================================
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mascotKey = 'accounts';
  function perchMascot(navKey, animate) {
    const mascot = $('mascot'); if (!mascot) return;
    const btn = document.querySelector('.navbtn[data-nav="' + navKey + '"]'); if (!btn) return;
    const r = btn.getBoundingClientRect();
    const mw = mascot.offsetWidth || 64, mh = mascot.offsetHeight || 58;
    const x = Math.round(r.right - mw * 0.42);
    const y = Math.round(r.top + r.height / 2 - mh / 2);
    if (!animate || reduceMotion) {
      mascot.style.transition = 'none';
      mascot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      // force reflow so the next animated move transitions from here
      void mascot.offsetWidth;
      mascot.style.transition = '';
    } else {
      mascot.classList.add('flying');
      mascot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      window.clearTimeout(perchMascot._t);
      perchMascot._t = window.setTimeout(() => mascot.classList.remove('flying'), 760);
    }
    mascotKey = navKey;
  }
  window.addEventListener('resize', () => perchMascot(mascotKey, false));

  // ======================================================================
  // views + nav
  // ======================================================================
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('current', v.id === id));
  }
  function enterApp() {
    showView('view-app');
    $('mascot').classList.add('in-app');
    refreshAccounts();
    navTo('accounts');
    requestAnimationFrame(() => perchMascot('accounts', false));
  }
  const PANEL_TITLE = { accounts: 'Nuvio accounts', profile: 'Profile', sync: 'Sync desk', drive: 'Google Drive', activity: 'Activity', settings: 'Settings' };
  function navTo(panel) {
    document.querySelectorAll('[data-panel]').forEach((p) => { p.style.display = p.dataset.panel === panel ? '' : 'none'; });
    document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('on', b.dataset.nav === panel));
    $('crumb-page').textContent = PANEL_TITLE[panel] || '';
    perchMascot(panel, true);
    if (panel === 'accounts') refreshAccounts();
    if (panel === 'profile') refreshProfileTab();
    if (panel === 'sync') refreshSyncTab();
    if (panel === 'drive') refreshDriveTab();
    if (panel === 'activity') renderActivity();
  }

  // ======================================================================
  // account loading  (+ read-keys strip)
  // ======================================================================
  async function loadAccount(accountId, force) {
    const cached = accountCache[accountId];
    if (cached && cached.keysLoaded === readKeys && !force) return cached;
    const c = A.client(store, accountId);
    const backup = await c.exportBackup();
    if (!readKeys && Array.isArray(backup.profile_settings_blobs)) {
      backup.profile_settings_blobs = backup.profile_settings_blobs.map((b) =>
        b && b.settings_json ? { ...b, settings_json: stripKeyFields(b.settings_json) } : b);
    }
    if (!readKeys && Array.isArray(backup.home_catalog_settings)) {
      backup.home_catalog_settings = backup.home_catalog_settings.map((b) =>
        b && b.settings_json ? { ...b, settings_json: stripKeyFields(b.settings_json) } : b);
    }
    const rec = { backup, profiles: normalizeProfiles(backup.profiles), keysLoaded: readKeys };
    accountCache[accountId] = rec;
    return rec;
  }
  function invalidateAccount(accountId) { delete accountCache[accountId]; }
  function invalidateAll() { Object.keys(accountCache).forEach((k) => delete accountCache[k]); }

  // one profile's live add-on/plugin/collection slice from a loaded backup
  function sliceProfile(backup, idx) {
    const pick = (arr) => (Array.isArray(arr) ? arr.filter((r) => r.profile_id === idx) : []);
    const coll = pick(backup.collections)[0];
    const sBlobs = {};
    pick(backup.profile_settings_blobs).forEach((b) => { if (b && b.settings_json) sBlobs[b.platform] = b.settings_json; });
    return {
      addons: pick(backup.addons).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      plugins: pick(backup.plugins).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      collections: (coll && coll.collections_json) || [],
      settings: sBlobs,
    };
  }
  function sliceWatch(backup, idx) {
    const p = (arr) => (Array.isArray(arr) ? arr.filter((r) => r.profile_id === idx) : []);
    return { watched: p(backup.watched_items), progress: p(backup.watch_progress) };
  }

  // ======================================================================
  // ACCOUNTS panel
  // ======================================================================
  async function linkAccount() {
    const email = $('ac-email').value.trim(), pass = $('ac-pass').value, label = $('ac-label').value.trim();
    const log = $('ac-log');
    if (!email || !pass) { status(log, 'Enter a Nuvio email and password.', 'err'); return; }
    status(log, 'Signing in to Nuvio…');
    let session;
    try { session = await A.signIn(email, pass); }
    catch (e) {
      status(log, 'Sign-in failed: ' + e.message, 'err');
      logAct('Sign-in failed for ' + email + ': ' + e.message, 'err');
      return;
    }
    const already = store.get(S.decodeSub(session.access_token));
    try { store.add(session, { email, label }); }
    catch (e) { status(log, "Couldn't save this account: " + e.message, 'err'); return; }
    invalidateAccount(S.decodeSub(session.access_token));
    $('ac-email').value = ''; $('ac-pass').value = ''; $('ac-label').value = '';
    status(log, (already ? 'Refreshed ' : 'Linked ') + (label || email) + '.', 'ok');
    logAct((already ? 'Refreshed account ' : 'Linked account ') + (label || email), 'ok');
    await refreshAccounts();
  }

  async function refreshAccounts() {
    const list = store.list();
    if ($('ac-count')) $('ac-count').textContent = String(list.length);
    if ($('sb-sub')) $('sb-sub').textContent = list.length ? list.length + ' account' + (list.length === 1 ? '' : 's') + ' linked' : 'No accounts yet';
    const box = $('ac-list'); if (!box) return; clear(box);
    if (!list.length) { box.appendChild(el('p', 'empty', 'No accounts linked yet. Add one above to load its profiles.')); return; }
    for (const rec of list) {
      const card = el('div', 'account-card');
      const head = el('div', 'account-head');
      head.appendChild(avatar({ name: rec.label || rec.email, color: null }, 40));
      const who = el('div', 'account-who');
      const nameEl = el('div', 'account-name', rec.label || rec.email || rec.accountId.slice(0, 10));
      who.appendChild(nameEl);
      if (rec.email && rec.label) who.appendChild(el('div', 'account-mail', rec.email));
      head.appendChild(who);
      head.appendChild(el('span', 'spacer'));
      const ren = el('button', 'btn-ghost sm', 'Rename');
      ren.onclick = () => startRename(who, nameEl, rec.accountId);
      const rm = el('button', 'btn-ghost sm danger', 'Unlink');
      rm.onclick = () => unlinkAccount(rec.accountId, rec.label || rec.email);
      head.appendChild(ren); head.appendChild(rm);
      card.appendChild(head);

      const prof = el('div', 'account-profiles');
      prof.appendChild(el('span', 'muted sm', 'Loading profiles…'));
      card.appendChild(prof);
      box.appendChild(card);

      loadAccount(rec.accountId).then(({ profiles }) => {
        clear(prof);
        if (!profiles.length) { prof.appendChild(el('span', 'muted sm', 'No profiles on this account.')); return; }
        profiles.forEach((p) => {
          const chip = el('span', 'profile-mini');
          chip.appendChild(avatar(p, 26));
          chip.appendChild(el('span', 'pm-name', p.name));
          prof.appendChild(chip);
        });
      }).catch((e) => {
        clear(prof);
        const err = el('span', 'muted sm err-text', "Couldn't load profiles: " + e.message);
        prof.appendChild(err);
        logAct("Couldn't load profiles for " + (rec.label || rec.email) + ': ' + e.message, 'err');
      });
    }
  }

  function startRename(who, nameEl, accountId) {
    const input = el('input'); input.type = 'text'; input.value = nameEl.textContent; input.maxLength = 40; input.className = 'rename-input';
    who.replaceChild(input, nameEl); input.focus(); input.select();
    const commit = () => { store.setLabel(accountId, input.value.trim() || null); logAct('Renamed an account', 'info'); refreshAccounts(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refreshAccounts(); });
    input.addEventListener('blur', commit);
  }
  function unlinkAccount(accountId, name) {
    if (!confirm('Unlink ' + name + '? This removes it from this device only — your Nuvio account is untouched.')) return;
    store.remove(accountId); invalidateAccount(accountId);
    if (pfAccount === accountId) { pfAccount = null; pfIndex = null; pfEdit = null; }
    if (syAccount === accountId) { syAccount = null; syIndex = null; sySnapshot = null; }
    logAct('Unlinked account ' + name, 'info');
    refreshAccounts();
  }

  function setReadKeys(on) {
    readKeys = on; savePref('numax.readKeys', on);
    if ($('ac-readkeys')) $('ac-readkeys').checked = on;
    if ($('st-readkeys')) $('st-readkeys').checked = on;
    invalidateAll();
    logAct('API keys ' + (on ? 'will be loaded' : 'will be hidden') + ' when reading profiles', 'info');
    // refresh whatever is visible
    const open = document.querySelector('[data-panel]:not([style*="display: none"])');
    refreshAccounts();
    if (pfAccount != null) openProfileEditor(pfAccount, pfIndex, true);
    if (syAccount != null) selectSyncSource(syAccount, syIndex, true);
  }

  // ======================================================================
  // PROFILE panel — load one profile, edit it, save to that profile
  // ======================================================================
  function refreshProfileTab() {
    const list = store.list();
    const sel = $('pf-account'); const prev = sel.value;
    sel.innerHTML = list.map((r) => '<option value="' + esc(r.accountId) + '">' + esc(accountName(r.accountId)) + '</option>').join('');
    if (!list.length) {
      $('pf-profiles').innerHTML = '';
      $('pf-editor').style.display = 'none';
      $('pf-empty').style.display = '';
      $('pf-empty').textContent = 'Link a Nuvio account first — then pick a profile to edit.';
      return;
    }
    $('pf-empty').style.display = 'none';
    if (prev && list.some((r) => r.accountId === prev)) sel.value = prev; else sel.value = (pfAccount && list.some((r) => r.accountId === pfAccount)) ? pfAccount : list[0].accountId;
    renderProfilePicker(sel.value);
  }
  async function renderProfilePicker(accountId) {
    const box = $('pf-profiles'); clear(box);
    box.appendChild(el('span', 'muted sm', 'Loading…'));
    let profiles;
    try { profiles = (await loadAccount(accountId)).profiles; }
    catch (e) { clear(box); box.appendChild(el('span', 'muted sm err-text', "Couldn't load profiles: " + e.message)); return; }
    clear(box);
    if (!profiles.length) { box.appendChild(el('span', 'muted sm', 'This account has no profiles.')); return; }
    const keepIdx = (accountId === pfAccount && profiles.some((p) => p.index === pfIndex)) ? pfIndex : profiles[0].index;
    profiles.forEach((p) => {
      const chip = el('button', 'profile-chip' + (p.index === keepIdx ? ' on' : ''));
      chip.type = 'button';
      chip.appendChild(avatar(p, 44));
      chip.appendChild(el('span', 'pc-name', p.name));
      chip.onclick = () => { if (pfDirty && anyDirty() && !confirm('Discard unsaved edits to this profile?')) return; openProfileEditor(accountId, p.index); };
      box.appendChild(chip);
    });
    openProfileEditor(accountId, keepIdx);
  }
  function anyDirty() { return Object.values(pfDirty).some(Boolean); }

  async function openProfileEditor(accountId, idx, silent) {
    pfAccount = accountId; pfIndex = idx;
    pfDirty = { identity: false, addons: false, plugins: false, collections: false, settingsTv: false, settingsMobile: false };
    document.querySelectorAll('#pf-profiles .profile-chip').forEach((c, i) => {
      loadAccount(accountId).then(({ profiles }) => c.classList.toggle('on', profiles[i] && profiles[i].index === idx)).catch(() => {});
    });
    const ed = $('pf-editor'); ed.style.display = ''; $('pf-empty').style.display = 'none';
    status($('pf-save-status'), '');
    let backup, profiles;
    try { const acc = await loadAccount(accountId); backup = acc.backup; profiles = acc.profiles; }
    catch (e) { ed.style.display = 'none'; $('pf-empty').style.display = ''; $('pf-empty').textContent = "Couldn't read this account: " + e.message; return; }
    const meta = profiles.find((p) => p.index === idx) || { index: idx, name: 'Profile ' + idx };
    const slice = sliceProfile(backup, idx);

    // pull LIVE settings (for accurate updated_at on guarded writes)
    let liveSettings = { tv: null, mobile: null };
    let updatedAt = { tv: null, mobile: null };
    try {
      const c = A.client(store, accountId);
      for (const plat of ['tv', 'mobile']) {
        const row = await c.pullSettings(idx, plat);
        if (row && row.settings_json) {
          liveSettings[plat] = readKeys ? row.settings_json : stripKeyFields(row.settings_json);
          updatedAt[plat] = row.updated_at || null;
        }
      }
    } catch (e) { logAct("Couldn't read live settings: " + e.message, 'err'); }

    pfEdit = {
      meta: { ...meta },
      addons: JSON.parse(JSON.stringify(slice.addons)),
      plugins: JSON.parse(JSON.stringify(slice.plugins)),
      collections: JSON.parse(JSON.stringify(slice.collections)),
      settings: JSON.parse(JSON.stringify(liveSettings)),
      updatedAt,
      watch: sliceWatch(backup, idx),
    };
    renderProfileEditor();
    if (!silent) logAct('Opened ' + meta.name + ' for editing', 'info');
  }

  function markDirty(k) { pfDirty[k] = true; $('pf-save-hint').style.display = anyDirty() ? '' : 'none'; }

  function renderProfileEditor() {
    if (!pfEdit) return;
    $('pf-name-input').value = pfEdit.meta.name || '';
    $('pf-editor-title').textContent = pfEdit.meta.name || 'Profile';
    renderPfList('addons');
    renderPfList('plugins');
    renderPfCollections();
    renderPfSettings();
    $('pf-save-hint').style.display = anyDirty() ? '' : 'none';
    // watched / progress counts
    $('pf-watch-note').textContent =
      (pfEdit.watch.watched.length || 0) + ' watched · ' + (pfEdit.watch.progress.length || 0) + ' in progress';
  }

  function renderPfList(kind) {
    const box = $('pf-' + kind); clear(box);
    const list = pfEdit[kind];
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'No ' + kind + ' on this profile.')); return; }
    list.forEach((item, i) => {
      const row = el('div', 'edit-row');
      const tog = el('button', 'toggle' + (item.enabled !== false ? ' on' : ''));
      tog.type = 'button'; tog.title = item.enabled !== false ? 'On — click to turn off' : 'Off — click to turn on';
      tog.onclick = () => { item.enabled = !(item.enabled !== false); tog.classList.toggle('on', item.enabled); markDirty(kind); };
      row.appendChild(tog);
      const body = el('div', 'er-body');
      body.appendChild(el('div', 'er-name', item.name || host(item.url)));
      body.appendChild(el('div', 'er-sub', host(item.url)));
      row.appendChild(body);
      const del = el('button', 'er-del', '✕'); del.title = 'Remove from this profile';
      del.onclick = () => { pfEdit[kind].splice(i, 1); markDirty(kind); renderPfList(kind); };
      row.appendChild(del);
      box.appendChild(row);
    });
    const save = el('button', 'btn-dark sm', 'Save ' + kind + ' to this profile');
    save.onclick = () => savePfList(kind);
    box.appendChild(save);
  }

  function renderPfCollections() {
    const box = $('pf-collections'); clear(box);
    const list = pfEdit.collections;
    if (!Array.isArray(list) || !list.length) { box.appendChild(el('p', 'empty sm', 'No collections on this profile.')); return; }
    list.forEach((c, i) => {
      const row = el('div', 'edit-row');
      const body = el('div', 'er-body');
      body.appendChild(el('div', 'er-name', collLabel(c)));
      const folders = (c && Array.isArray(c.folders)) ? c.folders.length : 0;
      body.appendChild(el('div', 'er-sub', folders ? folders + ' folder' + (folders === 1 ? '' : 's') : 'No folders'));
      row.appendChild(body);
      const del = el('button', 'er-del', '✕'); del.title = 'Remove collection';
      del.onclick = () => { pfEdit.collections.splice(i, 1); markDirty('collections'); renderPfCollections(); };
      row.appendChild(del);
      box.appendChild(row);
    });
    const save = el('button', 'btn-dark sm', 'Save collections to this profile');
    save.onclick = () => savePfCollections();
    box.appendChild(save);
  }

  function renderPfSettings() {
    const wrap = $('pf-settings'); clear(wrap);
    const platforms = ['tv', 'mobile'].filter((p) => pfEdit.settings[p] && pfEdit.settings[p].features);
    if (!platforms.length) { wrap.appendChild(el('p', 'empty sm', 'No settings found for this profile.')); return; }
    platforms.forEach((plat) => {
      const feat = pfEdit.settings[plat].features;
      const platBox = el('div', 'pf-plat');
      const ph = el('div', 'pf-plat-head');
      ph.appendChild(el('span', 'pf-plat-name', plat === 'tv' ? 'TV app' : 'Mobile app'));
      const save = el('button', 'btn-dark sm', 'Save ' + (plat === 'tv' ? 'TV' : 'mobile') + ' settings');
      save.onclick = () => savePfSettings(plat);
      ph.appendChild(el('span', 'spacer')); ph.appendChild(save);
      platBox.appendChild(ph);

      Object.keys(feat).sort().forEach((group) => {
        const gv = feat[group];
        const gtype = ACCOUNT_GROUP.test(group) ? 'account' : (typeof gv === 'string' ? 'payload' : (PERSONAL_GROUP.test(group) ? 'personal' : 'leaves'));
        const gbox = el('div', 'sgroup');
        const gh = el('div', 'sgroup-head');
        gh.appendChild(el('span', 'chev', '›'));
        gh.appendChild(el('span', 'sg-name', humanize(group)));
        const badge = { account: 'linked to account', payload: 'copied as-is', personal: 'personal', leaves: '' }[gtype];
        if (badge) gh.appendChild(el('span', 'sg-badge ' + gtype, badge));
        gh.onclick = () => gbox.classList.toggle('open');
        gbox.appendChild(gh);
        const gb = el('div', 'sgroup-body');

        if (gtype === 'leaves' || gtype === 'personal') {
          Object.keys(gv).forEach((leaf) => {
            const isSecret = SECRET_LEAF.test(leaf);
            const row = el('div', 'sleaf');
            row.appendChild(el('span', 'sl-name', humanize(leaf)));
            if (isSecret) {
              const tag = el('span', 'sl-secret', readKeys ? '•••• hidden from copy' : 'hidden');
              row.appendChild(tag);
            } else {
              row.appendChild(renderLeafEditor(gv, leaf, plat));
            }
            gb.appendChild(row);
          });
        } else if (gtype === 'payload') {
          let n = 0; try { n = Object.keys(JSON.parse(gv || '{}')).length; } catch {}
          gb.appendChild(el('div', 'sleaf muted', n ? n + ' option' + (n === 1 ? '' : 's') + ' — copied as a whole' : 'Copied as a whole'));
        } else { // account
          gb.appendChild(el('div', 'sleaf muted', 'Tied to this account — left untouched.'));
        }
        gbox.appendChild(gb);
        platBox.appendChild(gbox);
      });
      wrap.appendChild(platBox);
    });
  }

  // returns an editing control for one leaf, writing back into the blob
  function renderLeafEditor(groupObj, leaf, plat) {
    const l = groupObj[leaf];
    const t = leafType(l), v = leafValue(l);
    const write = (nv) => {
      if (l && typeof l === 'object' && 'value' in l) l.value = nv; else groupObj[leaf] = nv;
      markDirty(plat === 'tv' ? 'settingsTv' : 'settingsMobile');
    };
    if (t === 'boolean' || typeof v === 'boolean') {
      const tog = el('button', 'toggle' + (v ? ' on' : '')); tog.type = 'button';
      tog.onclick = () => { const nv = !tog.classList.contains('on'); tog.classList.toggle('on', nv); write(nv); };
      return tog;
    }
    if (t === 'number' || typeof v === 'number') {
      const inp = el('input', 'sl-input num'); inp.type = 'number'; inp.value = v; 
      inp.onchange = () => write(inp.value === '' ? 0 : Number(inp.value));
      return inp;
    }
    if (typeof v === 'string') {
      const inp = el('input', 'sl-input'); inp.type = 'text'; inp.value = v;
      inp.onchange = () => write(inp.value);
      return inp;
    }
    // arrays / objects: read-only summary
    return el('span', 'sl-ro', formatVal(l));
  }

  // ---- profile save handlers ----
  // Only these columns go back in a sync_push_profiles whole-array replace —
  // matches the audited extension pattern, so PIN state / timestamps are never
  // pushed or propagated across the array.
  const PROFILE_FIELDS = ['profile_index', 'name', 'avatar_color_hex', 'uses_primary_addons', 'uses_primary_plugins', 'avatar_id', 'avatar_url'];
  function normalizeProfileRow(row) { const o = {}; for (const f of PROFILE_FIELDS) o[f] = row[f] === undefined ? null : row[f]; return o; }
  function normalizeRaw(raw) { return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []); }

  async function savePfIdentity() {
    const name = $('pf-name-input').value.trim();
    if (!name) { status($('pf-save-status'), 'Give the profile a name.', 'err'); return; }
    if (name === pfEdit.meta.name) { status($('pf-save-status'), 'Name is unchanged.', 'info'); return; }
    if (!confirm('Rename this profile to “' + name + '”?')) return;
    status($('pf-save-status'), 'Renaming…');
    try {
      const c = A.client(store, pfAccount);
      const live = normalizeRaw(await c.pullProfiles());
      if (!live.length) throw new Error("Couldn't read the current profile list — nothing was changed.");
      const target = live.find((p) => p.profile_index === pfIndex);
      if (!target) throw new Error('This profile is no longer on the account.');
      const next = live.map((p) => { const row = normalizeProfileRow(p); if (p.profile_index === pfIndex) row.name = name.slice(0, 60); return row; });
      // refuse to send if any profile went missing between pull and here
      const liveIds = live.map((p) => p.profile_index).sort().join(',');
      const nextIds = next.map((p) => p.profile_index).sort().join(',');
      if (liveIds !== nextIds) throw new Error('Profile list changed while saving — reload and try again.');
      await c.rpc('sync_push_profiles', { p_profiles: next, p_client_max_profiles: 6 });
      pfEdit.meta.name = name; pfDirty.identity = false;
      invalidateAccount(pfAccount);
      status($('pf-save-status'), 'Saved.', 'ok'); logAct('Renamed profile to ' + name, 'ok');
      $('pf-editor-title').textContent = name;
      renderProfilePicker(pfAccount);
    } catch (e) { status($('pf-save-status'), "Couldn't rename: " + e.message, 'err'); logAct('Rename failed: ' + e.message, 'err'); }
  }

  async function savePfList(kind) {
    const list = pfEdit[kind];
    if (!confirm('Save the ' + kind + ' list to ' + pfEdit.meta.name + '? This replaces that profile\'s ' + kind + ' with exactly what\'s shown.')) return;
    status($('pf-save-status'), 'Saving ' + kind + '…');
    try {
      const c = A.client(store, pfAccount);
      const rows = list.map((x, i) => {
        const r = { url: x.url, name: x.name ?? null, enabled: x.enabled !== false, sort_order: i };
        if (kind === 'plugins' && x.repo_type !== undefined) r.repo_type = x.repo_type;
        return r;
      });
      const rpc = kind === 'addons' ? 'sync_push_addons' : 'sync_push_plugins';
      const param = kind === 'addons' ? 'p_addons' : 'p_plugins';
      await c.rpc(rpc, { [param]: rows, p_profile_id: pfIndex, p_origin_client_id: 'numax-web' });
      pfDirty[kind] = false; invalidateAccount(pfAccount);
      status($('pf-save-status'), 'Saved ' + kind + '.', 'ok'); logAct('Saved ' + kind + ' to ' + pfEdit.meta.name, 'ok');
    } catch (e) { status($('pf-save-status'), "Couldn't save " + kind + ': ' + e.message, 'err'); logAct('Save ' + kind + ' failed: ' + e.message, 'err'); }
  }

  async function savePfCollections() {
    if (!confirm('Save collections to ' + pfEdit.meta.name + '? This replaces that profile\'s collections with exactly what\'s shown.')) return;
    status($('pf-save-status'), 'Saving collections…');
    try {
      const c = A.client(store, pfAccount);
      await c.rpc('sync_push_collections', { p_profile_id: pfIndex, p_collections_json: pfEdit.collections, p_origin_client_id: 'numax-web' });
      pfDirty.collections = false; invalidateAccount(pfAccount);
      status($('pf-save-status'), 'Saved collections.', 'ok'); logAct('Saved collections to ' + pfEdit.meta.name, 'ok');
    } catch (e) { status($('pf-save-status'), "Couldn't save collections: " + e.message, 'err'); logAct('Save collections failed: ' + e.message, 'err'); }
  }

  async function savePfSettings(plat) {
    const blob = pfEdit.settings[plat];
    if (!blob) return;
    if (!confirm('Save ' + (plat === 'tv' ? 'TV' : 'mobile') + ' settings to ' + pfEdit.meta.name + '?')) return;
    status($('pf-save-status'), 'Saving settings…');
    try {
      const c = A.client(store, pfAccount);
      // guarded write: refuse if someone else saved since we read
      await c.rpc('sync_push_profile_settings_blob_guarded', {
        p_profile_id: pfIndex, p_settings_json: blob, p_platform: plat,
        p_expected_updated_at: pfEdit.updatedAt[plat] || null,
      });
      pfDirty[plat === 'tv' ? 'settingsTv' : 'settingsMobile'] = false;
      // refresh updated_at so a second save in the same session still guards
      const row = await c.pullSettings(pfIndex, plat);
      if (row) pfEdit.updatedAt[plat] = row.updated_at || null;
      invalidateAccount(pfAccount);
      status($('pf-save-status'), 'Saved settings.', 'ok'); logAct('Saved ' + plat + ' settings to ' + pfEdit.meta.name, 'ok');
    } catch (e) {
      const conflict = e instanceof A.ConflictError || /changed on another device|40001|409/i.test(e.message || '');
      status($('pf-save-status'), conflict ? 'Someone changed these settings elsewhere — reopen the profile and try again.' : "Couldn't save settings: " + e.message, 'err');
      logAct('Save ' + plat + ' settings failed: ' + e.message, 'err');
    }
  }

  // ======================================================================
  // SYNC DESK — source profile → choose what to carry → targets → apply
  // ======================================================================
  function refreshSyncTab() {
    const list = store.list();
    const sel = $('sy-account'); const prev = sel.value;
    sel.innerHTML = list.map((r) => '<option value="' + esc(r.accountId) + '">' + esc(accountName(r.accountId)) + '</option>').join('');
    if (!list.length) {
      $('sy-source').innerHTML = ''; $('sy-body').style.display = 'none'; $('sy-empty').style.display = '';
      return;
    }
    $('sy-empty').style.display = 'none'; $('sy-body').style.display = '';
    if (prev && list.some((r) => r.accountId === prev)) sel.value = prev; else sel.value = (syAccount && list.some((r) => r.accountId === syAccount)) ? syAccount : list[0].accountId;
    renderSyncSourcePicker(sel.value);
  }
  async function renderSyncSourcePicker(accountId) {
    const box = $('sy-source'); clear(box); box.appendChild(el('span', 'muted sm', 'Loading…'));
    let profiles; try { profiles = (await loadAccount(accountId)).profiles; } catch (e) { clear(box); box.appendChild(el('span', 'muted sm err-text', e.message)); return; }
    clear(box);
    if (!profiles.length) { box.appendChild(el('span', 'muted sm', 'No profiles on this account.')); return; }
    const keep = (accountId === syAccount && profiles.some((p) => p.index === syIndex)) ? syIndex : profiles[0].index;
    profiles.forEach((p) => {
      const chip = el('button', 'profile-chip' + (p.index === keep ? ' on' : '')); chip.type = 'button';
      chip.appendChild(avatar(p, 40)); chip.appendChild(el('span', 'pc-name', p.name));
      chip.onclick = () => selectSyncSource(accountId, p.index);
      box.appendChild(chip);
    });
    selectSyncSource(accountId, keep);
  }
  async function selectSyncSource(accountId, idx, silent) {
    syAccount = accountId; syIndex = idx;
    document.querySelectorAll('#sy-source .profile-chip').forEach((c, i) => loadAccount(accountId).then(({ profiles }) => c.classList.toggle('on', profiles[i] && profiles[i].index === idx)).catch(() => {}));
    status($('sy-status'), 'Reading source…');
    try {
      const { backup } = await loadAccount(accountId);
      const slice = sliceProfile(backup, idx);
      // pull live settings for the source (for accurate copy)
      const c = A.client(store, accountId); const settings = {};
      for (const plat of ['tv', 'mobile']) { const row = await c.pullSettings(idx, plat); if (row && row.settings_json) settings[plat] = readKeys ? row.settings_json : stripKeyFields(row.settings_json); }
      sySnapshot = { addons: slice.addons, plugins: slice.plugins, collections: slice.collections, settings };
      resetSyncSelection();
      renderSyncItemLists(); renderSyncSettingsTree(); await renderSyncTargets(); updateSyncCounts();
      status($('sy-status'), '');
      if (!silent) logAct('Sync source set to a profile on ' + accountName(accountId), 'info');
    } catch (e) { sySnapshot = null; status($('sy-status'), "Couldn't read source: " + e.message, 'err'); }
  }
  function resetSyncSelection() {
    const s = sySnapshot || { addons: [], plugins: [], collections: [], settings: {} };
    sySel.addons = new Set((s.addons || []).map((a) => a.url));
    sySel.plugins = new Set((s.plugins || []).map((p) => p.url));
    sySel.collections = new Set((s.collections || []).map(collKey));
    sySel.settings = defaultSettingsTokens(s.settings || {});
  }
  function defaultSettingsTokens(settings) {
    const t = new Set();
    for (const plat of Object.keys(settings)) {
      const feat = (settings[plat] && settings[plat].features) || {};
      for (const g of Object.keys(feat)) {
        const gv = feat[g];
        if (ACCOUNT_GROUP.test(g)) continue;
        if (typeof gv === 'string') { t.add(plat + '::' + g); continue; }
        if (PERSONAL_GROUP.test(g)) continue;
        if (gv && typeof gv === 'object') for (const leaf of Object.keys(gv)) if (!SECRET_LEAF.test(leaf)) t.add(plat + '::' + g + '.' + leaf);
      }
    }
    return t;
  }

  function syList(kind) { const s = sySnapshot; return !s ? [] : (kind === 'collections' ? (s.collections || []) : (s[kind] || [])); }
  function syKey(kind, x) { return kind === 'collections' ? collKey(x) : x.url; }
  function renderSyncItemLists() { ['addons', 'plugins', 'collections'].forEach(renderSyncItemList); }
  function renderSyncItemList(kind) {
    const box = $('sy-items-' + kind); clear(box);
    const list = syList(kind);
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'The source has no ' + kind + '.')); return; }
    const bar = el('div', 'chooser-bar');
    const all = el('button', 'link-btn', 'Select all'), none = el('button', 'link-btn', 'Select none');
    all.onclick = () => { list.forEach((x) => sySel[kind].add(syKey(kind, x))); renderSyncItemList(kind); updateSyncCounts(); };
    none.onclick = () => { sySel[kind].clear(); renderSyncItemList(kind); updateSyncCounts(); };
    bar.appendChild(all); bar.appendChild(none); box.appendChild(bar);
    list.forEach((x) => {
      const key = syKey(kind, x);
      const row = el('label', 'pick-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = sySel[kind].has(key);
      cb.onchange = () => { cb.checked ? sySel[kind].add(key) : sySel[kind].delete(key); updateSyncCounts(); };
      row.appendChild(cb);
      const body = el('div', 'pr-body');
      if (kind === 'collections') { body.appendChild(el('div', 'pr-name', collLabel(x))); const f = (x.folders || []).length; body.appendChild(el('div', 'pr-sub', f ? f + ' folder' + (f === 1 ? '' : 's') : 'No folders')); }
      else { body.appendChild(el('div', 'pr-name', x.name || host(x.url))); body.appendChild(el('div', 'pr-sub', host(x.url))); }
      row.appendChild(body);
      if (kind !== 'collections' && x.enabled === false) row.appendChild(el('span', 'pr-tag', 'off'));
      box.appendChild(row);
    });
  }

  function renderSyncSettingsTree() {
    const tree = $('sy-settings-tree'); clear(tree);
    const settings = (sySnapshot && sySnapshot.settings) || {};
    const platforms = Object.keys(settings).filter((p) => settings[p] && settings[p].features);
    if (!platforms.length) { tree.appendChild(el('p', 'empty sm', 'The source has no settings.')); return; }
    platforms.forEach((plat) => {
      const feat = settings[plat].features;
      const platHead = el('div', 'st-plat', plat === 'tv' ? 'TV app' : 'Mobile app');
      tree.appendChild(platHead);
      Object.keys(feat).sort().forEach((group) => {
        const gv = feat[group];
        const gtype = ACCOUNT_GROUP.test(group) ? 'account' : (typeof gv === 'string' ? 'payload' : (PERSONAL_GROUP.test(group) ? 'personal' : 'leaves'));
        const gbox = el('div', 'sgroup');
        const gh = el('div', 'sgroup-head');
        // group checkbox for selectable types
        if (gtype === 'payload' || gtype === 'personal') {
          const tok = plat + '::' + group;
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = sySel.settings.has(tok);
          cb.onclick = (e) => e.stopPropagation();
          cb.onchange = () => { cb.checked ? sySel.settings.add(tok) : sySel.settings.delete(tok); updateSyncCounts(); };
          gh.appendChild(cb);
        } else if (gtype === 'leaves') {
          const leaves = Object.keys(gv).filter((l) => !SECRET_LEAF.test(l));
          const selN = leaves.filter((l) => sySel.settings.has(plat + '::' + group + '.' + l)).length;
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = selN > 0 && selN === leaves.length; cb.indeterminate = selN > 0 && selN < leaves.length;
          cb.onclick = (e) => e.stopPropagation();
          cb.onchange = () => { leaves.forEach((l) => { const t = plat + '::' + group + '.' + l; cb.checked ? sySel.settings.add(t) : sySel.settings.delete(t); }); renderSyncSettingsTree(); updateSyncCounts(); };
          gh.appendChild(cb);
        } else { gh.appendChild(el('span', 'cb-spacer')); }
        gh.appendChild(el('span', 'chev', '›'));
        gh.appendChild(el('span', 'sg-name', humanize(group)));
        const badge = { account: 'linked to account', payload: 'copied as-is', personal: 'personal', leaves: '' }[gtype];
        if (badge) gh.appendChild(el('span', 'sg-badge ' + gtype, badge));
        gh.onclick = () => gbox.classList.toggle('open');
        gbox.appendChild(gh);
        const gb = el('div', 'sgroup-body');
        if (gtype === 'leaves') {
          Object.keys(gv).forEach((leaf) => {
            const isSecret = SECRET_LEAF.test(leaf);
            const row = el('div', 'sleaf');
            if (isSecret) { row.appendChild(el('span', 'cb-spacer')); row.appendChild(el('span', 'sl-name', humanize(leaf))); row.appendChild(el('span', 'sl-secret', 'never copied')); }
            else {
              const tok = plat + '::' + group + '.' + leaf;
              const cb = el('input'); cb.type = 'checkbox'; cb.checked = sySel.settings.has(tok);
              cb.onchange = () => { cb.checked ? sySel.settings.add(tok) : sySel.settings.delete(tok); renderSyncSettingsTree(); updateSyncCounts(); };
              row.appendChild(cb); row.appendChild(el('span', 'sl-name', humanize(leaf))); row.appendChild(el('span', 'sl-val', formatVal(gv[leaf])));
            }
            gb.appendChild(row);
          });
        } else if (gtype === 'payload') {
          let n = 0; try { n = Object.keys(JSON.parse(gv || '{}')).length; } catch {}
          gb.appendChild(el('div', 'sleaf muted', n ? n + ' option' + (n === 1 ? '' : 's') : 'Visual options — copied as a whole'));
        } else if (gtype === 'personal') {
          gb.appendChild(el('div', 'sleaf muted', Object.keys(gv).length + ' per-title choices — off by default, tick the group to include'));
        } else { gb.appendChild(el('div', 'sleaf muted', 'Tied to the account — never copied.')); }
        gbox.appendChild(gb);
        tree.appendChild(gbox);
      });
    });
  }

  function updateSyncCounts() {
    const s = sySnapshot || { addons: [], plugins: [], collections: [], settings: {} };
    const set = (id, sel, tot) => { const e = $(id); if (e) e.textContent = tot ? sel + ' / ' + tot : '0'; };
    set('sy-cnt-addons', sySel.addons.size, (s.addons || []).length);
    set('sy-cnt-plugins', sySel.plugins.size, (s.plugins || []).length);
    set('sy-cnt-collections', sySel.collections.size, (s.collections || []).length);
    if ($('sy-cnt-settings')) $('sy-cnt-settings').textContent = sySel.settings.size + ' selected';
  }

  async function renderSyncTargets() {
    const box = $('sy-targets'); clear(box); syTargets.clear();
    const list = store.list();
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'Link an account to choose targets.')); return; }
    let any = false;
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const targetable = profiles.filter((p) => !(rec.accountId === syAccount && p.index === syIndex));
      if (!targetable.length) continue;
      box.appendChild(el('div', 'target-acct', accountName(rec.accountId)));
      const grid = el('div', 'target-grid');
      targetable.forEach((p) => {
        const tid = rec.accountId + ':' + p.index;
        const chip = el('button', 'profile-chip multi'); chip.type = 'button';
        chip.appendChild(avatar(p, 40)); chip.appendChild(el('span', 'pc-name', p.name));
        chip.appendChild(el('span', 'chip-check', '✓'));
        chip.onclick = () => { const on = syTargets.has(tid); on ? syTargets.delete(tid) : syTargets.add(tid); chip.classList.toggle('on', !on); };
        grid.appendChild(chip);
      });
      box.appendChild(grid); any = true;
    }
    if (!any) box.appendChild(el('p', 'empty sm', 'No other profiles to sync into yet.'));
  }

  function syncFilteredMaster() {
    const s = sySnapshot;
    const out = { addons: [], plugins: [], collections: [], settings: {} };
    out.addons = (s.addons || []).filter((a) => sySel.addons.has(a.url));
    out.plugins = (s.plugins || []).filter((p) => sySel.plugins.has(p.url));
    out.collections = (s.collections || []).filter((c) => sySel.collections.has(collKey(c)));
    for (const plat of Object.keys(s.settings || {})) {
      const blob = s.settings[plat]; const feat = (blob && blob.features) || {}; const outFeat = {};
      for (const g of Object.keys(feat)) {
        const gv = feat[g]; const gtok = plat + '::' + g;
        if (sySel.settings.has(gtok)) { outFeat[g] = gv; continue; }
        if (gv && typeof gv === 'object' && typeof gv !== 'string') {
          const picked = {};
          for (const leaf of Object.keys(gv)) if (sySel.settings.has(plat + '::' + g + '.' + leaf)) picked[leaf] = gv[leaf];
          if (Object.keys(picked).length) outFeat[g] = picked;
        }
      }
      if (Object.keys(outFeat).length) out.settings[plat] = { version: blob.version, features: outFeat };
    }
    return out;
  }

  async function syncPreview() {
    status($('sy-status'), 'Reading target profiles…');
    $('sy-results').innerHTML = ''; $('sy-apply').disabled = true; $('sy-confirm-wrap').style.display = 'none'; $('sy-confirm').checked = false; syPlans = null;
    if (!sySnapshot) { status($('sy-status'), 'Pick a source profile first.', 'err'); return; }
    const targets = [...syTargets];
    if (!targets.length) { status($('sy-status'), 'Tick at least one target profile.', 'err'); return; }
    const mode = $('sy-mode').value === 'overwrite' ? 'mirror' : 'merge';
    const cats = { addons: $('sy-cat-addons').checked, plugins: $('sy-cat-plugins').checked, collections: $('sy-cat-collections').checked, settings: $('sy-cat-settings').checked };
    const master = syncFilteredMaster();
    try {
      const plans = []; let anyRemovals = false;
      for (const tid of targets) {
        const [accountId, idxStr] = tid.split(':'); const idx = parseInt(idxStr, 10);
        const c = A.client(store, accountId); const { backup } = await loadAccount(accountId);
        const state = sliceProfile(backup, idx); const updatedAt = {};
        if (cats.settings) { state.settings = {}; for (const plat of ['tv', 'mobile']) { const row = await c.pullSettings(idx, plat); if (row && row.settings_json) { state.settings[plat] = row.settings_json; updatedAt[plat] = row.updated_at; } } }
        const plan = E.planTarget(master, state, {
          categories: cats,
          modes: { addons: mode, plugins: mode, collections: mode },
          settings: { includePersonal: true },
          profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: updatedAt,
        });
        if (plan.hasRemovals) anyRemovals = true;
        plans.push({ accountId, tid, plan });
      }
      syPlans = plans; renderSyncReports(plans);
      if (anyRemovals) $('sy-confirm-wrap').style.display = '';
      $('sy-apply').disabled = anyRemovals;
      status($('sy-status'), 'Preview ready — nothing has been written yet.', 'ok');
      logAct('Previewed sync into ' + plans.length + ' profile(s)', 'info');
    } catch (e) { status($('sy-status'), e.message, 'err'); logAct('Sync preview failed: ' + e.message, 'err'); }
  }

  function tag(cls, sign, arr) { return (arr && arr.length) ? '<span class="' + cls + '">' + sign + arr.length + '</span>' : ''; }
  function renderSyncReports(plans) {
    const box = $('sy-results'); box.innerHTML = '';
    plans.forEach(({ tid, plan }) => {
      const [id, i] = tid.split(':'); const name = tidName(tid);
      const r = plan.report; const div = el('div', 'report');
      let html = '<div class="report-head">' + esc(name) + (plan.hasChanges ? '<span class="rbadge chg">changes</span>' : '<span class="rbadge no">no change</span>') + '</div>';
      const line = (label, o) => {
        if (!o) return '';
        const bits = [tag('t-add', '+', o.added), tag('t-upd', '~', o.updated), tag('t-rem', '−', o.removed), (o.keptLocal && o.keptLocal.length ? '<span class="t-keep">keeps ' + o.keptLocal.length + '</span>' : '')].filter(Boolean);
        return bits.length ? '<div class="rline"><span class="rk">' + label + '</span>' + bits.join(' ') + '</div>' : '';
      };
      html += line('Add-ons', r.addons) + line('Plugins', r.plugins) + line('Collections', r.collections);
      if (r.settings) { let ch = 0, held = 0; for (const p of Object.keys(r.settings)) { ch += r.settings[p].changed.length; held += r.settings[p].skippedSecrets.length; } if (ch || held) html += '<div class="rline"><span class="rk">Settings</span>' + (ch ? '<span class="t-upd">' + ch + ' fields</span>' : '') + (held ? '<span class="t-held">' + held + ' keys kept back</span>' : '') + '</div>'; }
      if (!plan.hasChanges) html += '<div class="rline muted">Already matches — nothing to do.</div>';
      div.innerHTML = html; box.appendChild(div);
    });
  }
  function tidName(tid) { const [id, i] = tid.split(':'); const rec = accountCache[id]; const p = rec && rec.profiles.find((x) => x.index === parseInt(i, 10)); return (p ? p.name : 'Profile ' + i) + ' · ' + accountName(id); }

  async function syncApply() {
    if (!syPlans) return;
    $('sy-apply').disabled = true; status($('sy-status'), 'Applying…');
    let ok = 0, fail = 0;
    for (const { accountId, plan } of syPlans) {
      if (!plan.hasChanges) continue;
      try { const res = await A.client(store, accountId).applyPlan(plan, { dryRun: false }); (res.results || []).forEach((r) => { r.ok ? ok++ : fail++; if (!r.ok) logAct('Sync ' + r.surface + ' failed: ' + r.error, 'err'); }); }
      catch (e) { fail++; logAct('Apply failed: ' + e.message, 'err'); }
    }
    invalidateAll();
    status($('sy-status'), 'Done — ' + ok + ' change' + (ok === 1 ? '' : 's') + ' applied' + (fail ? ', ' + fail + ' failed (see Activity).' : '.'), fail ? 'err' : 'ok');
    logAct('Applied sync: ' + ok + ' ok' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'err' : 'ok');
    syPlans = null;
    selectSyncSource(syAccount, syIndex, true);
  }

  // ======================================================================
  // GOOGLE DRIVE
  // ======================================================================
  const GOOGLE = { clientId: '841898218953-c5f3ide5lcsg8g2opn1ucrekvlq335rs.apps.googleusercontent.com', scope: 'openid email profile https://www.googleapis.com/auth/drive.file' };
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';

  function googleReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }
  function signInGoogle(after) {
    if (!googleReady()) { logAct('Google library not loaded — entering without Drive.', 'info'); enterApp(); return; }
    if (!googleClient) {
      googleClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE.clientId, scope: GOOGLE.scope,
        callback: async (resp) => {
          if (resp && resp.error) { logAct('Google sign-in error: ' + resp.error, 'err'); if ($('dr-status')) status($('dr-status'), 'Google sign-in failed: ' + resp.error, 'err'); return; }
          googleToken = resp;
          try {
            const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + resp.access_token } }).then((r) => r.json());
            googleUser = who;
            if (who && who.email) { $('sb-name').textContent = who.name || who.email; $('sb-avatar').textContent = (who.name || who.email)[0].toUpperCase(); }
          } catch {}
          logAct('Signed in with Google — Drive ready', 'ok');
          if ($('dr-status')) { setDriveConnected(true); }
          if (typeof after === 'function') after();
        },
      });
    }
    googleClient.requestAccessToken();
  }
  function ensureDrive() { if (!googleToken) { throw new Error('Connect Google Drive first.'); } return { Authorization: 'Bearer ' + googleToken.access_token }; }
  function sanitizeName(name) { return String(name || 'numax-backup').replace(/['"\\/]/g, '').trim().slice(0, 80) || 'numax-backup'; }

  async function driveSaveNamed(displayName, obj) {
    const auth = ensureDrive();
    const safe = sanitizeName(displayName); const fileName = safe.endsWith('.json') ? safe : safe + '.json';
    // find an existing file we created with the same name
    const q = encodeURIComponent(`name='${fileName.replace(/'/g, "\\'")}' and trashed=false`);
    const found = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name)`, { headers: auth }).then((r) => r.json()).catch(() => ({}));
    const existingId = found && found.files && found.files[0] && found.files[0].id;
    const boundary = 'numax' + Date.now();
    const meta = { name: fileName, mimeType: 'application/json', appProperties: { numax: 'backup' } };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify(obj, null, 2) + `\r\n--${boundary}--`;
    const url = existingId ? `${DRIVE_UP}/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime` : `${DRIVE_UP}/files?uploadType=multipart&fields=id,name,modifiedTime`;
    const res = await fetch(url, { method: existingId ? 'PATCH' : 'POST', headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }).then((r) => r.json());
    if (!res || !res.id) throw new Error('Drive did not confirm the save.');
    return { ...res, overwritten: !!existingId };
  }
  async function driveList() {
    const auth = ensureDrive();
    const q = encodeURIComponent(`appProperties has { key='numax' and value='backup' } and trashed=false`);
    const res = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`, { headers: auth }).then((r) => r.json());
    return (res && res.files) || [];
  }
  async function driveDownload(id) {
    const auth = ensureDrive();
    const res = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: auth });
    if (!res.ok) throw new Error('Could not read that backup (' + res.status + ').');
    return res.json();
  }
  function setDriveConnected(on) {
    const s = $('dr-status'); if (!s) return;
    if (on) { status(s, googleUser && googleUser.email ? 'Connected as ' + googleUser.email : 'Connected.', 'ok'); $('dr-connect').textContent = 'Reconnect Google Drive'; $('dr-backup-btn').disabled = false; $('dr-restore-refresh').disabled = false; }
    else { status(s, 'Not connected.', ''); $('dr-backup-btn').disabled = true; $('dr-restore-refresh').disabled = true; }
  }

  async function refreshDriveTab() {
    setDriveConnected(!!googleToken);
    // profile picker for backup selection
    const box = $('dr-backup-picker'); clear(box);
    const list = store.list();
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'Link a Nuvio account to choose what to back up.')); return; }
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      box.appendChild(el('div', 'target-acct', accountName(rec.accountId)));
      const grid = el('div', 'target-grid');
      profiles.forEach((p) => {
        const tid = rec.accountId + ':' + p.index;
        const chip = el('button', 'profile-chip multi on'); chip.type = 'button'; chip.dataset.tid = tid;
        chip.appendChild(avatar(p, 40)); chip.appendChild(el('span', 'pc-name', p.name)); chip.appendChild(el('span', 'chip-check', '✓'));
        chip.onclick = () => chip.classList.toggle('on');
        grid.appendChild(chip);
      });
      box.appendChild(grid);
    }
  }

  async function driveBackupNow() {
    const log = $('dr-backup-log');
    const picked = [...document.querySelectorAll('#dr-backup-picker .profile-chip.on')].map((c) => c.dataset.tid);
    if (!picked.length) { status(log, 'Pick at least one profile to back up.', 'err'); return; }
    const name = $('dr-name').value.trim() || ('numax-backup-' + new Date().toISOString().slice(0, 10));
    const includeKeys = $('dr-keys').checked;
    $('dr-backup-btn').disabled = true; status(log, 'Building backup…');
    try {
      const out = { app: 'numax', kind: 'backup', savedAt: new Date().toISOString(), includesKeys: includeKeys, profiles: [] };
      const byAccount = {};
      picked.forEach((tid) => { const [id, i] = tid.split(':'); (byAccount[id] = byAccount[id] || []).push(parseInt(i, 10)); });
      for (const accountId of Object.keys(byAccount)) {
        const c = A.client(store, accountId); const { backup } = await loadAccount(accountId);
        for (const idx of byAccount[accountId]) {
          const slice = sliceProfile(backup, idx);
          const meta = (accountCache[accountId].profiles.find((p) => p.index === idx)) || { name: 'Profile ' + idx };
          const settings = {};
          for (const plat of ['tv', 'mobile']) {
            const row = await c.pullSettings(idx, plat);
            if (row && row.settings_json) settings[plat] = includeKeys ? row.settings_json : stripKeyFields(row.settings_json);
          }
          out.profiles.push({ account: accountName(accountId), accountId, profileIndex: idx, name: meta.name, addons: slice.addons, plugins: slice.plugins, collections: slice.collections, settings });
        }
      }
      status(log, 'Uploading to Drive…');
      const res = await driveSaveNamed(name, out);
      status(log, (res.overwritten ? 'Updated ' : 'Saved ') + res.name + ' (' + out.profiles.length + ' profile' + (out.profiles.length === 1 ? '' : 's') + ').', 'ok');
      logAct((res.overwritten ? 'Updated' : 'Saved') + ' Drive backup "' + res.name + '"', 'ok');
      refreshRestoreList();
    } catch (e) { status(log, "Backup failed: " + e.message, 'err'); logAct('Drive backup failed: ' + e.message, 'err'); }
    finally { $('dr-backup-btn').disabled = false; }
  }

  let restoreDoc = null;
  async function refreshRestoreList() {
    const box = $('dr-restore-list'); clear(box);
    if (!googleToken) { box.appendChild(el('p', 'empty sm', 'Connect Google Drive to see your backups.')); return; }
    box.appendChild(el('p', 'muted sm', 'Loading backups…'));
    let files; try { files = await driveList(); } catch (e) { clear(box); box.appendChild(el('p', 'empty sm err-text', e.message)); return; }
    clear(box);
    if (!files.length) { box.appendChild(el('p', 'empty sm', 'No Numax backups in your Drive yet.')); return; }
    files.forEach((f) => {
      const row = el('button', 'restore-file'); row.type = 'button';
      row.appendChild(el('span', 'rf-name', f.name));
      row.appendChild(el('span', 'rf-date', f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : ''));
      row.onclick = () => loadRestoreDoc(f);
      box.appendChild(row);
    });
  }
  async function loadRestoreDoc(file) {
    const cfg = $('dr-restore-config'); clear(cfg); cfg.style.display = '';
    cfg.appendChild(el('p', 'muted sm', 'Reading ' + file.name + '…'));
    try { restoreDoc = await driveDownload(file.id); restoreDoc._file = file; }
    catch (e) { clear(cfg); cfg.appendChild(el('p', 'empty sm err-text', e.message)); return; }
    renderRestoreConfig();
  }
  function renderRestoreConfig() {
    const cfg = $('dr-restore-config'); clear(cfg);
    if (!restoreDoc || !Array.isArray(restoreDoc.profiles) || !restoreDoc.profiles.length) { cfg.appendChild(el('p', 'empty sm', "That file doesn't contain any profiles to restore.")); return; }
    cfg.appendChild(el('div', 'restore-title', 'Restore from ' + esc(restoreDoc._file.name)));
    // source profile
    const srcWrap = el('div', 'restore-field');
    srcWrap.appendChild(el('label', '', 'Which saved profile'));
    const src = el('select', 'restore-select');
    restoreDoc.profiles.forEach((p, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = p.name + ' · ' + (p.account || 'backup'); src.appendChild(o); });
    srcWrap.appendChild(src); cfg.appendChild(srcWrap);
    // target profile
    const tgtWrap = el('div', 'restore-field');
    tgtWrap.appendChild(el('label', '', 'Restore into'));
    const tgt = el('select', 'restore-select'); tgt.id = 'dr-restore-target';
    cfg.appendChild(tgtWrap); tgtWrap.appendChild(tgt);
    populateRestoreTargets(tgt);
    // buckets
    const bwrap = el('div', 'restore-field');
    bwrap.appendChild(el('label', '', 'What to restore'));
    const bgrid = el('div', 'restore-buckets');
    [['addons', 'Add-ons'], ['plugins', 'Plugins'], ['collections', 'Collections'], ['settings', 'Settings']].forEach(([k, lbl]) => {
      const b = el('label', 'rb');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.bucket = k; b.appendChild(cb); b.appendChild(el('span', '', lbl));
      bgrid.appendChild(b);
    });
    bwrap.appendChild(bgrid); cfg.appendChild(bwrap);
    // mode
    const mwrap = el('div', 'restore-field');
    mwrap.appendChild(el('label', '', 'How to apply'));
    const mode = el('select', 'restore-select'); mode.id = 'dr-restore-mode';
    mode.innerHTML = '<option value="merge">Merge — add and update, keep the rest</option><option value="overwrite">Overwrite — make it match this backup exactly</option>';
    mwrap.appendChild(mode); cfg.appendChild(mwrap);
    // actions
    const act = el('div', 'restore-actions');
    const btn = el('button', 'btn-dark', 'Preview restore'); btn.onclick = () => previewRestore(parseInt(src.value, 10));
    act.appendChild(btn);
    cfg.appendChild(act);
    cfg.appendChild(el('div', 'restore-results')).id = 'dr-restore-results';
  }
  async function populateRestoreTargets(sel) {
    sel.innerHTML = '';
    for (const rec of store.list()) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      profiles.forEach((p) => { const o = document.createElement('option'); o.value = rec.accountId + ':' + p.index; o.textContent = p.name + ' · ' + accountName(rec.accountId); sel.appendChild(o); });
    }
  }
  async function previewRestore(srcIdx) {
    const results = $('dr-restore-results'); results.innerHTML = ''; results.className = 'restore-results';
    const saved = restoreDoc.profiles[srcIdx];
    const tid = $('dr-restore-target').value; if (!tid) { results.textContent = 'Pick a target profile.'; return; }
    const [accountId, iStr] = tid.split(':'); const idx = parseInt(iStr, 10);
    const buckets = [...document.querySelectorAll('#dr-restore-config .rb input:checked')].map((c) => c.dataset.bucket);
    if (!buckets.length) { results.textContent = 'Pick at least one thing to restore.'; return; }
    const mode = $('dr-restore-mode').value === 'overwrite' ? 'mirror' : 'merge';
    results.textContent = 'Reading target…';
    try {
      const master = { addons: saved.addons || [], plugins: saved.plugins || [], collections: saved.collections || [], settings: saved.settings || {} };
      const c = A.client(store, accountId); const { backup } = await loadAccount(accountId);
      const state = sliceProfile(backup, idx); const updatedAt = {};
      if (buckets.includes('settings')) { state.settings = {}; for (const plat of ['tv', 'mobile']) { const row = await c.pullSettings(idx, plat); if (row && row.settings_json) { state.settings[plat] = row.settings_json; updatedAt[plat] = row.updated_at; } } }
      const cats = { addons: buckets.includes('addons'), plugins: buckets.includes('plugins'), collections: buckets.includes('collections'), settings: buckets.includes('settings') };
      const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: updatedAt });
      renderRestorePlan(results, plan, accountId);
    } catch (e) { results.textContent = 'Preview failed: ' + e.message; logAct('Restore preview failed: ' + e.message, 'err'); }
  }
  function renderRestorePlan(results, plan, accountId) {
    results.innerHTML = '';
    const r = plan.report;
    const div = el('div', 'report');
    const line = (label, o) => { if (!o) return; const bits = [tag('t-add', '+', o.added), tag('t-upd', '~', o.updated), tag('t-rem', '−', o.removed)].filter(Boolean); if (bits.length) { const d = el('div', 'rline'); d.innerHTML = '<span class="rk">' + label + '</span>' + bits.join(' '); div.appendChild(d); } };
    line('Add-ons', r.addons); line('Plugins', r.plugins); line('Collections', r.collections);
    if (r.settings) { let ch = 0; for (const p of Object.keys(r.settings)) ch += r.settings[p].changed.length; if (ch) { const d = el('div', 'rline'); d.innerHTML = '<span class="rk">Settings</span><span class="t-upd">' + ch + ' fields</span>'; div.appendChild(d); } }
    if (!plan.hasChanges) div.appendChild(el('div', 'rline muted', 'Already matches — nothing to restore.'));
    results.appendChild(div);
    if (plan.hasRemovals) {
      const warn = el('label', 'confirm-line');
      const cb = el('input'); cb.type = 'checkbox'; cb.id = 'dr-restore-confirm';
      warn.appendChild(cb); warn.appendChild(el('span', '', 'This will remove items the target has that this backup doesn\'t. I understand.'));
      results.appendChild(warn);
    }
    const apply = el('button', 'btn-dark', 'Apply restore'); apply.disabled = !plan.hasChanges;
    apply.onclick = async () => {
      if (plan.hasRemovals && !($('dr-restore-confirm') && $('dr-restore-confirm').checked)) { alert('Tick the confirmation box first.'); return; }
      apply.disabled = true; apply.textContent = 'Restoring…';
      try { const res = await A.client(store, accountId).applyPlan(plan, { dryRun: false }); const fails = (res.results || []).filter((x) => !x.ok); invalidateAll(); apply.textContent = fails.length ? 'Restored with errors' : 'Restored ✓'; logAct('Restored a backup into a profile' + (fails.length ? ' with ' + fails.length + ' error(s)' : ''), fails.length ? 'err' : 'ok'); }
      catch (e) { apply.textContent = 'Restore failed'; logAct('Restore failed: ' + e.message, 'err'); }
    };
    results.appendChild(apply);
  }

  // ======================================================================
  // SETTINGS panel
  // ======================================================================
  function clearLocalData() {
    if (!confirm('Remove all linked accounts and preferences from this device? Your Nuvio and Google accounts are not affected.')) return;
    store.clear(); invalidateAll();
    savePref('numax.readKeys', false); readKeys = false;
    logAct('Cleared all local data', 'info');
    refreshAccounts(); navTo('accounts');
  }

  // ======================================================================
  // wiring
  // ======================================================================
  function wire() {
    // landing
    $('btn-google').onclick = () => signInGoogle(enterApp);
    $('btn-skip').onclick = enterApp;

    // nav
    document.querySelectorAll('.navbtn').forEach((b) => { b.onclick = () => navTo(b.dataset.nav); });

    // accounts
    $('ac-link-btn').onclick = linkAccount;
    $('ac-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') linkAccount(); });
    $('ac-readkeys').checked = readKeys;
    $('ac-readkeys').onchange = (e) => setReadKeys(e.target.checked);

    // profile
    $('pf-account').onchange = () => renderProfilePicker($('pf-account').value);
    $('pf-save-identity').onclick = savePfIdentity;

    // sync
    $('sy-account').onchange = () => renderSyncSourcePicker($('sy-account').value);
    ['addons', 'plugins', 'collections', 'settings'].forEach((k) => {
      const cat = $('sy-cat-' + k); const chooser = $('sy-chooser-' + k);
      if (chooser) { chooser.style.display = cat.checked ? '' : 'none'; cat.addEventListener('change', () => { chooser.style.display = cat.checked ? '' : 'none'; }); }
    });
    document.querySelectorAll('.sy-chooser-toggle').forEach((btn) => { btn.onclick = () => { const box = $(btn.dataset.target); box.classList.toggle('open'); }; });
    $('sy-preview').onclick = syncPreview;
    $('sy-apply').onclick = syncApply;
    $('sy-confirm').onchange = () => { $('sy-apply').disabled = !$('sy-confirm').checked; };

    // drive
    $('dr-connect').onclick = () => signInGoogle(() => { setDriveConnected(true); refreshRestoreList(); });
    $('dr-backup-btn').onclick = driveBackupNow;
    $('dr-restore-refresh').onclick = refreshRestoreList;

    // settings
    $('st-readkeys').checked = readKeys;
    $('st-readkeys').onchange = (e) => setReadKeys(e.target.checked);
    $('st-clear-btn').onclick = clearLocalData;

    // activity
    $('act-clear').onclick = () => { activity.length = 0; renderActivity(); };
  }

  window.addEventListener('DOMContentLoaded', () => {
    wire();
    // if accounts already exist, allow skipping straight in without Google
    const hasAccounts = store.list().length > 0;
    $('btn-skip').style.display = hasAccounts ? '' : '';
    renderActivity();
  });
})();
