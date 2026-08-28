// ============================================================
// Numax controller (app.js)
// Google-only account model (accounts live in Drive, nothing on device),
// schema-driven Nuvio settings editor, templates on Drive, reorder.
// Core modules (api/store/engine/meta) unchanged; schema from nuvio-settings-schema.js.
// ============================================================
(function () {
  'use strict';
  const A = window.NumaxApi, S = window.NumaxStore, E = window.NumaxEngine;
  const SCHEMA = window.NUVIO_SETTINGS || { tv: [], mobile: [] };

  // memory-only store — nothing is written to localStorage, so no account ever
  // "sticks" on the device. The linked-account registry lives in Drive instead.
  const mem = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: k => { delete m[k]; } }; })();
  const store = S.makeStore(mem);
  const $ = id => document.getElementById(id);

  // ---- secret handling ----
  const SECRET_LEAF = (E && E.SECRET_LEAF) || /(api_?key|client_id|token|secret|access_token|refresh|password)/i;
  const API_KEY_STRIP = /(mdblist|tmdb|torbox|premiumize|animeskip|debrid).*(api_?key|token|secret|client_?id)/i;
  function stripKeys(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(stripKeys);
    const o = {}; for (const [k, v] of Object.entries(node)) { if (API_KEY_STRIP.test(k)) continue; o[k] = (v && typeof v === 'object') ? stripKeys(v) : v; } return o;
  }
  const ACCOUNT_GROUP = /^trakt_/i, PERSONAL_GROUP = /^track_preference$/i;

  // ======================================================================
  // state
  // ======================================================================
  const cache = {};                     // accountId -> {backup, profiles, keysLoaded}
  let readKeys = false;
  let gAuth = { token: null, client: null, user: null };
  let pfA = null, pfI = null, pfEdit = null, pfPlat = 'tv', pfTab = 0, pfEditorTab = 'addons';
  const PF_TAB_LABEL = { addons: 'Add-ons', plugins: 'Plugins', collections: 'Collections', settings: 'Settings', watchprogress: 'Watch Progress', watched: 'Watched' };
  const PF_TAB_SAVEABLE = { addons: true, plugins: true, collections: true, settings: true, watchprogress: true, watched: true };
  function switchPfEditorTab(kind) {
    pfEditorTab = kind;
    document.querySelectorAll('.pf-editor-tab').forEach(b => b.classList.toggle('on', b.dataset.pftab === kind));
    document.querySelectorAll('.pf-pane').forEach(p => p.style.display = (p.id === 'pf-pane-' + kind) ? '' : 'none');
    $('pf-editor-pane-title').textContent = PF_TAB_LABEL[kind] || kind;
    $('pf-editor-pane-tpl').dataset.tpl = kind;
    $('pf-editor-pane-tpl').style.display = PF_TAB_SAVEABLE[kind] ? '' : 'none';
  }
  const pfDirty = {};
  let syA = null, syI = null, sySnap = null;
  const sySel = { addons: new Set(), plugins: new Set(), collections: new Set(), settings: new Set() };
  const syTargets = new Set(); let syPlans = null;

  // ======================================================================
  // utils
  // ======================================================================
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = u => { try { return new URL(u).host; } catch { return String(u || ''); } };
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const clr = n => { while (n && n.firstChild) n.removeChild(n.firstChild); };
  const status = (n, m, c) => { if (n) { n.textContent = m || ''; n.className = 'inline-status' + (c ? ' ' + c : ''); } };

  // in-app modal — replaces browser confirm/prompt (no native "top" dialogs)
  function uiModal(opts) {
    return new Promise(resolve => {
      const root = $('modal-root'), inp = $('modal-input'), ok = $('modal-ok'), cancel = $('modal-cancel');
      $('modal-msg').textContent = opts.message || '';
      if (opts.input) { inp.style.display = ''; inp.value = opts.defaultVal || ''; setTimeout(() => { inp.focus(); inp.select(); }, 30); } else inp.style.display = 'none';
      ok.textContent = opts.okLabel || 'Confirm'; ok.className = 'btn ' + (opts.danger ? 'danger-btn' : 'btn-primary');
      cancel.style.display = opts.noCancel ? 'none' : '';
      root.style.display = '';
      const done = v => { root.style.display = 'none'; ok.onclick = cancel.onclick = $('modal-bg').onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
      ok.onclick = () => done(opts.input ? inp.value : true);
      cancel.onclick = () => done(opts.input ? null : false);
      $('modal-bg').onclick = () => done(opts.input ? null : false);
      const onKey = e => { if (e.key === 'Escape') done(opts.input ? null : false); if (e.key === 'Enter') done(opts.input ? inp.value : true); };
      document.addEventListener('keydown', onKey);
    });
  }
  const uiConfirm = (message, o) => uiModal({ message, okLabel: (o && o.okLabel) || 'Confirm', danger: o && o.danger });
  const uiPrompt = (message, defaultVal) => uiModal({ message, input: true, defaultVal, okLabel: 'Save' });
  const uiAlert = message => uiModal({ message, okLabel: 'OK', noCancel: true });
  const accountName = id => { const r = store.get(id); return (r && (r.label || r.email)) || (id ? id.slice(0, 8) + '…' : ''); };
  const collKey = c => (c && typeof c === 'object') ? (c.id != null ? 'id:' + c.id : (c.title != null ? 'title:' + c.title : 'j:' + JSON.stringify(c))) : 'j:' + JSON.stringify(c);
  const collLabel = c => (c && (c.title || c.name || (c.id != null ? 'Collection ' + c.id : null))) || 'Untitled';

  const avatarCatalog = {}; // avatar_id -> imageUrl, filled if a catalog is available
  function avatarUrlFor(p) {
    if (!p) return null;
    const url = (p.avatarUrl || '').trim(); if (url) return url;
    const id = (p.avatarId || '').trim(); if (id && avatarCatalog[id]) return avatarCatalog[id];
    return null;
  }
  function avatar(p, size, cls) {
    const s = el('span', 'av ' + (cls || '')); s.style.width = size + 'px'; s.style.height = size + 'px'; s.style.fontSize = Math.round(size * .4) + 'px';
    const url = avatarUrlFor(p);
    if (p && p.color) s.style.background = p.color;
    const ini = el('span', 'av-ini', ((p && p.name) ? p.name.trim()[0] : '?').toUpperCase() || '?'); s.appendChild(ini);
    if (url) { const i = document.createElement('img'); i.alt = ''; i.onload = () => { ini.style.display = 'none'; }; i.onerror = () => { i.remove(); }; i.src = url; s.appendChild(i); }
    return s;
  }
  function normProfiles(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
    return list.map((p, i) => ({
      index: p.profile_index != null ? p.profile_index : i + 1,
      name: p.name || p.display_name || ('Profile ' + (p.profile_index != null ? p.profile_index : i + 1)),
      avatarUrl: p.avatar_url || null, color: p.avatar_color_hex || null, avatarId: p.avatar_id || null,
      usesPrimaryAddons: !!p.uses_primary_addons, usesPrimaryPlugins: !!p.uses_primary_plugins,
    })).sort((a, b) => a.index - b.index);
  }
  const PROFILE_FIELDS = ['profile_index', 'name', 'avatar_color_hex', 'uses_primary_addons', 'uses_primary_plugins', 'avatar_id', 'avatar_url'];
  const normRow = r => { const o = {}; for (const f of PROFILE_FIELDS) o[f] = r[f] === undefined ? null : r[f]; return o; };
  const rawList = r => Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);

  // ======================================================================
  // activity
  // ======================================================================
  const activity = [];
  function logAct(msg, lvl) {
    activity.unshift({ t: Date.now(), msg, lvl: lvl || 'info' }); if (activity.length > 300) activity.pop();
    (lvl === 'err' ? console.error : console.info)('[Numax] ' + msg);
    if ($('act-list') && document.querySelector('[data-panel="activity"]').style.display !== 'none') renderActivity();
  }
  function renderActivity() {
    const b = $('act-list'); clr(b);
    if (!activity.length) { b.appendChild(el('p', 'empty', 'Nothing yet.')); return; }
    activity.forEach(a => { const r = el('div', 'rline'); r.style.borderTop = '1px solid var(--line-2)'; r.style.padding = '9px 0';
      r.appendChild(el('span', '', new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))).style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;color:var(--t35);width:54px;flex:none';
      const m = el('span', '', a.msg); m.style.color = a.lvl === 'err' ? '#ff8a80' : a.lvl === 'ok' ? '#7bd88f' : 'var(--t70)'; r.appendChild(m); b.appendChild(r); });
  }

  // (mascot/bird-flight system removed)
  function perch(navKey, animate) { /* mascot removed - no-op */ }

  // ======================================================================
  // views + nav
  // ======================================================================
  function showView(id) { document.querySelectorAll('.view').forEach(v => v.classList.toggle('current', v.id === id)); }
  const TITLES = { accounts: 'Nuvio accounts', profile: 'Profile', sync: 'Sync desk', templates: 'Templates', drive: 'Google Drive', activity: 'Activity', settings: 'Settings' };
  function enterApp() {
    showView('view-app');
    nav('accounts');
    // populate avatar catalog for built-in Nuvio avatars
    A.fetchAvatarCatalog().then(map => { Object.assign(avatarCatalog, map); }).catch(() => {});
  }
  function nav(panel) {
    document.querySelectorAll('[data-panel]').forEach(p => p.style.display = p.dataset.panel === panel ? '' : 'none');
    document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('on', b.dataset.nav === panel));
    $('crumb').textContent = TITLES[panel] || '';
    perch(panel, true);
    if (panel === 'accounts') refreshAccounts();
    if (panel === 'profile') refreshProfileTab();
    if (panel === 'sync') refreshSyncTab();
    if (panel === 'templates') refreshTemplates();
    if (panel === 'drive') refreshDrive();
    if (panel === 'activity') renderActivity();
  }

  // ======================================================================
  // Google auth + Drive REST
  // ======================================================================
  const G = { clientId: '841898218953-c5f3ide5lcsg8g2opn1ucrekvlq335rs.apps.googleusercontent.com', scope: 'openid email profile https://www.googleapis.com/auth/drive.file' };
  const DRIVE = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  function gReady() { return !!(window.google && window.google.accounts && window.google.accounts.oauth2); }
  function signIn(after) {
    if (!gReady()) { status($('ac-log'), 'Google library still loading — try again in a second.', 'err'); return; }
    if (!gAuth.client) {
      gAuth.client = window.google.accounts.oauth2.initTokenClient({
        client_id: G.clientId, scope: G.scope, callback: async resp => {
          if (resp && resp.error) { logAct('Google sign-in error: ' + resp.error, 'err'); return; }
          gAuth.token = resp;
          try { gAuth.user = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + resp.access_token } }).then(r => r.json()); } catch {}
          if (gAuth.user && gAuth.user.email) { $('sb-name').textContent = gAuth.user.name || gAuth.user.email; $('sb-avatar').textContent = (gAuth.user.name || gAuth.user.email)[0].toUpperCase(); }
          logAct('Signed in with Google', 'ok');
          await loadRegistry();
          if (typeof after === 'function') after();
        }
      });
    }
    gAuth.client.requestAccessToken();
  }
  function auth() { if (!gAuth.token) throw new Error('Sign in with Google first.'); return { Authorization: 'Bearer ' + gAuth.token.access_token }; }
  const safeName = n => String(n || 'numax').replace(/['"\\/]/g, '').trim().slice(0, 80) || 'numax';

  async function driveFindByProp(k, v) {
    const q = encodeURIComponent(`appProperties has { key='${k}' and value='${v}' } and trashed=false`);
    const r = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime,appProperties)&orderBy=modifiedTime desc`, { headers: auth() }).then(r => r.json());
    return (r && r.files) || [];
  }
  async function driveUpload(name, obj, appProps, existingId) {
    const boundary = 'nx' + Date.now();
    const meta = { name, mimeType: 'application/json', appProperties: appProps }; if (!existingId) meta.name = name;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;
    const url = existingId ? `${UP}/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime` : `${UP}/files?uploadType=multipart&fields=id,name,modifiedTime`;
    const r = await fetch(url, { method: existingId ? 'PATCH' : 'POST', headers: { ...auth(), 'Content-Type': `multipart/related; boundary=${boundary}` }, body }).then(r => r.json());
    if (!r || !r.id) throw new Error('Drive did not confirm the write.'); return r;
  }
  async function driveDownload(id) { const r = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: auth() }); if (!r.ok) throw new Error('Read failed (' + r.status + ').'); return r.json(); }
  async function driveDelete(id) { await fetch(`${DRIVE}/files/${id}`, { method: 'DELETE', headers: auth() }); }

  // ---- account registry in Drive ----
  let registryFileId = null;
  async function loadRegistry() {
    try {
      const files = await driveFindByProp('numax', 'registry');
      if (!files.length) { registryFileId = null; refreshAccounts(); return; }
      registryFileId = files[0].id;
      const doc = await driveDownload(registryFileId);
      (doc.accounts || []).forEach(a => { try { if (a.session && a.session.access_token) store.add(a.session, { email: a.email, label: a.label }); } catch (e) {} });
      logAct('Loaded ' + (doc.accounts || []).length + ' linked account(s) from Drive', 'info');
    } catch (e) { logAct('Could not load account registry: ' + e.message, 'err'); }
    refreshAccounts();
  }
  async function saveRegistry() {
    if (!gAuth.token) return;
    try {
      const accounts = store.list().map(r => ({ accountId: r.accountId, label: r.label, email: r.email, session: r.session }));
      const r = await driveUpload('numax-registry.json', { app: 'numax', kind: 'registry', savedAt: new Date().toISOString(), accounts }, { numax: 'registry' }, registryFileId);
      registryFileId = r.id;
    } catch (e) { logAct('Could not save account registry: ' + e.message, 'err'); }
  }

  // ======================================================================
  // account loading
  // ======================================================================
  async function loadAccount(id, force) {
    const c = cache[id]; if (c && c.keysLoaded === readKeys && !force) return c;
    const cl = A.client(store, id); const backup = await cl.exportBackup();
    if (!readKeys && Array.isArray(backup.profile_settings_blobs)) backup.profile_settings_blobs = backup.profile_settings_blobs.map(b => b && b.settings_json ? { ...b, settings_json: stripKeys(b.settings_json) } : b);
    const rec = { backup, profiles: normProfiles(backup.profiles), keysLoaded: readKeys }; cache[id] = rec; return rec;
  }
  const inval = id => { delete cache[id]; };
  const invalAll = () => Object.keys(cache).forEach(k => delete cache[k]);
  function sliceProfile(backup, idx) {
    const pick = a => Array.isArray(a) ? a.filter(r => r.profile_id === idx) : [];
    const coll = pick(backup.collections)[0]; const sb = {};
    pick(backup.profile_settings_blobs).forEach(b => { if (b && b.settings_json) sb[b.platform] = b.settings_json; });
    return { addons: pick(backup.addons).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), plugins: pick(backup.plugins).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), collections: (coll && coll.collections_json) || [], settings: sb };
  }

  // ======================================================================
  // ACCOUNTS
  // ======================================================================
  async function linkAccount() {
    const email = $('ac-email').value.trim(), pass = $('ac-pass').value, label = $('ac-label').value.trim(), log = $('ac-log');
    if (!gAuth.token) { status(log, 'Sign in with Google first (reload if needed).', 'err'); return; }
    if (!email || !pass) { status(log, 'Enter a Nuvio email and password.', 'err'); return; }
    status(log, 'Signing in to Nuvio…');
    let session; try { session = await A.signIn(email, pass); } catch (e) { status(log, 'Sign-in failed: ' + e.message, 'err'); return; }
    const already = store.get(S.decodeSub(session.access_token));
    try { store.add(session, { email, label }); } catch (e) { status(log, "Couldn't save: " + e.message, 'err'); return; }
    inval(S.decodeSub(session.access_token));
    $('ac-email').value = ''; $('ac-pass').value = ''; $('ac-label').value = '';
    await saveRegistry();
    status(log, (already ? 'Refreshed ' : 'Linked ') + (label || email) + '.', 'ok');
    logAct((already ? 'Refreshed ' : 'Linked ') + (label || email), 'ok');
    refreshAccounts();
  }
  async function reloadAccounts() {
    if (!gAuth.token) { status($('ac-log'), 'Sign in with Google first.', 'err'); return; }
    const btn = $('ac-reload'); btn.disabled = true; status($('ac-log'), 'Reloading from Drive…');
    invalAll();
    try { await loadRegistry(); status($('ac-log'), 'Reloaded.', 'ok'); logAct('Reloaded accounts and profiles', 'info'); }
    catch (e) { status($('ac-log'), 'Reload failed: ' + e.message, 'err'); }
    finally { btn.disabled = false; refreshAccounts(); }
  }
  async function refreshAccounts() {
    const list = store.list();
    if ($('ac-count')) $('ac-count').textContent = list.length;
    if ($('nav-ac-cnt')) $('nav-ac-cnt').textContent = list.length || '';
    if ($('sb-sub')) $('sb-sub').textContent = list.length ? list.length + ' account' + (list.length === 1 ? '' : 's') : 'No accounts';
    const box = $('ac-list'); if (!box) return; clr(box);
    if (!list.length) { box.appendChild(el('p', 'empty', 'No accounts linked yet. Add one above.')); return; }
    for (const rec of list) {
      const card = el('div', 'acct'); const head = el('div', 'acct-head');
      head.appendChild(avatar({ name: rec.label || rec.email }, 38));
      const who = el('div'); who.style.minWidth = '0';
      const nmRow = el('div', 'acct-name'); nmRow.textContent = rec.label || rec.email || rec.accountId.slice(0, 10);
      who.appendChild(nmRow);
      if (rec.email && rec.label) who.appendChild(el('div', 'acct-mail', rec.email)); head.appendChild(who);
      head.appendChild(el('span', 'spacer'));
      const ren = el('button', 'btn btn-ghost btn-xs', 'Rename'); ren.onclick = () => startRename(who, nmRow, rec.accountId);
      const rm = el('button', 'btn btn-ghost btn-xs danger', 'Unlink'); rm.onclick = () => unlink(rec.accountId, rec.label || rec.email);
      head.appendChild(ren); head.appendChild(rm); card.appendChild(head);
      const prof = el('div', 'acct-profiles'); prof.appendChild(el('span', 'muted sm', 'Loading profiles…')); card.appendChild(prof); box.appendChild(card);
      loadAccount(rec.accountId).then(({ profiles, keysLoaded }) => {
        // add API keys badge if this account was loaded WITH keys
        if (keysLoaded && !nmRow.querySelector('.api-badge')) {
          const badge = el('span', 'api-badge'); badge.textContent = 'API keys included';
          const dot = el('span'); dot.textContent = '●'; dot.style.cssText = 'font-size:8px;color:#7bd88f'; badge.insertBefore(dot, badge.firstChild);
          nmRow.appendChild(badge);
        }
        clr(prof); if (!profiles.length) { prof.appendChild(el('span', 'muted sm', 'No profiles.')); return; }
        profiles.forEach(p => { const c = el('span', 'pmini'); c.appendChild(avatar(p, 24)); c.appendChild(el('span', '', p.name)); prof.appendChild(c); });
      })
        .catch(e => { clr(prof); prof.appendChild(el('span', 'muted sm err-text', "Couldn't load: " + e.message)); });
    }
  }
  function startRename(who, nm, id) {
    const i = el('input'); i.type = 'text'; i.value = nm.textContent; i.maxLength = 40; i.className = 'rename-input'; who.replaceChild(i, nm); i.focus(); i.select();
    const commit = async () => { store.setLabel(id, i.value.trim() || null); await saveRegistry(); logAct('Renamed an account', 'info'); refreshAccounts(); };
    i.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refreshAccounts(); });
    i.addEventListener('blur', commit);
  }
  async function unlink(id, name) {
    if (!(await uiConfirm('Unlink ' + name + '? This removes it from your Numax registry — your Nuvio account is untouched.', { danger: true, okLabel: 'Unlink' }))) return;
    store.remove(id); inval(id); if (pfA === id) { pfA = pfI = pfEdit = null; } if (syA === id) { syA = syI = sySnap = null; }
    await saveRegistry(); logAct('Unlinked ' + name, 'info'); refreshAccounts();
  }
  function setReadKeys(on) {
    readKeys = on; $('ac-readkeys').classList.toggle('on', on); $('st-readkeys').classList.toggle('on', on); invalAll();
    logAct('API keys ' + (on ? 'will load' : 'will stay hidden'), 'info'); refreshAccounts();
    if (pfA != null) openProfile(pfA, pfI, true);
  }

  // ======================================================================
  // settings blob get/set  (handles {type,value} leaves AND *_payload JSON groups)
  // ======================================================================
  const isPayload = feat => /_payload$/.test(feat);
  function blobGet(blob, feat, key, dflt) {
    if (!blob || !blob.features) return dflt;
    const g = blob.features[feat];
    if (isPayload(feat)) { let o = {}; try { o = g ? (typeof g === 'string' ? JSON.parse(g || '{}') : g) : {}; } catch {} return (o && key in o) ? o[key] : dflt; }
    const leaf = g && g[key]; return (leaf && typeof leaf === 'object' && 'value' in leaf) ? leaf.value : (leaf !== undefined ? leaf : dflt);
  }
  function blobSet(blob, feat, key, val, type) {
    if (!blob.features) blob.features = {};
    if (isPayload(feat)) { let o = {}; try { o = blob.features[feat] ? (typeof blob.features[feat] === 'string' ? JSON.parse(blob.features[feat] || '{}') : blob.features[feat]) : {}; } catch {} o[key] = val; blob.features[feat] = JSON.stringify(o); return; }
    if (!blob.features[feat] || typeof blob.features[feat] !== 'object') blob.features[feat] = {};
    const prev = blob.features[feat][key];
    const t = (prev && prev.type) || ({ boolean: 'boolean', int: 'int', number: 'int', string: 'string' }[type] || 'string');
    blob.features[feat][key] = { type: t, value: val };
  }

  // ======================================================================
  // PROFILE editor
  // ======================================================================
  function refreshProfileTab() {
    const list = store.list(); const sel = $('pf-account'); const prev = sel.value;
    sel.innerHTML = list.map(r => `<option value="${esc(r.accountId)}">${esc(accountName(r.accountId))}</option>`).join('');
    if (!list.length) { $('pf-profiles').innerHTML = ''; $('pf-editor').classList.remove('open'); $('pf-empty').style.display = ''; return; }
    $('pf-empty').style.display = 'none';
    sel.value = (prev && list.some(r => r.accountId === prev)) ? prev : (pfA && list.some(r => r.accountId === pfA) ? pfA : list[0].accountId);
    renderPfPicker(sel.value);
  }
  async function renderPfPicker(id) {
    const box = $('pf-profiles'); clr(box); box.appendChild(el('span', 'muted sm', 'Loading…'));
    let profiles; try { profiles = (await loadAccount(id)).profiles; } catch (e) { clr(box); box.appendChild(el('span', 'muted sm err-text', e.message)); return; }
    clr(box); if (!profiles.length) { box.appendChild(el('span', 'muted sm', 'No profiles.')); return; }
    const keep = (id === pfA && profiles.some(p => p.index === pfI)) ? pfI : profiles[0].index;
    profiles.forEach(p => { const c = el('button', 'pchip' + (p.index === keep ? ' on' : '')); c.type = 'button'; c.appendChild(avatar(p, 42)); c.appendChild(el('span', 'pcn', p.name)); c.onclick = () => openProfile(id, p.index); box.appendChild(c); });
    openProfile(id, keep);
  }
  async function openProfile(id, idx, silent) {
    pfA = id; pfI = idx; Object.keys(pfDirty).forEach(k => delete pfDirty[k]);
    document.querySelectorAll('#pf-profiles .pchip').forEach((c, i) => loadAccount(id).then(({ profiles }) => c.classList.toggle('on', profiles[i] && profiles[i].index === idx)).catch(() => {}));
    const ed = $('pf-editor'); ed.classList.add('open'); $('pf-empty').style.display = 'none'; status($('pf-save-status'), '');
    let backup, profiles; try { const a = await loadAccount(id); backup = a.backup; profiles = a.profiles; } catch (e) { ed.classList.remove('open'); $('pf-empty').style.display = ''; $('pf-empty').textContent = "Couldn't read account: " + e.message; return; }
    const meta = profiles.find(p => p.index === idx) || { index: idx, name: 'Profile ' + idx };
    const slice = sliceProfile(backup, idx);
    const live = { tv: null, mobile: null }, upd = { tv: null, mobile: null };
    try { const c = A.client(store, id); for (const pl of ['tv', 'mobile']) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { live[pl] = readKeys ? row.settings_json : stripKeys(row.settings_json); upd[pl] = row.updated_at || null; } } } catch (e) { logAct("Couldn't read settings: " + e.message, 'err'); }
    const watched = Array.isArray(backup.watched_items) ? backup.watched_items.filter(w => w.profile_id === idx) : [];
    const watchProgress = Array.isArray(backup.watch_progress) ? backup.watch_progress.filter(w => w.profile_id === idx) : [];
    pfEdit = { meta: { ...meta }, addons: JSON.parse(JSON.stringify(slice.addons)), plugins: JSON.parse(JSON.stringify(slice.plugins)), collections: JSON.parse(JSON.stringify(slice.collections)), settings: JSON.parse(JSON.stringify(live)), upd, watched, watchProgress };
    pfPlat = live.tv ? 'tv' : (live.mobile ? 'mobile' : 'tv');
    renderPfEditor(); if (!silent) logAct('Opened ' + meta.name, 'info');
  }
  const dirty = k => { pfDirty[k] = true; };
  function renderPfEditor() {
    if (!pfEdit) return;
    $('pf-name-input').value = pfEdit.meta.name || '';
    renderPfList('addons'); renderPfList('plugins'); renderPfCollections(); renderSettingsEditor();
    renderPfWatched(); renderPfWatchProgress();
    switchPfEditorTab(pfEditorTab);
  }

  function orderControls(kind, arr, i) {
    const box = el('div', 'ord');
    const up = el('button', 'iconbtn', '↑'); up.style.cssText = 'width:22px;height:16px;font-size:10px'; up.disabled = i === 0; up.title = 'Move up';
    const dn = el('button', 'iconbtn', '↓'); dn.style.cssText = 'width:22px;height:16px;font-size:10px'; dn.disabled = i === arr.length - 1; dn.title = 'Move down';
    up.onclick = () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; dirty(kind); (kind === 'collections' ? renderPfCollections : () => renderPfList(kind))(); };
    dn.onclick = () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; dirty(kind); (kind === 'collections' ? renderPfCollections : () => renderPfList(kind))(); };
    box.appendChild(up); box.appendChild(dn); return box;
  }
  function renderPfList(kind) {
    const box = $('pf-' + kind); clr(box); const list = pfEdit[kind];
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'No ' + kind + '.')); }
    list.forEach((item, i) => {
      const row = el('div', 'erow'); row.appendChild(orderControls(kind, list, i));
      const tog = el('button', 'tog' + (item.enabled !== false ? ' on' : '')); tog.onclick = () => { item.enabled = !(item.enabled !== false); tog.classList.toggle('on', item.enabled); dirty(kind); };
      row.appendChild(tog);
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', item.name || host(item.url))); b.appendChild(el('div', 'es', host(item.url))); row.appendChild(b);
      const del = el('button', 'iconbtn', '✕'); del.onclick = () => { list.splice(i, 1); dirty(kind); renderPfList(kind); }; row.appendChild(del);
      box.appendChild(row);
    });
    const save = el('button', 'btn btn-solid btn-xs', 'Save ' + kind + ' to this profile'); save.onclick = () => savePfList(kind); box.appendChild(save);
  }
  function renderPfCollections() {
    const box = $('pf-collections'); clr(box); const list = pfEdit.collections;
    if (!Array.isArray(list) || !list.length) { box.appendChild(el('p', 'empty sm', 'No collections.')); }
    (list || []).forEach((c, i) => {
      const row = el('div', 'erow'); row.appendChild(orderControls('collections', list, i));
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', collLabel(c)));
      const folders = (c && Array.isArray(c.folders)) ? c.folders : [];
      b.appendChild(el('div', 'es', folders.length ? folders.length + ' folder' + (folders.length === 1 ? '' : 's') : 'No folders')); row.appendChild(b);
      const ed = el('button', 'iconbtn', '⇅'); ed.title = 'Reorder folders'; ed.disabled = folders.length < 2; ed.onclick = () => toggleFolders(row, c, i); row.appendChild(ed);
      const del = el('button', 'iconbtn', '✕'); del.onclick = () => { list.splice(i, 1); dirty('collections'); renderPfCollections(); }; row.appendChild(del);
      box.appendChild(row);
      const fbox = el('div', 'subrow'); fbox.dataset.folders = i; fbox.style.display = 'none'; box.appendChild(fbox);
    });
    const save = el('button', 'btn btn-solid btn-xs', 'Save collections to this profile'); save.onclick = () => savePfCollections(); box.appendChild(save);
  }
  function toggleFolders(row, coll, idx) {
    const box = row.nextSibling; if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; clr(box); return; }
    box.style.display = ''; clr(box);
    (coll.folders || []).forEach((f, j) => {
      const fr = el('div', 'erow'); fr.appendChild(orderControls2(coll.folders, j, () => { dirty('collections'); toggleFolders(row, coll, idx); toggleFolders(row, coll, idx); }));
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', (f && (f.title || f.name)) || 'Folder ' + (j + 1))); fr.appendChild(b); box.appendChild(fr);
    });
  }
  function orderControls2(arr, i, after) {
    const box = el('div', 'ord');
    const up = el('button', 'iconbtn', '↑'); up.style.cssText = 'width:22px;height:16px;font-size:10px'; up.disabled = i === 0;
    const dn = el('button', 'iconbtn', '↓'); dn.style.cssText = 'width:22px;height:16px;font-size:10px'; dn.disabled = i === arr.length - 1;
    up.onclick = () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; after(); }; dn.onclick = () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; after(); };
    box.appendChild(up); box.appendChild(dn); return box;
  }

  // ---- watched / watch progress ----
  function renderPfWatched() {
    const box = $('pf-watched'); clr(box);
    const list = (pfEdit && pfEdit.watched) || [];
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'No watched history for this profile.')); return; }
    box.appendChild(el('p', 'muted sm', list.length + ' watched item' + (list.length === 1 ? '' : 's') + '.'));
    const display = list.slice(0, 80);
    const resolveQueue = [];
    display.forEach(w => {
      const row = el('div', 'watched-row');
      const hasTitle = !!w.title;
      const title = w.title || w.content_id || '(unknown)';
      const type = w.content_type || '';
      const season = w.season_number ? 'S' + w.season_number : '';
      const episode = w.episode_number ? 'E' + w.episode_number : '';
      const seInfo = [season, episode].filter(Boolean).join('');
      const titleSpan = el('span', 'watched-title', title + (seInfo ? ' ' : ''));
      if (seInfo) { const se = el('span', 'watched-se', seInfo); titleSpan.appendChild(se); }
      row.appendChild(titleSpan);
      if (type) row.appendChild(el('span', 'watched-meta', type));
      box.appendChild(row);
      if (!hasTitle && window.NumaxMeta && window.NumaxMeta.isImdbId(w.content_id)) {
        resolveQueue.push({ id: w.content_id, type: (type || '').toLowerCase() === 'series' ? 'series' : undefined, titleSpan, seInfo });
      }
    });
    if (list.length > 80) box.appendChild(el('p', 'muted sm', '… and ' + (list.length - 80) + ' more'));
    if (resolveQueue.length && window.NumaxMeta) {
      window.NumaxMeta.resolveBatch(
        resolveQueue.map(({ id, type }) => ({ id, type })),
        (id, result) => { if (!result) return; for (const e of resolveQueue) { if (e.id === id) { e.titleSpan.childNodes[0].textContent = result.name + (e.seInfo ? ' ' : ''); } } }
      );
    }
  }
  function renderPfWatchProgress() {
    const box = $('pf-watchprogress'); clr(box);
    const list = (pfEdit && pfEdit.watchProgress) || [];
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'No watch progress for this profile.')); return; }
    box.appendChild(el('p', 'muted sm', list.length + ' item' + (list.length === 1 ? '' : 's') + ' in progress.'));
    const display = list.slice(0, 80);
    const resolveQueue = [];
    display.forEach(w => {
      const row = el('div', 'watched-row');
      const label = w.content_id || w.progress_key || '(unknown)';
      const posMin = Math.round((w.position || 0) / 60000);
      const durMin = Math.round((w.duration || 0) / 60000);
      const pct = durMin > 0 ? Math.round((posMin / durMin) * 100) : 0;
      const titleSpan = el('span', 'watched-title', w.title || label);
      row.appendChild(titleSpan);
      const prog = el('div', 'row'); prog.style.gap = '8px';
      const bar = el('div', 'wp-bar'); const fill = el('div', 'wp-bar-fill'); fill.style.width = Math.min(pct, 100) + '%'; bar.appendChild(fill); prog.appendChild(bar);
      prog.appendChild(el('span', 'watched-meta', posMin + 'm / ' + durMin + 'm (' + pct + '%)'));
      row.appendChild(prog);
      box.appendChild(row);
      if (!w.title && window.NumaxMeta && window.NumaxMeta.isImdbId(w.content_id)) {
        resolveQueue.push({ id: w.content_id, type: (w.content_type || '').toLowerCase() === 'series' ? 'series' : undefined, titleSpan });
      }
    });
    if (list.length > 80) box.appendChild(el('p', 'muted sm', '… and ' + (list.length - 80) + ' more'));
    if (resolveQueue.length && window.NumaxMeta) {
      window.NumaxMeta.resolveBatch(
        resolveQueue.map(({ id, type }) => ({ id, type })),
        (id, result) => { if (!result) return; for (const e of resolveQueue) { if (e.id === id) e.titleSpan.textContent = result.name; } }
      );
    }
  }

  // ---- settings editor (schema-driven) ----
  function renderSettingsEditor() {
    const wrap = $('pf-settings'); clr(wrap);
    const plats = ['tv', 'mobile'].filter(p => pfEdit.settings[p] && pfEdit.settings[p].features);
    if (!plats.length) { wrap.appendChild(el('p', 'empty sm', 'No settings found for this profile.')); return; }
    if (!plats.includes(pfPlat)) pfPlat = plats[0];
    const bar = el('div', 'set-platbar');
    plats.forEach(p => { const b = el('button', p === pfPlat ? 'on' : '', p === 'tv' ? 'TV app' : 'Mobile app'); b.onclick = () => { pfPlat = p; pfTab = 0; renderSettingsEditor(); }; bar.appendChild(b); });
    const save = el('button', 'btn btn-solid btn-xs', 'Save ' + (pfPlat === 'tv' ? 'TV' : 'mobile') + ' settings'); save.style.marginLeft = 'auto'; save.onclick = () => savePfSettings(pfPlat); bar.appendChild(save);
    wrap.appendChild(bar);

    const tabs = SCHEMA[pfPlat] || [];
    const tabBar = el('div', 'set-tabs');
    tabs.forEach((t, i) => { const b = el('button', 'set-tab' + (i === pfTab ? ' on' : ''), t.title); b.onclick = () => { pfTab = i; renderSettingsEditor(); }; tabBar.appendChild(b); });
    wrap.appendChild(tabBar);

    const search = el('input'); search.type = 'search'; search.placeholder = 'Search ' + (pfPlat === 'tv' ? 'TV' : 'mobile') + ' settings'; search.className = 'set-search';
    search.oninput = () => filterSettings(search.value.trim().toLowerCase()); wrap.appendChild(search);

    const body = el('div'); body.id = 'set-body'; wrap.appendChild(body);
    const tab = tabs[pfTab]; if (!tab) return;
    (tab.groups || []).forEach(g => {
      const gb = el('div', 'set-group'); if (g.title) gb.appendChild(el('div', 'set-group-h', g.title)); if (g.description) gb.appendChild(el('div', 'set-group-d', g.description));
      g.fields.forEach(f => { if (!f.title) return; gb.appendChild(renderField(f)); }); body.appendChild(gb);
    });
    applyVisibility();
  }
  function filterSettings(q) {
    document.querySelectorAll('#set-body .set-field').forEach(row => {
      const hit = !q || (row.dataset.search || '').includes(q); row.dataset.filtered = hit ? '' : '1';
    });
    applyVisibility();
    document.querySelectorAll('#set-body .set-group').forEach(g => { const any = [...g.querySelectorAll('.set-field')].some(r => r.style.display !== 'none'); g.style.display = any ? '' : 'none'; });
  }
  function curVal(f) { const b = pfEdit.settings[pfPlat]; return blobGet(b, f.feature, f.key, f.defaultValue); }
  function setVal(f, v) { blobSet(pfEdit.settings[pfPlat], f.feature, f.key, v, f.type); dirty('settings-' + pfPlat); applyVisibility(); }
  function applyVisibility() {
    document.querySelectorAll('#set-body .set-field').forEach(row => {
      let show = true; const vw = row._vw;
      if (vw) { const v = blobGet(pfEdit.settings[pfPlat], vw.feature, vw.key, false); show = !!v; }
      if (row.dataset.filtered === '1') show = false;
      row.style.display = show ? '' : 'none';
    });
  }
  function renderField(f) {
    const row = el('div', 'set-field'); row.dataset.search = ((f.title || '') + ' ' + (f.description || '')).toLowerCase(); if (f.visibleWhen) row._vw = f.visibleWhen;
    const l = el('div', 'sf-l'); const t = el('div', 'sf-t'); t.textContent = f.title || f.key; if (f.advanced) { const a = el('span', 'sf-adv', 'Advanced'); t.appendChild(a); } l.appendChild(t);
    if (f.description) l.appendChild(el('div', 'sf-d', f.description)); row.appendChild(l);
    const c = el('div', 'sf-c'); c.appendChild(control(f)); row.appendChild(c); return row;
  }
  function control(f) {
    const v = curVal(f), ctl = f.control;
    if (SECRET_LEAF.test(f.key) || ctl === 'secret') {
      const w = el('div', 'sf-secret');
      if (readKeys) { const i = el('input'); i.type = 'password'; i.value = (v == null ? '' : v); i.onchange = () => setVal(f, i.value); w.appendChild(i); }
      else { const s = el('input'); s.type = 'text'; s.value = v ? '••••••••' : ''; s.disabled = true; w.appendChild(s); w.appendChild(el('span', 'lock', 'hidden')); }
      return w;
    }
    if (ctl === 'toggle') { const w = el('div', 'sf-toggle-wrap'); const st = el('span', 'st', v ? 'On' : 'Off'); const tg = el('button', 'tog' + (v ? ' on' : '')); tg.onclick = () => { const nv = !tg.classList.contains('on'); tg.classList.toggle('on', nv); st.textContent = nv ? 'On' : 'Off'; setVal(f, nv); }; w.appendChild(st); w.appendChild(tg); return w; }
    if (ctl === 'swatches') { const w = el('div', 'swatches'); (f.options || []).forEach(o => { const b = el('button', 'swatch' + (String(v) === String(o.value) ? ' on' : '')); if (o.color) { const d = el('span', 'dot'); d.style.background = o.color; b.appendChild(d); } b.appendChild(el('span', '', o.label || o.value)); if (o.supporterOnly) b.appendChild(el('span', 'sup', 'Supporter')); b.onclick = () => { setVal(f, o.value); [...w.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); }; w.appendChild(b); }); return w; }
    if (ctl === 'segmented') { const w = el('div', 'seg' + ((f.options || []).some(o => o.desc) ? ' cards' : '')); (f.options || []).forEach(o => { const b = el('button', String(v) === String(o.value) ? 'on' : ''); b.appendChild(el('span', '', o.label || o.value)); if (o.desc) b.appendChild(el('span', 'osub', o.desc)); b.onclick = () => { setVal(f, o.value); [...w.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); }; w.appendChild(b); }); return w; }
    if (ctl === 'select' || ctl === 'language') { const s = el('select', 'sel'); (f.options || []).forEach(o => { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label || o.value; if (String(v) === String(o.value)) op.selected = true; s.appendChild(op); }); s.onchange = () => setVal(f, s.value); return s; }
    if (ctl === 'slider') { const w = el('div', 'sf-range-wrap'); const r = el('input'); r.type = 'range'; if (f.min != null) r.min = f.min; if (f.max != null) r.max = f.max; if (f.step != null) r.step = f.step; r.value = v == null ? (f.min || 0) : v; const o = el('output', '', String(r.value) + (f.unit ? ' ' + f.unit : '')); r.oninput = () => { o.textContent = r.value + (f.unit ? ' ' + f.unit : ''); }; r.onchange = () => setVal(f, Number(r.value)); w.appendChild(r); w.appendChild(o); return w; }
    if (ctl === 'number') { const i = el('input'); i.type = 'number'; if (f.min != null) i.min = f.min; if (f.max != null) i.max = f.max; if (f.step != null) i.step = f.step; i.value = v == null ? '' : v; i.onchange = () => setVal(f, i.value === '' ? 0 : Number(i.value)); return i; }
    if (ctl === 'color') { const w = el('div', 'row'); const cp = el('input'); cp.type = 'color'; const hex = normHex(v); cp.value = hex; const tx = el('input'); tx.type = 'text'; tx.value = (v == null ? '' : v); tx.style.maxWidth = '120px'; cp.oninput = () => { tx.value = cp.value; setVal(f, cp.value); }; tx.onchange = () => { setVal(f, tx.value); const h = normHex(tx.value); if (h) cp.value = h; }; w.appendChild(cp); w.appendChild(tx); return w; }
    if (ctl === 'multiselect') { const w = el('div'); const sel = new Set(Array.isArray(v) ? v : []); const opts = multiOptions(f); if (!opts.length) { return el('span', 'muted sm', 'Populated from this profile\'s add-ons.'); } opts.forEach(o => { const lab = el('label', 'pick'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = sel.has(o.value); cb.onchange = () => { cb.checked ? sel.add(o.value) : sel.delete(o.value); setVal(f, [...sel]); }; lab.appendChild(cb); lab.appendChild(el('span', 'pn', o.label)); w.appendChild(lab); }); return w; }
    if (ctl === 'textarea' || ctl === 'json' || ctl === 'fusion_badge_rules') { const ta = el('textarea'); ta.value = (typeof v === 'string') ? v : (v == null ? '' : JSON.stringify(v, null, 2)); ta.onchange = () => { let nv = ta.value; if (ctl !== 'textarea') { try { nv = JSON.parse(ta.value); } catch { /* keep raw string */ } } setVal(f, nv); }; return ta; }
    // text (default)
    const i = el('input'); i.type = 'text'; i.value = (v == null ? '' : v); i.onchange = () => setVal(f, i.value); return i;
  }
  function normHex(v) { if (typeof v !== 'string') return '#000000'; let s = v.replace('#', ''); if (s.length === 8) s = s.slice(0, 6); if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s; if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s.split('').map(x => x + x).join(''); return '#000000'; }
  function multiOptions(f) { const src = /plugin/i.test(f.title) ? pfEdit.plugins : pfEdit.addons; return (src || []).map(x => ({ value: x.url, label: x.name || host(x.url) })); }

  // ---- profile saves ----
  async function savePfIdentity() {
    const name = $('pf-name-input').value.trim(); if (!name) { status($('pf-save-status'), 'Give the profile a name.', 'err'); return; }
    if (name === pfEdit.meta.name) { status($('pf-save-status'), 'Name unchanged.', 'info'); return; }
    status($('pf-save-status'), 'Renaming…');
    try {
      const c = A.client(store, pfA); const live = rawList(await c.pullProfiles()); if (!live.length) throw new Error("Couldn't read profiles.");
      if (!live.find(p => p.profile_index === pfI)) throw new Error('Profile no longer exists.');
      const next = live.map(p => { const r = normRow(p); if (p.profile_index === pfI) r.name = name.slice(0, 60); return r; });
      if (live.map(p => p.profile_index).sort().join() !== next.map(p => p.profile_index).sort().join()) throw new Error('Profile list changed — reload.');
      await c.rpc('sync_push_profiles', { p_profiles: next, p_client_max_profiles: 6 });
      pfEdit.meta.name = name; inval(pfA); status($('pf-save-status'), 'Saved.', 'ok'); logAct('Renamed profile to ' + name, 'ok'); renderPfPicker(pfA);
    } catch (e) { status($('pf-save-status'), "Couldn't rename: " + e.message, 'err'); }
  }
  async function savePfList(kind) {
    status($('pf-save-status'), 'Saving ' + kind + '…');
    try {
      const c = A.client(store, pfA);
      const rows = pfEdit[kind].map((x, i) => { const r = { url: x.url, name: x.name ?? null, enabled: x.enabled !== false, sort_order: i }; if (kind === 'plugins' && x.repo_type !== undefined) r.repo_type = x.repo_type; return r; });
      await c.rpc(kind === 'addons' ? 'sync_push_addons' : 'sync_push_plugins', { [kind === 'addons' ? 'p_addons' : 'p_plugins']: rows, p_profile_id: pfI, p_origin_client_id: 'numax-web' });
      inval(pfA); status($('pf-save-status'), 'Saved ' + kind + '.', 'ok'); logAct('Saved ' + kind + ' to ' + pfEdit.meta.name, 'ok');
    } catch (e) { status($('pf-save-status'), "Couldn't save " + kind + ': ' + e.message, 'err'); }
  }
  async function savePfCollections() {
    status($('pf-save-status'), 'Saving…');
    try { await A.client(store, pfA).rpc('sync_push_collections', { p_profile_id: pfI, p_collections_json: pfEdit.collections, p_origin_client_id: 'numax-web' }); inval(pfA); status($('pf-save-status'), 'Saved collections.', 'ok'); logAct('Saved collections to ' + pfEdit.meta.name, 'ok'); }
    catch (e) { status($('pf-save-status'), "Couldn't save collections: " + e.message, 'err'); }
  }
  async function savePfSettings(plat) {
    const blob = pfEdit.settings[plat]; if (!blob) return;
    status($('pf-save-status'), 'Saving settings…');
    try {
      const c = A.client(store, pfA);
      await c.rpc('sync_push_profile_settings_blob_guarded', { p_profile_id: pfI, p_settings_json: blob, p_platform: plat, p_expected_updated_at: pfEdit.upd[plat] || null });
      const row = await c.pullSettings(pfI, plat); if (row) pfEdit.upd[plat] = row.updated_at || null;
      inval(pfA); status($('pf-save-status'), 'Saved settings.', 'ok'); logAct('Saved ' + plat + ' settings to ' + pfEdit.meta.name, 'ok');
    } catch (e) { const conflict = (A.ConflictError && e instanceof A.ConflictError) || /40001|409|another device/i.test(e.message || ''); status($('pf-save-status'), conflict ? 'These settings changed elsewhere — reopen the profile and try again.' : "Couldn't save: " + e.message, 'err'); }
  }

  // ======================================================================
  // TEMPLATES (on Drive)
  // ======================================================================
  function pfSettingsForTemplate() {
    const out = {};
    for (const pl of ['tv', 'mobile']) { const b = pfEdit.settings[pl]; if (b && b.features) out[pl] = stripKeys(JSON.parse(JSON.stringify(b))); }
    return out;
  }
  async function saveTemplate(kind) {
    if (!gAuth.token) { await uiAlert('Sign in with Google first.'); return; }
    if (!pfEdit) { await uiAlert('Open a profile first.'); return; }
    const name = await uiPrompt('Name this template', pfEdit.meta.name + ' ' + kind); if (name == null || !name.trim()) return;
    const payload = { app: 'numax', kind: 'template', tkind: kind, name, savedAt: new Date().toISOString(), from: pfEdit.meta.name };
    if (kind === 'addons') payload.addons = pfEdit.addons;
    else if (kind === 'plugins') payload.plugins = pfEdit.plugins;
    else if (kind === 'collections') payload.collections = pfEdit.collections;
    else if (kind === 'settings') payload.settings = pfSettingsForTemplate();
    else if (kind === 'watchprogress') payload.watchProgress = pfEdit.watchProgress || [];
    else if (kind === 'watched') payload.watched = pfEdit.watched || [];
    else if (kind === 'profile') { payload.addons = pfEdit.addons; payload.plugins = pfEdit.plugins; payload.collections = pfEdit.collections; payload.settings = pfSettingsForTemplate(); payload.watched = pfEdit.watched || []; payload.watchProgress = pfEdit.watchProgress || []; }
    status($('pf-save-status'), 'Saving template…');
    try { await driveUpload(safeName('numax-tpl-' + name) + '.json', payload, { numax: 'template', tkind: kind }); status($('pf-save-status'), 'Template “' + name + '” saved to Drive — see the Templates tab.', 'ok'); logAct('Saved template "' + name + '" (' + kind + ')', 'ok'); if ($('tpl-list')) refreshTemplates(); }
    catch (e) { status($('pf-save-status'), "Couldn't save template: " + e.message, 'err'); logAct('Template save failed: ' + e.message, 'err'); }
  }
  async function refreshTemplates() {
    const box = $('tpl-list'); clr(box); status($('tpl-status'), '');
    if (!gAuth.token) { box.appendChild(el('p', 'empty', 'Sign in with Google to see templates.')); return; }
    box.appendChild(el('p', 'muted sm', 'Loading…'));
    let files; try { files = await driveFindByProp('numax', 'template'); } catch (e) { clr(box); box.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(box); if (!files.length) { box.appendChild(el('p', 'empty', 'No templates yet. Save one from a profile\'s editor.')); return; }
    files.forEach(f => {
      const kind = (f.appProperties && f.appProperties.tkind) || 'template';
      const row = el('div', 'erow');
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', f.name.replace(/^numax-tpl-/, '').replace(/\.json$/, ''))); b.appendChild(el('div', 'es', kind + ' · ' + (f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ''))); row.appendChild(b);
      const ap = el('button', 'btn btn-solid btn-xs', 'Apply'); ap.onclick = () => openTemplateApply(f); row.appendChild(ap);
      const del = el('button', 'iconbtn', '✕'); del.title = 'Delete template'; del.onclick = async () => { if (!(await uiConfirm('Delete this template?', { danger: true, okLabel: 'Delete' }))) return; await driveDelete(f.id); logAct('Deleted a template', 'info'); refreshTemplates(); }; row.appendChild(del);
      box.appendChild(row);
    });
  }
  async function openTemplateApply(file) {
    const card = $('tpl-apply-card'), body = $('tpl-apply-body'); card.style.display = ''; clr(body); body.appendChild(el('p', 'muted sm', 'Reading template…'));
    $('tpl-apply-title').textContent = 'Apply ' + file.name.replace(/^numax-tpl-/, '').replace(/\.json$/, '');
    let doc; try { doc = await driveDownload(file.id); } catch (e) { clr(body); body.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(body);
    // target picker
    const tw = el('label', 'fld'); tw.style.maxWidth = '440px'; tw.appendChild(el('span', '', 'Apply to profile'));
    const tsel = el('select', 'sel'); tw.appendChild(tsel); body.appendChild(tw);
    for (const rec of store.list()) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; } profiles.forEach(p => { const o = document.createElement('option'); o.value = rec.accountId + ':' + p.index; o.textContent = p.name + ' · ' + accountName(rec.accountId); tsel.appendChild(o); }); }
    const mw = el('label', 'fld'); mw.style.cssText = 'max-width:440px;margin-top:12px'; mw.appendChild(el('span', '', 'How to apply'));
    const msel = el('select', 'sel'); msel.innerHTML = '<option value="merge">Merge — add and update, keep the rest</option><option value="overwrite">Overwrite — match the template exactly</option>'; mw.appendChild(msel); body.appendChild(mw);
    const bar = el('div', 'actbar'); const btn = el('button', 'btn btn-primary', 'Preview'); const st = el('div', 'inline-status'); bar.appendChild(btn); bar.appendChild(st); body.appendChild(bar);
    const res = el('div'); res.style.marginTop = '12px'; body.appendChild(res);
    btn.onclick = async () => {
      const tid = tsel.value; if (!tid) { status(st, 'Pick a target.', 'err'); return; } const [aid, iStr] = tid.split(':'); const idx = parseInt(iStr, 10);
      const mode = msel.value === 'overwrite' ? 'mirror' : 'merge';
      // watchprogress / watched templates use a direct upsert (no plan/preview needed)
      if (doc.watched || doc.watchProgress) {
        const items = doc.watched ? { rpc: 'sync_push_watched_items', payload: doc.watched, label: 'watched items', paramKey: 'p_watched_items' }
                                  : { rpc: 'sync_push_watch_progress', payload: doc.watchProgress, label: 'watch progress', paramKey: 'p_watch_progress' };
        if (!Array.isArray(items.payload) || !items.payload.length) { status(st, 'Template has no ' + items.label + '.', 'err'); return; }
        clr(res); res.appendChild(el('div', 'report'));
        res.firstChild.innerHTML = `<div class="rhead">${items.payload.length} ${items.label} → target</div><div class="rline muted">Applied as an upsert — existing entries stay in place.</div>`;
        const ap = el('button', 'btn btn-solid', 'Apply');
        ap.onclick = async () => { ap.disabled = true; status(st, 'Applying…');
          try { await A.client(store, aid).rpc(items.rpc, { [items.paramKey]: items.payload, p_profile_id: idx, p_origin_client_id: 'numax-web' }); inval(aid); status(st, 'Template applied.', 'ok'); logAct('Applied ' + items.label + ' template to profile ' + idx, 'ok'); }
          catch (e) { status(st, 'Failed: ' + e.message, 'err'); } };
        res.appendChild(ap);
        return;
      }
      status(st, 'Reading target…');
      try {
        const master = { addons: doc.addons || [], plugins: doc.plugins || [], collections: doc.collections || [], settings: doc.settings || {} };
        const c = A.client(store, aid); const { backup } = await loadAccount(aid); const state = sliceProfile(backup, idx); const upd = {};
        if (doc.settings && Object.keys(doc.settings).length) { state.settings = {}; for (const pl of ['tv', 'mobile']) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { state.settings[pl] = row.settings_json; upd[pl] = row.updated_at; } } }
        const cats = { addons: !!(doc.addons), plugins: !!(doc.plugins), collections: !!(doc.collections), settings: !!(doc.settings && Object.keys(doc.settings).length) };
        const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: upd });
        renderApplyPlan(res, st, plan, aid, 'Template applied', { watched: doc.watched, watchProgress: doc.watchProgress, profileId: idx });
      } catch (e) { status(st, e.message, 'err'); }
    };
  }

  // shared apply-plan renderer (templates + restore)
  function tagHtml(cls, sign, arr) { return (arr && arr.length) ? `<span class="tag ${cls}">${sign}${arr.length}</span>` : ''; }
  function renderApplyPlan(res, st, plan, accountId, okMsg, extras) {
    clr(res); const r = plan.report; const d = el('div', 'report');
    const line = (label, o) => { if (!o) return; const bits = [tagHtml('add', '+', o.added), tagHtml('upd', '~', o.updated), tagHtml('rem', '−', o.removed)].filter(Boolean); if (bits.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">${label}</span>` + bits.join(' '); d.appendChild(x); } };
    line('Add-ons', r.addons); line('Plugins', r.plugins); line('Collections', r.collections);
    if (r.settings) { let ch = 0; for (const p of Object.keys(r.settings)) ch += r.settings[p].changed.length; if (ch) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Settings</span><span class="tag upd">${ch} fields</span>`; d.appendChild(x); } }
    if (extras && Array.isArray(extras.watched) && extras.watched.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Watched</span><span class="tag add">+${extras.watched.length}</span>`; d.appendChild(x); }
    if (extras && Array.isArray(extras.watchProgress) && extras.watchProgress.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Progress</span><span class="tag add">+${extras.watchProgress.length}</span>`; d.appendChild(x); }
    const hasExtras = extras && ((extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length));
    if (!plan.hasChanges && !hasExtras) d.appendChild(el('div', 'rline muted', 'Already matches — nothing to do.'));
    res.appendChild(d);
    let confirmed = !plan.hasRemovals;
    if (plan.hasRemovals) { const w = el('label', 'confirm'); const cb = el('input'); cb.type = 'checkbox'; cb.onchange = () => { confirmed = cb.checked; ap.disabled = !confirmed; }; w.appendChild(cb); w.appendChild(el('span', '', 'This removes items the target has that this doesn\'t. I understand.')); res.appendChild(w); }
    const ap = el('button', 'btn btn-solid', 'Apply'); ap.disabled = (!plan.hasChanges && !hasExtras) || !confirmed;
    ap.onclick = async () => { ap.disabled = true; status(st, 'Applying…');
      try {
        const rr = await A.client(store, accountId).applyPlan(plan, { dryRun: false }); const fails = (rr.results || []).filter(x => !x.ok);
        // extras: push watched/progress in addition to plan
        if (extras && extras.profileId != null) {
          const c = A.client(store, accountId);
          if (Array.isArray(extras.watched) && extras.watched.length) { try { await c.rpc('sync_push_watched_items', { p_watched_items: extras.watched, p_profile_id: extras.profileId, p_origin_client_id: 'numax-web' }); } catch (e) { fails.push({ ok: false, surface: 'watched', error: e.message }); } }
          if (Array.isArray(extras.watchProgress) && extras.watchProgress.length) { try { await c.rpc('sync_push_watch_progress', { p_watch_progress: extras.watchProgress, p_profile_id: extras.profileId, p_origin_client_id: 'numax-web' }); } catch (e) { fails.push({ ok: false, surface: 'progress', error: e.message }); } }
        }
        invalAll(); status(st, fails.length ? okMsg + ' with ' + fails.length + ' error(s).' : okMsg + '.', fails.length ? 'err' : 'ok'); logAct(okMsg + (fails.length ? ' (' + fails.length + ' errors)' : ''), fails.length ? 'err' : 'ok');
      } catch (e) { status(st, 'Failed: ' + e.message, 'err'); }
    };
    res.appendChild(ap);
  }

  // ======================================================================
  // SYNC DESK  (two-column workspace, live preview on every change,
  // watched/watchprogress as upsert-only categories, review grid + metrics)
  // ======================================================================
  const sySnapExt = { watched: [], watchProgress: [] }; // filled per source select

  function refreshSyncTab() {
    const list = store.list(); const sel = $('sy-account'); const prev = sel.value;
    sel.innerHTML = list.map(r => `<option value="${esc(r.accountId)}">${esc(accountName(r.accountId))}</option>`).join('');
    if (!list.length) { $('sy-body').classList.remove('open'); $('sy-empty').style.display = ''; return; }
    $('sy-empty').style.display = 'none'; $('sy-body').classList.add('open');
    sel.value = (prev && list.some(r => r.accountId === prev)) ? prev : (syA && list.some(r => r.accountId === syA) ? syA : list[0].accountId);
    renderSySource(sel.value);
  }
  async function renderSySource(id) {
    const box = $('sy-source'); clr(box); box.appendChild(el('span', 'muted sm', 'Loading…'));
    let profiles; try { profiles = (await loadAccount(id)).profiles; } catch (e) { clr(box); box.appendChild(el('span', 'muted sm err-text', e.message)); return; }
    clr(box); if (!profiles.length) { box.appendChild(el('span', 'muted sm', 'No profiles.')); return; }
    const keep = (id === syA && profiles.some(p => p.index === syI)) ? syI : profiles[0].index;
    profiles.forEach(p => {
      const c = el('button', 'pchip' + (p.index === keep ? ' on' : ''));
      c.type = 'button'; c.appendChild(avatar(p, 26)); c.appendChild(el('span', 'pcn', p.name));
      c.onclick = () => selectSource(id, p.index);
      box.appendChild(c);
    });
    selectSource(id, keep);
  }
  async function selectSource(id, idx) {
    syA = id; syI = idx;
    document.querySelectorAll('#sy-source .pchip').forEach((c, i) => loadAccount(id).then(({ profiles }) => c.classList.toggle('on', profiles[i] && profiles[i].index === idx)).catch(() => {}));
    status($('sy-status'), 'Reading source…');
    try {
      const { backup } = await loadAccount(id); const slice = sliceProfile(backup, idx); const c = A.client(store, id); const settings = {};
      for (const pl of ['tv', 'mobile']) { try { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) settings[pl] = readKeys ? row.settings_json : stripKeys(row.settings_json); } catch (e) { logAct("Couldn't read " + pl + " settings: " + e.message, 'err'); } }
      sySnap = { addons: slice.addons, plugins: slice.plugins, collections: slice.collections, settings };
      sySnapExt.watched = Array.isArray(backup.watched_items) ? backup.watched_items.filter(w => w.profile_id === idx) : [];
      sySnapExt.watchProgress = Array.isArray(backup.watch_progress) ? backup.watch_progress.filter(w => w.profile_id === idx) : [];
      resetSel(); renderSyItems(); renderSyTree(); await renderSyTargets(); updateSyCounts(); status($('sy-status'), '');
      renderReviewEmpty();
    } catch (e) { sySnap = null; status($('sy-status'), "Couldn't read source: " + e.message, 'err'); }
  }
  function resetSel() {
    const s = sySnap || {};
    sySel.addons = new Set((s.addons || []).map(a => a.url));
    sySel.plugins = new Set((s.plugins || []).map(p => p.url));
    sySel.collections = new Set((s.collections || []).map(collKey));
    sySel.settings = defTokens(s.settings || {});
  }
  function defTokens(settings) {
    const t = new Set();
    for (const pl of Object.keys(settings)) { const feat = (settings[pl] && settings[pl].features) || {}; for (const g of Object.keys(feat)) { const gv = feat[g]; if (ACCOUNT_GROUP.test(g)) continue; if (typeof gv === 'string') { t.add(pl + '::' + g); continue; } if (PERSONAL_GROUP.test(g)) continue; if (gv && typeof gv === 'object') for (const lf of Object.keys(gv)) if (!SECRET_LEAF.test(lf)) t.add(pl + '::' + g + '.' + lf); } }
    return t;
  }
  const syList = k => { const s = sySnap; return !s ? [] : (k === 'collections' ? (s.collections || []) : (s[k] || [])); };
  const syKey = (k, x) => k === 'collections' ? collKey(x) : x.url;
  function renderSyItems() { ['addons', 'plugins', 'collections'].forEach(renderSyItem); }
  function renderSyItem(kind) {
    const box = $('sy-items-' + kind); clr(box); const list = syList(kind);
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'None on the source.')); return; }
    const bar = el('div', 'sy-carry-chooser-bar');
    const all = el('button', 'sy-linkbtn', 'Select all'), none = el('button', 'sy-linkbtn muted', 'Select none');
    all.onclick = () => { list.forEach(x => sySel[kind].add(syKey(kind, x))); renderSyItem(kind); updateSyCounts(); scheduleLivePreview(); };
    none.onclick = () => { sySel[kind].clear(); renderSyItem(kind); updateSyCounts(); scheduleLivePreview(); };
    bar.appendChild(all); bar.appendChild(el('span', 'sy-sep', '|')); bar.appendChild(none); box.appendChild(bar);
    list.forEach(x => { const key = syKey(kind, x); const row = el('label', 'pick'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = sySel[kind].has(key); cb.onchange = () => { cb.checked ? sySel[kind].add(key) : sySel[kind].delete(key); updateSyCounts(); scheduleLivePreview(); }; row.appendChild(cb); const b = el('div', 'pb'); if (kind === 'collections') { b.appendChild(el('div', 'pn', collLabel(x))); } else { b.appendChild(el('div', 'pn', x.name || host(x.url))); b.appendChild(el('div', 'ps', host(x.url))); } row.appendChild(b); box.appendChild(row); });
  }
  function availTokens(pl) {
    const t = new Set(); const feat = ((sySnap.settings[pl]) || {}).features || {};
    for (const g of Object.keys(feat)) { const gv = feat[g]; if (ACCOUNT_GROUP.test(g) || PERSONAL_GROUP.test(g)) continue; if (typeof gv === 'string') { t.add(pl + '::' + g); continue; } if (gv && typeof gv === 'object') for (const l of Object.keys(gv)) if (!SECRET_LEAF.test(l)) t.add(pl + '::' + g + '.' + l); }
    return t;
  }
  function schemaTabTokens(pl, tab) {
    const toks = new Set();
    (tab.groups || []).forEach(g => g.fields.forEach(f => {
      if (!f.title || ACCOUNT_GROUP.test(f.feature) || SECRET_LEAF.test(f.key)) return;
      toks.add(isPayload(f.feature) ? pl + '::' + f.feature : pl + '::' + f.feature + '.' + f.key);
    }));
    return toks;
  }
  function renderSyTree() {
    const tree = $('sy-settings-tree'); clr(tree); const settings = (sySnap && sySnap.settings) || {}; const plats = Object.keys(settings).filter(p => settings[p] && settings[p].features);
    if (!plats.length) { tree.appendChild(el('p', 'empty sm', 'No settings on source.')); return; }
    const groupRow = (title, sub, eff, extraCls) => {
      const row = el('label', 'pick' + (extraCls ? ' ' + extraCls : '')); const cb = el('input'); cb.type = 'checkbox';
      const selN = eff.filter(t => sySel.settings.has(t)).length; cb.checked = eff.length > 0 && selN === eff.length; cb.indeterminate = selN > 0 && selN < eff.length;
      cb.onchange = () => { eff.forEach(t => cb.checked ? sySel.settings.add(t) : sySel.settings.delete(t)); renderSyTree(); updateSyCounts(); scheduleLivePreview(); };
      row.appendChild(cb); const b = el('div', 'pb'); b.appendChild(el('div', 'pn', title)); if (sub) b.appendChild(el('div', 'ps', sub)); row.appendChild(b); return row;
    };
    plats.forEach(pl => {
      tree.appendChild(el('div', 'set-group-h', pl === 'tv' ? 'TV app' : 'Mobile app'));
      const avail = availTokens(pl); const covered = new Set();
      (SCHEMA[pl] || []).forEach(tab => {
        const eff = [...schemaTabTokens(pl, tab)].filter(t => avail.has(t)); if (!eff.length) return;
        eff.forEach(t => covered.add(t));
        tree.appendChild(groupRow(tab.title, eff.length + ' setting' + (eff.length === 1 ? '' : 's'), eff));
      });
      const other = [...avail].filter(t => !covered.has(t));
      if (other.length) tree.appendChild(groupRow('Other settings', other.length + ' more', other));
      const feat = settings[pl].features;
      Object.keys(feat).forEach(g => { if (PERSONAL_GROUP.test(g)) tree.appendChild(groupRow('Personal watch preferences', 'off by default', [pl + '::' + g])); });
      if (Object.keys(feat).some(g => ACCOUNT_GROUP.test(g))) { const row = el('label', 'pick'); row.style.opacity = '.55'; row.appendChild(el('span', 'cb-spacer', '')); const b = el('div', 'pb'); b.appendChild(el('div', 'pn', 'Account-linked (Trakt)')); b.appendChild(el('div', 'ps', 'never copied')); row.appendChild(b); tree.appendChild(row); }
    });
  }
  function updateSyCounts() {
    const s = sySnap || {};
    const set = (id, sel, tot) => { const e = $(id); if (e) e.textContent = tot ? sel + ' / ' + tot : '0 / 0'; };
    set('sy-cnt-addons', sySel.addons.size, (s.addons || []).length);
    set('sy-cnt-plugins', sySel.plugins.size, (s.plugins || []).length);
    set('sy-cnt-collections', sySel.collections.size, (s.collections || []).length);
    if ($('sy-cnt-settings')) $('sy-cnt-settings').textContent = sySel.settings.size + ' selected';
    if ($('sy-cnt-watchprogress')) $('sy-cnt-watchprogress').textContent = (sySnapExt.watchProgress || []).length + ' items';
    if ($('sy-cnt-watched')) $('sy-cnt-watched').textContent = (sySnapExt.watched || []).length + ' items';
  }

  // ---- targets: grouped by account, chip-style, with per-account select all ----
  let allSyTids = [];
  async function renderSyTargets() {
    const box = $('sy-targets'); clr(box); syTargets.clear(); allSyTids = [];
    const list = store.list(); if (!list.length) { box.appendChild(el('p', 'empty sm', 'Link an account.')); return; }
    let any = false;
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const tgt = profiles.filter(p => !(rec.accountId === syA && p.index === syI)); if (!tgt.length) continue;
      const group = el('div', 'sy-ct-group');
      group.appendChild(el('div', 'sy-ct-group-lbl', (accountName(rec.accountId) || '').toUpperCase()));
      const chips = el('div', 'sy-ct-chips');
      const acctTids = [];
      tgt.forEach(p => {
        const tid = rec.accountId + ':' + p.index; allSyTids.push(tid); acctTids.push(tid);
        const c = el('button', 'sy-chip'); c.type = 'button'; c.dataset.tid = tid;
        c.appendChild(avatar(p, 22)); c.appendChild(el('span', 'pcn', p.name));
        const chk = el('span', 'chk'); chk.textContent = '✓'; c.appendChild(chk);
        c.onclick = () => {
          const on = syTargets.has(tid); on ? syTargets.delete(tid) : syTargets.add(tid);
          c.classList.toggle('on', !on); updateApplyBtnLabel(); scheduleLivePreview();
        };
        chips.appendChild(c);
      });
      group.appendChild(chips); box.appendChild(group);
      // per-account select-all is available via the header "Select all" — no per-account button in this design
      group._acctTids = acctTids;
      any = true;
    }
    if (!any) box.appendChild(el('p', 'empty sm', 'No other profiles to sync into.'));
  }
  function sySelectAll() {
    allSyTids.forEach(t => syTargets.add(t));
    document.querySelectorAll('#sy-targets .sy-chip').forEach(c => c.classList.add('on'));
    updateApplyBtnLabel(); scheduleLivePreview();
  }
  function syDeselectAll() {
    syTargets.clear();
    document.querySelectorAll('#sy-targets .sy-chip').forEach(c => c.classList.remove('on'));
    updateApplyBtnLabel(); renderReviewEmpty();
  }

  // ---- live preview ----
  let livePreviewTimer = null;
  function scheduleLivePreview() {
    updateApplyBtnLabel();
    clearTimeout(livePreviewTimer);
    livePreviewTimer = setTimeout(() => {
      if (syTargets.size === 0 || !sySnap) { renderReviewEmpty(); return; }
      livePreviewAllTargets();
    }, 220);
  }
  function updateApplyBtnLabel() {
    const n = syTargets.size;
    const btn = $('sy-apply'); if (!btn) return;
    btn.textContent = 'Apply to ' + n + ' profile' + (n === 1 ? '' : 's');
  }
  function renderReviewEmpty() {
    $('sy-review-empty').style.display = ''; $('sy-review-full').style.display = 'none';
    const sub = $('sy-review-sub'); if (sub) sub.textContent = '';
    status($('sy-pv-status'), '');
    $('sy-confirm-wrap').style.display = 'none'; $('sy-confirm').checked = false; $('sy-apply').disabled = true; syPlans = null;
  }
  async function livePreviewAllTargets() {
    if (!sySnap) { renderReviewEmpty(); return; }
    const targets = [...syTargets]; if (!targets.length) { renderReviewEmpty(); return; }
    $('sy-review-empty').style.display = 'none'; $('sy-review-full').style.display = '';
    status($('sy-pv-status'), 'Reading…');
    const mode = $('sy-mode').value === 'overwrite' ? 'mirror' : 'merge';
    const cats = {
      addons: $('sy-cat-addons').checked, plugins: $('sy-cat-plugins').checked,
      collections: $('sy-cat-collections').checked, settings: $('sy-cat-settings').checked,
      watchprogress: $('sy-cat-watchprogress').checked, watched: $('sy-cat-watched').checked,
    };
    const master = syMaster();
    try {
      const plans = []; let rem = false;
      for (const tid of targets) {
        const [aid, iStr] = tid.split(':'); const idx = parseInt(iStr, 10);
        const c = A.client(store, aid); const { backup } = await loadAccount(aid);
        const state = sliceProfile(backup, idx); const upd = {};
        if (cats.settings) { state.settings = {}; for (const pl of ['tv', 'mobile']) { try { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { state.settings[pl] = row.settings_json; upd[pl] = row.updated_at; } } catch (e) { logAct('Settings read failed for ' + pl + ': ' + e.message, 'err'); } } }
        const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: upd });
        if (plan.hasRemovals) rem = true;
        // watched / watchprogress: upsert-only, no removals possible
        const extras = {};
        if (cats.watchprogress && sySnapExt.watchProgress.length) extras.watchProgress = sySnapExt.watchProgress;
        if (cats.watched && sySnapExt.watched.length) extras.watched = sySnapExt.watched;
        plans.push({ aid, tid, plan, extras });
      }
      syPlans = plans; renderSyReports(plans); renderSyMetrics(plans);
      if (rem) $('sy-confirm-wrap').style.display = ''; else { $('sy-confirm-wrap').style.display = 'none'; $('sy-confirm').checked = false; }
      $('sy-apply').disabled = rem && !$('sy-confirm').checked;
      const sub = $('sy-review-sub'); if (sub) sub.textContent = plans.length + ' profile' + (plans.length === 1 ? '' : 's') + ' selected';
      renderSyReviewFoot(plans, rem);
      status($('sy-pv-status'), 'Live', 'ok');
    } catch (e) { status($('sy-pv-status'), e.message, 'err'); }
  }
  function syMaster() {
    const s = sySnap;
    const out = {
      addons: (s.addons || []).filter(a => sySel.addons.has(a.url)),
      plugins: (s.plugins || []).filter(p => sySel.plugins.has(p.url)),
      collections: (s.collections || []).filter(c => sySel.collections.has(collKey(c))),
      settings: {},
    };
    for (const pl of Object.keys(s.settings || {})) {
      const blob = s.settings[pl]; const feat = (blob && blob.features) || {}; const of = {};
      for (const g of Object.keys(feat)) {
        const gv = feat[g]; const gtok = pl + '::' + g;
        if (sySel.settings.has(gtok)) { of[g] = gv; continue; }
        if (gv && typeof gv === 'object' && typeof gv !== 'string') {
          const pick = {}; for (const lf of Object.keys(gv)) if (sySel.settings.has(pl + '::' + g + '.' + lf)) pick[lf] = gv[lf];
          if (Object.keys(pick).length) of[g] = pick;
        }
      }
      if (Object.keys(of).length) out.settings[pl] = { version: blob.version, features: of };
    }
    return out;
  }
  async function syncPreview() {
    if (!sySnap) { status($('sy-status'), 'Pick a source.', 'err'); return; }
    const targets = [...syTargets]; if (!targets.length) { status($('sy-status'), 'Tick at least one target.', 'err'); return; }
    status($('sy-status'), '');
    await livePreviewAllTargets();
    logAct('Previewed sync into ' + targets.length + ' profile(s)', 'info');
  }
  function tidName(tid) { const [id, i] = tid.split(':'); const rec = cache[id]; const p = rec && rec.profiles.find(x => x.index === parseInt(i, 10)); return { name: p ? p.name : 'Profile ' + i, acct: accountName(id), profile: p || { name: 'Profile ' + i } }; }

  // ---- metrics row ----
  function renderSyMetrics(plans) {
    const box = $('sy-metrics'); if (!box) return; clr(box);
    let addN = 0, plgN = 0, colN = 0, setN = 0, wpN = 0, wdN = 0;
    plans.forEach(({ plan, extras }) => {
      const r = plan.report;
      if (r.addons) addN += (r.addons.added || []).length + (r.addons.updated || []).length;
      if (r.plugins) plgN += (r.plugins.added || []).length + (r.plugins.updated || []).length;
      if (r.collections) colN += (r.collections.added || []).length + (r.collections.updated || []).length;
      if (r.settings) for (const p of Object.keys(r.settings)) setN += (r.settings[p].changed || []).length;
      if (extras.watchProgress) wpN += extras.watchProgress.length;
      if (extras.watched) wdN += extras.watched.length;
    });
    const metric = (icon, n, label) => {
      const m = el('div', 'sy-metric');
      const ic = el('span', 'sy-metric-ic'); ic.innerHTML = icon; m.appendChild(ic);
      const tx = el('div', 'sy-metric-tx'); tx.appendChild(el('div', 'n', String(n))); tx.appendChild(el('div', 'l', label)); m.appendChild(tx);
      return m;
    };
    box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>', plans.length, 'Profiles'));
    box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>', addN, 'Add-ons'));
    if (plgN) box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3v4M15 3v4M6 7h12v5a6 6 0 1 1-12 0V7z"/></svg>', plgN, 'Plugins'));
    if (colN) box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h18M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7"/></svg>', colN, 'Collections'));
    if (wpN) box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>', wpN, 'Progress'));
    if (wdN) box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>', wdN, 'Watched'));
    box.appendChild(metric('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-1.7-1L14 3.4h-4l-.7 2.7a7.5 7.5 0 0 0-1.7 1l-2.3-1-2 3.4L5.6 11a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 1.7 1l.7 2.7h4l.7-2.7a7.5 7.5 0 0 0 1.7-1l2.3 1 2-3.4Z"/></svg>', setN, 'Settings'));
  }

  // ---- profile change cards grid ----
  function renderSyReports(plans) {
    const box = $('sy-results'); clr(box);
    plans.forEach(({ tid, plan, extras }) => {
      const nm = tidName(tid);
      const r = plan.report; const d = el('div', 'sy-card-report');
      const head = el('div', 'rhead');
      head.appendChild(avatar(nm.profile, 26));
      const nameSpan = el('span', 'rhead-name'); nameSpan.textContent = nm.name;
      head.appendChild(nameSpan);
      const acctBadge = el('span', 'rbadge no'); acctBadge.textContent = nm.acct;
      acctBadge.style.background = 'var(--surface)'; acctBadge.style.border = '1px solid var(--line)';
      head.appendChild(acctBadge);
      const chgBadge = el('span', 'rbadge ' + (plan.hasChanges || (extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length) ? 'chg' : 'no'));
      chgBadge.textContent = (plan.hasChanges || (extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length)) ? 'changes' : 'no change';
      head.appendChild(chgBadge);
      d.appendChild(head);

      const line = (label, o) => {
        if (!o) return null;
        const bits = [];
        if (o.added && o.added.length) bits.push('<span class="tag add">+' + o.added.length + '</span>');
        if (o.updated && o.updated.length) bits.push('<span class="tag upd">~' + o.updated.length + '</span>');
        if (o.removed && o.removed.length) bits.push('<span class="tag rem">−' + o.removed.length + '</span>');
        if (o.keptLocal && o.keptLocal.length) bits.push('<span class="tag keep">keeps ' + o.keptLocal.length + '</span>');
        if (!bits.length) return null;
        const x = el('div', 'rline'); x.innerHTML = '<span class="rk">' + label + '</span>' + bits.join(' '); return x;
      };
      const rows = [];
      const a = line('Add-ons', r.addons); if (a) rows.push(a);
      const p = line('Plugins', r.plugins); if (p) rows.push(p);
      const c = line('Collections', r.collections); if (c) rows.push(c);
      if (r.settings) { let ch = 0, held = 0; for (const pl of Object.keys(r.settings)) { ch += r.settings[pl].changed.length; held += r.settings[pl].skippedSecrets.length; } if (ch || held) { const x = el('div', 'rline'); x.innerHTML = '<span class="rk">Settings</span>' + (ch ? '<span class="tag upd">' + ch + ' fields</span>' : '') + (held ? '<span class="tag held">' + held + ' held</span>' : ''); rows.push(x); } }
      if (extras.watchProgress && extras.watchProgress.length) { const x = el('div', 'rline'); x.innerHTML = '<span class="rk">Progress</span><span class="tag add">+' + extras.watchProgress.length + '</span>'; rows.push(x); }
      if (extras.watched && extras.watched.length) { const x = el('div', 'rline'); x.innerHTML = '<span class="rk">Watched</span><span class="tag add">+' + extras.watched.length + '</span>'; rows.push(x); }
      // removals line — explicit
      const remRow = el('div', 'rline');
      const totalRem = ((r.addons && (r.addons.removed || []).length) || 0) + ((r.plugins && (r.plugins.removed || []).length) || 0) + ((r.collections && (r.collections.removed || []).length) || 0);
      remRow.innerHTML = '<span class="rk">Removals</span>' + (totalRem ? '<span class="tag rem">−' + totalRem + '</span>' : '<span style="font-size:12px;color:var(--t45)">None</span>');
      if (rows.length) rows.forEach(rw => d.appendChild(rw));
      d.appendChild(remRow);
      if (!rows.length && !totalRem) d.appendChild(el('div', 'no-change', 'Already matches — nothing to do.'));
      box.appendChild(d);
    });
  }

  // ---- review footer (final confirmation area) ----
  function renderSyReviewFoot(plans, hasRem) {
    const foot = $('sy-review-foot'); if (!foot) return; clr(foot); foot.style.display = '';
    const note = el('div', 'foot-note' + (hasRem ? ' warn' : ''));
    note.innerHTML = hasRem
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 17h.01"/></svg><span>Removals detected — review and confirm on the left before applying.</span>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg><span>No removals in ' + ($('sy-mode').value === 'overwrite' ? 'Overwrite' : 'Merge') + ' mode — safe to apply.</span>';
    foot.appendChild(note);
  }

  async function syncApply() {
    if (!syPlans) return; $('sy-apply').disabled = true; status($('sy-status'), 'Applying…'); let ok = 0, fail = 0;
    for (const { aid, plan, extras } of syPlans) {
      const hasExtras = (extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length);
      if (!plan.hasChanges && !hasExtras) continue;
      try {
        if (plan.hasChanges) {
          const r = await A.client(store, aid).applyPlan(plan, { dryRun: false });
          (r.results || []).forEach(x => { x.ok ? ok++ : fail++; if (!x.ok) logAct('Sync ' + x.surface + ' failed: ' + x.error, 'err'); });
        }
        if (hasExtras) {
          const c = A.client(store, aid);
          if (extras.watchProgress && extras.watchProgress.length) { try { await c.rpc('sync_push_watch_progress', { p_watch_progress: extras.watchProgress, p_profile_id: plan.profileId, p_origin_client_id: 'numax-web' }); ok++; } catch (e) { fail++; logAct('Sync watch progress failed: ' + e.message, 'err'); } }
          if (extras.watched && extras.watched.length) { try { await c.rpc('sync_push_watched_items', { p_watched_items: extras.watched, p_profile_id: plan.profileId, p_origin_client_id: 'numax-web' }); ok++; } catch (e) { fail++; logAct('Sync watched failed: ' + e.message, 'err'); } }
        }
      } catch (e) { fail++; logAct('Apply failed: ' + e.message, 'err'); }
    }
    invalAll();
    status($('sy-status'), 'Done — ' + ok + ' change' + (ok === 1 ? '' : 's') + (fail ? ', ' + fail + ' failed.' : '.'), fail ? 'err' : 'ok');
    logAct('Applied sync: ' + ok + ' ok' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'err' : 'ok');
    syPlans = null; selectSource(syA, syI);
  }

  // ======================================================================
  // DRIVE (backup / restore)
  // ======================================================================
  async function refreshDrive() {
    status($('dr-status'), gAuth.token ? (gAuth.user && gAuth.user.email ? 'Connected as ' + gAuth.user.email : 'Connected.') : 'Not connected.', gAuth.token ? 'ok' : 'err');
    const box = $('dr-backup-picker'); clr(box); const list = store.list(); if (!list.length) { box.appendChild(el('p', 'empty sm', 'Link an account to choose what to back up.')); return; }
    const allBtn = el('button', 'btn btn-ghost btn-xs', 'Select all'); allBtn.style.marginBottom = '12px';
    allBtn.onclick = () => { const chips = box.querySelectorAll('.pchip.multi'); const allOn = [...chips].every(c => c.classList.contains('on')); chips.forEach(c => c.classList.toggle('on', !allOn)); allBtn.textContent = allOn ? 'Select all' : 'Deselect all'; };
    box.appendChild(allBtn);
    for (const rec of list) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const acctRow = el('div', 'tgt-acct-row'); acctRow.appendChild(el('div', 'tgt-acct', accountName(rec.accountId)));
      const acctSelAll = el('button', 'tgt-selall', 'select all');
      acctRow.appendChild(acctSelAll); box.appendChild(acctRow);
      const grid = el('div', 'tgt-grid'); profiles.forEach(p => { const tid = rec.accountId + ':' + p.index; const c = el('button', 'pchip multi'); c.type = 'button'; c.dataset.tid = tid; c.appendChild(avatar(p, 38)); c.appendChild(el('span', 'pcn', p.name)); c.appendChild(el('span', 'chk', '✓')); c.onclick = () => c.classList.toggle('on'); grid.appendChild(c); }); box.appendChild(grid);
      acctSelAll.onclick = () => { const chips = grid.querySelectorAll('.pchip.multi'); const allOn = [...chips].every(c => c.classList.contains('on')); chips.forEach(c => c.classList.toggle('on', !allOn)); acctSelAll.textContent = allOn ? 'select all' : 'deselect all'; };
    }
    refreshRestore();
  }
  async function backupNow() {
    const log = $('dr-backup-log'); const picked = [...document.querySelectorAll('#dr-backup-picker .pchip.on')].map(c => c.dataset.tid); if (!picked.length) { status(log, 'Pick at least one profile.', 'err'); return; }
    const name = $('dr-name').value.trim() || ('numax-backup-' + new Date().toISOString().slice(0, 10)); const keys = $('dr-keys').classList.contains('on');
    $('dr-backup-btn').disabled = true; status(log, 'Building backup…');
    try {
      const out = { app: 'numax', kind: 'backup', savedAt: new Date().toISOString(), includesKeys: keys, profiles: [] }; const by = {};
      picked.forEach(tid => { const [id, i] = tid.split(':'); (by[id] = by[id] || []).push(parseInt(i, 10)); });
      for (const aid of Object.keys(by)) { const c = A.client(store, aid); const { backup } = await loadAccount(aid); for (const idx of by[aid]) { const slice = sliceProfile(backup, idx); const meta = cache[aid].profiles.find(p => p.index === idx) || { name: 'Profile ' + idx }; const settings = {}; for (const pl of ['tv', 'mobile']) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) settings[pl] = keys ? row.settings_json : stripKeys(row.settings_json); } out.profiles.push({ account: accountName(aid), accountId: aid, profileIndex: idx, name: meta.name, addons: slice.addons, plugins: slice.plugins, collections: slice.collections, settings }); } }
      status(log, 'Uploading…'); const files = await driveFindByProp('numax', 'backup'); const existing = files.find(f => f.name === (safeName(name).endsWith('.json') ? safeName(name) : safeName(name) + '.json'));
      const r = await driveUpload(safeName(name).endsWith('.json') ? safeName(name) : safeName(name) + '.json', out, { numax: 'backup' }, existing && existing.id);
      status(log, (existing ? 'Updated ' : 'Saved ') + r.name + ' (' + out.profiles.length + ' profile' + (out.profiles.length === 1 ? '' : 's') + ').', 'ok'); logAct((existing ? 'Updated' : 'Saved') + ' backup "' + r.name + '"', 'ok'); refreshRestore();
    } catch (e) { status(log, 'Backup failed: ' + e.message, 'err'); } finally { $('dr-backup-btn').disabled = false; }
  }
  let restoreDoc = null;
  async function refreshRestore() {
    const box = $('dr-restore-list'); clr(box); if (!gAuth.token) { box.appendChild(el('p', 'empty sm', 'Connect Google Drive.')); return; }
    box.appendChild(el('p', 'muted sm', 'Loading…')); let files; try { files = await driveFindByProp('numax', 'backup'); } catch (e) { clr(box); box.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(box); if (!files.length) { box.appendChild(el('p', 'empty sm', 'No backups yet.')); return; }
    files.forEach(f => { const row = el('div', 'erow'); const b = el('div', 'eb'); b.appendChild(el('div', 'en', f.name)); b.appendChild(el('div', 'es', f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '')); row.appendChild(b); const op = el('button', 'btn btn-solid btn-xs', 'Open'); op.onclick = () => loadRestore(f); row.appendChild(op); box.appendChild(row); });
  }
  async function loadRestore(file) {
    const cfg = $('dr-restore-config'); cfg.style.display = ''; clr(cfg); cfg.appendChild(el('p', 'muted sm', 'Reading ' + file.name + '…'));
    try { restoreDoc = await driveDownload(file.id); restoreDoc._file = file; } catch (e) { clr(cfg); cfg.appendChild(el('p', 'empty err-text', e.message)); return; }
    if (!Array.isArray(restoreDoc.profiles) || !restoreDoc.profiles.length) { clr(cfg); cfg.appendChild(el('p', 'empty sm', 'No profiles in that backup.')); return; }
    clr(cfg); cfg.appendChild(el('div', 'set-group-h', 'Restore from ' + file.name));
    const sw = el('label', 'fld'); sw.style.cssText = 'max-width:440px;margin-top:10px'; sw.appendChild(el('span', '', 'Which saved profile')); const src = el('select', 'sel'); restoreDoc.profiles.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = p.name + ' · ' + (p.account || 'backup'); src.appendChild(o); }); sw.appendChild(src); cfg.appendChild(sw);
    const tw = el('label', 'fld'); tw.style.cssText = 'max-width:440px;margin-top:10px'; tw.appendChild(el('span', '', 'Restore into')); const tsel = el('select', 'sel'); tw.appendChild(tsel); cfg.appendChild(tw);
    for (const rec of store.list()) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; } profiles.forEach(p => { const o = document.createElement('option'); o.value = rec.accountId + ':' + p.index; o.textContent = p.name + ' · ' + accountName(rec.accountId); tsel.appendChild(o); }); }
    const mw = el('label', 'fld'); mw.style.cssText = 'max-width:440px;margin-top:10px'; mw.appendChild(el('span', '', 'How to apply')); const msel = el('select', 'sel'); msel.innerHTML = '<option value="merge">Merge</option><option value="overwrite">Overwrite</option>'; mw.appendChild(msel); cfg.appendChild(mw);
    const bar = el('div', 'actbar'); const btn = el('button', 'btn btn-primary', 'Preview restore'); const st = el('div', 'inline-status'); bar.appendChild(btn); bar.appendChild(st); cfg.appendChild(bar); const res = el('div'); res.style.marginTop = '12px'; cfg.appendChild(res);
    btn.onclick = async () => {
      const saved = restoreDoc.profiles[parseInt(src.value, 10)]; const tid = tsel.value; if (!tid) { status(st, 'Pick a target.', 'err'); return; } const [aid, iStr] = tid.split(':'); const idx = parseInt(iStr, 10); const mode = msel.value === 'overwrite' ? 'mirror' : 'merge';
      status(st, 'Reading target…');
      try { const master = { addons: saved.addons || [], plugins: saved.plugins || [], collections: saved.collections || [], settings: saved.settings || {} }; const c = A.client(store, aid); const { backup } = await loadAccount(aid); const state = sliceProfile(backup, idx); const upd = {};
        if (saved.settings && Object.keys(saved.settings).length) { state.settings = {}; for (const pl of ['tv', 'mobile']) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { state.settings[pl] = row.settings_json; upd[pl] = row.updated_at; } } }
        const cats = { addons: !!saved.addons, plugins: !!saved.plugins, collections: !!saved.collections, settings: !!(saved.settings && Object.keys(saved.settings).length) };
        const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: upd });
        renderApplyPlan(res, st, plan, aid, 'Restored'); } catch (e) { status(st, e.message, 'err'); }
    };
  }

  // ======================================================================
  // wiring + boot
  // ======================================================================
  function togWire(id, fn) { const b = $(id); b.setAttribute('role', 'switch'); b.onclick = () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); fn(on); }; }
  function wire() {
    $('btn-google').onclick = () => signIn(enterApp);
    document.querySelectorAll('.navbtn').forEach(b => b.onclick = () => nav(b.dataset.nav));
    $('ac-link-btn').onclick = linkAccount; $('ac-pass').addEventListener('keydown', e => { if (e.key === 'Enter') linkAccount(); });
    $('ac-reload').onclick = reloadAccounts;
    togWire('ac-readkeys', setReadKeys);
    $('pf-account').onchange = () => renderPfPicker($('pf-account').value); $('pf-save-identity').onclick = savePfIdentity;
    document.querySelectorAll('.pf-editor-tab').forEach(b => b.onclick = () => switchPfEditorTab(b.dataset.pftab));
    $('pf-editor-pane-tpl').onclick = () => saveTemplate($('pf-editor-pane-tpl').dataset.tpl);
    $('pf-tpl-profile').onclick = () => saveTemplate('profile');
    $('sy-account').onchange = () => renderSySource($('sy-account').value);
    $('sy-select-all').onclick = sySelectAll;
    $('sy-deselect-all').onclick = syDeselectAll;
    document.querySelectorAll('.sy-tgl').forEach(b => b.onclick = (e) => { e.preventDefault(); $(b.dataset.target).classList.toggle('open'); });
    // live preview on carry-over category toggles
    ['sy-cat-addons', 'sy-cat-plugins', 'sy-cat-collections', 'sy-cat-settings', 'sy-cat-watchprogress', 'sy-cat-watched'].forEach(id => {
      const cb = $(id); if (cb) cb.addEventListener('change', () => { updateSyCounts(); scheduleLivePreview(); });
    });
    // live preview on mode change
    $('sy-mode').addEventListener('change', () => {
      const desc = $('sy-mode-desc');
      if (desc) desc.textContent = $('sy-mode').value === 'overwrite'
        ? 'Overwrite mode makes the target match the source exactly. Anything the target has that the source doesn\'t will be removed.'
        : 'Merge mode adds new items and updates existing ones, but keeps everything else as-is.';
      scheduleLivePreview();
    });
    $('sy-preview').onclick = syncPreview; $('sy-apply').onclick = syncApply; $('sy-confirm').onchange = () => { $('sy-apply').disabled = !$('sy-confirm').checked; };
    $('tpl-refresh').onclick = refreshTemplates;
    $('dr-backup-btn').onclick = backupNow; $('dr-restore-refresh').onclick = refreshRestore; togWire('dr-keys', () => {});
    togWire('st-readkeys', setReadKeys);
    $('st-signout').onclick = async () => { if (!(await uiConfirm('Sign out of Google on this device? Your accounts and templates stay in your Drive.', { danger: true, okLabel: 'Sign out' }))) return; gAuth.token = null; gAuth.user = null; store.clear(); invalAll(); $('sb-name').textContent = 'Signed out'; showView('view-landing'); logAct('Signed out', 'info'); };
    $('act-clear').onclick = () => { activity.length = 0; renderActivity(); };
  }
  window.addEventListener('DOMContentLoaded', () => { wire(); renderActivity(); });
})();
