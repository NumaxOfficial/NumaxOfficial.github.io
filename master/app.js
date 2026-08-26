// ============================================================
// Numax app controller  (app.js)
//
// Vault (store) + client (api) + engine + Cinemeta (meta), wired to the
// two-pane UI. Adds: per-item selection of what the master copies
// (addons / plugins / collections / individual settings leaves), avatar
// profile pickers, and a live preview with Overview / Watched / Watch-
// progress tabs. Nothing writes until Preview -> (confirm) -> Apply.
// ============================================================
(function () {
  const E = window.NumaxEngine, A = window.NumaxApi, S = window.NumaxStore, M = window.NumaxMeta;
  const store = S.makeStore(window.localStorage);
  const $ = (id) => document.getElementById(id);

  const cache = {};        // accountId -> { backup, profiles:[{index,name,avatarUrl,color,avatarId}] }
  const masterCache = {};  // "acct:idx" -> master snapshot
  let currentMaster = null;
  let selection = { addons: new Set(), plugins: new Set(), collections: new Set(), settings: new Set() };
  const targetsSel = new Set(); // tids that are ticked in Clone-into
  let lastPlans = null;
  let previewMode = 'current';       // current | after
  let previewTab = 'overview';       // overview | watched | progress
  let previewTid = null;

  // secret / account / personal classification (mirrors engine.js)
  const SECRET_LEAF = E.SECRET_LEAF || /(api_?key|client_id|token|secret|access_token|refresh|password)/i;
  const ACCOUNT_GROUP_RE = /^trakt_/i;
  const PERSONAL_GROUP_RE = /^track_preference$/i;

  const CAT_COLOR = { addons: 'var(--blue)', plugins: 'var(--purple)', collections: 'var(--teal)', settings: 'var(--amber)' };

  // ---------- small utils ----------
  const setStatus = (el, m, c) => { el.textContent = m || ''; el.className = 'status' + (c ? ' ' + c : ''); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const elx = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const accountLabel = (id) => { const r = store.get(id); return (r && (r.label || r.email)) || (id.slice(0, 8) + '\u2026'); };
  const accountEmail = (id) => { const r = store.get(id); return (r && r.email) || ''; };
  const profileMeta = (id, idx) => { const c = cache[id]; return (c && c.profiles.find((x) => x.index === idx)) || { index: idx, name: 'Profile ' + idx }; };
  const profileName = (id, idx) => profileMeta(id, idx).name || ('Profile ' + idx);
  const labelForTid = (tid) => { const [id, i] = tid.split(':'); return profileName(id, parseInt(i, 10)) + ' \u2014 ' + accountLabel(id); };

  const collKey = (c) => (c && typeof c === 'object')
    ? (c.id != null ? 'id:' + c.id : (c.title != null ? 'title:' + c.title : 'json:' + JSON.stringify(c)))
    : 'json:' + JSON.stringify(c);

  const humanize = (key) => (key || '')
    .replace(/_v\d+$/i, '').replace(/_settings$/i, '').replace(/_payload$/i, '')
    .replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase()).trim() || key;
  const leafValue = (l) => (l && typeof l === 'object' && 'value' in l && 'type' in l) ? l.value : l;
  const formatVal = (val) => {
    const v = leafValue(val);
    if (v === null || v === undefined) return '\u2014';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v ? (v.length > 40 ? v.slice(0, 37) + '\u2026' : v) : '(empty)';
    if (Array.isArray(v)) return '[' + v.length + ' item' + (v.length === 1 ? '' : 's') + ']';
    return JSON.stringify(v).slice(0, 40);
  };

  // ---------- avatars & chips ----------
  function makeAvatar(p, size) {
    const span = elx('span', 'av');
    span.style.width = size + 'px'; span.style.height = size + 'px';
    span.style.fontSize = Math.round(size * 0.36) + 'px';
    span.style.background = (p && p.color) || '#5b3fa0';
    span.textContent = ((p && p.name) ? p.name.trim().charAt(0) : '?').toUpperCase() || '?';
    if (p && p.avatarUrl) {
      const img = document.createElement('img');
      img.src = p.avatarUrl; img.alt = '';
      img.onerror = () => { img.style.display = 'none'; };
      span.appendChild(img);
    }
    return span;
  }
  function makeChip(p, opts) {
    const btn = elx('button', 'pchip' + (opts.multi ? ' multi' : '') + (opts.selected ? ' on' : ''));
    btn.type = 'button';
    const ring = elx('span', 'ring');
    ring.appendChild(makeAvatar(p, 54));
    const check = elx('span', 'check', '\u2713'); ring.appendChild(check);
    btn.appendChild(ring);
    btn.appendChild(elx('span', 'lbl', p.name || ('Profile ' + p.index)));
    btn.onclick = opts.onClick;
    return btn;
  }

  // ---------- linking ----------
  async function linkWithPassword() {
    const label = $('link-name').value.trim();
    const email = $('link-email').value.trim(), password = $('link-password').value;
    if (!email || !password) return setStatus($('link-status'), 'Enter email and password.', 'err');
    setStatus($('link-status'), 'Signing in\u2026');
    try {
      const session = await A.signIn(email, password);
      store.add(session, { email, label });
      $('link-name').value = ''; $('link-email').value = ''; $('link-password').value = '';
      setStatus($('link-status'), 'Linked ' + (label || email) + '.', 'ok');
      await refreshAccounts();
    } catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }
  async function linkWithPaste() {
    const label = $('link-name').value.trim();
    let raw; try { raw = JSON.parse($('paste-json').value); } catch { return setStatus($('link-status'), 'That is not valid JSON.', 'err'); }
    try {
      store.add(raw, { label });
      $('paste-json').value = ''; $('link-name').value = '';
      setStatus($('link-status'), 'Linked' + (label ? ' ' + label : '') + ' from token.', 'ok');
      await refreshAccounts();
    } catch (e) { setStatus($('link-status'), e.message, 'err'); }
  }

  // ---------- data ----------
  async function loadAccount(accountId) {
    if (cache[accountId]) return cache[accountId];
    const c = A.client(store, accountId);
    const backup = await c.exportBackup();
    const profiles = (backup.profiles || [])
      .map((p) => ({
        index: p.profile_index,
        name: p.name || ('Profile ' + p.profile_index),
        avatarUrl: p.avatar_url || null,
        color: p.avatar_color_hex || null,
        avatarId: p.avatar_id || null,
      }))
      .sort((a, b) => a.index - b.index);
    cache[accountId] = { backup, profiles };
    return cache[accountId];
  }

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

  function sliceWatch(accountId, idx) {
    const b = (cache[accountId] || {}).backup || {};
    const p = (arr) => (Array.isArray(arr) ? arr.filter((r) => r.profile_id === idx) : []);
    return { watched: p(b.watched_items), progress: p(b.watch_progress) };
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

  // ---------- accounts panel ----------
  async function refreshAccounts() {
    const list = store.list();
    $('acct-count').textContent = list.length;
    const box = $('accounts'); clear(box);
    if (!list.length) { box.appendChild(elx('p', 'empty', 'No accounts linked yet.')); }
    else list.forEach((rec) => {
      const div = elx('div', 'acct');
      const body = elx('div', 'abody');
      const name = elx('div', 'aname', rec.label || rec.email || rec.accountId.slice(0, 10));
      body.appendChild(name);
      if (rec.email && rec.label) body.appendChild(elx('div', 'amail', rec.email));
      div.appendChild(body);
      const ren = elx('button', 'linkbtn', 'Rename'); ren.style.marginRight = '10px';
      ren.onclick = () => startRename(div, body, name, rec.accountId);
      div.appendChild(ren);
      const rm = elx('button', 'ghost sm', 'Unlink');
      rm.onclick = () => { store.remove(rec.accountId); delete cache[rec.accountId]; refreshAccounts(); };
      div.appendChild(rm);
      box.appendChild(div);
    });
    await rebuildMasterAccountOptions();
  }

  function startRename(row, body, nameEl, accountId) {
    const input = elx('input'); input.type = 'text'; input.value = nameEl.textContent;
    input.style.margin = '0'; input.maxLength = 40;
    body.replaceChild(input, nameEl); input.focus(); input.select();
    const commit = () => { const v = input.value.trim(); store.setLabel(accountId, v || null); refreshAccounts(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refreshAccounts(); });
    input.addEventListener('blur', commit);
  }

  async function rebuildMasterAccountOptions() {
    const list = store.list(); const ma = $('master-account'); const prev = ma.value;
    ma.innerHTML = list.map((r) => '<option value="' + esc(r.accountId) + '">' + esc(r.label || r.email || r.accountId.slice(0, 10)) + '</option>').join('');
    if (prev && list.some((r) => r.accountId === prev)) ma.value = prev;
    await onMasterAccountChanged(true);
  }

  async function onMasterAccountChanged(reset) {
    const accountId = $('master-account').value;
    const box = $('master-profiles'); clear(box);
    if (!accountId) { box.appendChild(elx('p', 'empty', 'Link an account to choose a master.')); currentMaster = null; await rebuildTargets(); await populatePreview(); return; }
    let profiles = [];
    try { profiles = (await loadAccount(accountId)).profiles; } catch (e) { setStatus($('global-status'), 'Could not load profiles: ' + e.message, 'err'); }
    if (!profiles.length) { box.appendChild(elx('p', 'empty', 'This account has no profiles.')); currentMaster = null; return; }
    let chosenIdx = (!reset && currentMaster && currentMaster.accountId === accountId) ? currentMaster.profileIndex : profiles[0].index;
    profiles.forEach((p) => {
      const chip = makeChip(p, { multi: false, selected: p.index === chosenIdx, onClick: () => selectMaster(accountId, p.index) });
      box.appendChild(chip);
    });
    await selectMaster(accountId, chosenIdx);
  }

  async function selectMaster(accountId, profileIndex) {
    document.querySelectorAll('#master-profiles .pchip').forEach((c, i) => {
      const list = (cache[accountId] || {}).profiles || [];
      c.classList.toggle('on', list[i] && list[i].index === profileIndex);
    });
    await renderMaster(accountId, profileIndex);
    resetSelections();
    renderAllItemLists();
    renderCounts();
    await rebuildTargets();
    await populatePreview();
  }

  async function renderMaster(accountId, profileIndex) {
    if (isNaN(profileIndex)) { currentMaster = null; return; }
    setStatus($('global-status'), 'Reading master\u2026');
    try {
      const snap = await buildMaster(accountId, profileIndex);
      currentMaster = { accountId, profileIndex, snapshot: snap };
      setStatus($('global-status'), '', '');
    } catch (e) { currentMaster = null; setStatus($('global-status'), 'Could not read master: ' + e.message, 'err'); }
  }

  // ---------- selection defaults ----------
  function defaultSettingsTokens(settings) {
    const tokens = new Set();
    for (const platform of Object.keys(settings || {})) {
      const feat = (settings[platform] && settings[platform].features) || {};
      for (const group of Object.keys(feat)) {
        const gv = feat[group];
        if (ACCOUNT_GROUP_RE.test(group)) continue;            // account-linked: never
        if (typeof gv === 'string') { tokens.add(platform + '::' + group); continue; } // visual payload: on
        if (!gv || typeof gv !== 'object') continue;
        if (PERSONAL_GROUP_RE.test(group)) continue;           // personal: off by default
        for (const leaf of Object.keys(gv)) {
          if (SECRET_LEAF.test(leaf)) continue;                // secret: never
          tokens.add(platform + '::' + group + '.' + leaf);
        }
      }
    }
    return tokens;
  }

  function resetSelections() {
    const s = currentMaster ? currentMaster.snapshot : { addons: [], plugins: [], collections: [], settings: {} };
    selection.addons = new Set((s.addons || []).map((a) => a.url));
    selection.plugins = new Set((s.plugins || []).map((p) => p.url));
    selection.collections = new Set((s.collections || []).map(collKey));
    selection.settings = defaultSettingsTokens(s.settings || {});
  }

  // ---------- item lists (addons / plugins / collections) ----------
  function masterList(kind) {
    const s = currentMaster ? currentMaster.snapshot : null;
    if (!s) return [];
    return kind === 'collections' ? (s.collections || []) : (s[kind] || []);
  }
  function itemKey(kind, x) { return kind === 'collections' ? collKey(x) : x.url; }

  function renderItemList(kind) {
    const box = $('items-' + kind); clear(box);
    const list = masterList(kind);
    if (!list.length) { box.appendChild(elx('p', 'empty', 'The master profile has no ' + kind + '.')); return; }
    const all = elx('div', 'allrow');
    const a = elx('button', 'linkbtn', 'Select all'); const n = elx('button', 'linkbtn', 'Select none');
    a.onclick = () => { list.forEach((x) => selection[kind].add(itemKey(kind, x))); renderItemList(kind); renderCounts(); refreshPreviewIfAfter(); };
    n.onclick = () => { selection[kind].clear(); renderItemList(kind); renderCounts(); refreshPreviewIfAfter(); };
    all.appendChild(a); all.appendChild(n); box.appendChild(all);
    list.forEach((x) => {
      const key = itemKey(kind, x);
      const row = elx('label', 'item');
      const cb = elx('input'); cb.type = 'checkbox'; cb.checked = selection[kind].has(key);
      cb.onchange = () => { cb.checked ? selection[kind].add(key) : selection[kind].delete(key); renderCounts(); refreshPreviewIfAfter(); };
      row.appendChild(cb);
      const body = elx('div', 'it-body');
      if (kind === 'collections') {
        body.appendChild(elx('div', 'it-name', x.title || x.name || '(untitled collection)'));
        const folders = (x.folders || []).length;
        body.appendChild(elx('div', 'it-sub', folders ? folders + ' folder' + (folders === 1 ? '' : 's') : 'no folders'));
      } else {
        body.appendChild(elx('div', 'it-name', x.name || host(x.url)));
        body.appendChild(elx('div', 'it-sub', host(x.url)));
      }
      row.appendChild(body);
      if (kind !== 'collections' && x.enabled === false) row.appendChild(elx('span', 'it-tag', 'off'));
      box.appendChild(row);
    });
  }
  function renderAllItemLists() { ['addons', 'plugins', 'collections'].forEach(renderItemList); }

  function renderCounts() {
    const s = currentMaster ? currentMaster.snapshot : { addons: [], plugins: [], collections: [], settings: {} };
    const set = (id, sel, tot) => { $(id).textContent = tot ? (sel + ' / ' + tot) : '0'; };
    set('cnt-addons', selection.addons.size, (s.addons || []).length);
    set('cnt-plugins', selection.plugins.size, (s.plugins || []).length);
    set('cnt-collections', selection.collections.size, (s.collections || []).length);
    $('cnt-settings').textContent = selection.settings.size + ' selected';
    // mirror-with-subset warning notes
    ['addons', 'plugins', 'collections'].forEach((k) => {
      const total = (k === 'collections' ? (s.collections || []) : (s[k] || [])).length;
      const partial = $('mode-' + k).value === 'mirror' && selection[k].size < total;
      $('note-' + k).classList.toggle('show', $('cat-' + k).checked && partial);
    });
  }

  // ---------- settings selector modal ----------
  let modalPlatform = null;
  function openSettingsModal() {
    if (!currentMaster) { setStatus($('global-status'), 'Pick a master profile first.', 'err'); return; }
    const settings = currentMaster.snapshot.settings || {};
    const platforms = Object.keys(settings).filter((p) => settings[p] && settings[p].features);
    if (!platforms.length) { setStatus($('global-status'), 'The master has no settings to choose from.', 'err'); return; }
    $('settings-sub').textContent = 'From ' + profileName(currentMaster.accountId, currentMaster.profileIndex);
    modalPlatform = platforms.includes(modalPlatform) ? modalPlatform : platforms[0];
    const tabs = $('settings-platforms'); clear(tabs);
    platforms.forEach((pl) => {
      const b = elx('button', pl === modalPlatform ? 'on' : '', pl === 'tv' ? 'TV' : (pl === 'mobile' ? 'Mobile' : humanize(pl)));
      b.type = 'button'; b.onclick = () => { modalPlatform = pl; renderSettingsTree(); tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
      tabs.appendChild(b);
    });
    renderSettingsTree();
    $('settings-modal').classList.add('open');
  }
  function closeSettingsModal() { $('settings-modal').classList.remove('open'); renderCounts(); refreshPreviewIfAfter(); }

  function groupType(group, gv) {
    if (ACCOUNT_GROUP_RE.test(group)) return 'account';
    if (typeof gv === 'string') return 'payload';
    if (PERSONAL_GROUP_RE.test(group)) return 'personal';
    return 'leaves';
  }

  function renderSettingsTree() {
    const tree = $('settings-tree'); clear(tree);
    const feat = ((currentMaster.snapshot.settings[modalPlatform]) || {}).features || {};
    const pl = modalPlatform;
    Object.keys(feat).forEach((group) => {
      const gv = feat[group];
      const type = groupType(group, gv);
      const box = elx('div', 'sgroup');
      const head = elx('div', 'sgroup-h');
      const chev = elx('span', 'chev', '\u203a');

      if (type === 'leaves' || type === 'payload' || type === 'personal') {
        // selectable groups get a header checkbox
        const gcb = elx('input'); gcb.type = 'checkbox';
        gcb.onclick = (e) => e.stopPropagation();
        if (type === 'payload') {
          const tok = pl + '::' + group; gcb.checked = selection.settings.has(tok);
          gcb.onchange = () => { gcb.checked ? selection.settings.add(tok) : selection.settings.delete(tok); updateSettingsCount(); };
        } else if (type === 'personal') {
          const tok = pl + '::' + group; gcb.checked = selection.settings.has(tok);
          gcb.onchange = () => { gcb.checked ? selection.settings.add(tok) : selection.settings.delete(tok); updateSettingsCount(); };
        } else {
          const leafKeys = Object.keys(gv).filter((l) => !SECRET_LEAF.test(l));
          const selCount = leafKeys.filter((l) => selection.settings.has(pl + '::' + group + '.' + l)).length;
          gcb.checked = selCount > 0 && selCount === leafKeys.length;
          gcb.indeterminate = selCount > 0 && selCount < leafKeys.length;
          gcb.onchange = () => {
            leafKeys.forEach((l) => { const t = pl + '::' + group + '.' + l; gcb.checked ? selection.settings.add(t) : selection.settings.delete(t); });
            renderSettingsTree(); updateSettingsCount();
          };
        }
        head.appendChild(gcb);
      } else {
        head.appendChild(elx('span', '', '')); // spacer for locked account group
      }

      head.appendChild(chev);
      head.appendChild(elx('span', 'gname', humanize(group)));
      const counter = elx('span', 'gcount');
      head.appendChild(counter);
      head.onclick = () => box.classList.toggle('open');
      box.appendChild(head);

      const body = elx('div', 'sgroup-body');
      if (type === 'account') {
        counter.textContent = 'account-linked';
        const leaves = (typeof gv === 'string') ? [{ leaf: group, val: gv }] : Object.keys(gv).map((l) => ({ leaf: l, val: gv[l] }));
        leaves.forEach(({ leaf, val }) => {
          const row = elx('div', 'sleaf locked');
          const spacer = elx('span'); spacer.style.width = '15px'; row.appendChild(spacer);
          row.appendChild(elx('span', 'lname', typeof gv === 'string' ? 'Whole payload' : humanize(leaf)));
          row.appendChild(elx('span', 'ltag account', 'account'));
          body.appendChild(row);
        });
      } else if (type === 'payload') {
        counter.textContent = 'whole payload';
        const row = elx('div', 'sleaf');
        const spacer = elx('span'); spacer.style.width = '15px'; row.appendChild(spacer);
        let keys = 0; try { keys = Object.keys(JSON.parse(gv || '{}')).length; } catch { keys = 0; }
        row.appendChild(elx('span', 'lname', 'Copied as a whole' + (keys ? ' \u00b7 ' + keys + ' option' + (keys === 1 ? '' : 's') : '')));
        body.appendChild(row);
      } else if (type === 'personal') {
        const n = Object.keys(gv).length;
        counter.textContent = 'personal';
        const row = elx('div', 'sleaf');
        const spacer = elx('span'); spacer.style.width = '15px'; row.appendChild(spacer);
        row.appendChild(elx('span', 'lname', 'Per-title playback prefs \u00b7 ' + n + ' entr' + (n === 1 ? 'y' : 'ies')));
        row.appendChild(elx('span', 'ltag personal', 'personal'));
        body.appendChild(row);
      } else { // leaves
        const total = Object.keys(gv).length;
        const selectable = Object.keys(gv).filter((l) => !SECRET_LEAF.test(l));
        const sel = selectable.filter((l) => selection.settings.has(pl + '::' + group + '.' + l)).length;
        counter.textContent = sel + '/' + selectable.length;
        Object.keys(gv).forEach((leaf) => {
          const isSecret = SECRET_LEAF.test(leaf);
          const row = elx('div', 'sleaf' + (isSecret ? ' locked' : ''));
          if (isSecret) { const sp = elx('span'); sp.style.width = '15px'; row.appendChild(sp); }
          else {
            const cb = elx('input'); cb.type = 'checkbox';
            const tok = pl + '::' + group + '.' + leaf;
            cb.checked = selection.settings.has(tok);
            cb.onchange = () => { cb.checked ? selection.settings.add(tok) : selection.settings.delete(tok); renderSettingsTree(); updateSettingsCount(); };
            row.appendChild(cb);
          }
          row.appendChild(elx('span', 'lname', humanize(leaf)));
          if (isSecret) row.appendChild(elx('span', 'ltag secret', 'key'));
          else row.appendChild(elx('span', 'lval', formatVal(gv[leaf])));
          body.appendChild(row);
        });
        if (total) box.classList.add('open');
      }
      box.appendChild(body);
      tree.appendChild(box);
    });
    updateSettingsCount();
  }

  function updateSettingsCount() {
    $('settings-count').textContent = selection.settings.size + ' selected';
    $('cnt-settings').textContent = selection.settings.size + ' selected';
  }

  function settingsSelectAllShareable() {
    // add every shareable token on the CURRENT platform (leaves + visual payloads; not secrets/account/personal)
    const feat = ((currentMaster.snapshot.settings[modalPlatform]) || {}).features || {};
    Object.keys(feat).forEach((group) => {
      const gv = feat[group];
      if (ACCOUNT_GROUP_RE.test(group)) return;
      if (typeof gv === 'string') { selection.settings.add(modalPlatform + '::' + group); return; }
      if (PERSONAL_GROUP_RE.test(group)) return;
      if (gv && typeof gv === 'object') Object.keys(gv).forEach((l) => { if (!SECRET_LEAF.test(l)) selection.settings.add(modalPlatform + '::' + group + '.' + l); });
    });
    renderSettingsTree();
  }
  function settingsClear() {
    // clear only the CURRENT platform's tokens
    [...selection.settings].forEach((t) => { if (t.startsWith(modalPlatform + '::')) selection.settings.delete(t); });
    renderSettingsTree();
  }

  // ---------- targets (clone into) ----------
  async function rebuildTargets() {
    const box = $('targets'); clear(box);
    const list = store.list();
    if (!list.length) { box.appendChild(elx('p', 'empty', 'Link an account and pick a master first.')); return; }
    const mAcct = currentMaster && currentMaster.accountId;
    const mIdx = currentMaster && currentMaster.profileIndex;
    targetsSel.clear();
    let any = false;
    for (const rec of list) {
      let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const targetable = profiles.filter((p) => !(rec.accountId === mAcct && p.index === mIdx));
      if (!targetable.length) continue;
      box.appendChild(elx('div', 'chipacc', rec.label || rec.email || rec.accountId.slice(0, 10)));
      targetable.forEach((p) => {
        const tid = rec.accountId + ':' + p.index;
        targetsSel.add(tid); any = true;
        const chip = makeChip(p, {
          multi: true, selected: true,
          onClick: () => { const on = targetsSel.has(tid); on ? targetsSel.delete(tid) : targetsSel.add(tid); chip.classList.toggle('on', !on); },
        });
        box.appendChild(chip);
      });
    }
    if (!any) box.appendChild(elx('p', 'empty', 'No other profiles to apply to yet.'));
  }

  // ---------- options + filtered master ----------
  function readOptions() {
    return {
      categories: { addons: $('cat-addons').checked, plugins: $('cat-plugins').checked, collections: $('cat-collections').checked, settings: $('cat-settings').checked },
      modes: { addons: $('mode-addons').value, plugins: $('mode-plugins').value, collections: $('mode-collections').value },
      settings: { includePersonal: true }, // selection is the gate now
      originClientId: 'numax-web',
    };
  }

  function filteredMaster() {
    const s = currentMaster.snapshot;
    const out = { addons: [], plugins: [], collections: [], settings: {} };
    out.addons = (s.addons || []).filter((a) => selection.addons.has(a.url));
    out.plugins = (s.plugins || []).filter((p) => selection.plugins.has(p.url));
    out.collections = (s.collections || []).filter((c) => selection.collections.has(collKey(c)));
    for (const platform of Object.keys(s.settings || {})) {
      const blob = s.settings[platform]; const feat = (blob && blob.features) || {};
      const outFeat = {};
      for (const group of Object.keys(feat)) {
        const gv = feat[group];
        const groupTok = platform + '::' + group;
        if (selection.settings.has(groupTok)) { outFeat[group] = gv; continue; } // payload / personal whole group
        if (gv && typeof gv === 'object' && typeof gv !== 'string') {
          const picked = {};
          for (const leaf of Object.keys(gv)) if (selection.settings.has(platform + '::' + group + '.' + leaf)) picked[leaf] = gv[leaf];
          if (Object.keys(picked).length) outFeat[group] = picked;
        }
      }
      if (Object.keys(outFeat).length) out.settings[platform] = { version: blob.version, features: outFeat };
    }
    return out;
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
    previewTid = sel.value || null;
    renderPreviewArea();
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
  function renderCards(st, plan) {
    const aA = afterListFrom(plan, 'addons', st.addons);
    const aP = afterListFrom(plan, 'plugins', st.plugins);
    const aC = afterListFrom(plan, 'collections', st.collections);
    const addonRows = diffRows(st.addons, aA, (x) => x.url, (x) => x.name || host(x.url), (x) => host(x.url));
    const pluginRows = diffRows(st.plugins, aP, (x) => x.url, (x) => x.name || host(x.url), (x) => host(x.url));
    const collRows = diffRows(st.collections, aC, collKey, (x) => x.title || x.name || x.id);
    let settingsCard;
    if (plan && plan.plan.report.settings) {
      const s = plan.plan.report.settings; const parts = [];
      for (const plat of Object.keys(s)) parts.push('<div class="pv-item"><span class="mk">+</span><span class="txt">' + plat + ': <span class="tag-u">' + s[plat].changed.length + ' changed</span>' + (s[plat].skippedSecrets.length ? ' &middot; <span class="tag-h">' + s[plat].skippedSecrets.length + ' held back</span>' : '') + '</span></div>');
      settingsCard = pvCard('Settings', CAT_COLOR.settings, '', parts.join(''), 'No settings changes.');
    } else {
      const rows = st.settingGroups.map((g) => '<div class="pv-item"><span class="mk"></span><span class="dot"></span><span class="txt">' + esc(humanize(g)) + '</span></div>').join('');
      settingsCard = pvCard('Settings groups', CAT_COLOR.settings, st.settingGroups.length, rows, 'No settings configured.');
    }
    return '<div class="pv-cols">' +
      pvCard('Addons', CAT_COLOR.addons, (st.addons || []).length, addonRows.map(rowHtml).join(''), 'No addons.') +
      pvCard('Plugins', CAT_COLOR.plugins, (st.plugins || []).length, pluginRows.map(rowHtml).join(''), 'No plugins.') +
      pvCard('Collections', CAT_COLOR.collections, (st.collections || []).length, collRows.map(rowHtml).join(''), 'No collections.') +
      settingsCard + '</div>';
  }

  function renderPreviewArea() {
    const tid = previewTid;
    // set the little avatar next to the selector
    const av = $('preview-av');
    if (tid) {
      const [id, i] = tid.split(':');
      const a = makeAvatar(profileMeta(id, parseInt(i, 10)), 26);
      av.replaceWith(a); a.id = 'preview-av'; a.classList.add('av');
    } else { av.style.display = 'none'; }

    $('overview-toggle').style.display = previewTab === 'overview' ? 'flex' : 'none';
    $('preview-body').style.display = previewTab === 'overview' ? 'block' : 'none';
    $('watched-body').style.display = previewTab === 'watched' ? 'block' : 'none';
    $('progress-body').style.display = previewTab === 'progress' ? 'block' : 'none';

    if (previewTab === 'overview') renderOverview(tid);
    else if (previewTab === 'watched') renderWatched(tid);
    else renderProgress(tid);
  }

  function renderOverview(tid) {
    const body = $('preview-body');
    if (!tid) { body.innerHTML = '<div class="pv-blank">Link an account to preview a profile.</div>'; return; }
    const [accountId, idxStr] = tid.split(':'); const idx = parseInt(idxStr, 10);
    const st = displayState(accountId, idx);
    const after = previewMode === 'after';
    const plan = after ? planForTid(tid) : null;
    if (after && !plan) {
      body.innerHTML = '<p class="pv-note">Showing <b>' + esc(labelForTid(tid)) + '</b>. No projected changes \u2014 run <b>Preview</b> with this profile ticked as a target.</p>' + renderCards(st, null);
      return;
    }
    const note = after
      ? '<p class="pv-note">Projected state of <b>' + esc(labelForTid(tid)) + '</b> after applying. <span class="tag-a">green = added</span>, <span class="tag-r">red = removed</span>.</p>'
      : '<p class="pv-note">Current state of <b>' + esc(labelForTid(tid)) + '</b>.</p>';
    body.innerHTML = note + renderCards(st, plan);
  }

  function renderWatched(tid) {
    const body = $('watched-body'); clear(body);
    if (!tid) { body.innerHTML = '<div class="pv-blank">Pick a profile.</div>'; return; }
    const [id, i] = tid.split(':'); const { watched } = sliceWatch(id, parseInt(i, 10));
    body.appendChild(elx('p', 'pv-note', watched.length ? watched.length + ' watched item' + (watched.length === 1 ? '' : 's') + ' for ' + profileName(id, parseInt(i, 10)) + '.' : 'Nothing in watched history for ' + profileName(id, parseInt(i, 10)) + '.'));
    if (!watched.length) return;
    const card = elx('div', 'wcard'); const queue = [];
    watched.slice(0, 60).forEach((w) => {
      const row = elx('div', 'wrow');
      const wbody = elx('div', 'wbody');
      const se = [w.season_number ? 'S' + w.season_number : '', w.episode_number ? 'E' + w.episode_number : ''].filter(Boolean).join('');
      const title = elx('div', 'wtitle', (w.title || w.content_id || '(unknown)') + (se ? ' \u00b7 ' + se : ''));
      wbody.appendChild(title);
      if (!w.title && w.content_id) wbody.appendChild(elx('div', 'wsub', w.content_id));
      row.appendChild(wbody);
      if (w.content_type) row.appendChild(elx('span', 'wtype', w.content_type));
      card.appendChild(row);
      if (!w.title && M.isImdbId(w.content_id)) queue.push({ id: w.content_id, type: (w.content_type || '').toLowerCase() === 'series' ? 'series' : undefined, title, se });
    });
    if (watched.length > 60) card.appendChild(elx('div', 'wrow', '\u2026 and ' + (watched.length - 60) + ' more'));
    body.appendChild(card);
    if (queue.length) M.resolveBatch(queue.map(({ id, type }) => ({ id, type })), (rid, res) => { if (!res) return; queue.forEach((q) => { if (q.id === rid) q.title.textContent = res.name + (q.se ? ' \u00b7 ' + q.se : ''); }); });
  }

  function renderProgress(tid) {
    const body = $('progress-body'); clear(body);
    if (!tid) { body.innerHTML = '<div class="pv-blank">Pick a profile.</div>'; return; }
    const [id, i] = tid.split(':'); const { progress } = sliceWatch(id, parseInt(i, 10));
    body.appendChild(elx('p', 'pv-note', progress.length ? progress.length + ' item' + (progress.length === 1 ? '' : 's') + ' in progress for ' + profileName(id, parseInt(i, 10)) + '.' : 'Nothing in progress for ' + profileName(id, parseInt(i, 10)) + '.'));
    if (!progress.length) return;
    const card = elx('div', 'wcard'); const queue = [];
    progress.slice(0, 60).forEach((w) => {
      const row = elx('div', 'wrow');
      const wbody = elx('div', 'wbody');
      const title = elx('div', 'wtitle', w.title || w.content_id || w.progress_key || '(unknown)');
      wbody.appendChild(title);
      const posMin = Math.round((w.position || 0) / 60000), durMin = Math.round((w.duration || 0) / 60000);
      const pct = (w.duration > 0) ? Math.min(100, Math.round((w.position / w.duration) * 100)) : 0;
      wbody.appendChild(elx('div', 'wsub', posMin + 'm / ' + durMin + 'm'));
      row.appendChild(wbody);
      const prog = elx('div', 'prog');
      const bar = elx('div', 'bar'); const fill = elx('span'); fill.style.width = pct + '%'; bar.appendChild(fill); prog.appendChild(bar);
      prog.appendChild(elx('div', 'pct', pct + '%'));
      row.appendChild(prog);
      card.appendChild(row);
      if (!w.title && M.isImdbId(w.content_id)) queue.push({ id: w.content_id, type: (w.content_type || '').toLowerCase() === 'series' ? 'series' : undefined, title });
    });
    if (progress.length > 60) card.appendChild(elx('div', 'wrow', '\u2026 and ' + (progress.length - 60) + ' more'));
    body.appendChild(card);
    if (queue.length) M.resolveBatch(queue.map(({ id, type }) => ({ id, type })), (rid, res) => { if (!res) return; queue.forEach((q) => { if (q.id === rid) q.title.textContent = res.name; }); });
  }

  function setPreviewMode(mode) {
    previewMode = mode;
    $('pv-current').classList.toggle('on', mode === 'current');
    $('pv-after').classList.toggle('on', mode === 'after');
    if (previewTab === 'overview') renderOverview(previewTid);
  }
  function setPreviewTab(tab) {
    previewTab = tab;
    document.querySelectorAll('#pv-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    renderPreviewArea();
  }
  function refreshPreviewIfAfter() { if (previewTab === 'overview' && previewMode === 'after') renderOverview(previewTid); }

  // ---------- preview (plan) / apply ----------
  async function preview() {
    setStatus($('global-status'), 'Reading profiles\u2026');
    $('results').innerHTML = ''; $('btn-apply').disabled = true;
    $('confirm-wrap').style.display = 'none'; $('confirm-removals').checked = false; lastPlans = null;
    if (!currentMaster) return setStatus($('global-status'), 'Pick a master profile.', 'err');
    const targets = [...targetsSel];
    if (!targets.length) return setStatus($('global-status'), 'Tick at least one target profile.', 'err');
    const opts = readOptions();
    const master = filteredMaster();
    try {
      const plans = []; let anyRemovals = false;
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
      const firstChanged = plans.find((p) => p.plan.hasChanges) || plans[0];
      if (firstChanged) { $('preview-profile').value = firstChanged.tid; previewTid = firstChanged.tid; setPreviewTab('overview'); setPreviewMode('after'); renderPreviewArea(); }
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
      if (!plan.hasChanges) html += '<div class="sumline"><span class="tag-k">Nothing to change for this profile.</span></div>';
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
    if (currentMaster) { await renderMaster(currentMaster.accountId, currentMaster.profileIndex); }
    await rebuildTargets(); await populatePreview();
  }

  // ---------- category toggles ----------
  function wireCategory(kind) {
    const cat = $('cat-' + kind);
    const choose = $('choose-' + kind);
    const box = $('items-' + kind);
    choose.disabled = !cat.checked;
    cat.addEventListener('change', () => { choose.disabled = !cat.checked; if (!cat.checked) box.classList.remove('open'); renderCounts(); refreshPreviewIfAfter(); });
    choose.addEventListener('click', () => { box.classList.toggle('open'); });
    $('mode-' + kind).addEventListener('change', () => { renderCounts(); refreshPreviewIfAfter(); });
  }

  // ---------- wire ----------
  window.addEventListener('DOMContentLoaded', () => {
    $('btn-link').onclick = linkWithPassword;
    $('btn-link-paste').onclick = linkWithPaste;
    $('link-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') linkWithPassword(); });
    $('master-account').addEventListener('change', () => onMasterAccountChanged(true));
    ['addons', 'plugins', 'collections'].forEach(wireCategory);
    $('cat-settings').addEventListener('change', () => { $('choose-settings').disabled = !$('cat-settings').checked; });

    $('choose-settings').onclick = openSettingsModal;
    $('settings-close').onclick = closeSettingsModal;
    $('btn-settings-done').onclick = closeSettingsModal;
    $('settings-selall').onclick = settingsSelectAllShareable;
    $('settings-none').onclick = settingsClear;
    $('settings-modal').addEventListener('click', (e) => { if (e.target === $('settings-modal')) closeSettingsModal(); });

    $('preview-profile').addEventListener('change', () => { previewTid = $('preview-profile').value || null; renderPreviewArea(); });
    document.querySelectorAll('#pv-tabs button').forEach((b) => { b.onclick = () => setPreviewTab(b.dataset.tab); });
    $('pv-current').onclick = () => setPreviewMode('current');
    $('pv-after').onclick = () => setPreviewMode('after');

    $('btn-preview').onclick = preview;
    $('btn-apply').onclick = apply;
    $('confirm-removals').onchange = updateApplyGate;

    refreshAccounts();
  });
})();
