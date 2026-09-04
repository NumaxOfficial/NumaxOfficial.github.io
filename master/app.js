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
  // presentation-only helpers (ui-motion.js). Every call is optional —
  // the app behaves identically if the motion layer failed to load.
  const M = window.NumaxMotion || {};
  const celebrate = n => { if (M.celebrate && n) M.celebrate(n); };

  // ---- secret handling ----
  const SECRET_LEAF = (E && E.SECRET_LEAF) || /(api_?key|client_id|token|secret|access_token|refresh|password)/i;
  const API_KEY_STRIP = /(mdblist|tmdb|torbox|premiumize|animeskip|debrid).*(api_?key|token|secret|client_?id)/i;
  function stripKeys(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(stripKeys);
    const o = {}; for (const [k, v] of Object.entries(node)) { if (API_KEY_STRIP.test(k)) continue; o[k] = (v && typeof v === 'object') ? stripKeys(v) : v; } return o;
  }
  const PERSONAL_GROUP = /^track_preference$/i;
  // watched_items / watch_progress rows come straight off the SOURCE profile and carry its own
  // row id, user_id (the source ACCOUNT's auth user), and profile_id — strip that identity before
  // pushing so the insert is scoped only by the top-level p_profile_id/auth session, the same
  // convention stripListForPush uses for addons/plugins (verified table columns: api.nuvio.tv's
  // PostgREST OpenAPI schema for watch_progress/watched_items).
  function stripWatchRow(row) {
    if (!row || typeof row !== 'object') return row;
    const { id, user_id, profile_id, created_at, updated_at, inserted_at, ...rest } = row;
    return rest;
  }

  // ======================================================================
  // state
  // ======================================================================
  const cache = {};                     // accountId -> {backup, profiles}
  const membershipCache = {};           // accountId -> {isSupporter, tier, status} | null (fetch failed)
  let readKeys = false;
  let acGen = 0; // bumped on every refreshAccounts() call so a stale call's late-resolving loadAccount() can't paint over a newer render
  let gAuth = { token: null, client: null, user: null };
  let pfA = null, pfI = null, pfEdit = null, pfMembership = null, pfPlat = 'tv', pfTab = 0, pfEditorTab = 'addons';
  const PF_TAB_LABEL = { addons: 'Add-ons', plugins: 'Plugins', collections: 'Collections', settings: 'Settings', watchprogress: 'Watch Progress', watched: 'Watched' };
  function switchPfEditorTab(kind) {
    pfEditorTab = kind;
    document.querySelectorAll('.pf-editor-tab').forEach(b => b.classList.toggle('on', b.dataset.pftab === kind));
    document.querySelectorAll('.pf-pane').forEach(p => p.style.display = (p.id === 'pf-pane-' + kind) ? '' : 'none');
    $('pf-editor-pane-title').textContent = PF_TAB_LABEL[kind] || kind;
  }
  const pfDirty = {};
  let syA = null, syI = null, sySnap = null;
  let sySrcLabel = '';               // display name of the chosen source, for the stepper summary
  let sySettingsIncludeKeys = false; // mirrors syCreds.copy — API keys are opt-in, as in Nuvio's dialog
  let syKeysAnsweredFor = null;      // "accountId:profileIndex" the answer above was given for (see selectSource)
  // API keys / provider credentials, modelled on Nuvio's own copy dialog: one opt-in,
  // plus "overwrite matching keys already in the target". Providers that exist only on
  // the destination are always kept, which is why the default is add-but-don't-replace.
  const syCreds = { copy: false, replace: false };
  const PLATS = ['tv', 'mobile', 'desktop'];
  const PLAT_LABEL = { tv: 'TV app', mobile: 'Mobile app', desktop: 'Desktop app' };
  const PLAT_SHORT = { tv: 'TV', mobile: 'mobile', desktop: 'desktop' };
  const sySel = { addons: new Set(), plugins: new Set(), collections: new Set(), settings: new Set() };
  const syTargets = new Set(); let syPlans = null;

  // ======================================================================
  // utils
  // ======================================================================
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = u => { try { return new URL(u).host; } catch { return String(u || ''); } };
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const clr = n => { while (n && n.firstChild) n.removeChild(n.firstChild); };
  // A trailing ellipsis is this app's existing convention for "async work is
  // running". Binding the shimmer to exactly that means it can never sit on a
  // static label, and it always stops when the message is replaced or cleared.
  const status = (n, m, c) => {
    if (!n) return;
    const t = m || '';
    n.textContent = t;
    n.className = 'inline-status' + (c ? ' ' + c : '') + (!c && /…$/.test(t) ? ' shimmer' : '');
  };
  // ---- async reads that can never hang a placeholder ----
  // Every network read here used to be an un-timed fetch sitting behind a
  // "Loading…"/"Reading…" placeholder that only cleared on the success path.
  // A stalled request therefore shimmered forever, and several early-return
  // paths never cleared theirs at all. These two helpers make both impossible:
  // a read resolves, times out, or throws, and the placeholder always reaches
  // a terminal state — content, empty, or a readable error.
  const READ_TIMEOUT = 25000;
  function withTimeout(p, ms, what) {
    let t;
    const limit = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error((what || 'That') + ' took too long — check your connection and try again.')), ms || READ_TIMEOUT);
    });
    return Promise.race([Promise.resolve(p), limit]).finally(() => clearTimeout(t));
  }
  // Runs an async load into `box` behind a shimmer, then hands the emptied box
  // back to the caller to fill. `stale()` lets a caller abandon a load whose
  // surface has since been replaced, without leaving the shimmer behind.
  async function loadInto(box, label, run, opts) {
    if (!box) return undefined;
    const o = opts || {};
    clr(box); box.appendChild(el('p', 'muted sm shimmer', label));
    let out;
    try {
      out = await withTimeout(run(), o.timeout, label.replace(/…\s*$/, ''));
    } catch (e) {
      if (!(o.stale && o.stale())) { clr(box); box.appendChild(el('p', 'empty sm err-text', (o.prefix || '') + e.message)); }
      return undefined;
    }
    if (o.stale && o.stale()) return undefined;
    clr(box);
    return { value: out };
  }

  // ---- iOS-style select ----------------------------------------------------
  // A native <select> styles its closed box but NOT its open list: that list is
  // drawn by the OS and lands as a flat grey rectangle on top of a dark themed
  // page. This wraps the real <select> — which stays in the DOM as the single
  // source of truth, so every existing `.value` read and 'change' listener
  // keeps working — and draws the closed control and the popup list itself.
  // A MutationObserver keeps the label in sync with options added later
  // (several selects are populated after an async profile read).
  const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let openSelect = null;
  function closeSelect() {
    if (!openSelect) return;
    const o = openSelect; openSelect = null;
    o.list.classList.remove('open');
    o.btn.setAttribute('aria-expanded', 'false');
    if (prefersReducedMotion()) o.list.remove(); else setTimeout(() => o.list.remove(), 160);
    document.removeEventListener('keydown', o.key, true);
    window.removeEventListener('resize', closeSelect);
    document.removeEventListener('scroll', closeSelect, true);
  }

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) return null;
    sel.dataset.enhanced = '1';
    const wrap = el('div', 'nsel');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('nsel-native');
    // The custom button is the control; keep the native element out of the tab
    // order and out of the accessibility tree so it is not announced twice.
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;

    const btn = el('button', 'nsel-btn'); btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const lab = el('span', 'nsel-lab');
    const car = el('span', 'nsel-car');
    car.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m7 10 5 5 5-5"/></svg>';
    btn.appendChild(lab); btn.appendChild(car);
    wrap.appendChild(btn);

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      lab.textContent = o ? (o.dataset.label || o.textContent) : '';
      btn.disabled = sel.disabled || !sel.options.length;
    };
    sync();
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
    sel.addEventListener('change', sync);

    btn.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      if (openSelect && openSelect.btn === btn) { closeSelect(); return; }
      closeSelect();
      const list = el('div', 'nsel-list'); list.setAttribute('role', 'listbox');
      [...sel.options].forEach((op, i) => {
        const row = el('div', 'nsel-opt' + (i === sel.selectedIndex ? ' on' : ''));
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
        const tx = el('div', 'nsel-tx');
        tx.appendChild(el('div', 'nsel-t', op.dataset.label || op.textContent));
        if (op.dataset.hint) tx.appendChild(el('div', 'nsel-h', op.dataset.hint));
        row.appendChild(tx);
        const ck = el('span', 'nsel-ck');
        ck.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
        row.appendChild(ck);
        row.onclick = () => {
          if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          sync(); closeSelect();
        };
        list.appendChild(row);
      });
      document.body.appendChild(list);
      // Measured, then clamped into the viewport in both axes — a list opened
      // from a control near the bottom flips above rather than running off.
      const r = btn.getBoundingClientRect();
      const lw = Math.max(r.width, 200);
      list.style.width = lw + 'px';
      const lh = list.offsetHeight;
      let top = r.bottom + 6;
      if (top + lh > window.innerHeight - 8) top = Math.max(8, (r.top - lh - 6 >= 8) ? r.top - lh - 6 : window.innerHeight - lh - 8);
      list.style.left = Math.round(Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - lw - 8))) + 'px';
      list.style.top = Math.round(top) + 'px';
      list.style.transformOrigin = (top < r.top ? 'bottom' : 'top') + ' center';
      requestAnimationFrame(() => list.classList.add('open'));
      btn.setAttribute('aria-expanded', 'true');

      const key = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); closeSelect(); btn.focus(); }
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const n = sel.options.length; if (!n) return;
          sel.selectedIndex = (sel.selectedIndex + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
          sel.dispatchEvent(new Event('change', { bubbles: true })); sync();
          [...list.children].forEach((c, i) => c.classList.toggle('on', i === sel.selectedIndex));
        } else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); closeSelect(); btn.focus(); }
      };
      document.addEventListener('keydown', key, true);
      window.addEventListener('resize', closeSelect);
      document.addEventListener('scroll', closeSelect, true);
      openSelect = { btn, list, key };
    };
    return { sync };
  }
  document.addEventListener('click', e => { if (openSelect && !openSelect.list.contains(e.target)) closeSelect(); });
  // Upgrade everything already on the page, and anything rendered later.
  function enhanceAllSelects(root) {
    (root || document).querySelectorAll('select.sel:not([data-enhanced])').forEach(enhanceSelect);
  }

  // Builds a select from plain data and enhances it. `hint` becomes the
  // secondary line in the popup — the long "Merge — add it, keep everything
  // else" labels read far better split into a title and a description.
  function mkSelect(items, cls) {
    const sel = el('select', 'sel' + (cls ? ' ' + cls : ''));
    items.forEach(it => {
      const o = document.createElement('option');
      o.value = it.value; o.textContent = it.label;
      o.dataset.label = it.label; if (it.hint) o.dataset.hint = it.hint;
      sel.appendChild(o);
    });
    const host = el('div', 'nsel-host');
    host.appendChild(sel);
    enhanceSelect(sel);
    return {
      node: host,
      select: sel,
      value: () => sel.value,
      onChange: fn => sel.addEventListener('change', fn),
    };
  }

  // ---- disclosure ----------------------------------------------------------
  // Collapsed by default, height-animated open. Used to demote long reference
  // lists (a repo's scrapers) below the controls that actually do something.
  function mkDisclosure(title, sub, openByDefault) {
    const node = el('div', 'disc');
    const head = el('button', 'disc-h'); head.type = 'button';
    const tx = el('div', 'disc-tx');
    tx.appendChild(el('div', 'disc-t', title));
    if (sub) tx.appendChild(el('div', 'disc-s', sub));
    head.appendChild(tx);
    const car = el('span', 'disc-car');
    car.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m7 10 5 5 5-5"/></svg>';
    head.appendChild(car);
    const wrap = el('div', 'disc-w');
    const body = el('div', 'disc-b');
    wrap.appendChild(body); node.appendChild(head); node.appendChild(wrap);
    let on = !!openByDefault;
    const paint = anim => {
      node.classList.toggle('open', on);
      head.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (!anim || prefersReducedMotion()) { wrap.style.height = on ? 'auto' : '0px'; return; }
      const h = body.scrollHeight;
      if (on) {
        wrap.style.height = '0px';
        requestAnimationFrame(() => { wrap.style.height = h + 'px'; });
        setTimeout(() => { if (on) wrap.style.height = 'auto'; }, 320);
      } else {
        wrap.style.height = h + 'px';
        requestAnimationFrame(() => { wrap.style.height = '0px'; });
      }
    };
    head.onclick = () => { on = !on; paint(true); };
    paint(false);
    return { node, body, head };
  }

  // Intentional empty state; ui-motion.js mounts the contained background from
  // data-bg and handles pausing it and honouring reduced motion.
  function emptyState(bg, title, body, iconPath) {
    const w = el('div', 'mo-empty'); if (bg) w.setAttribute('data-bg', bg);
    if (iconPath) { const ic = el('div', 'mo-empty-ic'); ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' + iconPath + '</svg>'; w.appendChild(ic); }
    w.appendChild(el('h4', '', title)); w.appendChild(el('p', '', body)); return w;
  }

  // in-app modal — replaces browser confirm/prompt (no native "top" dialogs)
  function uiModal(opts) {
    return new Promise(resolve => {
      const root = $('modal-root'), inp = $('modal-input'), ok = $('modal-ok'), cancel = $('modal-cancel');
      // Destructive confirmations spell out what happens, what data is affected,
      // whether it is Numax-only or the real Nuvio account, and whether it can be
      // undone. `details` entries are authored here — interpolate only escaped text.
      const msgBox = $('modal-msg'); clr(msgBox);
      if (opts.title) msgBox.appendChild(el('div', 'modal-title', opts.title));
      msgBox.appendChild(el('div', '', opts.message || ''));
      if (opts.details && opts.details.length) {
        const ul = el('ul', 'modal-details');
        opts.details.forEach(d => { const li = el('li'); li.innerHTML = d; ul.appendChild(li); });
        msgBox.appendChild(ul);
      }
      const card = root.querySelector('.modal-card');
      if (card) card.classList.toggle('danger-card', !!opts.danger);
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
    if (!activity.length) {
      b.appendChild(emptyState(null, 'Nothing has happened yet.',
        'Links, previews, saves, backups, restores and template applies from this session show up here, newest first.',
        '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'));
      return;
    }
    activity.forEach(a => {
      const r = el('div', 'mo-act-row' + (a.lvl === 'ok' ? ' ok' : a.lvl === 'err' ? ' err' : ''));
      r.appendChild(el('span', 'mo-act-t', new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      r.appendChild(el('span', 'mo-act-dot'));
      r.appendChild(el('span', 'mo-act-m', a.msg));
      b.appendChild(r);
    });
  }

  // (mascot/bird-flight system removed)
  function perch(navKey, animate) { /* mascot removed - no-op */ }

  // ======================================================================
  // views + nav
  // ======================================================================
  function showView(id) { document.querySelectorAll('.view').forEach(v => v.classList.toggle('current', v.id === id)); }
  const TITLES = { accounts: 'Nuvio accounts', profile: 'Profile', sync: 'Sync desk', templates: 'Templates', drive: 'Google Drive', market: 'Marketplace', activity: 'Activity', settings: 'Settings' };
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
    if (panel === 'market') refreshMarket();
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
    const r = await withTimeout(fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime,appProperties)&orderBy=modifiedTime desc`, { headers: auth() }).then(r => r.json()), READ_TIMEOUT, 'Reading Google Drive');
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
  async function driveDownload(id) { const r = await withTimeout(fetch(`${DRIVE}/files/${id}?alt=media`, { headers: auth() }), READ_TIMEOUT, 'Reading that file from Drive'); if (!r.ok) throw new Error('Read failed (' + r.status + ').'); return r.json(); }
  async function driveDelete(id) { await fetch(`${DRIVE}/files/${id}`, { method: 'DELETE', headers: auth() }); }

  // ---- account registry in Drive ----
  let registryFileId = null;
  async function loadRegistry() {
    try {
      const files = await driveFindByProp('numax', 'registry');
      if (!files.length) { registryFileId = null; refreshAccounts(); return; }
      registryFileId = files[0].id;
      const doc = await driveDownload(registryFileId);
      (doc.accounts || []).forEach(a => { try { if (a.session && a.session.access_token) store.add(a.session, { email: a.email, label: a.label, keysIncluded: a.keysIncluded }); } catch (e) {} });
      logAct('Loaded ' + (doc.accounts || []).length + ' linked account(s) from Drive', 'info');
    } catch (e) { logAct('Could not load account registry: ' + e.message, 'err'); }
    refreshAccounts();
  }
  async function saveRegistry() {
    if (!gAuth.token) return;
    try {
      const accounts = store.list().map(r => ({ accountId: r.accountId, label: r.label, email: r.email, keysIncluded: r.keysIncluded, session: r.session }));
      const r = await driveUpload('numax-registry.json', { app: 'numax', kind: 'registry', savedAt: new Date().toISOString(), accounts }, { numax: 'registry' }, registryFileId);
      registryFileId = r.id;
    } catch (e) { logAct('Could not save account registry: ' + e.message, 'err'); }
  }

  // ======================================================================
  // account loading
  // ======================================================================
  // whether THIS account had API keys included, decided at link time and stored
  // with it — not the live "Read API keys" switch, which only governs new links.
  const accountKeysIncluded = id => { const rec = store.get(id); return !!(rec && rec.keysIncluded); };
  // Every profile read in the app funnels through here, so the timeout lives
  // here rather than at ~17 call sites — an un-timed fetch was what left
  // "Reading profiles…" / "Loading profiles…" shimmering indefinitely.
  // `inflight` also collapses concurrent reads of the same account, which
  // previously fired a full account export per caller.
  const inflight = {};
  async function loadAccount(id, force) {
    const c = cache[id]; if (c && !force) return c;
    if (!force && inflight[id]) return inflight[id];
    const p = withTimeout(loadAccountNow(id), READ_TIMEOUT, 'Reading this account')
      .finally(() => { if (inflight[id] === p) delete inflight[id]; });
    inflight[id] = p;
    return p;
  }
  async function loadAccountNow(id) {
    const keysIncluded = accountKeysIncluded(id);
    const cl = A.client(store, id); const backup = await cl.exportBackup();
    if (!keysIncluded && Array.isArray(backup.profile_settings_blobs)) backup.profile_settings_blobs = backup.profile_settings_blobs.map(b => b && b.settings_json ? { ...b, settings_json: stripKeys(b.settings_json) } : b);
    const rec = { backup, profiles: normProfiles(backup.profiles) }; cache[id] = rec; return rec;
  }
  // Invalidating drops in-flight reads too: a read that started before the
  // invalidation describes the old state, so it must not be handed out after.
  const inval = id => { delete cache[id]; delete membershipCache[id]; delete inflight[id]; };
  const invalAll = () => { Object.keys(cache).forEach(k => delete cache[k]); Object.keys(membershipCache).forEach(k => delete membershipCache[k]); Object.keys(inflight).forEach(k => delete inflight[k]); };
  // whether an account has an active Nuvio Supporter / Supporter Plus membership —
  // gates the supporter-only theme colors the same way Nuvio's own client does.
  async function getMembership(id) {
    if (id in membershipCache) return membershipCache[id];
    try { membershipCache[id] = await A.client(store, id).getMembership(); }
    catch (e) { membershipCache[id] = null; }
    return membershipCache[id];
  }
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
    try { store.add(session, { email, label, keysIncluded: readKeys }); } catch (e) { status(log, "Couldn't save: " + e.message, 'err'); return; }
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
    const gen = ++acGen;
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
      const nmRow = el('div', 'acct-name'); const nmText = el('span', 'acct-name-text', rec.label || rec.email || rec.accountId.slice(0, 10)); nmRow.appendChild(nmText);
      // this account's own "keys included" state, fixed at link time — no fetch needed to know it
      if (rec.keysIncluded) {
        const badge = el('span', 'api-badge'); badge.textContent = 'API keys included';
        const dot = el('span'); dot.textContent = '●'; dot.style.cssText = 'font-size:8px;color:#7bd88f'; badge.insertBefore(dot, badge.firstChild);
        nmRow.appendChild(badge);
      }
      who.appendChild(nmRow);
      if (rec.email && rec.label) who.appendChild(el('div', 'acct-mail', rec.email)); head.appendChild(who);
      head.appendChild(el('span', 'spacer'));
      const ren = el('button', 'btn btn-ghost btn-xs', 'Rename'); ren.onclick = () => startRename(nmText, rec.accountId);
      const rm = el('button', 'btn btn-ghost btn-xs danger', 'Unlink'); rm.onclick = () => unlink(rec.accountId, rec.label || rec.email);
      head.appendChild(ren); head.appendChild(rm); card.appendChild(head);
      const prof = el('div', 'acct-profiles'); prof.appendChild(el('span', 'muted sm shimmer', 'Loading profiles…')); card.appendChild(prof); box.appendChild(card);
      loadAccount(rec.accountId).then(({ profiles }) => {
        if (gen !== acGen) return; // a newer refreshAccounts() already replaced this row — don't paint a detached one
        clr(prof); if (!profiles.length) { prof.appendChild(el('span', 'muted sm', 'No profiles.')); return; }
        profiles.forEach(p => { const c = el('span', 'pmini'); c.appendChild(avatar(p, 24)); c.appendChild(el('span', '', p.name)); prof.appendChild(c); });
        // Summary-only list, so the avatars overlap and spread on hover. Names stay
        // in the DOM (and in the accessibility tree) collapsed, never removed.
        if (M.avatarGroup) M.avatarGroup(prof, 6);
      })
        .catch(e => { if (gen !== acGen) return; clr(prof); prof.appendChild(el('span', 'muted sm err-text', "Couldn't load: " + e.message)); });
    }
  }
  function startRename(nm, id) {
    const i = el('input'); i.type = 'text'; i.value = nm.textContent; i.maxLength = 40; i.className = 'rename-input'; nm.parentNode.replaceChild(i, nm); i.focus(); i.select();
    const commit = async () => { store.setLabel(id, i.value.trim() || null); await saveRegistry(); logAct('Renamed an account', 'info'); refreshAccounts(); };
    i.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refreshAccounts(); });
    i.addEventListener('blur', commit);
  }
  async function unlink(id, name) {
    if (!(await uiModal({
      title: 'Unlink ' + name + '?',
      message: 'Numax will forget this Nuvio account and stop showing its profiles.',
      details: [
        'Affects <b>Numax only</b> — it removes the entry from the linked-account registry in your Google Drive.',
        'Your <b>Nuvio account is not touched</b>: its profiles, add-ons, plugins, collections, settings and watch history all stay exactly as they are.',
        'Templates and backups you already saved stay in your Drive.',
        '<b>Reversible</b> — link it again any time with its email and password.'
      ],
      danger: true, okLabel: 'Unlink'
    }))) return;
    store.remove(id); inval(id); if (pfA === id) { pfA = pfI = pfEdit = null; } if (syA === id) { syA = syI = sySnap = null; }
    await saveRegistry(); logAct('Unlinked ' + name, 'info'); refreshAccounts();
  }
  // sets the preference used the moment an account is next linked (or re-linked) —
  // does not touch any account already linked, since that's decided per account.
  function setReadKeys(on) {
    readKeys = on; $('ac-readkeys').classList.toggle('on', on); $('st-readkeys').classList.toggle('on', on);
    logAct('Accounts you link from now on will ' + (on ? 'include' : 'exclude') + ' API keys', 'info');
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
    const box = $('pf-profiles'); clr(box); box.appendChild(el('span', 'muted sm shimmer', 'Loading…'));
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
    const keysIncluded = accountKeysIncluded(id);
    try { const c = A.client(store, id); for (const pl of PLATS) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { live[pl] = keysIncluded ? row.settings_json : stripKeys(row.settings_json); upd[pl] = row.updated_at || null; } } } catch (e) { logAct("Couldn't read settings: " + e.message, 'err'); }
    const watched = Array.isArray(backup.watched_items) ? backup.watched_items.filter(w => w.profile_id === idx) : [];
    const watchProgress = Array.isArray(backup.watch_progress) ? backup.watch_progress.filter(w => w.profile_id === idx) : [];
    pfMembership = await getMembership(id);
    pfEdit = { meta: { ...meta }, addons: JSON.parse(JSON.stringify(slice.addons)), plugins: JSON.parse(JSON.stringify(slice.plugins)), collections: JSON.parse(JSON.stringify(slice.collections)), settings: JSON.parse(JSON.stringify(live)), upd, watched, watchProgress };
    pfPlat = PLATS.find(p => live[p]) || 'tv';
    renderPfEditor(); if (!silent) logAct('Opened ' + meta.name, 'info');
  }
  const dirty = k => { pfDirty[k] = true; updateSaveButtonsState(); };
  function updateHeadStats() {
    if (!pfEdit) return;
    $('pf-stat-addons-n').textContent = pfEdit.addons.length;
    $('pf-stat-plugins-n').textContent = pfEdit.plugins.length;
    $('pf-stat-collections-n').textContent = (pfEdit.collections || []).length;
  }
  function renderHeadAvatar() {
    const box = $('pf-avatar-big'); if (!box) return; clr(box);
    if (pfEdit) box.appendChild(avatar(pfEdit.meta, 72));
  }
  function updatePhotoPreview() {
    const box = $('pf-photo-preview'); if (!box || !pfEdit) return; clr(box);
    const typed = $('pf-photo-input').value.trim();
    box.appendChild(avatar(typed ? { ...pfEdit.meta, avatarUrl: typed } : pfEdit.meta, 40));
  }
  function renderPfEditor() {
    if (!pfEdit) return;
    $('pf-name-input').value = pfEdit.meta.name || '';
    $('pf-photo-input').value = '';
    renderPfList('addons'); renderPfList('plugins'); renderPfCollections(); renderSettingsEditor();
    renderPfWatched(); renderPfWatchProgress();
    renderHeadAvatar(); updateHeadStats(); updatePhotoPreview();
    updateSaveButtonsState();
    switchPfEditorTab(pfEditorTab);
  }

  function dragHandle() {
    const b = el('button', 'draghandle'); b.type = 'button'; b.title = 'Drag to reorder'; b.tabIndex = -1;
    b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
    return b;
  }
  // native HTML5 drag-and-drop: `arr` is spliced in place and `after()` re-renders.
  // Hovering the top/bottom half of a row decides insert-before/after; the
  // motion layer (if present) previews that slot with a snap-in line.
  function wireRowDrag(row, arr, i, after) {
    row.draggable = true;
    row.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); requestAnimationFrame(() => row.classList.add('dragging')); });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      window.NumaxMotion && window.NumaxMotion.dropline && window.NumaxMotion.dropline(null);
    });
    row.addEventListener('dragover', e => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const dropAfter = (e.clientY - rect.top) > rect.height / 2;
      row.dataset.dropAfter = dropAfter ? '1' : '';
      window.NumaxMotion && window.NumaxMotion.dropline && window.NumaxMotion.dropline(row.parentElement, dropAfter ? row.nextElementSibling : row);
    });
    row.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const dropAfter = row.dataset.dropAfter === '1';
      window.NumaxMotion && window.NumaxMotion.dropline && window.NumaxMotion.dropline(null);
      if (Number.isNaN(from)) return;
      let to = i + (dropAfter ? 1 : 0);
      if (from < to) to--;
      if (to === from) return;
      const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved);
      after();
    });
  }
  // Rows have their own dragover/drop, but the small gaps *between* rows (and the
  // empty space below the last one) belong to no row's listener — without this,
  // hovering there shows the browser's default "not-allowed" cursor even though
  // dropping is fine. One dragover/drop pair on the container covers those gaps;
  // row-level drop already stopPropagation()s, so this only ever fires for a drop
  // that missed every row. `rowSelector` is scoped to direct children only, since
  // pf-collections nests each folder's own `.erow` rows one level deeper.
  function wireListDropzone(box, arr, after, rowSelector) {
    rowSelector = rowSelector || ':scope > .erow';
    box.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    box.addEventListener('drop', e => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      window.NumaxMotion && window.NumaxMotion.dropline && window.NumaxMotion.dropline(null);
      if (Number.isNaN(from)) return;
      const rows = [...box.querySelectorAll(rowSelector)];
      let to = rows.length;
      for (let k = 0; k < rows.length; k++) { if (e.clientY < rows[k].getBoundingClientRect().top + rows[k].getBoundingClientRect().height / 2) { to = k; break; } }
      if (from < to) to--;
      if (to === from) return;
      const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved);
      after();
    });
  }
  function renderPfList(kind) {
    const box = $('pf-' + kind); clr(box); const list = pfEdit[kind];
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'No ' + kind + '.')); }
    list.forEach((item, i) => {
      const row = el('div', 'erow'); row.appendChild(dragHandle());
      wireRowDrag(row, list, i, () => { dirty(kind); renderPfList(kind); });
      const tog = el('button', 'tog' + (item.enabled !== false ? ' on' : '')); tog.onclick = () => { item.enabled = !(item.enabled !== false); tog.classList.toggle('on', item.enabled); dirty(kind); };
      row.appendChild(tog);
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', item.name || host(item.url))); b.appendChild(el('div', 'es', host(item.url))); row.appendChild(b);
      // Configure — same behaviour as Nuvio's own account page: shown only when
      // the add-on's manifest declares behaviorHints.configurable, and it just
      // opens <manifest base>/configure in a new tab. Resolved lazily because
      // the stored row carries no manifest; a manifest we can't read stays
      // hidden rather than offering a button that might not work.
      if (kind === 'addons' && window.NumaxMarket) {
        const cfg = el('button', 'btn btn-ghost btn-xs', 'Configure');
        cfg.style.display = 'none';
        cfg.onclick = () => window.open(window.NumaxMarket.configureUrl(item.url), '_blank', 'noopener,noreferrer');
        row.appendChild(cfg);
        window.NumaxMarket.isConfigurable(item.url).then(on => { if (on) cfg.style.display = ''; });
      }
      const del = el('button', 'iconbtn', '✕'); del.onclick = () => { list.splice(i, 1); dirty(kind); renderPfList(kind); }; row.appendChild(del);
      box.appendChild(row);
    });
    if (list.length) wireListDropzone(box, list, () => { dirty(kind); renderPfList(kind); });
    updateHeadStats();
  }
  function renderPfCollections() {
    const box = $('pf-collections'); clr(box); const list = pfEdit.collections;
    if (!Array.isArray(list) || !list.length) { box.appendChild(el('p', 'empty sm', 'No collections.')); }
    (list || []).forEach((c, i) => {
      const row = el('div', 'erow'); row.appendChild(dragHandle());
      wireRowDrag(row, list, i, () => { dirty('collections'); renderPfCollections(); });
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', collLabel(c)));
      const folders = (c && Array.isArray(c.folders)) ? c.folders : [];
      b.appendChild(el('div', 'es', folders.length ? folders.length + ' folder' + (folders.length === 1 ? '' : 's') : 'No folders')); row.appendChild(b);
      const ed = el('button', 'iconbtn', '⇅'); ed.title = 'Reorder folders'; ed.disabled = folders.length < 2; ed.onclick = () => toggleFolders(row, c, i); row.appendChild(ed);
      const del = el('button', 'iconbtn', '✕'); del.onclick = () => { list.splice(i, 1); dirty('collections'); renderPfCollections(); }; row.appendChild(del);
      box.appendChild(row);
      const fbox = el('div', 'subrow'); fbox.dataset.folders = i; fbox.style.display = 'none'; box.appendChild(fbox);
    });
    if (list && list.length) wireListDropzone(box, list, () => { dirty('collections'); renderPfCollections(); });
    updateHeadStats();
  }
  function toggleFolders(row, coll, idx) {
    const box = row.nextSibling; if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; clr(box); return; }
    box.style.display = ''; clr(box);
    (coll.folders || []).forEach((f, j) => {
      const fr = el('div', 'erow'); fr.appendChild(dragHandle());
      wireRowDrag(fr, coll.folders, j, () => { dirty('collections'); toggleFolders(row, coll, idx); toggleFolders(row, coll, idx); });
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', (f && (f.title || f.name)) || 'Folder ' + (j + 1))); fr.appendChild(b); box.appendChild(fr);
    });
    if (coll.folders && coll.folders.length) wireListDropzone(box, coll.folders, () => { dirty('collections'); toggleFolders(row, coll, idx); toggleFolders(row, coll, idx); });
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
    // TV / Mobile / Desktop, each rendered from that platform's own tab set. Desktop
    // shares the mobile definitions because NuvioDesktop writes the same feature groups
    // and only swaps the platform string (see nuvio-settings-schema.js header).
    const plats = PLATS.filter(p => pfEdit.settings[p] && pfEdit.settings[p].features);
    if (!plats.length) { wrap.appendChild(el('p', 'empty sm', 'No settings found for this profile.')); return; }
    if (!plats.includes(pfPlat)) pfPlat = plats[0];
    const bar = el('div', 'set-platbar');
    plats.forEach(p => { const b = el('button', p === pfPlat ? 'on' : '', PLAT_LABEL[p] || p); b.onclick = () => { pfPlat = p; pfTab = 0; renderSettingsEditor(); }; bar.appendChild(b); });
    wrap.appendChild(bar);

    const tabs = SCHEMA[pfPlat] || [];
    const tabBar = el('div', 'set-tabs');
    tabs.forEach((t, i) => { const b = el('button', 'set-tab' + (i === pfTab ? ' on' : ''), t.title); b.onclick = () => { pfTab = i; renderSettingsEditor(); }; tabBar.appendChild(b); });
    wrap.appendChild(tabBar);

    const search = el('input'); search.type = 'search'; search.placeholder = 'Search ' + PLAT_SHORT[pfPlat] + ' settings'; search.className = 'set-search';
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
      if (accountKeysIncluded(pfA)) { const i = el('input'); i.type = 'password'; i.value = (v == null ? '' : v); i.onchange = () => setVal(f, i.value); w.appendChild(i); }
      else { const s = el('input'); s.type = 'text'; s.value = v ? '••••••••' : ''; s.disabled = true; w.appendChild(s); w.appendChild(el('span', 'lock', 'hidden')); }
      return w;
    }
    if (ctl === 'toggle') { const w = el('div', 'sf-toggle-wrap'); const st = el('span', 'st', v ? 'On' : 'Off'); const tg = el('button', 'tog' + (v ? ' on' : '')); tg.onclick = () => { const nv = !tg.classList.contains('on'); tg.classList.toggle('on', nv); st.textContent = nv ? 'On' : 'Off'; setVal(f, nv); }; w.appendChild(st); w.appendChild(tg); return w; }
    if (ctl === 'swatches') { const w = el('div', 'swatches'); const isSupporter = !!(pfMembership && pfMembership.isSupporter); (f.options || []).forEach(o => { const locked = !!o.supporterOnly && !isSupporter; const b = el('button', 'swatch' + (String(v) === String(o.value) ? ' on' : '') + (locked ? ' locked' : '')); b.type = 'button'; if (locked) { b.disabled = true; b.title = 'Requires an active Nuvio Supporter membership on this account.'; } if (o.color) { const d = el('span', 'dot'); d.style.background = o.color; b.appendChild(d); } b.appendChild(el('span', '', o.label || o.value)); if (o.supporterOnly) b.appendChild(el('span', 'sup', 'Supporter')); b.onclick = () => { if (locked) return; setVal(f, o.value); [...w.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); }; w.appendChild(b); }); return w; }
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
  // Two sticky buttons replace the old per-tab save buttons: the red one commits every
  // dirty section at once (see saveAllDirty), the white one saves a template and is only
  // enabled once everything is saved (pfDirty empty) — see updateSaveButtonsState.
  const SAVE_LABEL = { addons: 'add-ons', plugins: 'plugins', collections: 'collections', 'settings-tv': 'TV settings', 'settings-mobile': 'mobile settings', 'settings-desktop': 'desktop settings', identity: 'name/photo' };
  function updateSaveButtonsState() {
    const isDirty = Object.keys(pfDirty).length > 0;
    const saveBtn = $('pf-save-btn'), tplBtn = $('pf-tpl-profile');
    if (saveBtn) saveBtn.disabled = !isDirty;
    if (tplBtn) tplBtn.disabled = isDirty;
  }
  function refreshCurrentChip() {
    const chip = document.querySelector('#pf-profiles .pchip.on'); if (!chip || !pfEdit) return;
    clr(chip); chip.appendChild(avatar(pfEdit.meta, 42)); chip.appendChild(el('span', 'pcn', pfEdit.meta.name));
  }
  // shared by the sticky Save button and by applying a template's "profile" part
  async function pushProfileIdentity(accountId, idx, { name, avatarUrl }) {
    const c = A.client(store, accountId); const live = rawList(await c.pullProfiles()); if (!live.length) throw new Error("couldn't read profiles");
    if (!live.find(p => p.profile_index === idx)) throw new Error('profile no longer exists');
    const next = live.map(p => { const r = normRow(p); if (p.profile_index === idx) { if (name) r.name = name.slice(0, 60); if (avatarUrl) r.avatar_url = avatarUrl; } return r; });
    if (live.map(p => p.profile_index).sort().join() !== next.map(p => p.profile_index).sort().join()) throw new Error('profile list changed — reload');
    await c.rpc('sync_push_profiles', { p_profiles: next, p_client_max_profiles: 6 });
  }
  async function saveIdentityKind() {
    const name = $('pf-name-input').value.trim(); if (!name) throw new Error('give the profile a name');
    const photoUrl = $('pf-photo-input').value.trim();
    await pushProfileIdentity(pfA, pfI, { name, avatarUrl: photoUrl || null });
    pfEdit.meta.name = name; if (photoUrl) pfEdit.meta.avatarUrl = photoUrl;
  }
  async function saveListKind(kind) {
    const c = A.client(store, pfA);
    const rows = pfEdit[kind].map((x, i) => { const r = { url: x.url, name: x.name ?? null, enabled: x.enabled !== false, sort_order: i }; if (kind === 'plugins' && x.repo_type !== undefined) r.repo_type = x.repo_type; return r; });
    await c.rpc(kind === 'addons' ? 'sync_push_addons' : 'sync_push_plugins', { [kind === 'addons' ? 'p_addons' : 'p_plugins']: rows, p_profile_id: pfI, p_origin_client_id: 'numax-web' });
  }
  async function saveCollectionsKind() {
    await A.client(store, pfA).rpc('sync_push_collections', { p_profile_id: pfI, p_collections_json: pfEdit.collections, p_origin_client_id: 'numax-web' });
  }
  async function saveSettingsKind(plat) {
    const blob = pfEdit.settings[plat]; if (!blob) return;
    const c = A.client(store, pfA);
    try { await c.rpc('sync_push_profile_settings_blob', { p_profile_id: pfI, p_settings_json: blob, p_platform: plat, p_origin_client_id: 'numax-web' }); }
    catch (e) { const conflict = (A.ConflictError && e instanceof A.ConflictError) || /40001|409|another device/i.test(e.message || ''); throw new Error(conflict ? 'changed elsewhere — reopen the profile and try again' : e.message); }
    const row = await c.pullSettings(pfI, plat); if (row) pfEdit.upd[plat] = row.updated_at || null;
  }
  async function saveAllDirty() {
    const kinds = Object.keys(pfDirty); if (!kinds.length) return;
    status($('pf-save-status'), 'Saving…');
    const okList = [], failList = [];
    for (const k of kinds) {
      try {
        if (k === 'addons' || k === 'plugins') await saveListKind(k);
        else if (k === 'collections') await saveCollectionsKind();
        else if (k.startsWith('settings-')) await saveSettingsKind(k.slice('settings-'.length));
        else if (k === 'identity') await saveIdentityKind();
        okList.push(k); delete pfDirty[k];
      } catch (e) { failList.push((SAVE_LABEL[k] || k) + ': ' + e.message); }
    }
    if (okList.length) {
      inval(pfA); logAct('Saved ' + okList.map(k => SAVE_LABEL[k] || k).join(', ') + ' to ' + pfEdit.meta.name, 'ok');
      updateHeadStats();
      if (okList.includes('identity')) { renderHeadAvatar(); refreshCurrentChip(); }
    }
    status($('pf-save-status'), failList.length ? "Couldn't save " + failList.join('; ') : 'Saved ' + okList.map(k => SAVE_LABEL[k] || k).join(', ') + '.', failList.length ? 'err' : 'ok');
    updateSaveButtonsState();
  }

  // ======================================================================
  // TEMPLATES (on Drive)
  // ======================================================================
  function pfSettingsForTemplate(includeKeys, plats) {
    const out = {};
    for (const pl of (plats && plats.length ? plats : PLATS)) { const b = pfEdit.settings[pl]; if (b && b.features) out[pl] = includeKeys ? JSON.parse(JSON.stringify(b)) : stripKeys(JSON.parse(JSON.stringify(b))); }
    return out;
  }
  // one combined template save, driven by the "Save as template" picker modal
  const TPL_PARTS = [
    { key: 'profile', label: 'Profile (name & photo)', count: () => 1 },
    { key: 'addons', label: 'Add-ons', count: () => (pfEdit.addons || []).length },
    { key: 'plugins', label: 'Plugins', count: () => (pfEdit.plugins || []).length },
    { key: 'collections', label: 'Collections', count: () => (pfEdit.collections || []).length },
    { key: 'settings', label: 'Settings', count: () => (PLATS.some(pl => pfEdit.settings[pl] && pfEdit.settings[pl].features) ? 1 : 0) },
    { key: 'watchprogress', label: 'Watch Progress', count: () => (pfEdit.watchProgress || []).length },
    { key: 'watched', label: 'Watched', count: () => (pfEdit.watched || []).length },
  ];
  PF_TAB_LABEL.profile = 'Profile';
  async function openSaveTemplateModal() {
    if (!gAuth.token) { await uiAlert('Sign in with Google first.'); return; }
    if (!pfEdit) { await uiAlert('Open a profile first.'); return; }
    const root = $('tpl-save-root'), list = $('tpl-save-list'), ok = $('tpl-save-ok'), cancel = $('tpl-save-cancel'), bg = $('tpl-save-bg');
    clr(list);
    const checks = {}, platChecks = {};
    TPL_PARTS.forEach(part => {
      const n = part.count(); const empty = !n;
      const row = el('label', 'pick'); if (empty) row.style.opacity = '.5';
      const cb = el('input'); cb.type = 'checkbox'; cb.disabled = empty; checks[part.key] = cb; row.appendChild(cb);
      const b = el('div', 'pb'); b.appendChild(el('div', 'pn', part.label));
      b.appendChild(el('div', 'ps', empty ? 'none on this profile' : (part.key === 'settings' ? 'available' : n + ' item' + (n === 1 ? '' : 's'))));
      row.appendChild(b); list.appendChild(row);
      // settings is per-platform — TV, mobile, desktop are separate blobs on the server,
      // so let the user pick which of this profile's platforms actually go into the template.
      if (part.key === 'settings' && !empty) {
        const platRow = el('div', 'tpl-plat-row');
        PLATS.forEach(pl => {
          const has = !!(pfEdit.settings[pl] && pfEdit.settings[pl].features);
          const lab = el('label', 'tpl-plat-pick'); if (!has) lab.style.opacity = '.4';
          const pcb = el('input'); pcb.type = 'checkbox'; pcb.checked = has; pcb.disabled = !has; platChecks[pl] = pcb;
          lab.appendChild(pcb); lab.appendChild(el('span', '', PLAT_LABEL[pl] || pl));
          platRow.appendChild(lab);
        });
        list.appendChild(platRow);
      }
    });
    root.style.display = '';
    return new Promise(resolve => {
      const done = async (proceed) => {
        root.style.display = 'none'; ok.onclick = cancel.onclick = bg.onclick = null;
        if (!proceed) { resolve(); return; }
        const kinds = TPL_PARTS.map(p => p.key).filter(k => checks[k].checked && !checks[k].disabled);
        if (!kinds.length) { await uiAlert('Pick at least one thing to save.'); resolve(); return; }
        let includeKeys = false;
        const selectedPlats = PLATS.filter(pl => platChecks[pl] && platChecks[pl].checked && !platChecks[pl].disabled);
        if (kinds.includes('settings')) {
          if (!selectedPlats.length) { await uiAlert('Pick at least one platform for Settings, or uncheck Settings.'); resolve(); return; }
          if (accountKeysIncluded(pfA)) includeKeys = await uiConfirm('Include this profile\'s API keys (debrid, TMDB, etc.) in this template?', { okLabel: 'Include keys' });
          else await uiAlert('This account wasn\'t linked with "Read API keys" on, so there are no key values to include — settings will save without keys.');
        }
        await saveTemplateParts(kinds, includeKeys, selectedPlats);
        resolve();
      };
      ok.onclick = () => done(true); cancel.onclick = () => done(false); bg.onclick = () => done(false);
    });
  }
  async function saveTemplateParts(kinds, includeKeys, plats) {
    const isWholeProfile = kinds.length === TPL_PARTS.length;
    const label = isWholeProfile ? 'profile' : kinds.map(k => PF_TAB_LABEL[k] || k).join(', ');
    const name = await uiPrompt('Name this template', pfEdit.meta.name + ' ' + label); if (name == null || !name.trim()) return;
    const tkind = isWholeProfile ? 'profile' : kinds.join('+');
    const payload = { app: 'numax', kind: 'template', tkind, name, savedAt: new Date().toISOString(), from: pfEdit.meta.name };
    if (kinds.includes('profile')) payload.profile = { name: pfEdit.meta.name, avatarUrl: pfEdit.meta.avatarUrl || null };
    if (kinds.includes('addons')) payload.addons = pfEdit.addons;
    if (kinds.includes('plugins')) payload.plugins = pfEdit.plugins;
    if (kinds.includes('collections')) payload.collections = pfEdit.collections;
    if (kinds.includes('settings')) payload.settings = pfSettingsForTemplate(includeKeys, plats);
    // Keys inside a settings blob are cosmetic only — the apps that matter (mobile,
    // desktop, and per the same schema note likely TV too) read provider keys from the
    // separate provider_credentials table and ignore whatever sits in settings_json.
    // So "include keys" also has to carry the real credential rows, the same table
    // Sync Desk's key-copy already uses, or the copied key silently never takes effect.
    if (kinds.includes('settings') && includeKeys) {
      try { payload.credentials = await A.client(store, pfA).pullProviderCredentials(pfI); }
      catch (e) { logAct("Couldn't read API keys for template: " + e.message, 'err'); }
    }
    if (kinds.includes('watchprogress')) payload.watchProgress = pfEdit.watchProgress || [];
    if (kinds.includes('watched')) payload.watched = pfEdit.watched || [];
    status($('pf-save-status'), 'Saving template…');
    try { await driveUpload(safeName('numax-tpl-' + name) + '.json', payload, { numax: 'template', tkind }); status($('pf-save-status'), 'Template “' + name + '” saved to Drive — see the Templates tab.', 'ok'); logAct('Saved template "' + name + '" (' + tkind + ')', 'ok'); if ($('tpl-list')) refreshTemplates(); }
    catch (e) { status($('pf-save-status'), "Couldn't save template: " + e.message, 'err'); logAct('Template save failed: ' + e.message, 'err'); }
  }
  async function refreshTemplates() {
    const box = $('tpl-list'); clr(box); status($('tpl-status'), '');
    if (!gAuth.token) { box.appendChild(el('p', 'empty', 'Sign in with Google to see templates.')); return; }
    box.appendChild(el('p', 'muted sm shimmer', 'Loading…'));
    let files; try { files = await driveFindByProp('numax', 'template'); } catch (e) { clr(box); box.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(box);
    if (!files.length) {
      box.appendChild(emptyState(null, 'No templates yet.',
        'Open a profile, then use “Save as template” to keep its add-ons, plugins, collections or settings for reuse on any other profile.',
        '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/>'));
      return;
    }
    files.forEach(f => {
      const kind = (f.appProperties && f.appProperties.tkind) || 'template';
      const tname = f.name.replace(/^numax-tpl-/, '').replace(/\.json$/, '');
      const row = el('div', 'erow');
      const b = el('div', 'eb'); b.appendChild(el('div', 'en', tname)); b.appendChild(el('div', 'es', kind + ' · ' + (f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ''))); row.appendChild(b);
      const ap = el('button', 'btn btn-solid btn-xs', 'Apply'); ap.onclick = () => openTemplateApply(f); row.appendChild(ap);
      const del = el('button', 'iconbtn', '✕'); del.title = 'Delete template';
      del.onclick = async () => {
        if (!(await uiModal({
          title: 'Delete “' + tname + '”?',
          message: 'This template will be removed from your Google Drive.',
          details: [
            'Affects <b>Numax only</b> — it deletes the template file Numax created in your Drive.',
            'Profiles you already applied this template to are <b>not changed</b>.',
            '<b>Not reversible</b> — Numax cannot recover the file once it is deleted.'
          ],
          danger: true, okLabel: 'Delete'
        }))) return;
        await driveDelete(f.id); logAct('Deleted a template', 'info'); refreshTemplates();
      };
      row.appendChild(del);
      box.appendChild(row);
    });
  }
  async function openTemplateApply(file) {
    const card = $('tpl-apply-card'), body = $('tpl-apply-body'); card.style.display = ''; clr(body); body.appendChild(el('p', 'muted sm shimmer', 'Reading template…'));
    $('tpl-apply-title').textContent = 'Apply ' + file.name.replace(/^numax-tpl-/, '').replace(/\.json$/, '');
    let doc; try { doc = await driveDownload(file.id); } catch (e) { clr(body); body.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(body);
    // target picker
    const tw = el('label', 'fld'); tw.style.maxWidth = '440px'; tw.appendChild(el('span', '', 'Apply to profile'));
    const tsel = el('select', 'sel'); tw.appendChild(tsel); body.appendChild(tw);
    for (const rec of store.list()) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; } profiles.forEach(p => { const o = document.createElement('option'); o.value = rec.accountId + ':' + p.index; o.textContent = p.name + ' · ' + accountName(rec.accountId); tsel.appendChild(o); }); }
    const mw = el('label', 'fld'); mw.style.cssText = 'max-width:440px;margin-top:12px'; mw.appendChild(el('span', '', 'How to apply'));
    const msel = el('select', 'sel'); msel.innerHTML = '<option value="merge" data-label="Merge" data-hint="add and update, keep the rest">Merge</option><option value="overwrite" data-label="Overwrite" data-hint="match the template exactly">Overwrite</option>'; mw.appendChild(msel); body.appendChild(mw);
    const bar = el('div', 'actbar'); const btn = el('button', 'btn btn-primary', 'Preview'); const st = el('div', 'inline-status'); bar.appendChild(btn); bar.appendChild(st); body.appendChild(bar);
    const res = el('div'); res.style.marginTop = '12px'; body.appendChild(res);
    btn.onclick = async () => {
      const tid = tsel.value; if (!tid) { status(st, 'Pick a target.', 'err'); return; } const [aid, iStr] = tid.split(':'); const idx = parseInt(iStr, 10);
      const mode = msel.value === 'overwrite' ? 'mirror' : 'merge';
      status(st, 'Reading target…');
      try {
        const master = { addons: doc.addons || [], plugins: doc.plugins || [], collections: doc.collections || [], settings: doc.settings || {} };
        const c = A.client(store, aid); const { backup } = await loadAccount(aid); const state = sliceProfile(backup, idx); const upd = {};
        if (doc.settings && Object.keys(doc.settings).length) { state.settings = {}; for (const pl of Object.keys(doc.settings)) { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { state.settings[pl] = row.settings_json; upd[pl] = row.updated_at; } } }
        const cats = { addons: !!(doc.addons), plugins: !!(doc.plugins), collections: !!(doc.collections), settings: !!(doc.settings && Object.keys(doc.settings).length) };
        // includeSecrets:true here is safe — a template only carries key values if the save-time "include API keys?" prompt was answered yes
        const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true, includeSecrets: true }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: upd });
        renderApplyPlan(res, st, plan, aid, 'Template applied', { watched: doc.watched, watchProgress: doc.watchProgress, profileId: idx, identity: doc.profile, credentials: doc.credentials, credentialsReplace: msel.value === 'overwrite' });
      } catch (e) { status(st, e.message, 'err'); }
    };
  }

  // Every settings leaf the engine declined to copy, as one readable line each, so
  // both preview surfaces can show exactly what was left behind instead of only
  // counting what changed. Buckets come from engine.mergeSettingsBlob's report.
  const SETTINGS_SKIP_WHY = [
    ['skippedSecrets', 'API key — not included in this copy'],
    ['skippedAccount', 'account/personal data — never copied'],
    ['skippedPersonal', 'personal preference — not opted in'],
    ['skippedUnreadable', ''],   // message already carries its own reason
  ];
  function settingsSkipLines(rep, platform) {
    const out = [];
    if (!rep) return out;
    SETTINGS_SKIP_WHY.forEach(([bucket, why]) => {
      (rep[bucket] || []).forEach(leaf => out.push(platform + ': ' + leaf + (why ? ' — ' + why : '')));
    });
    return out;
  }

  // shared apply-plan renderer (templates + restore)
  function tagHtml(cls, sign, arr) { return (arr && arr.length) ? `<span class="tag ${cls}">${sign}${arr.length}</span>` : ''; }
  function renderApplyPlan(res, st, plan, accountId, okMsg, extras) {
    clr(res); const r = plan.report; const d = el('div', 'report');
    const line = (label, o) => { if (!o) return; const bits = [tagHtml('add', '+', o.added), tagHtml('upd', '~', o.updated), tagHtml('rem', '−', o.removed)].filter(Boolean); if (bits.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">${label}</span>` + bits.join(' '); d.appendChild(x); } };
    line('Add-ons', r.addons); line('Plugins', r.plugins); line('Collections', r.collections);
    if (r.settings) {
      let ch = 0; const gapDetail = [], skipDetail = [];
      for (const p of Object.keys(r.settings)) {
        ch += r.settings[p].changed.length;
        settingsSkipLines(r.settings[p], p).forEach(s => skipDetail.push(s));
        (r.settings[p].wontApply || []).forEach(g => gapDetail.push(p + ': ' + g));
      }
      if (ch || skipDetail.length || gapDetail.length) {
        const x = el('div', 'rline');
        x.innerHTML = `<span class="rk">Settings</span>`
          + (ch ? `<span class="tag upd">${ch} fields</span>` : '')
          + (skipDetail.length ? `<span class="tag held" title="${esc(skipDetail.join('\n'))}">${skipDetail.length} skipped</span>` : '')
          + (gapDetail.length ? `<span class="tag warn" title="${esc(gapDetail.join('\n'))}">${gapDetail.length} won't apply</span>` : '');
        d.appendChild(x);
      }
    }
    if (extras && Array.isArray(extras.watched) && extras.watched.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Watched</span><span class="tag add">+${extras.watched.length}</span>`; d.appendChild(x); }
    if (extras && Array.isArray(extras.watchProgress) && extras.watchProgress.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Progress</span><span class="tag add">+${extras.watchProgress.length}</span>`; d.appendChild(x); }
    if (extras && extras.identity && extras.identity.name) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">Profile</span><span class="tag upd">name & photo</span>`; d.appendChild(x); }
    if (extras && Array.isArray(extras.credentials) && extras.credentials.length) { const x = el('div', 'rline'); x.innerHTML = `<span class="rk">API keys</span><span class="tag add">+${extras.credentials.length}</span>`; d.appendChild(x); }
    const hasExtras = extras && ((extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length) || (extras.identity && extras.identity.name) || (extras.credentials && extras.credentials.length));
    if (!plan.hasChanges && !hasExtras) d.appendChild(el('div', 'rline muted', 'Already matches — nothing to do.'));
    res.appendChild(d);
    let confirmed = !plan.hasRemovals;
    if (plan.hasRemovals) { const w = el('label', 'confirm'); const cb = el('input'); cb.type = 'checkbox'; cb.onchange = () => { confirmed = cb.checked; ap.disabled = !confirmed; }; w.appendChild(cb); w.appendChild(el('span', '', 'This removes items the target has that this doesn\'t. I understand.')); res.appendChild(w); }
    // Primary red, matching every other commit action on the site — a white
    // button was the odd one out on the review surfaces.
    const ap = el('button', 'btn btn-primary', 'Apply'); ap.disabled = (!plan.hasChanges && !hasExtras) || !confirmed;
    ap.style.marginTop = '4px';
    ap.onclick = async () => { ap.disabled = true; status(st, 'Applying…');
      try {
        const rr = await A.client(store, accountId).applyPlan(plan, { dryRun: false }); const fails = (rr.results || []).filter(x => !x.ok);
        // extras: push watched/progress/identity in addition to plan
        if (extras && extras.profileId != null) {
          const c = A.client(store, accountId);
          if (Array.isArray(extras.watched) && extras.watched.length) { try { await c.rpc('sync_push_watched_items', { p_items: extras.watched.map(stripWatchRow), p_profile_id: extras.profileId, p_origin_client_id: 'numax-web' }); } catch (e) { fails.push({ ok: false, surface: 'watched', error: e.message }); } }
          if (Array.isArray(extras.watchProgress) && extras.watchProgress.length) { try { await c.rpc('sync_push_watch_progress', { p_entries: extras.watchProgress.map(stripWatchRow), p_profile_id: extras.profileId, p_origin_client_id: 'numax-web' }); } catch (e) { fails.push({ ok: false, surface: 'progress', error: e.message }); } }
          if (extras.identity && extras.identity.name) { try { await pushProfileIdentity(accountId, extras.profileId, extras.identity); } catch (e) { fails.push({ ok: false, surface: 'profile', error: e.message }); } }
          // Additive by provider, same as Sync Desk's key copy: a provider the target
          // already has is left alone unless the caller opted into overwrite, and a
          // provider only the target has is never touched either way.
          if (Array.isArray(extras.credentials) && extras.credentials.length) {
            try {
              const existing = await c.pullProviderCredentials(extras.profileId);
              const have = new Set(existing.map(x => x.provider));
              const toWrite = extras.credentials.filter(x => extras.credentialsReplace || !have.has(x.provider));
              if (toWrite.length) await c.pushProviderCredentials(extras.profileId, toWrite, 'numax-web');
            } catch (e) { fails.push({ ok: false, surface: 'credentials', error: e.message }); }
          }
        }
        invalAll();
        // Prove it landed. The push RPCs answer 204 with an empty body, so a
        // clean response is not evidence the data is actually on the profile —
        // which is how a write could report success having changed nothing.
        if (!fails.length && extras && typeof extras.verify === 'function') {
          status(st, 'Checking it saved…');
          (await extras.verify()).forEach(m => fails.push({ ok: false, surface: 'verify', error: m }));
        }
        status(st, fails.length ? okMsg + ' with ' + fails.length + ' error(s).' : okMsg + ' — checked and saved.', fails.length ? 'err' : 'ok');
        logAct(okMsg + (fails.length ? ' (' + fails.length + ' errors)' : ''), fails.length ? 'err' : 'ok');
        if (fails.length) { const ul = el('ul', 'modal-details'); fails.forEach(f => ul.appendChild(el('li', '', (f.surface ? f.surface + ': ' : '') + f.error))); res.appendChild(ul); }
        if (!fails.length) celebrate(res.closest('.card') || res);
      } catch (e) { status(st, 'Failed: ' + e.message, 'err'); }
    };
    res.appendChild(ap);
  }

  // ======================================================================
  // SYNC DESK  (two-column workspace, live preview on every change,
  // watched/watchprogress as upsert-only categories, review grid + metrics)
  // ======================================================================
  const sySnapExt = { watched: [], watchProgress: [], credentials: [] }; // filled per source select

  function refreshSyncTab() {
    const list = store.list(); const sel = $('sy-account'); const prev = sel.value;
    sel.innerHTML = list.map(r => `<option value="${esc(r.accountId)}">${esc(accountName(r.accountId))}</option>`).join('');
    if (!list.length) { $('sy-body').classList.remove('open'); $('sy-empty').style.display = ''; return; }
    $('sy-empty').style.display = 'none'; $('sy-body').classList.add('open');
    sel.value = (prev && list.some(r => r.accountId === prev)) ? prev : (syA && list.some(r => r.accountId === syA) ? syA : list[0].accountId);
    // the desk is only measurable once its panel is on screen
    syOpenSec(sySecOpen || 'source');
    renderSySource(sel.value);
  }
  async function renderSySource(id) {
    const box = $('sy-source'); clr(box); box.appendChild(el('span', 'muted sm shimmer', 'Loading…'));
    let profiles; try { profiles = (await loadAccount(id)).profiles; } catch (e) { clr(box); box.appendChild(el('span', 'muted sm err-text', e.message)); return; }
    clr(box); if (!profiles.length) { box.appendChild(el('span', 'muted sm', 'No profiles.')); return; }
    const keep = (id === syA && profiles.some(p => p.index === syI)) ? syI : profiles[0].index;
    profiles.forEach(p => {
      const c = el('button', 'pchip' + (p.index === keep ? ' on' : ''));
      c.type = 'button'; c.appendChild(avatar(p, 26)); c.appendChild(el('span', 'pcn', p.name));
      c.onclick = () => selectSource(id, p.index, true);
      box.appendChild(c);
    });
    selectSource(id, keep);
  }
  async function selectSource(id, idx, userPicked) {
    // The "include API keys" answer belongs to the exact source profile it was given
    // for. This function runs again for the SAME source on every re-render — entering
    // the Sync Desk tab, switching accounts in the dropdown, refreshing the profile
    // chips — and it used to clear the answer unconditionally while leaving the
    // Settings checkbox ticked, so a later Apply quietly copied everything except the
    // keys with no prompt and no warning. Keep the answer when the source is unchanged;
    // when it genuinely changes, clear it AND untick Settings so the choice gets made
    // again rather than silently lost.
    if (syKeysAnsweredFor !== id + ':' + idx) {
      sySettingsIncludeKeys = false;
      syCreds.copy = false; syCreds.replace = false;
      syKeysAnsweredFor = null;
    }
    syA = id; syI = idx;
    document.querySelectorAll('#sy-source .pchip').forEach((c, i) => loadAccount(id).then(({ profiles }) => c.classList.toggle('on', profiles[i] && profiles[i].index === idx)).catch(() => {}));
    status($('sy-status'), 'Reading source…');
    try {
      const { backup } = await loadAccount(id); const slice = sliceProfile(backup, idx); const c = A.client(store, id); const settings = {}; const keysIncluded = accountKeysIncluded(id);
      // Desktop is read alongside TV and mobile. A profile that has never run the
      // desktop app simply returns nothing for it and the section is omitted.
      for (const pl of PLATS) { try { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) settings[pl] = keysIncluded ? row.settings_json : stripKeys(row.settings_json); } catch (e) { logAct("Couldn't read " + pl + " settings: " + e.message, 'err'); } }
      // The source's own API keys, from the separate credentials table Nuvio's copy uses.
      // Only read when the account was linked with "Read API keys" on.
      sySnapExt.credentials = [];
      if (keysIncluded) { try { sySnapExt.credentials = await c.pullProviderCredentials(idx); } catch (e) { logAct("Couldn't read API keys: " + e.message, 'err'); } }
      sySnap = { addons: slice.addons, plugins: slice.plugins, collections: slice.collections, settings };
      sySnapExt.watched = Array.isArray(backup.watched_items) ? backup.watched_items.filter(w => w.profile_id === idx) : [];
      sySnapExt.watchProgress = Array.isArray(backup.watch_progress) ? backup.watch_progress.filter(w => w.profile_id === idx) : [];
      resetSel(); renderSyItems(); renderSyTree(); await renderSyTargets(); updateSyCounts(); status($('sy-status'), '');
      renderReviewEmpty();
      const prof = (await loadAccount(id)).profiles.find(p => p.index === idx);
      sySrcLabel = prof ? (prof.name + ' · ' + accountName(id)) : '';
      if (userPicked) syOpenSec('targets', { scroll: true }); else { syncSteps(); syRemeasure(); }
    } catch (e) { sySnap = null; status($('sy-status'), "Couldn't read source: " + e.message, 'err'); }
  }
  function resetSel() {
    const s = sySnap || {};
    sySel.addons = new Set((s.addons || []).map(a => a.url));
    sySel.plugins = new Set((s.plugins || []).map(p => p.url));
    sySel.collections = new Set((s.collections || []).map(collKey));
    sySel.settings = defTokens(s.settings || {});
  }
  // ---- settings selection: one token per (platform, settings tab) ----
  // The tabs are exactly the ones on Nuvio's own settings pages — Appearance,
  // Experience, Layout, Playback, Integrations, Advanced for TV; Layout, Playback,
  // Streams, Content & Discovery, Integrations, Trakt, Notifications for mobile and
  // desktop — because nuvio-settings-schema.js is extracted from their account bundle.
  // Selecting a tab copies exactly the fields that tab shows, nothing else. The same
  // schema drives the profile editor, so both surfaces work off one definition.
  const tabsFor = (pl) => (SCHEMA && SCHEMA[pl]) || [];
  // The (feature,key) pairs a tab owns, limited to what the source blob actually holds.
  function tabFields(pl, tab) {
    const blob = (sySnap && sySnap.settings && sySnap.settings[pl]) || null;
    const feat = (blob && blob.features) || {};
    const out = [];
    (tab.groups || []).forEach(g => (g.fields || []).forEach(f => {
      const gv = feat[f.feature];
      if (gv === undefined) return;
      if (isPayload(f.feature)) {
        if (typeof gv !== 'string' || !gv.trim()) return;
        let o = {}; try { o = JSON.parse(gv); } catch { return; }
        if (!(f.key in o)) return;
      } else if (!gv || typeof gv !== 'object' || !(f.key in gv)) return;
      out.push(f);
    }));
    return out;
  }
  // A tab is offered when the source has at least one of its fields and at least one of
  // those is copyable under the current opt-ins.
  function tabStat(pl, tab) {
    const fields = tabFields(pl, tab);
    let copyable = 0, secrets = 0;
    fields.forEach(f => {
      if (SECRET_LEAF.test(f.key)) secrets++;
      const blocked = E && E.leafIsShareable
        ? !E.leafIsShareable(f.feature, f.key, { includeSecrets: sySettingsIncludeKeys, includePersonal: true })
        : (SECRET_LEAF.test(f.key) && !sySettingsIncludeKeys);
      if (!blocked) copyable++;
    });
    return { total: fields.length, copyable, secrets };
  }
  function defTokens(settings) {
    const t = new Set();
    for (const pl of PLATS) {
      if (!settings[pl] || !settings[pl].features) continue;
      tabsFor(pl).forEach(tab => {
        const fields = (tab.groups || []).flatMap(g => g.fields || []);
        const feat = settings[pl].features;
        const present = fields.some(f => feat[f.feature] !== undefined);
        if (present) t.add(pl + '::' + tab.key);   // all tabs on by default, like Nuvio's dialog
      });
    }
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
  // Developer's choice: addons + plugins + collections, plus only the Playback block
  // on every platform. Everything else — watch progress/history, other settings — off.
  function syDevChoice() {
    if (!sySnap) return;
    sySel.addons = new Set((sySnap.addons || []).map(a => a.url));
    sySel.plugins = new Set((sySnap.plugins || []).map(p => p.url));
    sySel.collections = new Set((sySnap.collections || []).map(collKey));
    sySel.settings = new Set();
    PLATS.forEach(pl => tabsFor(pl).forEach(tab => { if (tab.key === 'playback' && tabStat(pl, tab).copyable > 0) sySel.settings.add(pl + '::' + tab.key); }));
    $('sy-cat-addons').checked = true; $('sy-cat-plugins').checked = true; $('sy-cat-collections').checked = true;
    $('sy-cat-settings').checked = sySel.settings.size > 0;
    $('sy-cat-watchprogress').checked = false; $('sy-cat-watched').checked = false;
    renderSyItems(); renderSyTree(); updateSyCounts(); scheduleLivePreview();
  }

  // Sync Desk settings are split into TV / Mobile / Desktop / API keys sections so the
  // list stays short — pick a section, then tick the tabs inside it.
  let sySetSection = null;
  function renderSyTree() {
    const tree = $('sy-settings-tree'); clr(tree);
    const settings = (sySnap && sySnap.settings) || {};
    const plats = PLATS.filter(p => settings[p] && settings[p].features && Object.keys(settings[p].features).length);
    const sections = plats.concat(['keys']);
    if (!plats.length && !sySnapExt.credentials.length) { tree.appendChild(el('p', 'empty sm', 'No settings on source.')); return; }
    if (!sections.includes(sySetSection)) sySetSection = sections[0];

    // section bar
    const bar = el('div', 'sy-set-sections');
    sections.forEach(sec => {
      const isKeys = sec === 'keys';
      const b = el('button', 'sy-set-sec' + (sec === sySetSection ? ' on' : ''));
      b.type = 'button';
      b.appendChild(el('span', '', isKeys ? 'API keys' : (PLAT_LABEL[sec] || sec)));
      if (!isKeys) {
        const tabs = tabsFor(sec).filter(t => tabStat(sec, t).total > 0);
        const n = tabs.filter(t => sySel.settings.has(sec + '::' + t.key)).length;
        const c = el('span', 'sy-set-sec-n', n + '/' + tabs.length); b.appendChild(c);
      } else if (syCreds.copy) b.appendChild(el('span', 'sy-set-sec-n', 'on'));
      b.onclick = () => { sySetSection = sec; renderSyTree(); };
      bar.appendChild(b);
    });
    tree.appendChild(bar);

    if (sySetSection !== 'keys') {
      const pl = sySetSection;
      const tabs = tabsFor(pl).map(t => ({ tab: t, stat: tabStat(pl, t) })).filter(x => x.stat.total > 0);
      if (!tabs.length) { tree.appendChild(el('p', 'empty sm', 'Nothing synced for this app on the source profile.')); return; }
      const toks = tabs.filter(x => x.stat.copyable > 0).map(x => pl + '::' + x.tab.key);
      const selN = toks.filter(t => sySel.settings.has(t)).length;

      const head = el('label', 'pick set-plat-head');
      const hcb = el('input'); hcb.type = 'checkbox';
      hcb.checked = toks.length > 0 && selN === toks.length;
      hcb.indeterminate = selN > 0 && selN < toks.length;
      hcb.onchange = () => { toks.forEach(t => hcb.checked ? sySel.settings.add(t) : sySel.settings.delete(t)); renderSyTree(); updateSyCounts(); scheduleLivePreview(); };
      head.appendChild(hcb);
      const hb = el('div', 'pb');
      hb.appendChild(el('div', 'pn', 'All ' + (PLAT_LABEL[pl] || pl) + ' settings'));
      hb.appendChild(el('div', 'ps', selN + ' of ' + toks.length + ' tab' + (toks.length === 1 ? '' : 's') + ' selected'));
      head.appendChild(hb); tree.appendChild(head);

      tabs.forEach(({ tab, stat }) => {
        const tok = pl + '::' + tab.key;
        const row = el('label', 'pick set-block');
        if (!stat.copyable) {
          row.style.opacity = '.5';
          row.appendChild(el('span', 'cb-spacer', ''));
          const nb = el('div', 'pb');
          nb.appendChild(el('div', 'pn', tab.title));
          nb.appendChild(el('div', 'ps', 'only API keys here — use the API keys section'));
          row.appendChild(nb); tree.appendChild(row); return;
        }
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = sySel.settings.has(tok);
        cb.onchange = () => { cb.checked ? sySel.settings.add(tok) : sySel.settings.delete(tok); renderSyTree(); updateSyCounts(); scheduleLivePreview(); };
        row.appendChild(cb);
        const bb = el('div', 'pb');
        bb.appendChild(el('div', 'pn', tab.title));
        const bits = [stat.copyable + ' setting' + (stat.copyable === 1 ? '' : 's') + (stat.copyable < stat.total ? ' of ' + stat.total : '')];
        if (tab.subtitle) bits.push(tab.subtitle);
        bb.appendChild(el('div', 'ps', bits.join(' · ')));
        row.appendChild(bb); tree.appendChild(row);
      });
      return;
    }

    // ---- API keys / provider credentials, as its own section (Nuvio's model) ----
    const linked = accountKeysIncluded(syA);
    const found = (sySnapExt.credentials || []).length;
    const crow = el('label', 'pick set-block');
    const ccb = el('input'); ccb.type = 'checkbox'; ccb.checked = syCreds.copy && linked; ccb.disabled = !linked;
    ccb.onchange = () => {
      syCreds.copy = ccb.checked; if (!ccb.checked) syCreds.replace = false;
      sySettingsIncludeKeys = ccb.checked;
      syKeysAnsweredFor = syA + ':' + syI;   // remember this answer for this source
      renderSyTree(); updateSyCounts(); scheduleLivePreview();
    };
    crow.appendChild(ccb);
    const cb2 = el('div', 'pb');
    cb2.appendChild(el('div', 'pn', 'API keys and provider credentials'));
    cb2.appendChild(el('div', 'ps', !linked
      ? 'this account wasn\'t linked with "Read API keys" on'
      : 'Debrid, TMDB, MDBList, AnimeSkip and IntroDB keys' + (found ? ' — ' + found + ' on the source' : ' — none stored on the source') + '. Trakt and other OAuth connections are not included.'));
    crow.appendChild(cb2); tree.appendChild(crow);
    if (!linked) crow.style.opacity = '.5';

    const rrow = el('label', 'pick set-block set-sub');
    const rcb = el('input'); rcb.type = 'checkbox'; rcb.checked = syCreds.replace; rcb.disabled = !syCreds.copy || !linked;
    rcb.onchange = () => { syCreds.replace = rcb.checked; scheduleLivePreview(); };
    rrow.appendChild(rcb);
    const rb = el('div', 'pb');
    rb.appendChild(el('div', 'pn', 'Overwrite matching keys already in the target'));
    rb.appendChild(el('div', 'ps', 'Keys for providers that exist only on the destination are always kept.'));
    rrow.appendChild(rb);
    if (!syCreds.copy || !linked) rrow.style.opacity = '.45';
    tree.appendChild(rrow);
  }

  // Nuvio's own sync_copy_profile_setup is whole-platform and same-account only. Use it
  // when the selection maps exactly onto what it can express — that is the "known to
  // work" path, and the only one that reaches desktop settings and the credentials
  // table server-side. Anything finer, or any cross-account copy, falls back to the
  // block copy, which moves the chosen blocks verbatim.
  function nuvioCopyEligibility(targetAccountId) {
    if (targetAccountId !== syA) return { ok: false, why: 'different account' };
    const settingsOn = $('sy-cat-settings') && $('sy-cat-settings').checked;
    const flags = { copyTv: false, copyMobile: false, copyDesktop: false };
    if (settingsOn) {
      for (const pl of PLATS) {
        const usable = tabsFor(pl).filter(t => tabStat(pl, t).copyable > 0);
        if (!usable.length) continue;
        const selN = usable.filter(t => sySel.settings.has(pl + '::' + t.key)).length;
        if (selN === 0) continue;
        if (selN !== usable.length) return { ok: false, why: 'only part of the ' + (PLAT_LABEL[pl] || pl) + ' settings selected' };
        flags['copy' + pl.charAt(0).toUpperCase() + pl.slice(1)] = true;
      }
    }
    if (!flags.copyTv && !flags.copyMobile && !flags.copyDesktop && !syCreds.copy) return { ok: false, why: 'nothing it can carry' };
    return { ok: true, flags };
  }
  // ======================================================================
  // Sync Desk stepper
  //
  // Presentation of progress only — it opens and closes sections and writes
  // summary text. It never changes what a step contains or what Apply will do;
  // every control inside a collapsed section is still in the DOM and still
  // wired exactly as before.
  // ======================================================================
  let sySecOpen = 'source';
  function sySecs() { return [...document.querySelectorAll('.sy-sec[data-systep]')]; }
  function syMeasure(sec) {
    const w = sec.querySelector('.sy-sec-w'), b = sec.querySelector('.sy-sec-b');
    if (!w || !b) return;
    if (!sec.classList.contains('open')) { w.style.height = '0px'; return; }
    // 'auto' while idle so a chooser opening inside the section can still grow it
    w.style.height = b.offsetHeight + 'px';
    clearTimeout(w.__t);
    w.__t = setTimeout(() => { if (sec.classList.contains('open')) w.style.height = 'auto'; }, 320);
  }
  function syOpenSec(key, opts) {
    sySecOpen = key;
    sySecs().forEach(sec => {
      const on = sec.dataset.systep === key;
      const w = sec.querySelector('.sy-sec-w');
      if (w && w.style.height === 'auto') { w.style.height = sec.querySelector('.sy-sec-b').offsetHeight + 'px'; void w.offsetHeight; }
      sec.classList.toggle('open', on);
      syMeasure(sec);
    });
    syncSteps();
    if (opts && opts.scroll) {
      const sec = sySecs().find(x => x.dataset.systep === key);
      if (sec) sec.scrollIntoView({ block: 'nearest', behavior: ((M.reduced && M.reduced()) || document.hidden) ? 'auto' : 'smooth' });
    }
  }
  // Re-measure whenever something inside a section changes its height (a carry
  // chooser opening, targets finishing their load) so the accordion never clips.
  function syRemeasure() { sySecs().forEach(syMeasure); }
  function syCarrySummary() {
    const on = [];
    const label = { addons: 'Add-ons', plugins: 'Plugins', collections: 'Collections', watchprogress: 'Watch progress', watched: 'Watched', settings: 'Settings' };
    Object.keys(label).forEach(k => { const cb = $('sy-cat-' + k); if (cb && cb.checked) on.push(label[k]); });
    return on;
  }
  function syncSteps() {
    const srcName = (sySrcLabel || '').trim();
    const nTgt = syTargets.size;
    const carry = syCarrySummary();
    const state = {
      source: { done: !!srcName, sum: srcName || 'Pick the profile you want to copy from.' },
      targets: { done: nTgt > 0, sum: nTgt ? nTgt + ' profile' + (nTgt === 1 ? '' : 's') + ' selected' : 'Select one or more profiles to receive it.' },
      carry: { done: carry.length > 0, sum: carry.length ? (carry.length > 2 ? carry.slice(0, 2).join(', ') + ' +' + (carry.length - 2) : carry.join(', ')) : 'Nothing selected yet.' }
    };
    document.querySelectorAll('.sy-step[data-systep]').forEach(b => {
      const k = b.dataset.systep, st = state[k];
      b.classList.toggle('on', sySecOpen === k);
      b.classList.toggle('done', st.done && sySecOpen !== k);
      b.setAttribute('aria-selected', sySecOpen === k ? 'true' : 'false');
      const sum = b.querySelector('.sy-step-sum'); if (sum) sum.textContent = st.sum;
    });
    sySecs().forEach(sec => {
      const st = state[sec.dataset.systep]; if (!st) return;
      const sum = sec.querySelector('.sy-sec-sum'); if (sum) sum.textContent = st.done ? st.sum : '';
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
    syncSteps();
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
      const head = el('div', 'sy-ct-group-head');
      head.appendChild(el('div', 'sy-ct-group-lbl', (accountName(rec.accountId) || '').toUpperCase()));
      const acctBtn = el('button', 'sy-ct-group-selall'); acctBtn.type = 'button';
      head.appendChild(acctBtn); group.appendChild(head);
      const chips = el('div', 'sy-ct-chips');
      const acctTids = [];
      const syncAcctBtn = () => { acctBtn.textContent = acctTids.every(t => syTargets.has(t)) ? 'Deselect all' : 'Select all'; };
      tgt.forEach(p => {
        const tid = rec.accountId + ':' + p.index; allSyTids.push(tid); acctTids.push(tid);
        const c = el('button', 'sy-chip'); c.type = 'button'; c.dataset.tid = tid;
        c.appendChild(avatar(p, 22)); c.appendChild(el('span', 'pcn', p.name));
        const chk = el('span', 'chk'); chk.textContent = '✓'; c.appendChild(chk);
        c.onclick = () => {
          const on = syTargets.has(tid), first = syTargets.size === 0;
          on ? syTargets.delete(tid) : syTargets.add(tid);
          c.classList.toggle('on', !on); syncAcctBtn(); updateApplyBtnLabel(); scheduleLivePreview();
          if (first && !on) syOpenSec('carry', { scroll: true });
        };
        chips.appendChild(c);
      });
      acctBtn.onclick = () => {
        const allOn = acctTids.every(t => syTargets.has(t));
        acctTids.forEach(t => allOn ? syTargets.delete(t) : syTargets.add(t));
        chips.querySelectorAll('.sy-chip').forEach(c => c.classList.toggle('on', syTargets.has(c.dataset.tid)));
        syncAcctBtn(); updateApplyBtnLabel(); scheduleLivePreview();
      };
      syncAcctBtn();
      group.appendChild(chips); box.appendChild(group);
      any = true;
    }
    if (!any) box.appendChild(el('p', 'empty sm', 'No other profiles to sync into.'));
  }
  function syncAllAcctSelAllLabels() {
    document.querySelectorAll('#sy-targets .sy-ct-group').forEach(group => {
      const btn = group.querySelector('.sy-ct-group-selall'); const chips = [...group.querySelectorAll('.sy-chip')];
      if (btn && chips.length) btn.textContent = chips.every(c => c.classList.contains('on')) ? 'Deselect all' : 'Select all';
    });
  }
  function sySelectAll() {
    allSyTids.forEach(t => syTargets.add(t));
    document.querySelectorAll('#sy-targets .sy-chip').forEach(c => c.classList.add('on'));
    syncAllAcctSelAllLabels(); updateApplyBtnLabel(); scheduleLivePreview();
  }
  function syDeselectAll() {
    syTargets.clear();
    document.querySelectorAll('#sy-targets .sy-chip').forEach(c => c.classList.remove('on'));
    syncAllAcctSelAllLabels(); updateApplyBtnLabel(); renderReviewEmpty();
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
    syncSteps();
    const btn = $('sy-apply'); if (!btn) return;
    btn.textContent = 'Apply to ' + n + ' profile' + (n === 1 ? '' : 's');
  }
  // Two of these can be in flight at once — the debounced live preview and the
  // manual Preview button — and each awaits several network reads. Without a
  // generation guard a stale run could finish last and either paint outdated
  // numbers or blank the panel while leaving Apply enabled, which would let
  // someone apply a plan they never actually saw.
  let syPvGen = 0;
  function renderReviewEmpty() {
    syPvGen++;   // cancels any preview still in flight
    $('sy-review-empty').style.display = ''; $('sy-review-full').style.display = 'none';
    const sub = $('sy-review-sub'); if (sub) sub.textContent = '';
    status($('sy-pv-status'), '');
    $('sy-confirm-wrap').style.display = 'none'; $('sy-confirm').checked = false; $('sy-apply').disabled = true; syPlans = null;
  }
  async function livePreviewAllTargets() {
    const gen = ++syPvGen;
    const current = () => gen === syPvGen;
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
        if (cats.settings) { state.settings = {}; for (const pl of PLATS) { try { const row = await c.pullSettings(idx, pl); if (row && row.settings_json) { state.settings[pl] = row.settings_json; upd[pl] = row.updated_at || null; } } catch (e) { logAct('Settings read failed for ' + pl + ': ' + e.message, 'err'); } } }
        // Settings honour the same Merge/Overwrite choice as everything else: merge
        // overlays the chosen blocks, overwrite makes each chosen block match the
        // source exactly (and reports what that drops).
        const plan = E.planTarget(master, state, { categories: cats, modes: { addons: mode, plugins: mode, collections: mode }, settings: { includePersonal: true, includeSecrets: sySettingsIncludeKeys, blockMode: mode === 'mirror' ? 'replace' : 'merge' }, profileId: idx, originClientId: 'numax-web', settingsUpdatedAt: upd });
        if (plan.hasRemovals) rem = true;
        // watched / watchprogress: upsert-only, no removals possible
        const extras = {};
        if (cats.watchprogress && sySnapExt.watchProgress.length) extras.watchProgress = sySnapExt.watchProgress;
        if (cats.watched && sySnapExt.watched.length) extras.watched = sySnapExt.watched;
        plans.push({ aid, tid, plan, extras, nuvio: nuvioCopyEligibility(aid) });
      }
      if (!current()) return;   // a newer preview owns the panel now
      syPlans = plans; renderSyReports(plans); renderSyMetrics(plans);
      if (rem) $('sy-confirm-wrap').style.display = ''; else { $('sy-confirm-wrap').style.display = 'none'; $('sy-confirm').checked = false; }
      $('sy-apply').disabled = rem && !$('sy-confirm').checked;
      const sub = $('sy-review-sub'); if (sub) sub.textContent = plans.length + ' profile' + (plans.length === 1 ? '' : 's') + ' selected';
      renderSyReviewFoot(plans, rem);
      status($('sy-pv-status'), 'Live', 'ok');
    } catch (e) { if (current()) status($('sy-pv-status'), e.message, 'err'); }
  }
  function syMaster() {
    const s = sySnap;
    const out = {
      addons: (s.addons || []).filter(a => sySel.addons.has(a.url)),
      plugins: (s.plugins || []).filter(p => sySel.plugins.has(p.url)),
      collections: (s.collections || []).filter(c => sySel.collections.has(collKey(c))),
      settings: {},
    };
    // Selection is per settings tab. The master carries exactly the fields those tabs
    // show, copied straight out of the source blob — including fields that live inside
    // a mobile/desktop *_payload JSON string, which are rebuilt into a payload holding
    // only the selected keys (the engine then overlays those onto the target's payload).
    for (const pl of PLATS) {
      const blob = s.settings && s.settings[pl]; const feat = (blob && blob.features) || {};
      if (!blob) continue;
      const of = {}; const payloads = {};
      tabsFor(pl).forEach(tab => {
        if (!sySel.settings.has(pl + '::' + tab.key)) return;
        tabFields(pl, tab).forEach(f => {
          const gv = feat[f.feature];
          if (isPayload(f.feature)) {
            let o = {}; try { o = JSON.parse(gv); } catch { return; }
            if (!(f.key in o)) return;
            (payloads[f.feature] = payloads[f.feature] || {})[f.key] = o[f.key];
          } else {
            if (!gv || typeof gv !== 'object' || !(f.key in gv)) return;
            (of[f.feature] = of[f.feature] || {})[f.key] = gv[f.key];
          }
        });
      });
      Object.keys(payloads).forEach(g => { of[g] = JSON.stringify(payloads[g]); });
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
    plans.forEach(({ tid, plan, extras, nuvio }) => {
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
      // Which copy path this target will take — Nuvio's own server-side copy, or
      // Numax moving the chosen blocks verbatim. Cross-account always takes the latter.
      if ($('sy-cat-settings') && $('sy-cat-settings').checked) {
        const pathBadge = el('span', 'rbadge no');
        pathBadge.textContent = (nuvio && nuvio.ok) ? 'Nuvio copy' : 'block copy';
        pathBadge.title = (nuvio && nuvio.ok)
          ? "Uses Nuvio's own sync_copy_profile_setup — whole platforms, same account."
          : 'Numax copies the selected blocks verbatim' + (nuvio && nuvio.why ? ' (' + nuvio.why + ')' : '') + '.';
        head.appendChild(pathBadge);
      }
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
      if (r.settings) {
        let ch = 0; const gapDetail = [], skipDetail = [], remDetail = [];
        for (const pl of Object.keys(r.settings)) {
          ch += r.settings[pl].changed.length;
          settingsSkipLines(r.settings[pl], pl).forEach(s => skipDetail.push(s));
          (r.settings[pl].removed || []).forEach(g => remDetail.push(pl + ': ' + g));
          (r.settings[pl].wontApply || []).forEach(g => gapDetail.push(pl + ': ' + g));
        }
        if (ch || skipDetail.length || gapDetail.length || remDetail.length) {
          const x = el('div', 'rline');
          x.innerHTML = '<span class="rk">Settings</span>'
            + (ch ? '<span class="tag upd">' + ch + '</span>' : '')
            + (remDetail.length ? '<span class="tag rem" title="' + esc(remDetail.join('\n')) + '">−' + remDetail.length + '</span>' : '')
            + (skipDetail.length ? '<span class="tag held" title="' + esc(skipDetail.join('\n')) + '">' + skipDetail.length + ' skipped</span>' : '')
            + (gapDetail.length ? '<span class="tag warn" title="' + esc(gapDetail.join('\n')) + '">' + gapDetail.length + ' won\'t apply</span>' : '');
          rows.push(x);
        }
      }
      if (extras.watchProgress && extras.watchProgress.length) { const x = el('div', 'rline'); x.innerHTML = '<span class="rk">Progress</span><span class="tag add">+' + extras.watchProgress.length + '</span>'; rows.push(x); }
      if (extras.watched && extras.watched.length) { const x = el('div', 'rline'); x.innerHTML = '<span class="rk">Watched</span><span class="tag add">+' + extras.watched.length + '</span>'; rows.push(x); }
      // removals line — explicit
      const remRow = el('div', 'rline');
      let settingsRem = 0;
      if (r.settings) for (const pl of Object.keys(r.settings)) settingsRem += (r.settings[pl].removed || []).length;
      const totalRem = ((r.addons && (r.addons.removed || []).length) || 0) + ((r.plugins && (r.plugins.removed || []).length) || 0) + ((r.collections && (r.collections.removed || []).length) || 0) + settingsRem;
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

  // Copy API keys the way Nuvio's own copy does: additively by provider, with
  // "overwrite matching keys" as an explicit opt-in. Providers that exist only on the
  // destination are always kept, so this can never delete a key the target already had.
  async function applyCredentials(aid, profileId) {
    const src = sySnapExt.credentials || [];
    if (!syCreds.copy || !src.length) return { written: 0, kept: 0 };
    const c = A.client(store, aid);
    let existing = [];
    try { existing = await c.pullProviderCredentials(profileId); } catch (e) { logAct("Couldn't read target API keys: " + e.message, 'err'); }
    const have = new Set(existing.map(x => x.provider));
    const toWrite = src.filter(x => syCreds.replace || !have.has(x.provider));
    const kept = src.length - toWrite.length;
    if (toWrite.length) await c.pushProviderCredentials(profileId, toWrite, 'numax-web');
    return { written: toWrite.length, kept };
  }

  async function syncApply() {
    if (!syPlans) return;
    // Overwrite (and partial mirrors) can drop items a recipient currently has. The
    // review list already itemises them and the confirm checkbox is still the gate;
    // this states the consequence in words immediately before anything is written.
    const remPlans = syPlans.filter(x => x.plan.hasRemovals);
    if (remPlans.length) {
      const names = remPlans.map(x => tidName(x.tid).name);
      if (!(await uiModal({
        title: 'Apply changes and remove items?',
        message: 'Numax is about to write to ' + syPlans.length + ' profile' + (syPlans.length === 1 ? '' : 's') + '.',
        details: [
          'Writes to <b>your live Nuvio account</b>, not just to Numax — recipients pick the change up on their devices.',
          '<b>' + esc(names.join(', ')) + '</b> will lose items they currently have that the source does not.',
          'Every addition, update and removal is itemised in Review changes.',
          '<b>Not reversible from Numax</b> — restore from a Drive backup, or copy the items back, if you change your mind.'
        ],
        danger: true, okLabel: 'Apply changes'
      }))) return;
    }
    $('sy-apply').disabled = true; status($('sy-status'), 'Applying…'); let ok = 0, fail = 0;
    for (const { aid, plan, extras, nuvio } of syPlans) {
      const hasExtras = (extras.watched && extras.watched.length) || (extras.watchProgress && extras.watchProgress.length);
      const doCreds = syCreds.copy && (sySnapExt.credentials || []).length;
      if (!plan.hasChanges && !hasExtras && !nuvio && !doCreds) continue;
      try {
        // Nuvio's own server-side copy, when the selection is something it can express.
        if (nuvio && nuvio.ok) {
          try {
            const r = await A.client(store, aid).copyProfileSetup({
              sourceProfileId: syI, targetProfileId: plan.profileId,
              copyTv: nuvio.flags.copyTv, copyMobile: nuvio.flags.copyMobile, copyDesktop: nuvio.flags.copyDesktop,
              copyProviderCredentials: syCreds.copy, replaceProviderCredentials: syCreds.replace,
              originClientId: 'numax-web',
            });
            const done = PLATS.filter(p => r[p] === 'copied' || r[p] === 'copied_partial');
            done.length ? ok += done.length : ok++;
            logAct('Nuvio copy → profile ' + plan.profileId + ': ' + PLATS.map(p => p + '=' + r[p]).join(' ') + ', keys=' + r.credentials + ' (' + r.credentialsWritten + ' written, ' + r.credentialsPreserved + ' kept)', 'ok');
          } catch (e) { fail++; logAct('Nuvio copy failed: ' + e.message, 'err'); }
        } else if (doCreds) {
          // block path: settings go through the plan, keys are pushed separately
          try { const cr = await applyCredentials(aid, plan.profileId); if (cr.written) { ok++; logAct('Copied ' + cr.written + ' API key(s), kept ' + cr.kept, 'ok'); } }
          catch (e) { fail++; logAct('API key copy failed: ' + e.message, 'err'); }
        }
        // Add-ons / plugins / collections are never part of Nuvio's copy, so the plan
        // still runs — minus the settings pushes when the server-side copy did those.
        const usedNuvio = !!(nuvio && nuvio.ok);
        const ops = usedNuvio ? plan.operations.filter(o => !/^settings:/.test(o.surface)) : plan.operations;
        if (ops.length) {
          const r = await A.client(store, aid).applyPlan({ ...plan, operations: ops }, { dryRun: false });
          (r.results || []).forEach(x => { x.ok ? ok++ : fail++; if (!x.ok) logAct('Sync ' + x.surface + ' failed: ' + x.error, 'err'); });
        }
        if (hasExtras) {
          const c = A.client(store, aid);
          if (extras.watchProgress && extras.watchProgress.length) { try { await c.rpc('sync_push_watch_progress', { p_entries: extras.watchProgress.map(stripWatchRow), p_profile_id: plan.profileId, p_origin_client_id: 'numax-web' }); ok++; } catch (e) { fail++; logAct('Sync watch progress failed: ' + e.message, 'err'); } }
          if (extras.watched && extras.watched.length) { try { await c.rpc('sync_push_watched_items', { p_items: extras.watched.map(stripWatchRow), p_profile_id: plan.profileId, p_origin_client_id: 'numax-web' }); ok++; } catch (e) { fail++; logAct('Sync watched failed: ' + e.message, 'err'); } }
        }
      } catch (e) { fail++; logAct('Apply failed: ' + e.message, 'err'); }
    }
    invalAll();
    status($('sy-status'), 'Done — ' + ok + ' change' + (ok === 1 ? '' : 's') + (fail ? ', ' + fail + ' failed.' : '.'), fail ? 'err' : 'ok');
    logAct('Applied sync: ' + ok + ' ok' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'err' : 'ok');
    if (ok && !fail) celebrate(document.querySelector('.sy-review-card'));
    syPlans = null; selectSource(syA, syI);
  }

  // ======================================================================
  // DRIVE (backup / restore)
  // ======================================================================
  async function refreshDrive() {
    status($('dr-status'), gAuth.token ? (gAuth.user && gAuth.user.email ? 'Connected as ' + gAuth.user.email : 'Connected.') : 'Not connected.', gAuth.token ? 'ok' : 'err');
    const box = $('dr-backup-picker'); clr(box); const list = store.list();
    // refreshRestore() must run on EVERY path: it owns the restore list, whose
    // placeholder is static markup in index.html. The old early return here
    // left that placeholder shimmering "Loading backups…" forever.
    if (!list.length) { box.appendChild(el('p', 'empty sm', 'Link an account to choose what to back up.')); refreshRestore(); return; }
    const allBtn = el('button', 'selall-pill', 'Select all');
    allBtn.onclick = () => { const chips = box.querySelectorAll('.pchip.multi'); const allOn = [...chips].every(c => c.classList.contains('on')); chips.forEach(c => c.classList.toggle('on', !allOn)); allBtn.textContent = allOn ? 'Select all' : 'Deselect all'; };
    box.appendChild(allBtn);
    for (const rec of list) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; }
      const acctRow = el('div', 'tgt-acct-row'); acctRow.appendChild(el('div', 'tgt-acct', accountName(rec.accountId)));
      const acctSelAll = el('button', 'selall-pill sm', 'Select all');
      acctRow.appendChild(acctSelAll); box.appendChild(acctRow);
      const grid = el('div', 'tgt-grid'); profiles.forEach(p => { const tid = rec.accountId + ':' + p.index; const c = el('button', 'pchip multi'); c.type = 'button'; c.dataset.tid = tid; c.appendChild(avatar(p, 38)); c.appendChild(el('span', 'pcn', p.name)); c.appendChild(el('span', 'chk', '✓')); c.onclick = () => c.classList.toggle('on'); grid.appendChild(c); }); box.appendChild(grid);
      acctSelAll.onclick = () => { const chips = grid.querySelectorAll('.pchip.multi'); const allOn = [...chips].every(c => c.classList.contains('on')); chips.forEach(c => c.classList.toggle('on', !allOn)); acctSelAll.textContent = allOn ? 'Select all' : 'Deselect all'; };
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
      status(log, (existing ? 'Updated ' : 'Saved ') + r.name + ' (' + out.profiles.length + ' profile' + (out.profiles.length === 1 ? '' : 's') + ').', 'ok'); logAct((existing ? 'Updated' : 'Saved') + ' backup "' + r.name + '"', 'ok'); celebrate($('dr-backup-btn').closest('.card')); refreshRestore();
    } catch (e) { status(log, 'Backup failed: ' + e.message, 'err'); } finally { $('dr-backup-btn').disabled = false; }
  }
  let restoreDoc = null;
  async function refreshRestore() {
    const box = $('dr-restore-list'); clr(box); if (!gAuth.token) { box.appendChild(el('p', 'empty sm', 'Connect Google Drive.')); return; }
    box.appendChild(el('p', 'muted sm shimmer', 'Loading…')); let files; try { files = await driveFindByProp('numax', 'backup'); } catch (e) { clr(box); box.appendChild(el('p', 'empty err-text', e.message)); return; }
    clr(box); if (!files.length) { box.appendChild(el('p', 'empty sm', 'No backups yet.')); return; }
    files.forEach(f => { const row = el('div', 'erow'); const b = el('div', 'eb'); b.appendChild(el('div', 'en', f.name)); b.appendChild(el('div', 'es', f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '')); row.appendChild(b); const op = el('button', 'btn btn-solid btn-xs', 'Open'); op.onclick = () => loadRestore(f); row.appendChild(op); box.appendChild(row); });
  }
  async function loadRestore(file) {
    const cfg = $('dr-restore-config'); cfg.style.display = ''; clr(cfg); cfg.appendChild(el('p', 'muted sm shimmer', 'Reading ' + file.name + '…'));
    try { restoreDoc = await driveDownload(file.id); restoreDoc._file = file; } catch (e) { clr(cfg); cfg.appendChild(el('p', 'empty err-text', e.message)); return; }
    if (!Array.isArray(restoreDoc.profiles) || !restoreDoc.profiles.length) { clr(cfg); cfg.appendChild(el('p', 'empty sm', 'No profiles in that backup.')); return; }
    clr(cfg); cfg.appendChild(el('div', 'set-group-h', 'Restore from ' + file.name));
    const sw = el('label', 'fld'); sw.style.cssText = 'max-width:440px;margin-top:10px'; sw.appendChild(el('span', '', 'Which saved profile')); const src = el('select', 'sel'); restoreDoc.profiles.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = p.name + ' · ' + (p.account || 'backup'); src.appendChild(o); }); sw.appendChild(src); cfg.appendChild(sw);
    const tw = el('label', 'fld'); tw.style.cssText = 'max-width:440px;margin-top:10px'; tw.appendChild(el('span', '', 'Restore into')); const tsel = el('select', 'sel'); tw.appendChild(tsel); cfg.appendChild(tw);
    for (const rec of store.list()) { let profiles; try { profiles = (await loadAccount(rec.accountId)).profiles; } catch { continue; } profiles.forEach(p => { const o = document.createElement('option'); o.value = rec.accountId + ':' + p.index; o.textContent = p.name + ' · ' + accountName(rec.accountId); tsel.appendChild(o); }); }
    const mw = el('label', 'fld'); mw.style.cssText = 'max-width:440px;margin-top:10px'; mw.appendChild(el('span', '', 'How to apply')); const msel = el('select', 'sel'); msel.innerHTML = '<option value="merge" data-label="Merge" data-hint="add and update, keep the rest">Merge</option><option value="overwrite" data-label="Overwrite" data-hint="make this profile match the backup exactly">Overwrite</option>'; mw.appendChild(msel); cfg.appendChild(mw);
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
  // MARKETPLACE
  // Add-ons are configured on their own sites; Numax only writes back the
  // manifest URL you return with. Plugins install whole — Nuvio stores one
  // plugin row per PROVIDER REPO ({url,name,enabled}), not one per scraper
  // (verified against Nuvio's own Add Plugin dialog), so a repo's scrapers
  // are shown as contents, never as a picker we couldn't honour.
  //
  // Every write below goes through engine.planTarget + api.applyPlan, the
  // same read-modify-write path Sync Desk, templates and restore use.
  // ======================================================================
  const MK = window.NumaxMarket;
  let mkTab = 'addons';
  let mkProviders = null;      // cached index rows
  const mkManifest = {};       // manifestUrl -> {ok,value} | {ok:false,error}

  function refreshMarket() {
    if (!MK) {
      const box = $('mk-addon-groups'); if (box) { clr(box); box.appendChild(el('p', 'empty sm err-text', 'market.js did not load — the Marketplace data layer is missing.')); }
      return;
    }
    switchMkTab(mkTab);
  }
  function switchMkTab(kind) {
    mkTab = kind;
    document.querySelectorAll('.mk-tab').forEach(b => b.classList.toggle('on', b.dataset.mktab === kind));
    document.querySelectorAll('.mk-pane').forEach(p => p.style.display = (p.id === 'mk-pane-' + kind) ? '' : 'none');
    if (kind === 'addons') renderMkAddons();
    if (kind === 'plugins') renderMkPlugins();
    if (kind === 'collections') renderMkCollections();
  }

  // ---- popover (own mechanism; deliberately not ui-motion's carry-chooser) ----
  let mkPop = null;
  function mkPopKey(e) { if (e.key === 'Escape') closeMkPop(); }
  function mkPopReplace() { if (mkPop) mkPop.place(); }
  function closeMkPop() {
    if (!mkPop) return;
    mkPop.bg.remove(); mkPop.box.remove(); mkPop = null;
    document.removeEventListener('keydown', mkPopKey);
    window.removeEventListener('resize', mkPopReplace);
    window.removeEventListener('scroll', mkPopReplace, true);
  }
  function openMkPop(anchor, title, sub) {
    closeMkPop();
    const bg = el('div', 'mk-pop-bg'), box = el('div', 'mk-pop');
    const h = el('div', 'mk-pop-h'); h.appendChild(el('b', '', title)); if (sub) h.appendChild(el('span', '', sub));
    const body = el('div', 'mk-pop-b'), foot = el('div', 'mk-pop-f');
    box.appendChild(h); box.appendChild(body); box.appendChild(foot);
    document.body.appendChild(bg); document.body.appendChild(box);
    bg.onclick = closeMkPop;
    document.addEventListener('keydown', mkPopKey);
    // Resizing used to close the popover outright, throwing away whatever the
    // user had part-filled. Re-place it instead; only Escape or a click on the
    // backdrop closes it.
    window.addEventListener('resize', mkPopReplace);
    window.addEventListener('scroll', mkPopReplace, true);
    // The box is measured, not guessed — and re-measured by place() once async
    // content has filled it, or a list loaded later would hang off-screen.
    const place = () => {
      const r = anchor.getBoundingClientRect(), w = box.offsetWidth, ht = box.offsetHeight;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
      let top = r.bottom + 8;
      if (top + ht > window.innerHeight - 8) top = (r.top - ht - 8 >= 8) ? r.top - ht - 8 : window.innerHeight - ht - 8;
      // Final clamp: the flip-above branch above is only correct while the
      // anchor is on screen. Clamping unconditionally means the popover can
      // never be drawn outside the viewport whatever the anchor is doing.
      top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - ht - 8));
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    };
    place();
    mkPop = { bg, box, body, foot, place };
    return mkPop;
  }
  const openTab = url => window.open(url, '_blank', 'noopener,noreferrer');

  // One wiring for all three marketplace search boxes: debounced so a long list
  // is not rebuilt on every keystroke, Escape clears, and the clear button and
  // the input stay in step.
  function mkFindWire(inputId, clearId, render) {
    const inp = $(inputId), x = $(clearId);
    if (!inp) return;
    let t = null;
    const run = () => { clearTimeout(t); t = setTimeout(render, 110); };
    inp.addEventListener('input', run);
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; render(); } });
    if (x) x.onclick = () => { inp.value = ''; inp.focus(); render(); };
  }

  // ---- add-ons ----
  function renderMkAddons() {
    const sbox = $('mk-staples'); clr(sbox);
    MK.STAPLES.forEach(s => {
      const c = el('div', 'mk-staple');
      const top = el('div', 'mk-st-top');
      const ic = el('div', 'mk-ic' + (s.instances ? ' accent' : '')); ic.textContent = s.name[0];
      const tx = el('div'); tx.style.minWidth = '0';
      tx.appendChild(el('div', 'mk-nm', s.name));
      tx.appendChild(el('div', 'mk-sub', s.blurb));
      top.appendChild(ic); top.appendChild(tx); c.appendChild(top);
      const acts = el('div', 'mk-acts');
      if (s.instances) {
        const b = el('button', 'btn btn-primary btn-xs', 'Choose instance'); b.style.flex = '1';
        b.onclick = () => openInstancePicker(b, s.instances, s.name);
        acts.appendChild(b);
      } else {
        const b = el('button', 'btn btn-primary btn-xs', 'Open site'); b.style.flex = '1';
        b.onclick = () => { openTab(s.url); logAct('Opened ' + s.name, 'info'); };
        acts.appendChild(b);
      }
      const add = el('button', 'btn btn-ghost btn-xs', 'Add'); add.title = 'Paste this add-on’s manifest URL into profiles';
      add.onclick = () => openAddToProfile(add, s.name);
      acts.appendChild(add);
      c.appendChild(acts); sbox.appendChild(c);
    });

    renderMkAddonGroups();
  }

  // Every group used to be expanded at once: close to thirty rows and sixty
  // buttons on one screen. They are disclosures now, and the search box cuts
  // across all of them — typing opens exactly the groups that still match, so
  // nothing can hide behind a closed header.
  const mkAddonOpen = new Set();
  function mkDisc(sec, w, inner, open) {
    sec.classList.toggle('open', open);
    w.style.height = open ? inner.offsetHeight + 'px' : '0px';
    clearTimeout(w.__t);
    if (open) w.__t = setTimeout(() => { if (sec.classList.contains('open')) w.style.height = 'auto'; }, 320);
  }
  function renderMkAddonGroups() {
    const gbox = $('mk-addon-groups'); if (!gbox) return;
    clr(gbox);
    const inp = $('mk-addon-search');
    const q = ((inp && inp.value) || '').trim().toLowerCase();
    const find = inp && inp.closest('.mk-find');
    if (find) find.classList.toggle('has-q', !!q);
    const hit = it => !q || it.name.toLowerCase().includes(q) || String(it.url).toLowerCase().includes(q);
    let shown = 0, total = 0;
    MK.ADDON_GROUPS.forEach((g, gi) => {
      total += g.items.length;
      const items = g.items.filter(hit);
      if (!items.length) return;
      shown += items.length;
      const open = q ? true : (mkAddonOpen.size ? mkAddonOpen.has(g.title) : gi === 0);
      const sec = el('div', 'mk-sec');
      const h = el('button', 'mk-sec-h'); h.type = 'button';
      h.setAttribute('aria-expanded', open ? 'true' : 'false');
      h.appendChild(el('span', 'mk-sec-t ' + (g.tone || 'plain'), g.title));
      if (g.note) h.appendChild(el('span', 'mk-sec-n', g.note));
      h.appendChild(el('span', 'spacer'));
      h.appendChild(el('span', 'mk-sec-cnt', String(items.length)));
      const car = el('span', 'mk-sec-car');
      car.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
      h.appendChild(car);
      sec.appendChild(h);
      const w = el('div', 'mk-sec-w'), inner = el('div', 'mk-sec-b');
      const rows = el('div', 'mk-rows');
      items.forEach(it => {
        const r = el('div', 'mk-row');
        const ic = el('div', 'mk-ic'); ic.style.cssText = 'width:26px;height:26px;font-size:11px'; ic.textContent = it.name[0];
        const b = el('div', 'mk-rb');
        b.appendChild(el('div', 'mk-rn', it.name));
        b.appendChild(el('div', 'mk-ru', host(it.url)));
        const site = el('button', 'btn btn-ghost btn-xs', 'Open');
        site.onclick = () => { openTab(it.url); logAct('Opened ' + it.name, 'info'); };
        const add = el('button', 'btn btn-ghost btn-xs', 'Add');
        add.onclick = () => openAddToProfile(add, it.name);
        r.appendChild(ic); r.appendChild(b); r.appendChild(site); r.appendChild(add);
        rows.appendChild(r);
      });
      inner.appendChild(rows); w.appendChild(inner); sec.appendChild(w);
      h.onclick = () => {
        const next = !sec.classList.contains('open');
        // first interaction: seed the open-set from what is on screen, so
        // opening a second group does not silently close the default one
        if (!mkAddonOpen.size && !q) MK.ADDON_GROUPS.forEach((x, i) => { if (i === 0) mkAddonOpen.add(x.title); });
        next ? mkAddonOpen.add(g.title) : mkAddonOpen.delete(g.title);
        h.setAttribute('aria-expanded', next ? 'true' : 'false');
        mkDisc(sec, w, inner, next);
      };
      gbox.appendChild(sec);
      // opening state is applied once the node is in the document, so
      // offsetHeight is real; no animation is wanted on a fresh render
      if (open) { sec.classList.add('open'); w.style.height = 'auto'; }
    });
    if (!shown) gbox.appendChild(el('p', 'mk-find-none', 'No add-on matches \u201c' + q + '\u201d.'));
    const cnt = $('mk-addon-count');
    if (cnt) cnt.textContent = q ? shown + ' of ' + total : total + ' add-ons';
  }

  async function openInstancePicker(anchor, group, label) {
    const pop = openMkPop(anchor, label + ' · choose an instance', 'Opens that instance’s own site. Nothing is saved yet.');
    pop.body.appendChild(el('p', 'muted sm shimmer', 'Reading instance list…'));
    let list;
    try { list = await MK.loadInstances(group); }
    catch (e) { clr(pop.body); pop.body.appendChild(el('p', 'empty sm err-text', 'Could not read the instance list: ' + e.message)); return; }
    if (!mkPop) return; // closed while loading
    clr(pop.body);
    if (!list.length) { pop.body.appendChild(el('p', 'empty sm', 'No instances listed.')); return; }
    list.forEach(i => {
      const row = el('div', 'mk-inst');
      const b = el('div', 'mk-ib');
      b.appendChild(el('div', 'mk-in', i.name));
      b.appendChild(el('div', 'mk-iu', host(i.url)));
      row.appendChild(b);
      if (i.uptime != null) {
        const cls = i.uptime >= 99 ? '' : (i.uptime >= 95 ? ' mid' : ' low');
        row.appendChild(el('span', 'mk-up' + cls, i.uptime + '%'));
      }
      const go = el('button', 'btn btn-ghost btn-xs', 'Open');
      go.onclick = () => { openTab(i.url); logAct('Opened ' + label + ' — ' + i.name, 'info'); closeMkPop(); };
      row.appendChild(go);
      pop.body.appendChild(row);
    });
    const f = el('div');
    f.style.cssText = 'font-size:11px;color:var(--t35);font-family:ui-monospace,monospace';
    f.textContent = list.length + ' instances · uptime via ibbylabs';
    pop.foot.appendChild(f);
    pop.place();
  }

  // Every linked account's profiles, flattened, for the target pickers.
  // An account that fails to read is REPORTED, never skipped in silence: the
  // old version swallowed the error and an unreadable account was then
  // indistinguishable from "you have no accounts linked".
  async function mkAllProfiles() {
    const targets = [], failed = [];
    for (const rec of store.list()) {
      try {
        const { profiles } = await loadAccount(rec.accountId);
        profiles.forEach(p => targets.push({ aid: rec.accountId, idx: p.index, name: p.name, account: accountName(rec.accountId) }));
      } catch (e) { failed.push(accountName(rec.accountId) + ' — ' + e.message); }
    }
    return { targets, failed };
  }
  // Shared "pick some profiles" body: renders the list, any per-account read
  // failure, and the empty state, and returns the usable targets.
  async function mkFillTargets(box, chosen, onChange, stale) {
    const got = await loadInto(box, 'Reading profiles…', mkAllProfiles, { stale });
    if (!got) return null;
    const { targets, failed } = got.value;
    // mkTargetList clears the box, so it has to run before the failure lines.
    if (targets.length) mkTargetList(box, targets, chosen);
    failed.forEach(f => box.appendChild(el('p', 'empty sm err-text', f)));
    if (!targets.length) {
      box.appendChild(el('p', 'empty sm', failed.length
        ? 'No profiles could be read from the accounts above.'
        : 'No linked accounts yet — link one on the Nuvio accounts tab.'));
      return null;
    }
    if (onChange) box.addEventListener('mkchange', onChange);
    return targets;
  }
  function mkTargetList(box, targets, chosen) {
    clr(box);
    targets.forEach(t => {
      const key = t.aid + ':' + t.idx;
      const row = el('label', 'mk-tgt');
      const cb = el('button', 'mk-cb' + (chosen.has(key) ? ' on' : ''));
      cb.type = 'button';
      cb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
      cb.onclick = e => { e.preventDefault(); if (chosen.has(key)) chosen.delete(key); else chosen.add(key); cb.classList.toggle('on', chosen.has(key)); box.dispatchEvent(new CustomEvent('mkchange')); };
      const tx = el('div'); tx.style.minWidth = '0';
      tx.appendChild(el('div', 'mk-tn', t.name));
      tx.appendChild(el('div', 'mk-tm', t.account + ' · profile ' + t.idx));
      row.appendChild(cb); row.appendChild(tx);
      box.appendChild(row);
    });
  }

  async function openAddToProfile(anchor, name) {
    const pop = openMkPop(anchor, 'Add ' + name, 'Paste the manifest URL its site gave you.');
    const mine = pop;
    const stale = () => mkPop !== mine;
    const inp = el('input'); inp.type = 'url'; inp.placeholder = 'https://…/manifest.json';
    inp.style.cssText = 'width:100%;margin-bottom:10px';
    pop.body.appendChild(inp);
    const nm = el('input'); nm.type = 'text'; nm.placeholder = 'Name in Nuvio'; nm.value = name;
    nm.style.cssText = 'width:100%;margin-bottom:12px';
    pop.body.appendChild(nm);

    pop.body.appendChild(el('div', 'mk-sec-t', 'Add to'));
    const tbox = el('div', 'mk-tgts'); pop.body.appendChild(tbox);

    const modeW = el('label', 'fld mk-mode');
    modeW.appendChild(el('span', '', 'How to write it'));
    const msel = mkSelect([
      { value: 'merge', label: 'Merge', hint: 'add it, keep everything else' },
      { value: 'mirror', label: 'Overwrite', hint: 'replace all add-ons with just this' },
    ]);
    modeW.appendChild(msel.node); pop.body.appendChild(modeW);

    const st = el('div', 'inline-status'); st.style.marginTop = '10px'; pop.body.appendChild(st);
    const res = el('div', 'mk-res'); pop.body.appendChild(res);

    const go = el('button', 'btn btn-primary', 'Add'); go.style.width = '100%';
    pop.foot.appendChild(go);

    let targets = [];
    const chosen = new Set();
    const ready = () => chosen.size > 0 && !!inp.value.trim();
    const run = () => {
      const url = inp.value.trim();
      if (!/^https?:\/\//i.test(url)) { status(st, 'That doesn’t look like a URL.', 'err'); return; }
      mkWrite({
        kind: 'addons', master: [{ url, name: nm.value.trim() || name, enabled: true }],
        targets: targets.filter(t => chosen.has(t.aid + ':' + t.idx)),
        mode: msel.value(), st, res, btn: go, label: name,
      });
    };
    const reset = mkBindApply(go, res, st, 'Add', run, ready);
    msel.onChange(reset);
    inp.addEventListener('input', reset);

    const got = await mkFillTargets(tbox, chosen, reset, stale);
    if (stale()) return;
    if (!got) { go.disabled = true; pop.place(); return; }
    targets = got;
    reset();
    pop.place();
  }

  // Shared writer for add-ons and plugins. Reads each target fresh, plans with
  // the engine, shows exactly what changes, requires a tick before any removal,
  // then applies per target, verifies each write by reading it back, and
  // reports every failure individually.
  //
  // The button is a two-state machine — "plan" then "confirm" — and ANY change
  // to the selection or the merge/overwrite mode drops it back to "plan".
  // Previously the mode dropdown never re-planned, so the panel kept showing a
  // stale result and could apply a plan built for a different selection; and a
  // "nothing to do" outcome disabled the button permanently, which is why
  // switching Merge to Overwrite left no way to apply at all.
  async function mkWrite(o) {
    const { kind, master, targets, mode, st, res, btn, label, aid } = o;
    btn.disabled = true; clr(res); status(st, 'Reading target profiles…');
    const plans = [];
    try {
      for (const t of targets) {
        const { backup } = await loadAccount(t.aid, true);
        const state = sliceProfile(backup, t.idx);
        // Append after whatever is already there rather than jumping to the top —
        // but if this URL is already on the profile keep its existing position,
        // so re-adding something reads as "no change" instead of reordering it.
        const existing = new Map((state[kind] || []).map(x => [x.url, x]));
        const base = (state[kind] || []).reduce((m, x) => Math.max(m, Number(x.sort_order) || 0), 0);
        const rows = master.map((m, i) => {
          const had = existing.get(m.url);
          return { ...m, sort_order: had ? (had.sort_order ?? 0) : base + 1 + i };
        });
        const plan = E.planTarget({ [kind]: rows }, state, {
          categories: { [kind]: true }, modes: { [kind]: mode },
          profileId: t.idx, originClientId: 'numax-web',
        });
        plans.push({ t, plan });
      }
    } catch (e) { status(st, 'Failed: ' + e.message, 'err'); btn.disabled = false; return; }

    const anyChange = plans.some(p => p.plan.hasChanges);
    const anyRemoval = plans.some(p => p.plan.hasRemovals);
    const rep = el('div', 'report');
    plans.forEach(({ t, plan }) => {
      const r = (plan.report && plan.report[kind]) || {};
      const bits = [tagHtml('add', '+', r.added), tagHtml('upd', '~', r.updated), tagHtml('rem', '−', r.removed)].filter(Boolean);
      const line = el('div', 'rline');
      line.innerHTML = '<span class="rk">' + esc(t.name) + '</span>' + (bits.length ? bits.join(' ') : '<span class="tag keep">no change</span>');
      rep.appendChild(line);
    });
    res.appendChild(rep);
    status(st, '');

    // "Nothing to do" is an outcome, not a dead end: the button stays live so
    // switching Merge -> Overwrite (or picking another profile) re-plans.
    if (!anyChange) { status(st, 'Already there — nothing to do.', 'ok'); btn.disabled = true; return; }

    let confirmed = !anyRemoval;
    if (anyRemoval) {
      const w = el('label', 'confirm'); const cb = el('input'); cb.type = 'checkbox';
      cb.onchange = () => { confirmed = cb.checked; btn.disabled = !confirmed; };
      w.appendChild(cb);
      w.appendChild(el('span', '', 'This removes ' + kind + ' those profiles already have. I understand.'));
      res.appendChild(w);
    }
    btn.disabled = !confirmed;
    btn.textContent = 'Confirm';
    btn.onclick = async () => {
      btn.disabled = true; status(st, 'Writing…');
      let ok = 0; const fails = [];
      for (const { t, plan } of plans) {
        if (!plan.hasChanges) continue;
        try {
          const rr = await A.client(store, t.aid).applyPlan(plan, { dryRun: false });
          const bad = (rr.results || []).filter(x => !x.ok);
          if (bad.length) { fails.push(t.name + ': ' + bad.map(b => b.error).join('; ')); continue; }
          ok++;
        } catch (e) { fails.push(t.name + ': ' + e.message); }
      }
      invalAll();
      // Read back and prove it landed. The push RPCs answer 204 with no body,
      // so "the server didn't error" is NOT evidence the data is there — which
      // is exactly how a write could report success while nothing changed.
      if (ok) {
        status(st, 'Checking it saved…');
        const missing = await verifyWrote(plans.filter(x => x.plan.hasChanges), kind, master);
        missing.forEach(m => fails.push(m));
      }
      if (fails.length) {
        status(st, fails.length + ' problem' + (fails.length === 1 ? '' : 's') + ' — see below.', 'err');
        const ul = el('ul', 'modal-details'); fails.forEach(f => ul.appendChild(el('li', '', f))); res.appendChild(ul);
        logAct('Marketplace: ' + label + ' — ' + fails.length + ' error(s)', 'err');
      } else {
        status(st, 'Added to ' + ok + ' profile' + (ok === 1 ? '' : 's') + ' — checked and saved.', 'ok');
        logAct('Marketplace: added ' + label + ' to ' + ok + ' profile(s)', 'ok');
        celebrate(mkPop && mkPop.box);
      }
      if (pfA && pfI != null) openProfile(pfA, pfI, true);
    };
  }

  // Re-reads each written profile and confirms every item is actually present.
  // Returns a list of human-readable problems (empty when everything landed).
  async function verifyWrote(written, kind, master) {
    const problems = [];
    const wanted = master.map(m => m.url);
    const byAccount = new Map();
    written.forEach(({ t }) => { if (!byAccount.has(t.aid)) byAccount.set(t.aid, []); byAccount.get(t.aid).push(t); });
    for (const [acct, list] of byAccount) {
      let backup;
      try { ({ backup } = await loadAccount(acct, true)); }
      catch (e) { problems.push('Could not confirm the save: ' + e.message); continue; }
      list.forEach(t => {
        const have = new Set((sliceProfile(backup, t.idx)[kind] || []).map(x => x.url));
        const gone = wanted.filter(u => !have.has(u));
        if (gone.length) problems.push(t.name + ': Nuvio accepted the write but ' + gone.length + ' item(s) are not there afterwards.');
      });
    }
    return problems;
  }

  // ---- plugins ----
  async function renderMkPlugins(force) {
    const box = $('mk-prov-list'), stn = $('mk-prov-status');
    if (!mkProviders || force) {
      clr(box); status(stn, 'Reading the community index…'); $('mk-prov-count').textContent = '';
      try { mkProviders = await MK.loadPluginIndex(force); }
      catch (e) {
        status(stn, '');
        clr(box); box.appendChild(el('p', 'empty sm err-text', 'Could not read the plugin index: ' + e.message));
        return;
      }
    }
    status(stn, '');
    $('mk-prov-count').textContent = mkProviders.length + ' repos';
    clr(box);
    const inp = $('mk-prov-search');
    const q = ((inp && inp.value) || '').trim().toLowerCase();
    const find = inp && inp.closest('.mk-find');
    if (find) find.classList.toggle('has-q', !!q);
    const list = q
      ? mkProviders.filter(p => (p.name + ' ' + p.lang + ' ' + p.manifestUrl).toLowerCase().includes(q))
      : mkProviders;
    if (q) $('mk-prov-count').textContent = list.length + ' of ' + mkProviders.length + ' repos';
    if (!list.length) { box.appendChild(el('p', 'mk-find-none', 'No repo matches \u201c' + q + '\u201d.')); return; }
    const grid = el('div', 'mk-prov-grid'); box.appendChild(grid);
    list.forEach(p => {
      const row = el('div', 'mk-prov'); row.dataset.url = p.manifestUrl;
      const ic = el('div', 'mk-ic'); ic.textContent = p.name[0];
      const b = el('div', 'mk-pb');
      b.appendChild(el('div', 'mk-pn', p.name));
      const meta = el('div', 'mk-pm', 'checking…'); b.appendChild(meta);
      const lang = el('span', 'mk-lang', p.lang.replace(/ language$/i, ''));
      const open = el('button', 'btn btn-ghost btn-xs', 'View');
      open.onclick = () => openProvider(p);
      row.appendChild(ic); row.appendChild(b); row.appendChild(lang); row.appendChild(open);
      grid.appendChild(row);
      // Reachability is a fact worth showing: the community index currently
      // lists several dead manifests as though they were healthy.
      MK.loadManifest(p.manifestUrl).then(m => {
        meta.textContent = m.scrapers.length + ' scraper' + (m.scrapers.length === 1 ? '' : 's') + (m.version ? ' · v' + m.version : '');
      }).catch(e => {
        // Unreachable from Numax's own browser tab is still worth flagging —
        // but it isn't proof the repo is dead (Nuvio's own client fetches
        // scrapers on-device, not through this tab, and its Add Plugin dialog
        // never validates a URL before storing it either). Leave View enabled
        // so installing by URL alone is still possible.
        row.classList.add('dead');
        meta.textContent = 'could not preview — ' + e.message;
        meta.style.color = '#ff8a80';
      });
    });
  }

  // Binds a marketplace apply button to the inputs that feed its plan, so a
  // stale plan can never survive a change. Touching the profile ticks or the
  // merge/overwrite mode puts the button back into its planning state and
  // clears the previous report — the old code re-planned on ticks only, so
  // changing the mode left last time's answer (and last time's plan) on screen.
  function mkBindApply(btn, res, st, planLabel, run, isReady) {
    const reset = () => {
      btn.textContent = planLabel;
      btn.onclick = run;
      btn.disabled = !isReady();
      clr(res); status(st, '');
    };
    reset();
    return reset;
  }

  // Nuvio's own Add Plugin dialog never validates a manifest URL before
  // storing it (confirmed: it's exactly url/name/enabled, nothing else) — a
  // manifest Numax's own tab can't preview cross-origin isn't proof the repo
  // is dead, just proof Numax can't see it from here. So install stays
  // available either way; only the scraper list needs a working preview.
  //
  // Layout note: the install controls come FIRST and the scraper list is a
  // collapsed disclosure underneath. It used to be the other way round, which
  // buried the only actionable control under as many as 200 rows.
  let mkProvSeq = 0;
  async function openProvider(p) {
    const seq = ++mkProvSeq;
    const stale = () => seq !== mkProvSeq;
    const card = $('mk-prov-detail-card'), body = $('mk-prov-detail');
    card.style.display = ''; $('mk-prov-detail-title').textContent = p.name;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    const got = await loadInto(body, 'Reading manifest…', () => MK.loadManifest(p.manifestUrl).then(v => ({ m: v })).catch(e => ({ err: e })), { stale });
    if (!got) return;
    const m = got.value.m, previewError = got.value.err;

    // ---- summary strip ----
    const sum = el('div', 'mk-sum');
    if (m) {
      sum.appendChild(el('span', 'mk-sum-n', m.name));
      if (m.version) sum.appendChild(el('span', 'mk-lang', 'v' + m.version));
      sum.appendChild(el('span', 'mk-lang', m.scrapers.length + ' scrapers'));
    } else {
      sum.appendChild(el('span', 'mk-sum-n', p.name));
      sum.appendChild(el('span', 'mk-lang warnish', 'preview unavailable'));
    }
    const src = el('button', 'btn btn-ghost btn-xs', 'Open source');
    src.style.marginLeft = 'auto'; src.onclick = () => openTab(p.rawUrl);
    sum.appendChild(src);
    body.appendChild(sum);

    if (!m) {
      const note = el('div', 'mk-note mk-warn');
      note.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8.5v5"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>'
        + '<div><b>Could not preview this repo</b> — ' + esc(previewError.message) + '. Scrapers cannot be listed, but you can still install it by URL; Nuvio’s own Add Plugin dialog doesn’t check a manifest before storing it either.</div>';
      body.appendChild(note);
    }

    // ---- install controls, above the fold ----
    const inst = el('div', 'mk-install');
    inst.appendChild(el('div', 'mk-sec-t', 'Install to'));
    const tbox = el('div', 'mk-tgts'); inst.appendChild(tbox);

    const modeW = el('label', 'fld mk-mode'); modeW.appendChild(el('span', '', 'How to write it'));
    const msel = mkSelect([
      { value: 'merge', label: 'Merge', hint: 'add it, keep everything else' },
      { value: 'mirror', label: 'Overwrite', hint: 'replace all plugins with just this' },
    ]);
    modeW.appendChild(msel.node); inst.appendChild(modeW);

    const bar = el('div', 'actbar');
    const go = el('button', 'btn btn-primary', 'Install');
    const st = el('div', 'inline-status');
    bar.appendChild(go); bar.appendChild(st); inst.appendChild(bar);
    const res = el('div', 'mk-res'); inst.appendChild(res);
    body.appendChild(inst);

    // ---- scrapers, collapsed: context, not the main event ----
    if (m) {
      const d = mkDisclosure('What you get',
        m.scrapers.length + ' scraper' + (m.scrapers.length === 1 ? '' : 's') + ' — Nuvio installs the whole repo');
      const note = el('div', 'mk-note');
      note.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/></svg>'
        + '<div>Nuvio stores a plugin as the whole repo, so this installs all ' + m.scrapers.length + ' of its scrapers. Turning individual ones off is done inside the Nuvio app.</div>';
      d.body.appendChild(note);
      const srcW = el('div', 'mk-scroll');
      m.scrapers.slice(0, 200).forEach(sc => {
        const r = el('div', 'mk-scr');
        const t = el('div'); t.style.minWidth = '0';
        t.appendChild(el('div', 'mk-sn', sc.name || sc.id || 'scraper'));
        if (sc.description) t.appendChild(el('div', 'mk-sd', sc.description));
        r.appendChild(t);
        const langs = Array.isArray(sc.contentLanguage) ? sc.contentLanguage.join(' · ').toUpperCase() : '';
        if (langs) { const c = el('span', 'mk-lang', langs); c.style.marginLeft = 'auto'; r.appendChild(c); }
        srcW.appendChild(r);
      });
      d.body.appendChild(srcW);
      body.appendChild(d.node);
    }

    const chosen = new Set();
    const run = () => mkWrite({
      kind: 'plugins',
      master: [{ url: p.manifestUrl, name: (m && m.name) || p.name, enabled: true }],
      targets: targets.filter(t => chosen.has(t.aid + ':' + t.idx)),
      mode: msel.value(), st, res, btn: go, label: p.name,
    });
    const reset = mkBindApply(go, res, st, 'Install', run, () => chosen.size > 0);
    msel.onChange(reset);
    const targets = await mkFillTargets(tbox, chosen, reset, stale);
    if (!targets) { go.disabled = true; return; }
    reset();
  }

  // ---- collections ----
  // Browse from the manually-refreshed light snapshot (market.js
  // loadCollectionsSnapshot); install by reading that same collection's full
  // payload (market.js loadCollectionInstall) and writing it through the same
  // engine.planTarget + api.applyPlan path as everything else — see market.js
  // for why a once-captured snapshot is as good as a live read here.
  let mkCollectionsCache = null;
  async function renderMkCollections(force) {
    const box = $('mk-collections');
    if (!mkCollectionsCache || force) {
      clr(box); box.appendChild(el('p', 'muted sm shimmer', 'Reading the collections snapshot…'));
      try { mkCollectionsCache = await MK.loadCollectionsSnapshot(force); }
      catch (e) {
        clr(box); box.appendChild(el('p', 'empty sm err-text', 'Could not read the collections snapshot: ' + e.message));
        return;
      }
    }
    clr(box);

    const when = mkCollectionsCache.capturedAt ? new Date(mkCollectionsCache.capturedAt).toLocaleString() : 'unknown time';
    // The caveat is real and must stay readable, but it was a four-line wall of
    // text sitting above every visit. One line now, with the detail a click away.
    const n = el('div', 'mk-note mk-note-row');
    n.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/></svg>'
      + '<span class="mk-note-line"><b>Snapshot, not live</b> — captured ' + esc(when) + ', ' + mkCollectionsCache.total + ' collections.</span>';
    const why = el('div', 'mk-note-why', MK.COLLECTIONS.why);
    const more = el('button', 'link', 'Why?');
    more.onclick = () => { const on = n.classList.toggle('open'); more.textContent = on ? 'Hide' : 'Why?'; };
    const brw = el('button', 'link', 'Browse on Nuvio');
    brw.onclick = () => { openTab(MK.COLLECTIONS.site); logAct('Opened Nuvio community collections', 'info'); };
    const acts = el('span', 'mk-note-acts'); acts.appendChild(more); acts.appendChild(brw);
    n.appendChild(acts); n.appendChild(why);
    box.appendChild(n);

    const grid = el('div', 'mk-coll-grid');
    box.appendChild(grid);
    mkCollGrid = grid;
    renderMkCollGrid();
  }

  // 99 cards with no way to narrow them was the whole problem here. Search and
  // sort are pure view state: nothing is fetched again and the install path is
  // untouched.
  let mkCollGrid = null;
  function renderMkCollGrid() {
    const grid = mkCollGrid; if (!grid || !mkCollectionsCache) return;
    clr(grid);
    const inp = $('mk-coll-search');
    const q = ((inp && inp.value) || '').trim().toLowerCase();
    const find = inp && inp.closest('.mk-find');
    if (find) find.classList.toggle('has-q', !!q);
    const sort = ($('mk-coll-sort') && $('mk-coll-sort').value) || 'installs';
    const all = mkCollectionsCache.items || [];
    const hit = c => {
      if (!q) return true;
      const tags = Array.isArray(c.tags) ? c.tags.join(' ') : '';
      const need = Array.isArray(c.requiredAddons) ? c.requiredAddons.map(a => a.addonName || a.addonId || '').join(' ') : '';
      return (String(c.title || '') + ' ' + String(c.description || '') + ' ' + tags + ' ' + need).toLowerCase().includes(q);
    };
    const items = all.filter(hit).sort((a, b) => {
      if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
      if (sort === 'likes') return (b.likes_count || 0) - (a.likes_count || 0);
      return (b.installs_count || 0) - (a.installs_count || 0);
    });
    const cnt = $('mk-coll-count');
    if (cnt) cnt.textContent = q ? items.length + ' of ' + all.length : all.length + ' collections';
    if (!items.length) { grid.appendChild(el('p', 'mk-find-none', 'No collection matches \u201c' + q + '\u201d.')); return; }
    items.forEach(c => grid.appendChild(renderMkCollCard(c)));
  }

  // Descriptions come from creators as raw markdown; there's no renderer here,
  // so strip the syntax rather than show literal ### and ** on a plain card.
  function mdStrip(s) {
    return String(s || '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderMkCollCard(c) {
    const card = el('div', 'mk-coll-card');
    if (c.image_url) {
      const img = el('img', 'mk-coll-img'); img.src = c.image_url; img.alt = ''; img.loading = 'lazy';
      img.onerror = () => { img.remove(); };
      card.appendChild(img);
    }
    const body = el('div', 'mk-coll-body');
    body.appendChild(el('div', 'mk-coll-title', c.title));
    if (c.description) body.appendChild(el('div', 'mk-coll-desc', mdStrip(c.description)));
    if (Array.isArray(c.tags) && c.tags.length) {
      const tg = el('div', 'mk-coll-tags');
      c.tags.slice(0, 4).forEach(t => tg.appendChild(el('span', 'mk-lang', t)));
      if (c.tags.length > 4) {
        const more = el('span', 'mk-coll-more', '+' + (c.tags.length - 4));
        more.title = c.tags.join(', ');
        tg.appendChild(more);
      }
      body.appendChild(tg);
    }
    const s = c.stats || {};
    const statsText = [
      s.folderCount != null ? s.folderCount + ' folders' : null,
      s.sourceCount != null ? s.sourceCount + ' sources' : null,
      s.addonCount != null ? s.addonCount + ' add-ons' : null,
    ].filter(Boolean).join(' · ');
    if (statsText) body.appendChild(el('div', 'mk-coll-stats', statsText));
    if (Array.isArray(c.requiredAddons) && c.requiredAddons.length) {
      body.appendChild(el('div', 'mk-coll-req', 'Needs: ' + c.requiredAddons.map(a => a.addonName || a.addonId).join(', ')));
    }
    const foot = el('div', 'mk-coll-foot');
    foot.appendChild(el('span', 'muted sm', (c.likes_count || 0) + ' likes · ' + (c.installs_count || 0) + ' installs'));
    const acts = el('div'); acts.style.cssText = 'display:flex;gap:6px';
    const install = el('button', 'btn btn-primary btn-xs', 'Install to profile');
    install.onclick = () => openMkCollectionInstall(install, c);
    const open = el('button', 'btn btn-ghost btn-xs', 'View on Nuvio');
    open.onclick = () => { openTab(MK.COLLECTIONS.detailUrl(c.public_id)); logAct('Opened community collection ' + c.title, 'info'); };
    acts.appendChild(install); acts.appendChild(open);
    foot.appendChild(acts);
    body.appendChild(foot);
    card.appendChild(body);
    return card;
  }

  // Reads this collection's full payload (folders/sources + required
  // add-ons) from the per-collection snapshot file, applies Nuvio's own
  // install transformation to it, then plans+writes through
  // engine.planTarget/api.applyPlan exactly like a template apply — same
  // merge/overwrite choice, same removal-confirm tick, same per-item failure
  // reporting (renderApplyPlan, shared with Templates/Sync Desk) — and finally
  // reads the profile back to prove the collection is really there.
  //
  // The transformation is the fix for "it said it applied but didn't": Nuvio
  // rewrites a community collection's id to `<id>-community` and attaches a
  // `community` block on install, and 93 of the 99 captured payloads are the
  // raw pre-install form. Writing those unchanged produced a collection Nuvio
  // does not recognise as an installed community collection. See market.js
  // `toInstalledCollection` for the verified rule.
  async function openMkCollectionInstall(anchor, c) {
    const pop = openMkPop(anchor, 'Install ' + c.title, 'Adds this collection to one profile.');
    const mine = pop;
    const stale = () => mkPop !== mine;

    const got = await loadInto(pop.body, 'Reading collection…', () => MK.loadCollectionInstall(c.public_id),
      { stale, prefix: 'Could not read this collection: ' });
    if (!got) { if (!stale()) pop.place(); return; }
    const doc = got.value;

    // Shape every collection the way Nuvio's own installer would.
    const version = (c.community && c.community.version) || 1;
    const stampedAt = Date.now();
    const collections = doc.collections.map(x =>
      MK.toInstalledCollection(x, { publicId: c.public_id, version, installedAt: stampedAt }));

    if (collections.length > 1) {
      pop.body.appendChild(el('p', 'muted sm', 'This is a pack of ' + collections.length + ' collections — all install together.'));
    }
    if (doc.requiredAddons.length) {
      pop.body.appendChild(el('p', 'muted sm', 'Needs: ' + doc.requiredAddons.map(a => a.addonName || a.addonId).join(', ')));
    }
    if (doc.resources.length) {
      const rn = el('div', 'mk-note mk-warn');
      rn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8.5v5"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>'
        + '<div>Also includes ' + doc.resources.length + ' extra file' + (doc.resources.length === 1 ? '' : 's') + ' this install won\'t apply (' + doc.resources.map(r => esc(r.fileName || r.id)).join(', ') + ') — get ' + (doc.resources.length === 1 ? 'it' : 'them') + ' from Nuvio\'s own page.</div>';
      pop.body.appendChild(rn);
    }

    const tw = el('label', 'fld'); tw.appendChild(el('span', '', 'Install to profile'));
    const tsel = el('select', 'sel'); tw.appendChild(tsel); pop.body.appendChild(tw);

    const modeW = el('label', 'fld mk-mode');
    modeW.appendChild(el('span', '', 'How to add the collection'));
    const msel = mkSelect([
      { value: 'merge', label: 'Merge', hint: 'add it, keep everything else' },
      { value: 'mirror', label: 'Overwrite', hint: 'replace all collections with just this' },
    ]);
    modeW.appendChild(msel.node); pop.body.appendChild(modeW);

    const already = el('div'); pop.body.appendChild(already);
    const bar = el('div', 'actbar'); bar.style.marginTop = '12px';
    const btn = el('button', 'btn btn-primary', 'Preview'); const st = el('div', 'inline-status');
    bar.appendChild(btn); bar.appendChild(st); pop.body.appendChild(bar);
    const res = el('div', 'mk-res'); pop.body.appendChild(res);

    const tgot = await loadInto(el('div'), 'Reading profiles…', mkAllProfiles, { stale });
    if (stale()) return;
    if (!tgot) { status(st, 'Could not read your profiles.', 'err'); btn.disabled = true; pop.place(); return; }
    const { targets, failed } = tgot.value;
    failed.forEach(f => already.appendChild(el('p', 'empty sm err-text', f)));
    if (!targets.length) {
      already.appendChild(el('p', 'empty sm', failed.length
        ? 'No profiles could be read.' : 'No linked accounts yet — link one on the Nuvio accounts tab.'));
      btn.disabled = true; pop.place(); return;
    }
    targets.forEach(t => {
      const o = document.createElement('option');
      o.value = t.aid + ':' + t.idx; o.textContent = t.name + ' · ' + t.account;
      tsel.appendChild(o);
    });
    enhanceSelect(tsel);

    // Any change to the target or the mode invalidates a previous preview.
    const reset = () => { btn.textContent = 'Preview'; btn.onclick = preview; btn.disabled = false; clr(res); status(st, ''); };
    tsel.addEventListener('change', reset);
    msel.onChange(reset);

    async function preview() {
      const [aid, iStr] = tsel.value.split(':'); const idx = parseInt(iStr, 10);
      const mode = msel.value();
      status(st, 'Reading target profile…'); clr(res);
      try {
        const { backup } = await loadAccount(aid, true);
        const state = sliceProfile(backup, idx);
        const master = { collections };
        const cats = { collections: true };
        if (doc.requiredAddons.length) {
          const existing = new Map((state.addons || []).map(x => [x.url, x]));
          const base = (state.addons || []).reduce((m, x) => Math.max(m, Number(x.sort_order) || 0), 0);
          master.addons = doc.requiredAddons.map((a, i) => {
            const had = existing.get(a.manifestUrl);
            return { url: a.manifestUrl, name: a.addonName, enabled: true, sort_order: had ? (had.sort_order ?? 0) : base + 1 + i };
          });
          cats.addons = true;
        }
        const plan = E.planTarget(master, state, { categories: cats, modes: { collections: mode, addons: 'merge' }, profileId: idx, originClientId: 'numax-web' });
        status(st, '');
        renderApplyPlan(res, st, plan, aid, 'Collection installed', {
          verify: () => verifyCollections(aid, idx, collections),
        });
        pop.place();
      } catch (e) { status(st, 'Failed: ' + e.message, 'err'); }
    }
    reset();
    pop.place();
  }

  // Reads a profile's collections back and confirms each installed id is
  // present. A push RPC answers 204 with no body, so a clean response is not
  // by itself evidence that anything was stored.
  async function verifyCollections(accountId, profileId, wanted) {
    try {
      const rows = await withTimeout(A.client(store, accountId).rpc('sync_pull_collections', { p_profile_id: profileId }), READ_TIMEOUT, 'Checking the save');
      const row = Array.isArray(rows) ? rows[0] : rows;
      let live = row && row.collections_json;
      // Nuvio has been seen to return this blob as a JSON string rather than an
      // array; parse rather than treat a string as "no collections".
      if (typeof live === 'string') { try { live = JSON.parse(live); } catch (e) { live = null; } }
      if (!Array.isArray(live)) return ['Could not read the profile back to confirm the save.'];
      const have = new Set(live.map(x => x && x.id));
      const gone = wanted.filter(w => !have.has(w.id));
      return gone.length ? ['Nuvio accepted the write but ' + gone.length + ' collection(s) are not on the profile afterwards.'] : [];
    } catch (e) { return ['Could not confirm the save: ' + e.message]; }
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
    $('pf-account').onchange = () => renderPfPicker($('pf-account').value);
    $('pf-name-input').addEventListener('input', () => dirty('identity'));
    $('pf-photo-input').addEventListener('input', () => { dirty('identity'); updatePhotoPreview(); });
    document.querySelectorAll('.pf-editor-tab').forEach(b => b.onclick = () => switchPfEditorTab(b.dataset.pftab));
    document.querySelectorAll('.pf-stat').forEach(b => b.onclick = () => switchPfEditorTab(b.dataset.pftab));
    $('pf-save-btn').onclick = saveAllDirty;
    $('pf-tpl-profile').onclick = openSaveTemplateModal;
    document.querySelectorAll('.mk-tab').forEach(b => b.onclick = () => switchMkTab(b.dataset.mktab));
    // marketplace search / sort — view state only, nothing is refetched
    mkFindWire('mk-addon-search', 'mk-addon-clear', renderMkAddonGroups);
    mkFindWire('mk-prov-search', 'mk-prov-clear', () => renderMkPlugins());
    mkFindWire('mk-coll-search', 'mk-coll-clear', renderMkCollGrid);
    if ($('mk-coll-sort')) $('mk-coll-sort').addEventListener('change', renderMkCollGrid);
    $('mk-prov-refresh').onclick = () => renderMkPlugins(true);
    $('mk-prov-close').onclick = () => { $('mk-prov-detail-card').style.display = 'none'; };
    $('sy-account').onchange = () => renderSySource($('sy-account').value);
    // stepper: the header chips and the section headers open the same sections
    document.querySelectorAll('.sy-step[data-systep]').forEach(b => b.onclick = () => syOpenSec(b.dataset.systep, { scroll: true }));
    document.querySelectorAll('.sy-sec[data-systep] .sy-sec-h').forEach(h => h.onclick = () => {
      const sec = h.closest('.sy-sec');
      syOpenSec(sec.classList.contains('open') ? '' : sec.dataset.systep);
    });
    $('sy-oldapp-dismiss').onclick = () => { $('sy-oldapp-notice').style.display = 'none'; };
    $('sy-select-all').onclick = sySelectAll;
    $('sy-deselect-all').onclick = syDeselectAll;
    $('sy-dev-choice').onclick = syDevChoice;
    document.querySelectorAll('.sy-tgl').forEach(b => b.onclick = (e) => { e.preventDefault(); $(b.dataset.target).classList.toggle('open'); syRemeasure(); });
    // live preview on carry-over category toggles
    ['sy-cat-addons', 'sy-cat-plugins', 'sy-cat-collections', 'sy-cat-watchprogress', 'sy-cat-watched'].forEach(id => {
      const cb = $(id); if (cb) cb.addEventListener('change', () => { updateSyCounts(); scheduleLivePreview(); });
    });
    // API keys are no longer a modal prompt — they are the "API keys and provider
    // credentials" row in the settings tree, matching Nuvio's own dialog. Turning
    // Settings off clears that opt-in too, so keys can never ride along unnoticed.
    $('sy-cat-settings').addEventListener('change', () => {
      if (!$('sy-cat-settings').checked) { syCreds.copy = false; syCreds.replace = false; sySettingsIncludeKeys = false; }
      renderSyTree(); updateSyCounts(); scheduleLivePreview();
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
    $('st-signout').onclick = async () => { if (!(await uiModal({
      title: 'Sign out of Google?',
      message: 'Numax will forget this session on this device.',
      details: [
        'Affects <b>this device only</b> — nothing is deleted anywhere.',
        'Linked accounts, templates and backups stay in <b>your Google Drive</b>.',
        'Any unsaved edits open in the Profile editor will be lost.',
        '<b>Reversible</b> — sign back in with Google and everything comes back.'
      ],
      danger: true, okLabel: 'Sign out'
    }))) return; gAuth.token = null; gAuth.user = null; store.clear(); invalAll(); $('sb-name').textContent = 'Signed out'; showView('view-landing'); logAct('Signed out', 'info'); };
    $('act-clear').onclick = () => { activity.length = 0; renderActivity(); };
  }
  window.addEventListener('resize', () => { if (typeof syRemeasure === 'function') syRemeasure(); });
  window.addEventListener('DOMContentLoaded', () => {
    wire(); renderActivity();
    enhanceAllSelects();
    // Panels are rebuilt constantly (profiles, sync, restore, templates), so a
    // one-shot pass would miss most selects. Watch instead of chasing call sites.
    let selScan = 0;
    new MutationObserver(() => {
      cancelAnimationFrame(selScan);
      selScan = requestAnimationFrame(() => enhanceAllSelects());
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
