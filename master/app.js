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
  const TITLES = { wizard: 'Setup wizard', accounts: 'Nuvio accounts', profile: 'Profile', sync: 'Sync desk', templates: 'Templates', drive: 'Google Drive', market: 'Marketplace', activity: 'Activity', settings: 'Settings' };
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
    if (panel === 'wizard') refreshWizard();
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
    const rec = { backup, profiles: normProfiles(backup.profiles) };
    cache[id] = rec; profileCache[id] = rec.profiles; return rec;
  }

  // ---- the cheap read: profile names only ----
  // Every picker in the app needs nothing but each profile's name and index,
  // but they all used to get that from loadAccount() — a WHOLE-ACCOUNT export.
  // Measured live against the test account: 244 KB / ~1.0 s for the export
  // versus 1.9 KB / ~0.4 s for sync_pull_profiles, and the gap only widens with
  // watch history. That is the whole reason "Reading profiles…" sat there for
  // a beat even on a second visit. This read is cached on its own, is satisfied
  // for free when a full export already happens to be in hand, and is dropped
  // by the same inval()/invalAll() as everything else.
  const profileCache = {};
  const profileInflight = {};
  const profileStamp = {};
  const PROFILE_FRESH_MS = 60000;   // how long a cached name list is trusted outright
  async function loadProfiles(id, force) {
    if (!force && profileCache[id]) return profileCache[id];
    if (!force && cache[id]) { profileCache[id] = cache[id].profiles; profileStamp[id] = profileStamp[id] || Date.now(); return profileCache[id]; }
    if (!force && profileInflight[id]) return profileInflight[id];
    const p = withTimeout(A.client(store, id).pullProfiles(), READ_TIMEOUT, 'Reading profiles')
      .then(raw => { const list = normProfiles(raw); profileCache[id] = list; profileStamp[id] = Date.now(); return list; })
      .finally(() => { if (profileInflight[id] === p) delete profileInflight[id]; });
    profileInflight[id] = p;
    return p;
  }
  // True when every linked account's name list was read recently enough that
  // re-reading it behind the picker would be pure noise.
  const profilesFresh = () => store.list().every(r => (Date.now() - (profileStamp[r.accountId] || 0)) < PROFILE_FRESH_MS);
  // What is already known, with no network call and no promise — so a picker
  // can paint its real contents on the first frame instead of shimmering.
  const profilesCached = id => profileCache[id] || (cache[id] && cache[id].profiles) || null;

  // Invalidating drops in-flight reads too: a read that started before the
  // invalidation describes the old state, so it must not be handed out after.
  const inval = id => { delete cache[id]; delete membershipCache[id]; delete inflight[id]; delete profileCache[id]; delete profileInflight[id]; delete profileStamp[id]; };
  const invalAll = () => { [cache, membershipCache, inflight, profileCache, profileInflight, profileStamp].forEach(m => Object.keys(m).forEach(k => delete m[k])); };
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

  // The category tick and its item picks are one control, not two. Only the tick
  // reaches the plan (`cats` in syPreview), so before this you could select 2 of 4
  // add-ons, read "2 / 4" on the row, and have the whole category skipped at apply
  // time with nothing saying so. The tick now always reports what is actually
  // selected: none, some (a dash), or all.
  function syMirrorCat(kind) {
    const cb = $('sy-cat-' + kind); if (!cb) return;
    // With no source read yet there is nothing to mirror, and forcing the tick
    // off here would make it spring back the moment you clicked it.
    if (!sySnap) return;
    const picked = sySel[kind].size, total = syList(kind).length;
    cb.checked = picked > 0;
    cb.indeterminate = picked > 0 && picked < total;
  }
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
    // addons / plugins / collections ticks follow their picks via syMirrorCat().
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
  // An open section rests at height:auto so a chooser opening inside it can
  // still grow it. Two things follow from that, and both were wrong before:
  //   - CSS cannot transition FROM auto, so a close straight off 'auto' snapped
  //     shut. Pin the real height and commit the frame first.
  //   - When content arrives while the section is already at auto, the box is
  //     ALREADY the new size, so setting it to that same size animates nothing
  //     and the content pops in. Pin the height the box is showing, commit, and
  //     only then set the new one.
  function syMeasure(sec) {
    const w = sec.querySelector('.sy-sec-w'), b = sec.querySelector('.sy-sec-b');
    if (!w || !b) return;
    clearTimeout(w.__t);
    const anim = !((M.reduced && M.reduced()) || document.hidden);
    if (!sec.classList.contains('open')) {
      if (anim && w.style.height === 'auto') { w.style.height = w.offsetHeight + 'px'; void w.offsetHeight; }
      w.style.height = '0px';
      return;
    }
    const next = b.offsetHeight;
    if (!anim) { w.style.height = 'auto'; return; }
    if (w.style.height === 'auto') {
      const shown = w.offsetHeight;
      if (shown === next) return;                 // nothing moved; leave it at auto
      w.style.height = shown + 'px'; void w.offsetHeight;
    }
    w.style.height = next + 'px';
    w.__t = setTimeout(() => { if (sec.classList.contains('open')) w.style.height = 'auto'; }, 320);
  }
  function syOpenSec(key, opts) {
    sySecOpen = key;
    sySecs().forEach(sec => {
      sec.classList.toggle('open', sec.dataset.systep === key);
      syMeasure(sec);
    });
    syncSteps();
    if (opts && opts.scroll) {
      const sec = sySecs().find(x => x.dataset.systep === key);
      // The section is growing for the next ~260 ms. A smooth scroll aimed at a
      // target whose height is changing under it overshoots and then crawls
      // back, which is most of what read as jank here. Aim at the section's
      // HEADER, which does not move, and only scroll when it is actually out of
      // view — a scroll that had nothing to do never looks smooth.
      const head = sec && sec.querySelector('.sy-sec-h');
      if (head) requestAnimationFrame(() => {
        const r = head.getBoundingClientRect();
        if (r.top >= 0 && r.bottom <= (window.innerHeight || 0)) return;
        head.scrollIntoView({ block: 'nearest', behavior: ((M.reduced && M.reduced()) || document.hidden) ? 'auto' : 'smooth' });
      });
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
    ['addons', 'plugins', 'collections'].forEach(syMirrorCat);
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
    const box = $('dr-backup-picker'); const list = store.list();
    // refreshRestore() must run on EVERY path: it owns the restore list, whose
    // placeholder is static markup in index.html. The old early return here
    // left that placeholder shimmering "Loading backups…" forever.
    if (!list.length) { clr(box); box.appendChild(el('p', 'empty sm', 'Link an account to choose what to back up.')); refreshRestore(); return; }
    // Selection survives a refresh: the chips are rebuilt, the set is not.
    drPicked.forEach(k => { if (!list.some(r => k.indexOf(r.accountId + ':') === 0)) drPicked.delete(k); });
    await mkFillTargets(box, drPicked, null, null, { label: 'Profiles to back up' });
    refreshRestore();
  }
  // The Drive picker's own selection, held apart from the DOM so a background
  // profile refresh cannot silently drop a tick the user has already made.
  const drPicked = new Set();
  async function backupNow() {
    const log = $('dr-backup-log'); const picked = [...drPicked]; if (!picked.length) { status(log, 'Pick at least one profile.', 'err'); return; }
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
  // The one info glyph these notes share, so the same 200 characters of path
  // data are not typed out at every call site.
  const MK_INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/></svg>';
  let mkTab = 'addons';
  // Said in both the Marketplace and the Setup Wizard, so it is written once.
  // wizard.js owns the wording; the Marketplace must survive without it (it is
  // optional in exactly the way market.js is), hence the fallback.
  const WZ_PLUGIN_ONDEVICE = (window.NumaxWizard && window.NumaxWizard.PLUGINS && window.NumaxWizard.PLUGINS.ondevice)
    || 'Adding a repository is all Numax can do. Turning the individual providers on happens on the device, under Settings → Content &amp; Discovery → Plugins — those switches are not part of what a Nuvio account syncs.';
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

  // ---- the marketplace dialog ----
  // This was an anchored popover. It had to guess a position, re-measure after
  // every async load, re-place on scroll and resize, and could still land
  // somewhere awkward on a short window — and the plugins tab did not use it at
  // all: its install controls sat at the bottom of a detail card, so "install
  // this repo" meant scrolling past a 200-row scraper list to reach them. One
  // centred dialog for all three tabs replaces the lot: fixed height, its own
  // scroll, nothing to position.
  //
  // It carries the app's own .modal-root / .modal-card classes, so it gets the
  // same open/close motion, focus trap and focus restore as every other dialog
  // here, straight from ui-motion, with no new mechanism.
  //
  // The returned object keeps the old shape — {bg, box, body, foot, place} —
  // so every existing caller works unchanged; place() is simply a no-op now,
  // because a centred dialog has nowhere to be placed.
  let mkPop = null;
  function mkPopKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMkPop(); } }
  function closeMkPop() {
    if (!mkPop) return;
    const root = mkPop.root; mkPop = null;
    document.removeEventListener('keydown', mkPopKey, true);
    // Hand the exit animation to ui-motion (it watches display on .modal-root),
    // then take the node out once that animation has had its 130 ms.
    root.style.display = 'none';
    setTimeout(() => root.remove(), 260);
  }
  function openMkPop(anchor, title, sub) {
    closeMkPop();
    const root = el('div', 'modal-root mk-dlg-root');
    const bg = el('div', 'modal-bg');
    const box = el('div', 'modal-card mk-dlg');
    const h = el('div', 'mk-dlg-h modal-msg');
    h.appendChild(el('b', '', title)); if (sub) h.appendChild(el('span', '', sub));
    const x = el('button', 'mk-dlg-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.onclick = closeMkPop;
    h.appendChild(x);
    const body = el('div', 'mk-dlg-b'), foot = el('div', 'mk-dlg-f');
    box.appendChild(h); box.appendChild(body); box.appendChild(foot);
    root.appendChild(bg); root.appendChild(box);
    document.body.appendChild(root);
    bg.onclick = closeMkPop;
    document.addEventListener('keydown', mkPopKey, true);
    mkPop = { root, bg, box, body, foot, place: () => {} };
    return mkPop;
  }
  const openTab = url => window.open(url, '_blank', 'noopener,noreferrer');

  // Somebody else's mark on a marketplace row. Same rule as the wizard's
  // wzLogo, and for the same reason: the monogram is drawn FIRST and the image
  // sits on top of it, so a host that stops serving its logo degrades to a
  // letter rather than to a broken-image icon.
  //
  // Plugin repositories publish no logo of their own — their manifests carry
  // exactly { name, version, scrapers } (checked live 2026-09-13). market.js
  // derives the publishing account's avatar instead; see pluginOwner there.
  // Individual scrapers DO each carry a `logo`, and those are used as-is.
  function mkLogo(name, src, cls) {
    const t = el('div', 'mk-ic mk-ic-l' + (cls ? ' ' + cls : ''));
    t.appendChild(el('span', 'mk-ic-m', ((String(name || '?')).trim()[0] || '?').toUpperCase()));
    if (src) {
      const i = document.createElement('img');
      // Deliberately NOT loading="lazy", for the same measured reason wzLogo
      // is not: a lazy image never starts loading at all while the document is
      // hidden, because the observer that would trigger it never fires. Every
      // one of these stayed blank in exactly that state. They are 26-32px
      // marks that are on screen the moment their row is, so lazy buys nothing.
      i.alt = ''; i.referrerPolicy = 'no-referrer';
      i.onerror = () => i.remove();
      i.src = src;
      t.appendChild(i);
    }
    return t;
  }

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
      const add = el('button', 'btn btn-ghost btn-xs', 'Add'); add.title = 'Put this add-on on one or more profiles';
      // The catalogue link goes in prefilled, so the common case ("I just want
      // the default setup") is one click and a tick rather than a copy-paste
      // round trip. Configure first and paste over it when you need settings.
      add.onclick = () => openAddToProfile(add, s.name, s.url || '');
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
  // An open group rests at height:auto so it can grow with its content. CSS
  // cannot transition FROM auto, though, so closing one straight from 'auto' to
  // '0px' snapped shut with no animation at all — every group in the add-on
  // list did this. Pin the real height first and force the frame to commit, and
  // the close animates like the open does.
  function mkDisc(sec, w, inner, open) {
    clearTimeout(w.__t);
    if (!open && w.style.height === 'auto') { w.style.height = inner.offsetHeight + 'px'; void w.offsetHeight; }
    sec.classList.toggle('open', open);
    w.style.height = open ? inner.offsetHeight + 'px' : '0px';
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
        add.onclick = () => openAddToProfile(add, it.name, it.url);
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
  //
  // Reads run in PARALLEL and go through loadProfiles — the ~2 KB
  // sync_pull_profiles read — rather than one whole-account export after
  // another. On the test account that is the difference between roughly a
  // second per account in series and roughly a third of a second for all of
  // them at once, and the second visit costs nothing at all.
  async function mkAllProfiles(force) {
    const recs = store.list();
    const settled = await Promise.all(recs.map(rec =>
      loadProfiles(rec.accountId, force)
        .then(profiles => ({ rec, profiles }))
        .catch(e => ({ rec, error: e.message }))));
    const targets = [], failed = [];
    settled.forEach(({ rec, profiles, error }) => {
      if (error) { failed.push(accountName(rec.accountId) + ' — ' + error); return; }
      profiles.forEach(p => targets.push({ aid: rec.accountId, idx: p.index, name: p.name, account: accountName(rec.accountId), profile: p }));
    });
    return { targets, failed };
  }
  // Everything already in memory, shaped exactly like mkAllProfiles' result, or
  // null when nothing is cached yet. This is what lets the picker paint real
  // rows on the first frame instead of a shimmer that resolves into the same
  // thing a moment later.
  function mkCachedProfiles() {
    const recs = store.list();
    if (!recs.length) return null;
    const targets = [];
    for (const rec of recs) {
      const ps = profilesCached(rec.accountId);
      if (!ps) return null;   // partial is worse than honest: shimmer instead
      ps.forEach(p => targets.push({ aid: rec.accountId, idx: p.index, name: p.name, account: accountName(rec.accountId), profile: p }));
    }
    return { targets, failed: [] };
  }

  // ---- "which profiles?" — one picker, organised by account ----
  // The old list was every profile from every account in one flat column of
  // checkboxes. This groups them the way people actually hold it in their head:
  // an account is a row you open, it carries its own Select all and its own
  // "2 of 4" count, and its profiles are chips inside it. One account linked
  // means one section, already open, and the grouping costs nothing.
  //
  // `single` (collections) turns the chips into a one-of choice and hides the
  // Select all, because installing one collection into eight profiles at once
  // is not a thing the install path does.
  async function mkFillTargets(box, chosen, onChange, stale, opts) {
    const o = opts || {};
    const paint = got => {
      const { targets, failed } = got;
      clr(box);
      if (targets.length) mkTargetList(box, targets, chosen, o);
      failed.forEach(m => box.appendChild(el('p', 'empty sm err-text', m)));
      if (!targets.length) {
        box.appendChild(el('p', 'empty sm', failed.length
          ? 'No profiles could be read from the accounts above.'
          : 'No linked accounts yet — link one on the Nuvio accounts tab.'));
      }
      return targets.length ? targets : null;
    };
    const cached = mkCachedProfiles();
    if (cached) {
      // Paint from memory now, then quietly confirm against the server. A
      // refresh only repaints when the profile set actually changed, so the
      // ticks the user has already made are never wiped out underneath them.
      const shown = paint(cached);
      if (onChange) box.addEventListener('mkchange', onChange);
      if (profilesFresh()) return shown;   // read moments ago; nothing to confirm
      const key = cached.targets.map(t => t.aid + ':' + t.idx + ':' + t.name).join('|');
      mkAllProfiles(true).then(fresh => {
        if (stale && stale()) return;
        if (fresh.targets.map(t => t.aid + ':' + t.idx + ':' + t.name).join('|') === key && !fresh.failed.length) return;
        paint(fresh);
        box.dispatchEvent(new CustomEvent('mkchange'));
      }).catch(() => {});
      return shown;
    }
    const got = await loadInto(box, 'Reading profiles…', () => mkAllProfiles(), { stale });
    if (!got) return null;
    const shown = paint(got.value);
    if (onChange) box.addEventListener('mkchange', onChange);
    return shown;
  }
  function mkTargetList(box, targets, chosen, opts) {
    const o = opts || {};
    clr(box);
    // Group order follows store.list(), so the picker matches the Accounts tab.
    const byAcct = [];
    targets.forEach(t => {
      let g = byAcct.find(x => x.aid === t.aid);
      if (!g) { g = { aid: t.aid, name: t.account, items: [] }; byAcct.push(g); }
      g.items.push(t);
    });
    const wrap = el('div', 'mk-pick');
    // Two columns only when there is a second account to put in one. auto-fit
    // cannot work this out on its own here: the select-all row spans both
    // tracks, so the empty track never collapses and a lone account would sit
    // in half the dialog with nothing beside it.
    if (byAcct.length > 1) wrap.classList.add('multi');
    const fire = () => box.dispatchEvent(new CustomEvent('mkchange'));
    const allKeys = targets.map(t => t.aid + ':' + t.idx);

    // One control above everything: every profile of every account. The
    // per-account Select all stays where it is — this is the row above it, not
    // a replacement for it.
    let topAll = null, topCnt = null;
    if (!o.single) {
      const top = el('div', 'mk-pick-top');
      const tx = el('div', 'mk-pick-top-tx');
      tx.appendChild(el('span', 'mk-pick-top-t', o.label || 'Add to'));
      topCnt = el('span', 'mk-pick-top-c');
      tx.appendChild(topCnt);
      top.appendChild(tx);
      topAll = el('button', 'mk-pick-topall', 'Select all'); topAll.type = 'button';
      top.appendChild(topAll);
      wrap.appendChild(top);
    }

    byAcct.forEach((g, gi) => {
      const sec = el('div', 'mk-pick-acct');
      const head = el('button', 'mk-pick-h'); head.type = 'button';
      const av = el('span', 'mk-pick-ic'); av.textContent = (g.name || '?')[0].toUpperCase();
      head.appendChild(av);
      const tx = el('span', 'mk-pick-htx');
      tx.appendChild(el('span', 'mk-pick-hn', g.name));
      const cnt = el('span', 'mk-pick-hc');
      tx.appendChild(cnt);
      head.appendChild(tx);
      const car = el('span', 'mk-pick-car');
      car.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
      head.appendChild(car);
      sec.appendChild(head);

      const w = el('div', 'mk-pick-w'), inner = el('div', 'mk-pick-b');
      let all = null;
      if (!o.single) {
        const bar = el('div', 'mk-pick-bar');
        all = el('button', 'mk-pick-all', 'Select all'); all.type = 'button';
        bar.appendChild(all); inner.appendChild(bar);
      }
      const chips = el('div', 'mk-pick-chips');
      const nodes = [];
      g.items.forEach(t => {
        const key = t.aid + ':' + t.idx;
        const c = el('button', 'pchip multi mk-pick-chip' + (chosen.has(key) ? ' on' : ''));
        c.type = 'button'; c.dataset.tid = key;
        c.appendChild(avatar(t.profile || { name: t.name }, 30));
        c.appendChild(el('span', 'pcn', t.name));
        const ck = el('span', 'chk'); ck.textContent = '\u2713'; c.appendChild(ck);
        c.onclick = () => {
          if (o.single) { chosen.clear(); chosen.add(key); }
          else if (chosen.has(key)) chosen.delete(key);
          else chosen.add(key);
          sync(); fire();
        };
        chips.appendChild(c); nodes.push({ key, node: c });
      });
      inner.appendChild(chips); w.appendChild(inner); sec.appendChild(w);

      const sync = () => {
        // Every group re-reads `chosen`, so single-select correctly clears a
        // chip that lives in a different account's group.
        wrap.querySelectorAll('.mk-pick-chip').forEach(n => n.classList.toggle('on', chosen.has(n.dataset.tid)));
        wrap.querySelectorAll('.mk-pick-acct').forEach(s => { if (s.__sync) s.__sync(); });
        if (topCnt) {
          const on = allKeys.filter(k => chosen.has(k)).length;
          topCnt.textContent = on
            ? on + ' of ' + allKeys.length + ' profile' + (allKeys.length === 1 ? '' : 's') + ' selected'
            : allKeys.length + ' profile' + (allKeys.length === 1 ? '' : 's') + ' across ' + byAcct.length + ' account' + (byAcct.length === 1 ? '' : 's');
          topCnt.classList.toggle('on', !!on);
          topAll.textContent = on === allKeys.length ? 'Clear all' : 'Select all';
          topAll.classList.toggle('on', on === allKeys.length);
        }
      };
      sec.__syncTop = sync;
      sec.__sync = () => {
        const on = nodes.filter(n => chosen.has(n.key)).length;
        cnt.textContent = on ? on + ' of ' + nodes.length + ' selected' : nodes.length + ' profile' + (nodes.length === 1 ? '' : 's');
        cnt.classList.toggle('on', !!on);
        if (all) all.textContent = on === nodes.length ? 'Clear all' : 'Select all';
      };
      if (all) all.onclick = () => {
        const every = nodes.every(n => chosen.has(n.key));
        nodes.forEach(n => { if (every) chosen.delete(n.key); else chosen.add(n.key); });
        sync(); fire();
      };
      // Every account starts open. The dialog is sized to show them, and a
      // closed account is a profile you cannot see you have — which was most of
      // what made this picker feel like guesswork.
      const open = true;
      sec.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.onclick = () => {
        const next = !sec.classList.contains('open');
        head.setAttribute('aria-expanded', next ? 'true' : 'false');
        mkDisc(sec, w, inner, next);
      };
      sec.__sync();
      // Set synchronously, not in a rAF: a backgrounded tab never runs the
      // callback, and the group would then paint at its CSS height of 0 — an
      // empty picker. A fresh render should not animate anyway.
      if (open) w.style.height = 'auto';
      wrap.appendChild(sec);
    });
    if (topAll) {
      topAll.onclick = () => {
        const every = allKeys.every(k => chosen.has(k));
        allKeys.forEach(k => { if (every) chosen.delete(k); else chosen.add(k); });
        wrap.querySelectorAll('.mk-pick-chip').forEach(n => n.classList.toggle('on', chosen.has(n.dataset.tid)));
        wrap.querySelectorAll('.mk-pick-acct').forEach(x => { if (x.__sync) x.__sync(); });
        wrap.querySelectorAll('.mk-pick-acct').forEach(x => { if (x.__syncTop) x.__syncTop(); });
        box.dispatchEvent(new CustomEvent('mkchange'));
      };
    }
    box.appendChild(wrap);
    // paint the counts once everything is in the document
    const firstSec = wrap.querySelector('.mk-pick-acct');
    if (firstSec && firstSec.__syncTop) firstSec.__syncTop();
  }

  // Merge / Overwrite as a two-button segment rather than a dropdown. It stays
  // an explicit choice on every write surface — that rule is not negotiable —
  // but it stops being a full labelled form row inside a dialog whose whole
  // point is to be short.
  function mkModeSeg(kindLabel, onChange) {
    const wrap = el('div', 'mk-seg-wrap');
    const seg = el('div', 'mk-seg');
    let value = 'merge';
    const opts = [
      { v: 'merge', t: 'Merge', d: 'Add it and keep everything already on the profile.' },
      { v: 'mirror', t: 'Overwrite', d: 'Replace every ' + kindLabel + ' on the profile with just this one.' },
    ];
    const desc = el('div', 'mk-seg-d', opts[0].d);
    const btns = opts.map(o => {
      const b = el('button', 'mk-seg-b' + (o.v === value ? ' on' : ''), o.t);
      b.type = 'button';
      b.onclick = () => {
        if (value === o.v) return;
        value = o.v;
        btns.forEach((x, i) => x.classList.toggle('on', opts[i].v === value));
        desc.textContent = o.d;
        wrap.classList.toggle('danger', value === 'mirror');
        if (onChange) onChange();
      };
      seg.appendChild(b); return b;
    });
    wrap.appendChild(seg); wrap.appendChild(desc);
    return { node: wrap, value: () => value, onChange: fn => { onChange = fn; } };
  }

  // Add-ons are the one surface where what the user has in their clipboard is
  // usually NOT what Nuvio needs. An add-on site hands you its /configure page,
  // or a stremio:// link, or just its home page — and Nuvio stores whatever
  // string it is given without checking, so all three write a row that looks
  // added and then never loads. That is the "it says it added but it doesn't"
  // report, and this is the fix: resolve what was pasted to a real manifest
  // URL, prove it over the network, and show which URL is actually going to be
  // saved before anything is written.
  //
  // A manifest we cannot READ is not an error — plenty of working add-ons
  // refuse cross-origin reads, and Nuvio's own Add Plugin dialog never checks
  // either — so that case warns and still lets the write through. Only an
  // address that answers and is definitely not a manifest is called out.
  async function openAddToProfile(anchor, name, presetUrl) {
    const pop = openMkPop(anchor, 'Add ' + name, 'Paste the link its site gave you — Numax works out the manifest URL.');
    const mine = pop;
    const stale = () => mkPop !== mine;

    const f1 = el('label', 'mk-f'); f1.appendChild(el('span', '', 'Link from the add-on’s site'));
    const inp = el('input', 'modal-input'); inp.type = 'url'; inp.placeholder = 'https://…/configure';
    if (presetUrl) inp.value = presetUrl;
    f1.appendChild(inp); pop.body.appendChild(f1);
    const chk = el('div', 'mk-chk'); pop.body.appendChild(chk);

    const f2 = el('label', 'mk-f'); f2.appendChild(el('span', '', 'Name in Nuvio'));
    const nm = el('input'); nm.type = 'text'; nm.placeholder = 'Name in Nuvio'; nm.value = name;
    f2.appendChild(nm); pop.body.appendChild(f2);

    const tbox = el('div', 'mk-tgts'); pop.body.appendChild(tbox);

    pop.body.appendChild(el('div', 'mk-sec-t', 'How to write it'));
    const msel = mkModeSeg('add-on');
    pop.body.appendChild(msel.node);

    const st = el('div', 'inline-status'); st.style.marginTop = '10px'; pop.body.appendChild(st);
    const res = el('div', 'mk-res'); pop.body.appendChild(res);

    const go = el('button', 'btn btn-primary', 'Add'); go.style.width = '100%';
    pop.foot.appendChild(go);

    let targets = [];
    let resolved = null;       // the checked manifest URL, when we have one
    let probeSeq = 0;
    const chosen = new Set();
    const typed = () => inp.value.trim();
    // The URL that will actually be written: the proven one when the probe
    // found it, otherwise the best-guess rewrite of what was typed.
    const finalUrl = () => resolved || (MK.resolveManifestUrl(typed())[0] || typed());
    const ready = () => chosen.size > 0 && !!typed();

    const note = (cls, text, sub) => {
      clr(chk);
      chk.className = 'mk-chk ' + cls;
      const line = el('div', 'mk-chk-l', text);
      chk.appendChild(line);
      if (sub) chk.appendChild(el('div', 'mk-chk-s', sub));
    };
    const probe = async () => {
      const seq = ++probeSeq;
      const raw = typed();
      resolved = null;
      if (!raw) { clr(chk); chk.className = 'mk-chk'; reset(); return; }
      if (MK.resolveManifestUrl(raw).length === 0) { note('bad', 'That is not a web address.'); reset(); return; }
      note('wait', 'Checking that link…');
      let r;
      try { r = await MK.probeManifest(raw); } catch (e) { r = { ok: false, reason: 'blocked' }; }
      if (stale() || seq !== probeSeq) return;
      if (r.ok) {
        resolved = r.url;
        const v = r.manifest.version ? ' v' + r.manifest.version : '';
        note('ok', 'Found ' + (r.manifest.name || 'this add-on') + v, 'Saving: ' + r.url);
        // Only fill the name if it is still the catalogue's generic one — a
        // name the user typed themselves is never overwritten.
        if (r.manifest.name && (nm.value === name || !nm.value.trim())) nm.value = r.manifest.name;
      } else if (r.reason === 'blocked') {
        note('warn', 'Could not check this from here.',
          'That is normal — many add-ons block outside reads. Saving: ' + finalUrl());
      } else {
        note('bad', 'No add-on manifest at that address.',
          'Open the add-on’s site, configure it, and copy the install link it gives you. You can still add it as-is.');
      }
      reset();
    };
    let probeT = null;
    const schedule = () => { clearTimeout(probeT); probeT = setTimeout(probe, 450); };

    const run = () => {
      const url = finalUrl();
      if (!/^https?:\/\//i.test(url)) { status(st, 'That doesn’t look like a URL.', 'err'); return; }
      mkWrite({
        kind: 'addons', master: [{ url, name: nm.value.trim() || name, enabled: true }],
        targets: targets.filter(t => chosen.has(t.aid + ':' + t.idx)),
        mode: msel.value(), st, res, btn: go, label: name,
      });
    };
    const reset = mkBindApply(go, res, st, 'Add', run, ready);
    msel.onChange(reset);
    inp.addEventListener('input', () => { resolved = null; reset(); schedule(); });
    inp.addEventListener('blur', () => { clearTimeout(probeT); probe(); });
    inp.addEventListener('paste', () => setTimeout(probe, 0));

    const got = await mkFillTargets(tbox, chosen, reset, stale, { label: 'Add to' });
    if (stale()) return;
    if (!got) { go.disabled = true; return; }
    targets = got;
    reset();
    if (presetUrl) probe(); else setTimeout(() => { try { inp.focus(); } catch (e) {} }, 60);
  }

  // Plugins get the same dialog add-ons do. They used to install from a block
  // at the bottom of the repo detail card, underneath as many as 200 scraper
  // rows — so "install this" meant scrolling to the end of the page to find the
  // profile list. Nothing about the write changes; only where the controls are.
  async function openInstallPlugin(anchor, p, manifestName) {
    const label = manifestName || p.name;
    const pop = openMkPop(anchor, 'Install ' + label, 'Nuvio stores the whole repository; which providers inside it run is chosen on the device.');
    const mine = pop;
    const stale = () => mkPop !== mine;

    const u = el('div', 'mk-chk ok');
    u.appendChild(el('div', 'mk-chk-l', 'Saving: ' + p.manifestUrl));
    pop.body.appendChild(u);
    const dn = el('div', 'mk-note');
    dn.innerHTML = MK_INFO_SVG + '<div>' + WZ_PLUGIN_ONDEVICE + '</div>';
    pop.body.appendChild(dn);

    const tbox = el('div', 'mk-tgts'); pop.body.appendChild(tbox);

    pop.body.appendChild(el('div', 'mk-sec-t', 'How to write it'));
    const msel = mkModeSeg('plugin');
    pop.body.appendChild(msel.node);

    const st = el('div', 'inline-status'); st.style.marginTop = '10px'; pop.body.appendChild(st);
    const res = el('div', 'mk-res'); pop.body.appendChild(res);
    const go = el('button', 'btn btn-primary', 'Install'); go.style.width = '100%';
    pop.foot.appendChild(go);

    let targets = [];
    const chosen = new Set();
    const run = () => mkWrite({
      kind: 'plugins',
      master: [{ url: p.manifestUrl, name: label, enabled: true }],
      targets: targets.filter(t => chosen.has(t.aid + ':' + t.idx)),
      mode: msel.value(), st, res, btn: go, label,
    });
    const reset = mkBindApply(go, res, st, 'Install', run, () => chosen.size > 0);
    msel.onChange(reset);
    const got = await mkFillTargets(tbox, chosen, reset, stale, { label: 'Install to' });
    if (stale()) return;
    if (!got) { go.disabled = true; return; }
    targets = got;
    reset();
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
  // `keepOrder` (Setup Wizard only) means the caller has already decided every
  // row's sort_order — used when an add-on has to land ABOVE what is installed,
  // which the append-at-the-end arithmetic below cannot express. Nothing in the
  // Marketplace passes it, so its behaviour is unchanged.
  async function mkWrite(o) {
    const { kind, master, targets, mode, st, res, btn, label, aid, keepOrder, onDone, auto } = o;
    btn.disabled = true; clr(res); status(st, 'Reading target profiles…');
    const plans = [];
    try {
      // One fresh export PER ACCOUNT, not per target. Ticking four profiles on
      // one account used to fire four whole-account exports back to back, each
      // of them a quarter-megabyte, behind a 120 ms throttle — which is most of
      // what made "Reading target profiles…" feel slow.
      const reads = new Map();
      for (const t of targets) {
        if (!reads.has(t.aid)) reads.set(t.aid, (await loadAccount(t.aid, true)).backup);
        const backup = reads.get(t.aid);
        const state = sliceProfile(backup, t.idx);
        // Append after whatever is already there rather than jumping to the top —
        // but if this URL is already on the profile keep its existing position,
        // so re-adding something reads as "no change" instead of reordering it.
        const existing = new Map((state[kind] || []).map(x => [x.url, x]));
        const base = (state[kind] || []).reduce((m, x) => Math.max(m, Number(x.sort_order) || 0), 0);
        const rows = keepOrder ? master.map(m => ({ ...m })) : master.map((m, i) => {
          const had = existing.get(m.url);
          return { ...m, sort_order: had ? (had.sort_order ?? 0) : base + 1 + i };
        });
        const plan = E.planTarget({ [kind]: rows }, state, {
          categories: { [kind]: true }, modes: { [kind]: mode },
          profileId: t.idx, originClientId: 'numax-web',
        });
        plans.push({ t, plan });
      }
    } catch (e) { status(st, 'Failed: ' + e.message, 'err'); btn.disabled = false; return { written: false, ok: false }; }

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
    if (!anyChange) { status(st, 'Already there — nothing to do.', 'ok'); btn.disabled = true; return { written: false, ok: true }; }

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
    const doWrite = async () => {
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
      if (typeof onDone === 'function') onDone(!fails.length);
      if (pfA && pfI != null) openProfile(pfA, pfI, true);
      return { written: true, ok: !fails.length };
    };
    btn.onclick = doWrite;
    // `auto` (Setup Wizard only) skips the second click when there is nothing
    // to confirm. It NEVER skips the removal gate: if this plan would delete
    // anything the profile has, anyRemoval is true, the tick is still required
    // and the caller still has to click. The wizard only ever merges a single
    // add-on into a profile, so in practice that gate is simply never reached.
    if (auto && !anyRemoval) return doWrite();
    return { written: false, ok: true };
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
      ? mkProviders.filter(p => (p.name + ' ' + p.lang + ' ' + p.manifestUrl + ' ' + ((p.owner && p.owner.login) || '')).toLowerCase().includes(q))
      : mkProviders;
    if (q) $('mk-prov-count').textContent = list.length + ' of ' + mkProviders.length + ' repos';
    if (!list.length) { box.appendChild(el('p', 'mk-find-none', 'No repo matches \u201c' + q + '\u201d.')); return; }
    const grid = el('div', 'mk-prov-grid'); box.appendChild(grid);
    list.forEach(p => {
      const row = el('div', 'mk-prov'); row.dataset.url = p.manifestUrl;
      const ic = mkLogo(p.name, p.logo);
      if (p.owner) ic.title = p.owner.login + ' on ' + p.owner.forge;
      const b = el('div', 'mk-pb');
      b.appendChild(el('div', 'mk-pn', p.name));
      const meta = el('div', 'mk-pm', 'checking…'); b.appendChild(meta);
      const lang = el('span', 'mk-lang', p.lang.replace(/ language$/i, ''));
      const open = el('button', 'btn btn-ghost btn-xs', 'View');
      open.onclick = () => openProvider(p);
      const inst = el('button', 'btn btn-primary btn-xs', 'Install');
      inst.onclick = () => openInstallPlugin(inst, p);
      row.appendChild(ic); row.appendChild(b); row.appendChild(lang); row.appendChild(open); row.appendChild(inst);
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
    sum.appendChild(mkLogo((m && m.name) || p.name, p.logo));
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

    // ---- install, above the fold ----
    // One button that opens the shared dialog. The profile list, the
    // merge/overwrite choice and the report used to be rendered inline here,
    // which put them below however many scrapers this repo has.
    const inst = el('div', 'mk-install');
    const go = el('button', 'btn btn-primary', 'Install to profiles…');
    go.onclick = () => openInstallPlugin(go, p, m && m.name);
    inst.appendChild(go);
    inst.appendChild(el('p', 'muted sm', 'Pick the profiles, and merge or overwrite, in the next step.'));
    body.appendChild(inst);

    // ---- scrapers, collapsed: context, not the main event ----
    if (m) {
      const d = mkDisclosure('What you get',
        m.scrapers.length + ' scraper' + (m.scrapers.length === 1 ? '' : 's') + ' — Nuvio installs the whole repo');
      const note = el('div', 'mk-note');
      note.innerHTML = MK_INFO_SVG
        + '<div>Nuvio stores a plugin as the whole repository, so all ' + m.scrapers.length + ' of these come with it. <b>Which of them actually run is chosen on the device</b> — Settings → Content &amp; Discovery → Plugins. Those switches are not part of what a Nuvio account syncs, so nothing here can set them.</div>';
      d.body.appendChild(note);
      const srcW = el('div', 'mk-scroll');
      m.scrapers.slice(0, 200).forEach(sc => {
        const r = el('div', 'mk-scr');
        r.appendChild(mkLogo(sc.name || sc.id, sc.logo, 'mk-ic-s'));
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

  }

  // ---- collections ----
  // Browse from the manually-refreshed light snapshot (market.js
  // loadCollectionsSnapshot); install by reading that same collection's full
  // payload (market.js loadCollectionInstall) and writing it through the same
  // engine.planTarget + api.applyPlan path as everything else — see market.js
  // for why a once-captured snapshot is as good as a live read here.
  let mkCollectionsCache = null;
  let mkCollectionsFellBack = '';   // why we are on the snapshot, when a relay exists

  // A usable Nuvio session access token from any linked account — what the
  // collections relay forwards. api.js already rotates and persists a refreshed
  // token; this only has to make sure the one we hand over is not about to
  // expire. Nothing here is a new credential: it is the same token this browser
  // already sends to api.nuvio.tv on every other call.
  async function nuvioToken() {
    const recs = store.list();
    for (const rec of recs) {
      const s = rec.session; if (!s || !s.access_token) continue;
      const nowSec = Math.floor(Date.now() / 1000);
      if (s.expires_at && s.expires_at - nowSec <= 60) {
        if (!s.refresh_token) continue;
        try {
          const fresh = await A.refresh(s.refresh_token);
          store.updateSession(rec.accountId, fresh);
          return fresh.access_token;
        } catch (e) { continue; }
      }
      return s.access_token;
    }
    return null;
  }

  // Live through the relay when one is deployed, the captured snapshot when it
  // is not or when it fails — and `mkCollectionsFellBack` records WHY, because
  // the banner has to name which of the two is on screen. Shared with the Setup
  // Wizard's metadata step so there is one read, one cache and one fallback
  // rule rather than a second copy that could drift out of step with this one.
  async function mkLoadCollections(force) {
    if (mkCollectionsCache && !force) return mkCollectionsCache;
    mkCollectionsFellBack = '';
    if (MK.COLLECTIONS.relayReady && MK.COLLECTIONS.relayReady()) {
      try { mkCollectionsCache = await MK.loadCollectionsLive(await nuvioToken(), force); return mkCollectionsCache; }
      catch (e) { mkCollectionsFellBack = e.message; }
    }
    mkCollectionsCache = await MK.loadCollectionsSnapshot(force);
    return mkCollectionsCache;
  }

  async function renderMkCollections(force) {
    const box = $('mk-collections');
    const live = MK.COLLECTIONS.relayReady && MK.COLLECTIONS.relayReady();
    if (!mkCollectionsCache || force) {
      clr(box); box.appendChild(el('p', 'muted sm shimmer', live ? 'Reading community collections…' : 'Reading the collections snapshot…'));
      {
        try { await mkLoadCollections(force); }
        catch (e) {
          clr(box);
          // A same-origin fetch that comes back as anything but JSON is nearly
          // always a sign-in wall in front of the site, not a missing file —
          // say so, because "malformed" sends you looking in the wrong place.
          const wall = /JSON|Unexpected token|malformed|unreachable/i.test(e.message);
          box.appendChild(el('p', 'empty sm err-text', 'Could not read the collections list: ' + e.message));
          if (wall) box.appendChild(el('p', 'muted sm', 'If this page has been open a long time, its sign-in may have expired — reload the page and try again.'));
          const again = el('button', 'btn btn-ghost btn-xs', 'Try again');
          again.onclick = () => renderMkCollections(true);
          box.appendChild(again);
          return;
        }
      }
    }
    clr(box);

    const isLive = !!mkCollectionsCache.live;
    const when = mkCollectionsCache.capturedAt ? new Date(mkCollectionsCache.capturedAt).toLocaleString() : 'unknown time';
    // The caveat is real and must stay readable, but it was a four-line wall of
    // text sitting above every visit. One line now, with the detail a click away.
    const n = el('div', 'mk-note mk-note-row');
    n.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/></svg>'
      + (isLive
        ? '<span class="mk-note-line"><b>Live from Nuvio</b> — ' + mkCollectionsCache.total + ' collections, read just now.'
        // A short read is stated, never smoothed over: the API pages, and
        // a page that failed halfway must not look like the whole catalogue.
        + (mkCollectionsCache.short ? ' Nuvio lists ' + mkCollectionsCache.short + ' — the rest did not come back, so this is incomplete.' : '') + '</span>'
        : '<span class="mk-note-line"><b>Snapshot, not live</b> — captured ' + esc(when) + ', ' + mkCollectionsCache.total + ' collections.'
          + (mkCollectionsFellBack ? ' The live read failed (' + esc(mkCollectionsFellBack) + ').' : '') + '</span>');
    const why = el('div', 'mk-note-why', MK.COLLECTIONS.why);
    const more = el('button', 'link', 'Why?');
    more.onclick = () => { const on = n.classList.toggle('open'); more.textContent = on ? 'Hide' : 'Why?'; };
    const brw = el('button', 'link', 'Browse on Nuvio');
    brw.onclick = () => { openTab(MK.COLLECTIONS.site); logAct('Opened Nuvio community collections', 'info'); };
    const acts = el('span', 'mk-note-acts');
    if (!isLive) acts.appendChild(more);
    acts.appendChild(brw);
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
  let mkCollLastQ = '';
  function renderMkCollGrid() {
    const grid = mkCollGrid; if (!grid || !mkCollectionsCache) return;
    clr(grid);
    const inp = $('mk-coll-search');
    const q = ((inp && inp.value) || '').trim().toLowerCase();
    const find = inp && inp.closest('.mk-find');
    if (find) find.classList.toggle('has-q', !!q);
    const sort = ($('mk-coll-sort') && $('mk-coll-sort').value) || 'installs';
    const all = mkCollectionsCache.items || [];
    // A new query is a new list; carrying "show all" across it would defeat
    // the point of narrowing.
    if (q !== mkCollLastQ) { mkCollShowAll = false; mkCollLastQ = q; }
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
    // Ninety-nine cards at once is a wall, and it is also ninety-nine remote
    // images. Show a page; the search box above is the real way through the
    // list, and "Show all" is one click for anyone who would rather scroll.
    const page = mkCollShowAll ? items.length : Math.min(items.length, MK_COLL_PAGE);
    items.slice(0, page).forEach(c => grid.appendChild(renderMkCollCard(c)));
    if (page < items.length) {
      const more = el('button', 'btn btn-ghost mk-coll-more-btn', 'Show all ' + items.length + ' collections');
      more.onclick = () => { mkCollShowAll = true; renderMkCollGrid(); };
      grid.appendChild(more);
    }
  }
  const MK_COLL_PAGE = 36;
  let mkCollShowAll = false;

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
      const names = c.requiredAddons.map(a => a.addonName || a.addonId);
      const req = el('div', 'mk-coll-req', 'Needs: ' + names.join(', '));
      req.title = names.join(', ');   // the full list is a hover away, not a paragraph
      body.appendChild(req);
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

    const got = await loadInto(pop.body, 'Reading collection…', async () => {
      // Live when a relay is deployed, the captured file otherwise — and if
      // live fails, fall through rather than dead-end on a working fallback.
      if (MK.COLLECTIONS.relayReady && MK.COLLECTIONS.relayReady()) {
        try { return await MK.loadCollectionInstallLive(c.public_id, await nuvioToken()); }
        catch (e) { /* fall through to the captured payload */ }
      }
      return MK.loadCollectionInstall(c.public_id);
    }, { stale, prefix: 'Could not read this collection: ' });
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

    pop.body.appendChild(el('div', 'mk-sec-t', 'Install to'));
    const tbox = el('div', 'mk-tgts'); pop.body.appendChild(tbox);

    pop.body.appendChild(el('div', 'mk-sec-t', 'How to add the collection'));
    const msel = mkModeSeg('collection');
    pop.body.appendChild(msel.node);

    const already = el('div'); pop.body.appendChild(already);
    const st = el('div', 'inline-status'); st.style.marginTop = '10px'; pop.body.appendChild(st);
    const res = el('div', 'mk-res'); pop.body.appendChild(res);
    // Pinned to the dialog footer rather than sitting at the end of a body that
    // scrolls — the action must never be the thing you have to scroll to find.
    const btn = el('button', 'btn btn-primary', 'Preview'); btn.style.width = '100%';
    pop.foot.appendChild(btn);

    // Same account-grouped picker the other two tabs use, in single-select
    // mode: the install path plans and applies one profile at a time.
    const chosen = new Set();
    // Any change to the target or the mode invalidates a previous preview.
    const reset = () => { btn.textContent = 'Preview'; btn.onclick = preview; btn.disabled = !chosen.size; clr(res); status(st, ''); };
    msel.onChange(reset);
    const targets = await mkFillTargets(tbox, chosen, reset, stale, { single: true });
    if (stale()) return;
    if (!targets) { btn.disabled = true; return; }
    // Nothing is preselected when there is real ambiguity; with one profile
    // linked, preselecting it saves a pointless click.
    if (targets.length === 1) chosen.add(targets[0].aid + ':' + targets[0].idx);
    mkTargetList(tbox, targets, chosen, { single: true });
    reset();

    async function preview() {
      const pick = [...chosen][0];
      if (!pick) { status(st, 'Pick a profile first.', 'err'); return; }
      const [aid, iStr] = pick.split(':'); const idx = parseInt(iStr, 10);
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
      } catch (e) { status(st, 'Failed: ' + e.message, 'err'); }
    }
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
  // SETUP WIZARD
  // ======================================================================
  // Content and catalogues live in wizard.js (read-only, owns no state). This
  // is the controller: it drives the step rail and performs writes — and every
  // write reuses a path that already exists and is already verified.
  //
  //   profile create -> sync_push_profiles, after a pull that proves every
  //                     existing profile_index survives (the rule in CLAUDE.md;
  //                     this RPC is a whole-account full replace)
  //   API keys       -> pushProviderCredentials (api.js), the same call Sync
  //                     Desk's applyCredentials uses
  //   toggles        -> the profile blob + sync_push_profile_settings_blob,
  //                     read-modify-write, guarded where we know updated_at
  //   add-ons        -> engine.planTarget + api.applyPlan via mkWrite, exactly
  //                     as the Marketplace does, so Merge/Overwrite, removal
  //                     confirmation and per-item failure reporting are shared
  const WZ = window.NumaxWizard || null;
  const WZ_STEPS = ['account', 'keys', 'streams', 'meta', 'done'];
  // Everything the wizard knows about the run in progress. Reset when the
  // target profile changes, so a summary can never describe a different profile.
  //
  // `undo` is what makes Exit honest. The target profile is a free choice right
  // up until the wizard writes something to it; after that it is a commitment,
  // because half a setup on one profile and half on another is worse than
  // either. So the first successful write locks the picker, and the only way
  // back out is Exit — which puts the profile back the way it was.
  //
  // The snapshot is taken PER SURFACE, immediately before that surface is first
  // written, and never again. What Numax holds is therefore exactly the
  // pre-run state of exactly the things the wizard touched — in particular it
  // never holds the value of a credential the wizard did not go on to change.
  const wzBlank = () => ({
    step: 'account', aid: null, idx: null, mode: null, host: null, route: null, debrid: null,
    done: [], entry: null, locked: false, madeProfile: null, madeAccount: null,
    undo: { creds: new Map(), blobs: new Map(), addons: null, plugins: null, collections: null },
  });
  let wz = wzBlank();

  const wzTarget = () => (wz.aid && wz.idx != null) ? { aid: wz.aid, idx: wz.idx, name: wzProfileName() } : null;
  function wzProfileName() {
    const p = (wzProfiles || []).find(x => x.index === wz.idx);
    if (p) return p.name;
    const rec = cache[wz.aid];
    const c = rec && rec.profiles.find(x => x.index === wz.idx);
    return c ? c.name : 'Profile ' + wz.idx;
  }
  // Every successful write ends here. The "This run" box is repainted straight
  // away because it costs nothing, and the rest of the panel re-reads — the
  // write paths have just called inval() on the account, so that read is fresh.
  function wzLog(what) {
    wz.done.push(what);
    const run = document.querySelector('#wz-panel .wz-pnl-run');
    if (run) wzPaintRun(run);
    wzRenderPanel();
  }

  // ---- lock ---------------------------------------------------------------
  // Called by every path that has just written something. Repaints only the
  // chrome that changes (the target strip and the step-1 pickers) rather than
  // re-running wzShow, which would re-read the account mid-write.
  function wzLock() {
    if (wz.locked) return;
    wz.locked = true;
    wzPaintTarget();
    wzPaintEntry();
    logAct('Wizard: locked to profile ' + wzProfileName() + ' — first change written', 'info');
  }

  // ---- snapshots ----------------------------------------------------------
  // Each of these records the pre-run state of one surface, once. They throw on
  // failure, and every caller treats that as "do not write": a change that
  // cannot be undone is not one the wizard is allowed to make.
  // `specs` is [{ provider, field }]. The field matters as much as the value:
  // a provider that had NOTHING before cannot be put back by writing an empty
  // object — Nuvio rejects that outright with 22023 "Invalid credential payload
  // for provider: x" (probed live 2026-09-11, and there is no delete-credential
  // RPC and no table access either). Writing the provider's own field as an
  // empty string is accepted, so that is what "clear it" has to mean, and the
  // field name has to be remembered here to do it.
  async function wzSnapCreds(c, idx, specs) {
    const need = specs.filter(x => !wz.undo.creds.has(x.provider));
    if (!need.length) return;
    const live = await c.pullProviderCredentials(idx);
    need.forEach(x => {
      const row = live.find(r => r.provider === x.provider);
      wz.undo.creds.set(x.provider, {
        field: x.field,
        prior: row ? JSON.parse(JSON.stringify(row.credential_json)) : null,
      });
    });
  }
  function wzSnapBlob(platform, row) {
    if (wz.undo.blobs.has(platform)) return;
    wz.undo.blobs.set(platform, (row && row.settings_json) ? JSON.parse(JSON.stringify(row.settings_json)) : null);
  }
  async function wzSnapAddons(t) { return wzSnapList(t, 'addons'); }
  async function wzSnapPlugins(t) { return wzSnapList(t, 'plugins'); }
  async function wzSnapCollections(t) { return wzSnapList(t, 'collections'); }
  // Same rule as the credential snapshot above: once, immediately before that
  // surface is first written, and never again — so what Numax holds is the
  // pre-run state of exactly the things the wizard went on to change. A
  // snapshot that throws BLOCKS the write; every caller treats it that way.
  async function wzSnapList(t, kind) {
    if (wz.undo[kind]) return;
    const { backup } = await loadAccount(t.aid, true);
    wz.undo[kind] = JSON.parse(JSON.stringify(sliceProfile(backup, t.idx)[kind] || []));
  }

  // ---- exit = undo --------------------------------------------------------
  // Spells out what will be put back BEFORE doing it, and asks separately about
  // the one thing that cannot be taken back: deleting a profile the wizard
  // created, which takes everything on it with it.
  async function wzExitAndUndo() {
    if (!wz.locked) { wzResetRun(); return; }
    const name = wzProfileName();
    const details = [];
    if (wz.undo.addons) details.push('Add-ons go back to the <b>' + wz.undo.addons.length + '</b> this profile had before the wizard started.');
    if (wz.undo.plugins) details.push('Plugin repositories go back to the <b>' + wz.undo.plugins.length + '</b> it had before.');
    if (wz.undo.collections) details.push('Collections go back to the <b>' + wz.undo.collections.length + '</b> it had before.');
    if (wz.undo.creds.size) {
      const back = [...wz.undo.creds.values()].filter(v => v && v.prior).length;
      const clear = wz.undo.creds.size - back;
      if (back) details.push('<b>' + back + '</b> key(s) go back to the value they had.');
      if (clear) details.push('<b>' + clear + '</b> key(s) are emptied — there was nothing stored for them before, and Nuvio has no way to remove a credential row entirely.');
    }
    if (wz.undo.blobs.size) details.push('Settings for <b>' + [...wz.undo.blobs.keys()].map(wzPlatLabel).join(', ') + '</b> go back to what they were.');
    if (wz.madeAccount) details.push('The Nuvio account the wizard created <b>cannot be deleted</b> from here — it stays, and stays linked in Numax.');
    if (!details.length) details.push('Nothing was written to Nuvio yet, so there is nothing to put back.');
    if (!(await uiModal({
      title: 'Undo everything the wizard wrote to “' + name + '”?',
      message: 'This puts the profile back the way it was before this run, then starts the wizard over.',
      details, okLabel: 'Undo and exit', danger: true,
    }))) return;

    let killProfile = false;
    if (wz.madeProfile != null) {
      killProfile = await uiModal({
        title: 'Also delete the profile “' + name + '”?',
        message: 'The wizard created this profile during this run. Deleting it removes the profile and everything on it from Nuvio, and that cannot be taken back.',
        details: [
          'Choosing <b>Keep it</b> leaves an empty profile behind, which is safe — you can delete it in Nuvio later.',
          'Numax has no backup of this profile: it did not exist before this run.',
        ],
        okLabel: 'Delete the profile', danger: true,
      });
    }

    const r = await wzRunUndo(killProfile);
    await uiModal({
      title: r.problems.length ? 'Undone, with problems' : 'Put back',
      message: r.problems.length
        ? 'Some of it went back; the rest is listed below and needs sorting out by hand.'
        : 'Everything the wizard wrote to this profile has been put back.',
      details: r.lines.concat(r.problems.map(x => '<b>Problem:</b> ' + esc(x))),
      okLabel: 'Close', noCancel: true, danger: !!r.problems.length,
    });
    logAct('Wizard: exit — undo finished with ' + r.problems.length + ' problem(s)', r.problems.length ? 'err' : 'ok');
    wzResetRun();
  }

  // Every restore reuses the path that made the change in the first place:
  // add-ons through engine.planTarget + api.applyPlan (overwrite, so anything
  // the wizard added comes back off), settings through the guarded blob RPC,
  // keys through sync_push_provider_credentials. No new write mechanism.
  // How the engine identifies a row on each list surface, which is also how a
  // read-back has to compare one. Add-ons and plugins are keyed by URL;
  // collections are not URL-shaped at all and the engine keys them by id (the
  // id market.js's toInstalledCollection sets, which is stable).
  const WZ_LIST_KEY = {
    addons: x => String(x && x.url),
    plugins: x => String(x && x.url),
    collections: x => (x && x.id != null) ? 'id:' + x.id : JSON.stringify(x),
  };
  // Put one list surface back exactly as it was. One copy, shared by all three,
  // because there are two things here that were got wrong the first time and
  // both reported success while doing nothing:
  //
  //   - The engine's exact-replace mode is 'mirror'. Anything that is NOT
  //     'mirror' falls through to merge, silently — so the item being undone
  //     survived while the summary said it had gone.
  //   - A push answers 204 with no body, so "the server didn't error" is not
  //     evidence. The list is read back and compared before anything is
  //     reported as put back.
  async function wzUndoList(c, t, kind, prior, label, lines, problems) {
    const keyOf = WZ_LIST_KEY[kind];
    try {
      const { backup } = await loadAccount(t.aid, true);
      const plan = E.planTarget({ [kind]: prior }, sliceProfile(backup, t.idx), {
        categories: { [kind]: true }, modes: { [kind]: 'mirror' },
        profileId: t.idx, originClientId: 'numax-web',
      });
      if (!plan.hasChanges) { lines.push(label + ' were already back as they were.'); return; }
      const rr = await c.applyPlan(plan, { dryRun: false });
      const bad = (rr.results || []).filter(x => !x.ok);
      if (bad.length) { problems.push(label + ': ' + bad.map(b => b.error).join('; ')); return; }
      const fresh = await loadAccount(t.aid, true);
      const now = (sliceProfile(fresh.backup, t.idx)[kind] || []).map(keyOf).sort();
      const want = prior.map(keyOf).sort();
      const same = now.length === want.length && now.every((k, i) => k === want[i]);
      if (!same) {
        const extra = now.filter(k => want.indexOf(k) < 0);
        problems.push(label + ' did not go back' + (extra.length ? ' — still on the profile: ' + extra.join(', ') : '') + '.');
      } else lines.push(label + ' put back — ' + prior.length + ' on the profile again, checked.');
    } catch (e) { problems.push(label + ': ' + e.message); }
  }

  async function wzRunUndo(killProfile) {
    const t = { aid: wz.aid, idx: wz.idx, name: wzProfileName() };
    const lines = [], problems = [];
    if (!t.aid || t.idx == null) return { lines: ['Nothing to put back.'], problems };
    const c = A.client(store, t.aid);

    if (wz.undo.addons) await wzUndoList(c, t, 'addons', wz.undo.addons, 'Add-ons', lines, problems);
    if (wz.undo.plugins) await wzUndoList(c, t, 'plugins', wz.undo.plugins, 'Plugin repositories', lines, problems);
    if (wz.undo.collections) await wzUndoList(c, t, 'collections', wz.undo.collections, 'Collections', lines, problems);

    for (const [platform, prior] of wz.undo.blobs) {
      try {
        const row = await c.pullSettings(t.idx, platform);
        const body = prior || { version: WZ_BLOB_VERSION[platform] || 1, features: {} };
        if (row && row.settings_json) {
          await c.rpc('sync_push_profile_settings_blob_guarded', {
            p_profile_id: t.idx, p_settings_json: body, p_platform: platform,
            p_expected_updated_at: row.updated_at || null,
          });
        } else {
          await c.rpc('sync_push_profile_settings_blob', {
            p_profile_id: t.idx, p_settings_json: body, p_platform: platform, p_origin_client_id: 'numax-web',
          });
        }
        lines.push(prior
          ? wzPlatLabel(platform) + ' settings put back.'
          : wzPlatLabel(platform) + ' had no settings before — the switches are off again, but the (empty) row Nuvio created stays, because there is no way to remove one.');
      } catch (e) { problems.push(wzPlatLabel(platform) + ' settings: ' + e.message); }
    }

    if (wz.undo.creds.size) {
      // No delete-credential RPC exists and the table itself is permission-denied
      // (both probed live 2026-09-11), so a provider that had nothing before is
      // emptied rather than removed — said out loud below rather than glossed.
      const entries = [...wz.undo.creds.entries()];
      const creds = entries.map(([provider, rec]) => ({
        provider, credential_json: rec.prior || { [rec.field || 'api_key']: '' },
      }));
      try {
        await c.pushProviderCredentials(t.idx, creds, 'numax-web');
        // A push answers 204, which proves nothing — read it back.
        const live = await c.pullProviderCredentials(t.idx);
        const stuck = [];
        entries.forEach(([provider, rec]) => {
          const want = rec.prior || { [rec.field || 'api_key']: '' };
          const row = live.find(r => r.provider === provider);
          const got = (row && row.credential_json) || {};
          if (Object.keys(want).some(f => String(got[f] || '') !== String(want[f] || ''))) stuck.push(provider);
        });
        const back = entries.filter(([, rec]) => !!rec.prior).length;
        if (back) lines.push(back + ' key(s) put back to their previous value.');
        if (entries.length - back) lines.push((entries.length - back) + ' key(s) emptied — Nuvio has no way to remove a credential row, so an empty one stays where there was none.');
        if (stuck.length) problems.push('These keys did not go back and are still set in Nuvio: ' + stuck.join(', '));
      } catch (e) { problems.push('API keys: ' + e.message); }
    }

    if (killProfile && wz.madeProfile != null) {
      try {
        const read = await wzReadProfiles(t.aid);
        if (!read.crossChecked) throw new Error('could not double-check the profile list against Nuvio, and removing a profile rewrites the whole list — not risking it');
        if (!read.idx.includes(wz.madeProfile)) throw new Error('that profile is not on the account any more');
        const keep = read.idx.filter(i => i !== wz.madeProfile);
        const nextList = read.rows.map(normRow).filter(r => r.profile_index !== wz.madeProfile);
        const missing = keep.filter(i => !nextList.some(x => x.profile_index === i));
        if (missing.length) throw new Error('safety check failed — profile ' + missing.join(', ') + ' would have been lost too');
        await c.rpc('sync_push_profiles', { p_profiles: nextList, p_client_max_profiles: 6 });
        inval(t.aid);
        const after = await wzReadProfiles(t.aid);
        const lost = keep.filter(i => !after.idx.includes(i));
        if (lost.length) throw new Error('profile ' + lost.join(', ') + ' went missing — restore from a Drive backup straight away');
        if (after.idx.includes(wz.madeProfile)) throw new Error('Nuvio accepted the write but the profile is still there');
        lines.push('Deleted the profile the wizard created.');
      } catch (e) { problems.push('Profile delete: ' + e.message); }
    } else if (wz.madeProfile != null) {
      lines.push('Kept the profile the wizard created — it is empty now.');
    }

    inval(t.aid);
    if (!lines.length) lines.push('Nothing had been written, so nothing needed putting back.');
    return { lines, problems };
  }

  // Back to a clean run: wizard state, every built-in-place pane, every field.
  function wzResetRun() {
    wz = wzBlank();
    wzSavedKeys.clear();
    wzVerified.clear();
    ['keys', 'streams', 'meta'].forEach(k => { wzPending[k].length = 0; });
    ['wz-entry', 'wz-keys', 'wz-meta', 'wz-collections', 'wz-modes', 'wz-routes', 'wz-instances',
     'wz-native-debrid', 'wz-p2p', 'wz-plugins', 'wz-aio-install', 'wz-p2p-install',
     'wz-sim-install', 'wz-sim-result', 'wz-native-res', 'wz-keys-res', 'wz-summary']
      .forEach(id => { const n = $(id); if (n) { n.dataset.built = ''; clr(n); } });
    // The TorBox box keeps its own built flag (its tick is wired to it, not to
    // a container), so it is cleared by value and by flag, not by clr().
    const simKey = $('wz-sim-key'); if (simKey) simKey.dataset.built = '';
    wzNativeRecheck = null;
    ['wz-native-key', 'wz-sim-key', 'wz-prof-name', 'wz-new-email', 'wz-new-pass', 'wz-new-pass2', 'wz-new-label']
      .forEach(id => { const n = $(id); if (n) n.value = ''; });
    ['wz-keyv-sim', 'wz-keyv-native'].forEach(id => { const n = $(id); if (n) { n.textContent = ''; n.className = 'wz-key-v'; } });
    ['wz-chk-sim', 'wz-chk-native'].forEach(id => { const n = $(id); if (n) { n.className = 'wz-chk idle'; n.innerHTML = ''; n.title = ''; } });
    ['wz-keys-status', 'wz-native-status', 'wz-sim-status', 'wz-profile-status', 'wz-new-status',
     'wz-inst-status'].forEach(id => { const n = $(id); if (n) status(n, ''); });
    ['wz-sim-result', 'wz-sim-install', 'wz-mode-simple', 'wz-mode-advanced', 'wz-route-aiostreams',
     'wz-route-native', 'wz-route-plugins', 'wz-newprof'].forEach(id => { const n = $(id); if (n) n.style.display = 'none'; });
    if ($('wz-account')) $('wz-account').disabled = false;
    refreshWizard();
  }

  // ---- reading the profile list -----------------------------------------
  // Deliberately NOT loadAccount(): that runs sync_export_account_backup, a
  // whole-account export the picker does not need, and which is the most
  // likely call to fail on an account that has never synced from a device.
  // sync_pull_profiles is small and is the same read the create path uses.
  //
  // TWO independent reads, and they must agree. get_sync_overview returns its
  // own profile map from a different query, so a short or partial read from
  // either one is caught instead of being trusted. This matters because the
  // create path below does a WHOLE-ACCOUNT FULL REPLACE: a list that is missing
  // profiles is not a display glitch there, it is data loss.
  let wzProfiles = null, wzProfGen = 0;
  async function wzReadProfiles(aid) {
    const c = A.client(store, aid);
    const [live, overview] = await Promise.all([
      withTimeout(c.pullProfiles(), READ_TIMEOUT, 'Reading profiles'),
      c.rpc('get_sync_overview', {}).catch(() => null),   // cross-check only; never fatal on its own
    ]);
    const rows = rawList(live);
    const idx = rows.map(r => r.profile_index).filter(n => n != null).sort((a, b) => a - b);
    let crossChecked = false;
    if (overview && overview.profiles && typeof overview.profiles === 'object') {
      const other = Object.keys(overview.profiles).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      if (other.join() !== idx.join()) {
        throw new Error('Nuvio returned two different profile lists (' + (idx.join(', ') || 'none') +
          ' vs ' + (other.join(', ') || 'none') + ') — reload before changing anything');
      }
      crossChecked = true;
    }
    return { rows, idx, crossChecked };
  }

  function refreshWizard() {
    if (!WZ) return;
    const signedIn = !!gAuth.token;
    if ($('wz-signin-card')) $('wz-signin-card').style.display = signedIn ? 'none' : '';
    if ($('wz-account-body')) $('wz-account-body').style.display = signedIn ? '' : 'none';
    if (!signedIn) { wzShow('account'); return; }
    wzRenderEntry();
    wzFillAccounts();
    wzShow(wz.step);
  }

  // ---- step 1: the one question this step opens with ----------------------
  // Both branches existed before and still do; they just wait behind whichever
  // of the two answers applies, instead of being two full columns of controls
  // that only one of them will ever use.
  const WZ_ENTRY = [
    { id: 'have', name: 'I already have a Nuvio account',
      one: 'Pick the account, then the profile you want set up from scratch.' },
    { id: 'new', name: 'I need to make a Nuvio account',
      one: 'Creates a real Nuvio account, links it here, and signs you straight in.' },
  ];
  function wzRenderEntry() {
    const box = $('wz-entry'); if (!box) return;
    if (box.dataset.built !== '1') {
      clr(box);
      WZ_ENTRY.forEach(e => {
        const card = wzCard('', () => { wz.entry = e.id; wzPaintEntry(); wzPaintHead(); });
        card.dataset.wzentry = e.id;
        const h = el('div', 'wz-pick-h'); h.appendChild(el('span', 'wz-pick-n', e.name));
        card.appendChild(h);
        card.appendChild(el('div', 'wz-pick-one', e.one));
        box.appendChild(card);
      });
      box.dataset.built = '1';
    }
    wzPaintEntry();
  }
  function wzPaintEntry() {
    const box = $('wz-entry'); if (!box) return;
    // A locked run can no longer be asked the question at all. A picked profile
    // ANSWERS it — which is why coming back to step 1 from step 3 lands on the
    // account branch rather than on the two front doors — but answering it must
    // not silence it: Back has to be able to put the doors back. The old
    // version forced 'have' on every repaint the moment a profile existed, so
    // Back set the state and this line immediately undid it, one frame later.
    // That, and nothing else, is why Back did nothing. 'choose' is the explicit
    // "I pressed Back" state that survives the repaint.
    if (wz.locked) wz.entry = 'have';
    else if (wz.entry == null && wz.idx != null) wz.entry = 'have';
    const on = wz.entry === 'have' || wz.entry === 'new' ? wz.entry : null;
    box.style.display = on ? 'none' : '';
    if ($('wz-have')) $('wz-have').style.display = on === 'have' ? '' : 'none';
    if ($('wz-new')) $('wz-new').style.display = on === 'new' ? '' : 'none';
    document.querySelectorAll('.wz-entry-back').forEach(b => {
      b.style.display = wz.locked ? 'none' : '';
      b.onclick = () => { wz.entry = 'choose'; wzPaintEntry(); wzPaintHead(); wzPaintNext(); };
    });
    if ($('wz-account')) $('wz-account').disabled = !!wz.locked;
    // The chips are normally already on screen when the first write happens, so
    // the lock is applied to them in place rather than by re-reading the account.
    document.querySelectorAll('#wz-profiles .pchip[data-wzidx]').forEach(ch => {
      ch.disabled = !!wz.locked && Number(ch.dataset.wzidx) !== wz.idx;
    });
    if ($('wz-addprof')) $('wz-addprof').style.display = wz.locked ? 'none' : '';
    if (wz.locked && $('wz-newprof')) $('wz-newprof').style.display = 'none';
    // The locked notice sits above the pickers it is explaining.
    let note = $('wz-lock-note');
    if (wz.locked) {
      if (!note) {
        note = el('div', 'wz-lock'); note.id = 'wz-lock-note';
        $('wz-account-body').insertBefore(note, $('wz-account-body').firstChild);
      }
      clr(note);
      const tx = el('span');
      tx.innerHTML = 'The wizard has already written to <b>' + esc(wzProfileName()) +
        '</b>, so the profile is fixed for the rest of this run.';
      note.appendChild(tx);
      note.appendChild(el('span', 'spacer'));
      const b = el('button', 'btn btn-ghost btn-xs', 'Exit and undo');
      b.onclick = wzExitAndUndo;
      note.appendChild(b);
    } else if (note) note.remove();
  }

  function wzFillAccounts() {
    const list = store.list(), sel = $('wz-account'); if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = list.map(r => `<option value="${esc(r.accountId)}">${esc(accountName(r.accountId))}</option>`).join('');
    if (!list.length) { clr($('wz-profiles')); $('wz-profiles').appendChild(el('p', 'empty', 'No Nuvio account is linked yet — go back and create one, or link it on the Nuvio accounts tab.')); return; }
    const keep = (prev && list.some(r => r.accountId === prev)) ? prev
      : (wz.aid && list.some(r => r.accountId === wz.aid) ? wz.aid : list[0].accountId);
    sel.value = keep;
    wzRenderProfiles(keep);
  }

  async function wzRenderProfiles(aid) {
    const box = $('wz-profiles'); if (!box) return;
    const gen = ++wzProfGen;                       // a slower earlier read must never paint over a newer one
    clr(box); box.appendChild(el('span', 'muted sm shimmer', 'Reading profiles…'));
    $('wz-newprof').style.display = 'none';
    $('wz-profile-count').textContent = '';
    let read;
    try { read = await wzReadProfiles(aid); }
    catch (e) {
      if (gen !== wzProfGen) return;
      clr(box);
      box.appendChild(el('span', 'muted sm err-text', "Couldn't read this account's profiles: " + e.message));
      const retry = el('button', 'btn btn-ghost btn-xs', 'Try again'); retry.style.marginLeft = '10px';
      retry.onclick = () => wzRenderProfiles(aid);
      box.appendChild(retry);
      logAct('Wizard: profile read failed — ' + e.message, 'err');
      wzShow(wz.step);
      return;
    }
    if (gen !== wzProfGen) return;
    wzProfiles = normProfiles(read.rows);
    clr(box);
    $('wz-profile-count').textContent = wzProfiles.length + ' of 6';
    if (wz.aid !== aid) { wz.aid = aid; wz.idx = null; wz.done = []; }
    if (wz.idx != null && !wzProfiles.some(p => p.index === wz.idx)) wz.idx = null;
    wzProfiles.forEach(p => {
      const c = el('button', 'pchip' + (p.index === wz.idx ? ' on' : '')); c.type = 'button';
      // Locked: the picked one still reads as picked, the rest are visibly out
      // of reach rather than quietly doing nothing when clicked.
      c.dataset.wzidx = String(p.index);
      // 54, not 42: this step is one question and the chips are the answer, so
      // they are sized to be the thing on screen rather than a row of buttons.
      c.appendChild(avatar(p, 54)); c.appendChild(el('span', 'pcn', p.name));
      c.onclick = () => { if (wz.locked) return; wz.aid = aid; wz.idx = p.index; wz.done = []; wzRenderProfiles(aid); };
      box.appendChild(c);
    });
    if (wzProfiles.length < 6 && !wz.locked) {
      const add = el('button', 'pchip wz-add'); add.type = 'button'; add.id = 'wz-addprof';
      add.appendChild(el('span', 'plus', '+'));
      add.appendChild(el('span', 'pcn', wzProfiles.length ? 'New profile' : 'Create the first profile'));
      add.onclick = () => {
        $('wz-newprof').style.display = 'flex';
        $('wz-prof-name').value = ''; $('wz-prof-name').focus();
        status($('wz-profile-status'), '');
      };
      box.appendChild(add);
    } else if (!wz.locked) {
      box.appendChild(el('span', 'muted sm', 'All six profile slots are used.'));
    }
    // A brand-new Nuvio account normally arrives with one profile already made.
    // Say so when it does not, instead of showing an empty row with no
    // explanation, which reads as a failure.
    if (!wzProfiles.length) box.appendChild(el('p', 'empty', 'This account has no profiles yet — make the first one above.'));
    wzPaintEntry();
    wzShow(wz.step);
  }

  // Create a profile.
  //
  // sync_push_profiles is a WHOLE-ACCOUNT FULL REPLACE: whatever list is sent
  // becomes the account's entire set of profiles, and anything absent from it
  // is deleted along with its add-ons, settings and watch history. So the only
  // question that matters here is whether the list this was built from is
  // complete.
  //
  // An earlier version checked the new list against the same read it was built
  // from, which is circular — it can prove the append was done correctly, and
  // nothing at all about whether the read was short. wzReadProfiles now settles
  // that with a second, independent read (get_sync_overview) and refuses when
  // they disagree; on top of that this refuses to push at all unless the
  // cross-check actually ran, and re-reads immediately afterwards to confirm
  // every profile that existed before still exists.
  async function wzCreateProfile() {
    const aid = $('wz-account').value, st = $('wz-profile-status');
    const name = $('wz-prof-name').value.trim();
    if (!aid) { status(st, 'Pick an account first.', 'err'); return; }
    if (!name) { status(st, 'Give the profile a name.', 'err'); return; }
    const btn = $('wz-prof-create'); btn.disabled = true;
    status(st, 'Checking the account before writing…');
    try {
      const c = A.client(store, aid);
      const read = await wzReadProfiles(aid);
      if (!read.crossChecked) {
        throw new Error('could not double-check the profile list against Nuvio, and adding a profile rewrites the whole list — not risking it. Reload and try again');
      }
      if (read.idx.length >= 6) throw new Error('this account already has all six profiles');
      let next = 1; while (read.idx.includes(next)) next++;
      if (next > 6) throw new Error('no free profile slot');
      const row = { profile_index: next, name: name.slice(0, 60), avatar_color_hex: $('wz-prof-color').value || '#1E88E5',
        uses_primary_addons: false, uses_primary_plugins: false, avatar_id: null, avatar_url: null };
      const nextList = read.rows.map(normRow).concat([row]);
      const missing = read.idx.filter(i => !nextList.some(p => p.profile_index === i));
      if (missing.length) throw new Error('safety check failed — profile ' + missing.join(', ') + ' would have been lost');
      status(st, 'Creating the profile…');
      await c.rpc('sync_push_profiles', { p_profiles: nextList, p_client_max_profiles: 6 });
      inval(aid);
      const after = await wzReadProfiles(aid);
      if (!after.idx.includes(next)) throw new Error('Nuvio accepted the write but the profile is not there afterwards');
      const lost = read.idx.filter(i => !after.idx.includes(i));
      if (lost.length) throw new Error('profile ' + lost.join(', ') + ' went missing — restore from a Drive backup straight away');
      wz.aid = aid; wz.idx = next; wz.done = ['Created the profile “' + name + '”.'];
      // Creating a profile IS a change to the account, so the run locks here
      // too — and Exit can offer to delete exactly the profile it made.
      wz.madeProfile = next;
      wzLock();
      status(st, 'Created “' + name + '” and selected it.', 'ok');
      logAct('Wizard: created profile ' + name + ' (index ' + next + '); list ' + read.idx.join(',') + ' -> ' + after.idx.join(','), 'ok');
      $('wz-newprof').style.display = 'none';
      await wzRenderProfiles(aid);
      celebrate($('wz-profile-card'));
    } catch (e) {
      status(st, "Couldn't create it: " + e.message, 'err');
      logAct('Wizard: profile create failed — ' + e.message, 'err');
    } finally { btn.disabled = false; }
  }

  // Create a Nuvio account. GoTrue sign-up, then straight into the same store
  // + Drive registry every linked account lives in, so it is a first-class
  // account everywhere else in Numax immediately.
  async function wzCreateAccount() {
    const st = $('wz-new-status');
    const email = $('wz-new-email').value.trim(), pass = $('wz-new-pass').value,
          pass2 = $('wz-new-pass2').value, label = $('wz-new-label').value.trim();
    if (!gAuth.token) { status(st, 'Sign in with Google first.', 'err'); return; }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status(st, 'Enter a valid email address.', 'err'); return; }
    if (pass.length < 6) { status(st, 'Nuvio needs a password of at least 6 characters.', 'err'); return; }
    if (pass !== pass2) { status(st, "The two passwords don't match.", 'err'); return; }
    if (!(await uiModal({
      title: 'Create a Nuvio account for ' + email + '?',
      message: 'This creates a real account on Nuvio’s servers, not just in Numax.',
      details: [
        'Numax links it straight away and saves it to <b>your Google Drive</b> with the others.',
        'Keep the password somewhere safe — <b>Numax cannot recover it</b> for you.',
        'Nothing else happens to it: no profile, no add-ons, until you carry on through the wizard.',
      ],
      okLabel: 'Create account',
    }))) return;
    const btn = $('wz-new-btn'); btn.disabled = true; status(st, 'Creating the account…');
    try {
      const session = await wzSignUp(email, pass);
      store.add(session, { email, label, keysIncluded: readKeys });
      const id = S.decodeSub(session.access_token);
      inval(id);
      await saveRegistry();
      $('wz-new-email').value = ''; $('wz-new-pass').value = ''; $('wz-new-pass2').value = ''; $('wz-new-label').value = '';
      wz.aid = id; wz.idx = null; wz.done = ['Created the Nuvio account ' + email + '.'];
      wz.madeAccount = id;
      // The account half of this branch is finished, so hand straight over to
      // the other one rather than leaving a filled-in form on screen.
      wz.entry = 'have';
      status(st, 'Created and linked ' + (label || email) + '. Now pick a profile.', 'ok');
      logAct('Wizard: created Nuvio account ' + email, 'ok');
      refreshAccounts(); wzFillAccounts(); wzPaintEntry();
      if ($('wz-account')) { $('wz-account').value = id; wzRenderProfiles(id); }
    } catch (e) {
      status(st, "Couldn't create it: " + e.message, 'err');
      logAct('Wizard: account create failed — ' + e.message, 'err');
    } finally { btn.disabled = false; }
  }

  // GoTrue sign-up, built from api.js's own exported constants rather than by
  // editing that core module. Nuvio's auth settings report mailer_autoconfirm,
  // so a successful sign-up returns a usable session with no email step; if
  // that ever changes, the missing access_token is reported honestly instead of
  // silently linking a half-made account.
  async function wzSignUp(email, password) {
    let res;
    try {
      res = await fetch(A.AUTH_BASE + '/signup', {
        method: 'POST',
        headers: { apikey: A.ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (e) { throw new Error("couldn't reach Nuvio — check your connection"); }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && (body.msg || body.error_description || body.error)) || ('sign-up failed (' + res.status + ')');
      throw new Error(String(msg));
    }
    const sess = body && (body.session || body);
    if (!sess || !sess.access_token) {
      throw new Error('Nuvio made the account but did not sign you in — check your email for a confirmation link, then link it on the Nuvio accounts tab');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: sess.access_token,
      refresh_token: sess.refresh_token || null,
      expires_at: sess.expires_at || (sess.expires_in ? nowSec + sess.expires_in : 0),
    };
  }

  // ---- step rail ----
  function wzShow(step) {
    if (!WZ) return;
    wz.step = WZ_STEPS.includes(step) ? step : 'account';
    const ready = !!wzTarget();
    document.querySelectorAll('.wz-pane').forEach(p => p.style.display = p.dataset.wzpane === wz.step ? '' : 'none');
    document.querySelectorAll('.wz-step').forEach(b => {
      const k = b.dataset.wzstep;
      b.classList.toggle('on', k === wz.step);
      b.classList.toggle('did', k !== wz.step && ready && WZ_STEPS.indexOf(k) < WZ_STEPS.indexOf(wz.step));
      // The rail says where you are and where you have been. It is deliberately
      // NOT a way to jump any more, and neither is the footer, which no longer
      // has a Back button at all. Hopping back into a step you have already
      // written from is how a run ends up half on one set of answers and half
      // on another — Next is the only way on, and the target strip's "Exit and
      // undo" is the only way out. The green ticks still show the progress.
      //
      // EVERY step is inert, the current one included: there is no click
      // handler left, and one live-looking button that does nothing is worse
      // than five that plainly don't. aria-current is what carries the meaning
      // now that the bar is an indicator rather than a set of controls.
      b.disabled = true;
      if (k === wz.step) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    wzPaintTarget();
    wzPaintHead();
    if (wz.step === 'account') wzPaintEntry();
    wzPaintNext();
    if (wz.step === 'keys') wzRenderKeys();
    if (wz.step === 'streams') wzRenderStreams();
    if (wz.step === 'meta') wzRenderMeta();
    if (wz.step === 'done') wzRenderDone();
    wzRenderPanel();
  }

  // The step's question, at size. Hidden on step 1 until a profile exists,
  // because until then the two front doors ARE the question.
  function wzPaintHead() {
    const h = $('wz-head'); if (!h) return;
    const copy = (WZ.STEP_HEADS || {})[wz.step];
    const hideOnEntry = wz.step === 'account' && !wzTarget() && wz.entry !== 'have' && wz.entry !== 'new';
    if (!copy || hideOnEntry) { h.style.display = 'none'; return; }
    h.style.display = '';
    clr(h);
    h.appendChild(el('h2', null, copy.q));
    if (copy.sub) h.appendChild(el('p', null, copy.sub));
  }

  // "Writing to X" strip — present from step 2 on, so there is never any doubt
  // which profile a button on this page is about to change. Once the run is
  // locked it also appears on step 1, because that is where the way out is.
  function wzPaintTarget() {
    const t = $('wz-target'); if (!t) return;
    const ready = !!wzTarget();
    if (!ready || (wz.step === 'account' && !wz.locked)) { t.style.display = 'none'; return; }
    clr(t); t.style.display = ''; t.classList.toggle('locked', !!wz.locked);
    t.appendChild(avatar({ name: wzProfileName() }, 26));
    const tx = el('span');
    tx.innerHTML = 'Setting up <b>' + esc(wzProfileName()) + '</b> <span class="muted">on ' + esc(accountName(wz.aid)) + '</span>';
    t.appendChild(tx);
    if (wz.locked) t.appendChild(wzTag('Locked in', 'plain'));
    t.appendChild(el('span', 'wz-pick-sp'));
    const b = el('button', 'btn btn-ghost btn-xs', wz.locked ? 'Exit and undo' : 'Change');
    b.onclick = wz.locked ? wzExitAndUndo : () => wzShow('account');
    t.appendChild(b);
  }

  // What Next would write if it were pressed right now, which is both its label
  // and its colour: explicit and red when there is something to save, quiet grey
  // when there is not. It is never disabled for having nothing to do — a step
  // you legitimately want to skip has to stay walkable.
  function wzStepDirty(step) {
    if (!WZ) return false;
    if (step === 'keys') {
      return WZ.KEYS.some(k => {
        const i = $('wz-key-' + k.id); const v = i ? i.value.trim() : '';
        return !!v && wzSavedKeys.get(k.id) !== v;
      });
    }
    if (step === 'streams' && wz.mode === 'advanced' && wz.route === 'native') {
      const n = $('wz-native-key'); const v = n ? n.value.trim() : '';
      if (v && wzSavedKeys.get('debrid') !== v) return true;
    }
    return (wzPending[step] || []).some(x => x.dirty());
  }
  // Whether this step has been answered, which is a different question from
  // whether it has anything to write. Next lights up on THIS, not on dirty:
  // "you have chosen something, you may go on" is the thing a wizard has to
  // say, and a step that is answered but needs no write (a metadata add-on you
  // already have, a route you only wanted to read about) was showing a dead
  // grey button that looked like it had stopped working.
  function wzCanAdvance(step) {
    if (!wzTarget()) return false;
    if (step === 'keys') {
      const i = $('wz-key-tmdb');
      return wzSavedKeys.has('tmdb') || !!(i && i.value.trim());
    }
    if (step === 'streams') return wz.mode === 'advanced' ? !!wz.route : !!wz.mode;
    return true;                       // account (a target exists) and metadata (all optional)
  }
  // What is missing, in the words of the thing that is missing. Only shown when
  // Next is not lit, so it never sits next to a button that already works.
  const WZ_BLOCKED = {
    keys: 'TMDB is required — paste its key to carry on.',
    streams: 'Pick how you want your streams set up.',
  };
  function wzPaintNext() {
    const b = $('wz-next'); if (!b) return;
    const i = WZ_STEPS.indexOf(wz.step), ready = !!wzTarget(), last = i === WZ_STEPS.length - 1;
    // The Done step's button is the end of the run rather than a dead control.
    // It does NOT undo anything — the setup is meant to stay — it clears the
    // wizard and hands you back to the profile picker for the next profile.
    if (last) {
      b.disabled = false;
      b.textContent = 'Finish';
      b.className = 'btn btn-primary';
      const n0 = $('wz-foot-note');
      if (n0) n0.textContent = 'Everything above is saved. Finish takes you back to pick another profile.';
      return;
    }
    b.disabled = !ready;
    const dirty = ready && !last && wzStepDirty(wz.step);
    const can = ready && !last && wzCanAdvance(wz.step);
    b.textContent = dirty ? 'Save and move to next step' : (i === WZ_STEPS.length - 2 ? 'Finish' : 'Next');
    b.className = 'btn ' + (can ? 'btn-primary' : 'btn-ghost');
    const note = $('wz-foot-note');
    if (note) {
      note.textContent = !ready ? 'Pick or create a profile to carry on.'
        : last ? ''
        : !can ? (WZ_BLOCKED[wz.step] || '')
        : dirty ? '' : 'Nothing to save on this step.';
    }
  }
  // Forward only. There is no caller with a negative d any more — the Back
  // button is gone and the rail no longer navigates — but the bound check stays
  // so this cannot walk off either end of the list.
  const wzGo = d => { const i = WZ_STEPS.indexOf(wz.step) + d; if (i >= 0 && i < WZ_STEPS.length) wzShow(WZ_STEPS[i]); };

  // ---- shared: pros/cons block ----
  // A selectable card. NOT a <button>: these cards carry their own "Open site"
  // button, and interactive content nested inside a button is invalid HTML and
  // lays out unpredictably (which is exactly what it did). Built as a div with
  // the button role and keyboard handling instead, so it still behaves like one.
  function wzCard(cls, onPick) {
    const c = el('div', 'wz-pick' + (cls ? ' ' + cls : ''));
    c.setAttribute('role', 'button'); c.tabIndex = 0;
    const go = e => { if (e.target.closest('button')) return; onPick(); };
    c.onclick = go;
    c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } };
    return c;
  }
  // Somebody else's mark — TMDB, TorBox, AIOStreams, Torrentio and the rest.
  // One helper for all of them, and one rule: the monogram is drawn first and
  // the image on top of it, so a host that stops serving its logo degrades to a
  // letter rather than to a broken-image icon. `size` is '', 'sm' or 'lg'.
  function wzLogo(m, size) {
    // `logos` (plural) is a route that names two services — Nuvio's own debrid
    // works with TorBox and Premiumize — and draws a mark for each rather than
    // picking one and implying the other is not on offer.
    if (Array.isArray(m.logos) && m.logos.length) {
      const g = el('span', 'wz-logo-pair');
      m.logos.forEach(src => g.appendChild(wzLogo({ logo: src, mono: m.mono, name: m.name }, size)));
      return g;
    }
    const t = el('span', 'wz-logo' + (size ? ' ' + size : ''));
    // A drawn mark for something with no third party to borrow one from — the
    // plugins route is Nuvio's own format, not a company. The SVG is authored
    // copy from wizard.js and nothing user-supplied ever reaches this line.
    if (m.svg) { t.classList.add('drawn'); t.innerHTML = m.svg; return t; }
    t.appendChild(el('span', 'mono', m.mono || ((m.name || '?').trim()[0] || '?').toUpperCase()));
    if (m.logo) {
      const i = document.createElement('img');
      // Deliberately NOT loading="lazy". These are 21-34px marks that are on
      // screen the moment their row is, so lazy buys nothing — and it costs
      // something real: a lazy image never starts loading at all while the
      // document is hidden, because the observer that would trigger it never
      // fires. Every logo in the panel stayed blank for exactly that reason.
      i.alt = ''; i.referrerPolicy = 'no-referrer';
      i.onerror = () => i.remove();
      i.src = m.logo;
      t.appendChild(i);
    }
    return t;
  }

  // ======================================================================
  // the live "On this profile" panel
  // ======================================================================
  // The wizard used to pick a target and then work blind on it for four steps.
  // This is the thing that was missing, and it happens to be what fills the
  // empty half of every sparse step.
  //
  // It is READ-ONLY and it writes nothing. Both reads are ones the wizard
  // already makes: loadAccount() is cached per account (wzMarkMetaInstalled
  // uses the same one), and pullProviderCredentials is the same small RPC
  // Sync Desk uses. A generation guard stops a slow read painting over a newer
  // one, exactly like wzRenderProfiles.
  //
  // API KEY VALUES ARE NEVER SHOWN, and that is not an oversight. This app
  // strips credential values on receipt by design; the panel answers "does
  // this profile have a TMDB key" — which is the question — and never "what
  // is it".
  let wzPanelGen = 0;
  function wzRenderPanel() {
    const host = $('wz-panel'); if (!host) return;
    const t = wzTarget();
    if (!t) { host.style.display = 'none'; return; }
    host.style.display = '';
    const gen = ++wzPanelGen;

    clr(host);
    const who = el('div', 'wz-pnl-who');
    who.appendChild(avatar({ name: t.name }, 34));
    const wh = el('div', null);
    wh.appendChild(el('div', 'nm', t.name));
    wh.appendChild(el('div', 'sub', accountName(t.aid) + ' · profile ' + t.idx));
    who.appendChild(wh);
    host.appendChild(who);

    const body = el('div', 'wz-pnl-body'); host.appendChild(body);
    body.appendChild(el('div', 'wz-pnl-load shimmer', 'Reading this profile…'));

    const run = el('div', 'wz-pnl-run'); host.appendChild(run);
    wzPaintRun(run);

    (async () => {
      let addons = [], creds = [];
      let addonErr = '', credErr = '';
      try {
        const { backup } = await loadAccount(t.aid);
        addons = (sliceProfile(backup, t.idx).addons || []).filter(a => a && a.url);
      } catch (e) { addonErr = e.message; }
      try {
        creds = await A.client(store, t.aid).pullProviderCredentials(t.idx);
      } catch (e) { credErr = e.message; }
      if (gen !== wzPanelGen) return;

      // Classify with the table first so the panel paints immediately, then
      // upgrade each row once its manifest answers. A slow or dead add-on host
      // therefore costs nothing on screen beyond its own row staying generic.
      const rows = addons.map(a => Object.assign(
        { url: a.url, stored: a.name, order: a.sort_order },
        wzAddonFallback(a.url, a.name)
      ));
      clr(body);
      wzPaintAddons(body, rows, addonErr);
      wzPaintKeys(body, creds, credErr);

      Promise.all(rows.map(async r => {
        const info = await wzAddonInfo(r.url, r.stored);
        Object.assign(r, info);
      })).then(() => {
        if (gen !== wzPanelGen) return;
        clr(body);
        wzPaintAddons(body, rows, addonErr);
        wzPaintKeys(body, creds, credErr);
      });
    })();
  }

  function wzPnlHead(text) {
    return el('div', 'wz-pnl-h', text);
  }
  function wzPaintAddons(body, rows, err) {
    if (err) {
      body.appendChild(wzPnlHead('Add-ons'));
      body.appendChild(el('div', 'wz-pnl-err', "Couldn't read them: " + err));
      return;
    }
    (WZ.PANEL_SECTIONS || []).forEach(sec => {
      const mine = rows.filter(r => r.kind === sec.kind);
      // 'Other' only appears when there is something in it — an empty
      // "Other add-ons: none" is a line that never says anything.
      if (!mine.length && !sec.empty) return;
      body.appendChild(wzPnlHead(sec.label));
      if (!mine.length) { body.appendChild(el('div', 'wz-pnl-none', sec.empty)); return; }
      mine.sort((a, b) => (a.order || 0) - (b.order || 0));
      mine.forEach(r => {
        const row = el('div', 'wz-pnl-row');
        row.appendChild(wzLogo(r, 'xs'));
        const nm = el('span', 'nm', r.name);
        // The user's own label is worth keeping when it differs — "Main" is how
        // Furqan finds that row in Nuvio, "AIOStreams" is what it actually is.
        row.appendChild(nm);
        const stored = wzShortName(r.stored);
        if (stored && stored.toLowerCase() !== r.name.toLowerCase()) {
          row.appendChild(el('span', 'as', '“' + stored + '”'));
        }
        body.appendChild(row);
      });
    });
  }
  function wzPaintKeys(body, creds, err) {
    body.appendChild(wzPnlHead('API keys'));
    if (err) { body.appendChild(el('div', 'wz-pnl-err', "Couldn't read them: " + err)); return; }
    const has = p => (creds || []).some(c => c && c.provider === p &&
      c.credential_json && Object.values(c.credential_json).some(v => typeof v === 'string' && v.trim()));
    (WZ.KEYS || []).forEach(k => {
      const row = el('div', 'wz-pnl-row');
      row.appendChild(wzLogo(k, 'xs'));
      row.appendChild(el('span', 'nm', k.name));
      row.appendChild(el('span', 'sp'));
      const on = has(k.provider);
      row.appendChild(el('span', 'st' + (on ? ' on' : ''), on ? 'set' : 'not set'));
      body.appendChild(row);
    });
    // Debrid lives under its own provider ids, and only ever one at a time.
    const d = (WZ.DEBRID || []).filter(x => x.native).find(x => has('debrid:' + x.id));
    const row = el('div', 'wz-pnl-row');
    row.appendChild(wzLogo(d || { mono: 'D', name: 'Debrid' }, 'xs'));
    row.appendChild(el('span', 'nm', d ? d.name : 'Debrid'));
    row.appendChild(el('span', 'sp'));
    row.appendChild(el('span', 'st' + (d ? ' on' : ''), d ? 'linked' : 'not linked'));
    body.appendChild(row);
  }
  function wzPaintRun(run) {
    clr(run);
    run.appendChild(wzPnlHead('This run'));
    if (!wz.done.length) { run.appendChild(el('div', 'wz-pnl-none', 'nothing written yet')); return; }
    wz.done.forEach(d => {
      const r = el('div', 'wz-pnl-did');
      r.appendChild(el('span', 'tk', '✓'));
      r.appendChild(el('span', '', d));
      run.appendChild(r);
    });
  }

  // ======================================================================
  // what IS this add-on?
  // ======================================================================
  // Nuvio stores only {url, name, enabled, sort_order} — no type, and a name
  // the user chose (the test account's AIOStreams instances are called "Main"
  // and "Niche"), so the URL is the only thing that can answer this.
  //
  // Order of authority, best first:
  //   1. the add-on's OWN manifest, fetched from the stored URL exactly as
  //      stored. Stremio's `resources` is the answer: 'stream' wins outright,
  //      then 'subtitles', then 'catalog'/'meta'. It also hands back the real
  //      product name and logo, which is why "Main" can be shown as AIOStreams.
  //   2. wizard.js's ADDON_KINDS table, for the manifests a browser cannot
  //      read cross-origin — and for the two that answer but do not settle it:
  //      Cinemeta publishes no logo, AIOMetadata publishes empty `resources`.
  //   3. 'other'. An add-on nobody can identify is shown as one. It is never
  //      filed under a guess, because a stream source counted as metadata is
  //      worse than an honest "Other add-on".
  const _wzAddonCache = new Map();          // stored url -> {name, kind, logo}
  // `resources` entries are strings OR {name, types, idPrefixes} objects.
  const wzResList = m => (Array.isArray(m && m.resources) ? m.resources : [])
    .map(r => (typeof r === 'string' ? r : (r && r.name) || '')).filter(Boolean);
  // Vendor suffixes: Comet's manifest calls itself "Comet | ElfHosted". Furqan
  // wants the product name, so the first segment wins — but only on a real
  // separator, so "OpenSubtitles v3" survives intact.
  const wzShortName = n => String(n || '').split(/\s+[|·—–]\s+/)[0].trim() || '';
  // Several manifests (OpenSubtitles v3 among them) publish an http: logo,
  // which a browser on the https site blocks outright as mixed content.
  const wzHttps = u => String(u || '').replace(/^http:\/\//i, 'https://');

  function wzKnownAddon(url) {
    const u = String(url || '');
    return (WZ.ADDON_KINDS || []).find(k => k.re.test(u)) || null;
  }
  function wzAddonFallback(url, storedName) {
    const k = wzKnownAddon(url);
    return {
      name: k ? k.name : (wzShortName(storedName) || 'Add-on'),
      kind: k ? k.kind : 'other',
      logo: k && k.logo ? k.logo : '',
      sure: !!k,
    };
  }
  async function wzAddonInfo(url, storedName) {
    const key = String(url || '');
    if (_wzAddonCache.has(key)) return _wzAddonCache.get(key);
    const fb = wzAddonFallback(key, storedName);
    let out = fb;
    try {
      // Nuvio does NOT always store a full manifest URL — the test account has
      // OpenSubtitles stored as bare "https://opensubtitles-v3.strem.io", which
      // answers with a page rather than JSON. market.js already owns the repair
      // (it appends manifest.json to a directory form, and rewrites Codeberg's
      // no-CORS raw path), so reuse it rather than writing a second one. The
      // cache key stays the STORED url, because that is what identifies the row.
      const fetchUrl = (MK && MK.normalizeManifestUrl) ? MK.normalizeManifestUrl(key) : key;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const m = await fetch(fetchUrl, { signal: ctl.signal }).then(r => r.json());
      clearTimeout(t);
      const res = wzResList(m);
      const kind = res.includes('stream') ? 'stream'
        : res.includes('subtitles') ? 'subs'
        : (res.includes('catalog') || res.includes('meta')) ? 'meta'
        : fb.kind;                                   // empty resources -> the table
      // The NAME is the one thing the table beats the manifest at. A manifest's
      // name is whatever that INSTANCE calls itself, not what the product is:
      // the test account's second AIOStreams config is named "Mainstream" by
      // the community template it was built from, so trusting the manifest put
      // "AIOStreams" and "Mainstream" side by side as if they were different
      // products. A recognised host gets its product name; only an
      // unrecognised one falls back to whatever its manifest says it is.
      out = {
        name: fb.sure ? fb.name : (wzShortName(m && m.name) || fb.name),
        kind,
        logo: wzHttps((m && m.logo) || '') || fb.logo,
        sure: true,
      };
    } catch (e) { /* unreadable cross-origin — the table already answered */ }
    _wzAddonCache.set(key, out);
    return out;
  }

  // The round "?" in a card's header, and the only thing that opens its
  // reasoning. Volunteering pros and cons on every card made the streams step a
  // wall of text; opening them on hover made the page rearrange itself as the
  // pointer crossed it. Asked for, then shown.
  function wzWhyBtn(card, label) {
    const q = el('button', 'wz-pick-q', '?'); q.type = 'button';
    q.setAttribute('aria-label', 'More about ' + label);
    q.setAttribute('aria-expanded', 'false');
    q.onclick = e => {
      e.stopPropagation();
      const on = card.classList.toggle('showpc');
      q.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    return q;
  }
  function wzProsCons(pros, cons) {
    const w = el('div', 'wz-pc');
    (pros || []).forEach(p => { const r = el('div', 'pro'); r.innerHTML = '<span class="s">+</span><span>' + p + '</span>'; w.appendChild(r); });
    (cons || []).forEach(c => { const r = el('div', 'con'); r.innerHTML = '<span class="s">−</span><span>' + c + '</span>'; w.appendChild(r); });
    return w;
  }
  // What "Do it all for me" behind its "?" — the preset, not a pros-and-cons
  // list. "What am I actually getting" was the only question anyone had about
  // that card, and it used to be answered by a whole section sitting under it
  // taking a screenful to say six things. Same disclosure mechanism, so the
  // card behaves exactly like its neighbour.
  function wzPresetBlock() {
    const P = WZ.PRESET, w = el('div', 'wz-pc');
    if (P.blurb) w.appendChild(el('div', 'wz-pc-b', P.blurb));
    (P.points || []).forEach(p => { const r = el('div', 'pro'); r.innerHTML = '<span class="s">+</span><span>' + p + '</span>'; w.appendChild(r); });
    if (P.note) w.appendChild(el('div', 'wz-pc-b', P.note));
    return w;
  }
  function wzTag(text, cls) { const s = el('span', 'wz-tag' + (cls ? ' ' + cls : ''), text); return s; }
  const wzOpen = url => window.open(url, '_blank', 'noopener');

  // ======================================================================
  // step 2 — API keys
  // ======================================================================
  function wzRenderKeys() {
    const box = $('wz-keys'); if (!box || box.dataset.built === '1') return;
    clr(box);
    WZ.KEYS.forEach(k => {
      const w = el('div', 'wz-key'); w.dataset.wzkey = k.id;
      const h = el('div', 'wz-key-h');
      // The provider's own mark rather than a counter. Three rows in a fixed
      // order do not need numbering, and the logo is the thing that tells you
      // at a glance which site this row is asking you to go to.
      h.appendChild(wzLogo(k, 'sm'));
      h.appendChild(el('span', 'wz-key-n', k.name));
      if (k.tag) h.appendChild(wzTag(k.tag, k.required ? 'req' : (/optional/i.test(k.tag) ? 'plain' : '')));
      h.appendChild(el('span', 'wz-pick-sp'));
      const get = el('button', 'btn btn-ghost btn-xs', 'Get one · ' + k.getLabel);
      get.onclick = () => wzOpen(k.getUrl);
      h.appendChild(get);
      w.appendChild(h);
      // One line of copy. Everything else that used to sit here — why it is
      // worth having, which platforms need it — was three more paragraphs per
      // key on a step that is really just three boxes to paste into.
      w.appendChild(el('div', 'wz-key-b', k.blurb));
      const ol = el('ol', 'wz-steps');
      k.steps.forEach(x => { const li = el('li'); li.innerHTML = x; ol.appendChild(li); });
      const disc = mkDisclosure('How to get it', k.steps.length + ' steps', false);
      disc.body.appendChild(ol);
      w.appendChild(disc.node);

      const row = el('div', 'wz-key-row');
      const inp = el('input'); inp.type = 'password'; inp.id = 'wz-key-' + k.id;
      inp.placeholder = k.placeholder; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.className = 'wz-key-input';
      if (k.required) inp.setAttribute('aria-required', 'true');
      const chk = el('span', 'wz-chk idle'); chk.id = 'wz-chk-' + k.id;
      row.appendChild(inp); row.appendChild(chk);
      w.appendChild(row);
      const v = el('div', 'wz-key-v'); v.id = 'wz-keyv-' + k.id; w.appendChild(v);
      wzWireCheck({ inp, chk, val: v, card: w }, () => k);
      box.appendChild(w);
    });
    box.dataset.built = '1';
  }

  // ---- is this key real? --------------------------------------------------
  // Asked of the provider itself, because nothing else can answer it: a key is
  // either recognised over there or it is not. The key goes to the provider it
  // belongs to and nowhere else — the same request Nuvio will make with it a
  // minute later — and a network failure resolves to "couldn't check", never to
  // a cross, so a blocked corporate proxy can't make a good key look bad.
  // Keyed by what was asked and what was asked about, NOT by which box it was
  // typed into: the same TorBox key can be typed on the simple path and on the
  // Nuvio+TorBox path, and asking TorBox twice about the same string is pure
  // waste. Cleared with the rest of the run by wzResetRun.
  const wzVerified = new Map();          // verify-kind + '\0' + value -> { state, msg }
  const wzVerifyGen = {};
  const WZ_CHK = {
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 7.5v6"/><path d="M12 17h.01"/></svg>',
    busy: '',
  };
  // `els` is the trio a tick needs: the box, the tick, and the line under it
  // (plus optionally the card to mark green). `getSpec` is called fresh every
  // time rather than captured, because on the streams step WHICH service is
  // being checked changes under the same box when you pick a different one.
  function wzChkPaint(els, state, msg) {
    if (els.chk) {
      els.chk.className = 'wz-chk ' + state;
      els.chk.innerHTML = WZ_CHK[state] || '';
      els.chk.title = msg || '';
    }
    if (els.val) { els.val.textContent = msg || ''; els.val.className = 'wz-key-v' + (state === 'busy' || state === 'idle' ? '' : ' ' + state); }
    if (els.card) els.card.classList.toggle('ok', state === 'good');
  }
  const wzChkLabel = spec => spec.getLabel || spec.name || 'the provider';
  async function wzRunCheck(els, spec) {
    if (!els.inp) return;
    const val = (els.inp.value || '').trim();
    if (!val || !spec || !spec.verify) { wzChkPaint(els, 'idle', ''); return; }
    const ck = spec.verify + '\u0000' + val;
    const seen = wzVerified.get(ck);
    if (seen) { wzChkPaint(els, seen.state, seen.msg); return; }
    const gen = wzVerifyGen[spec.verify] = (wzVerifyGen[spec.verify] || 0) + 1;
    wzChkPaint(els, 'busy', 'Checking it with ' + wzChkLabel(spec) + '…');
    let out;
    try { out = await wzAskProvider(spec.verify, val); }
    catch (e) { out = { state: 'unknown', msg: "Couldn't check this one with " + wzChkLabel(spec) + ' — save it anyway, Nuvio will tell you if it is wrong.' }; }
    if (gen !== wzVerifyGen[spec.verify] || (els.inp.value || '').trim() !== val) return;   // a newer keystroke won
    wzVerified.set(ck, out);
    wzChkPaint(els, out.state, out.msg);
  }
  // A key is checked once it LOOKS finished (spec.shape), not while it is half
  // typed — a red cross after three characters is noise, not feedback. A box you
  // leave with something unrecognisable in it still gets checked on blur, so a
  // wrong-format paste is told rather than silently accepted.
  const wzChkWired = new WeakMap();
  function wzWireCheck(els, getSpec) {
    // The two streams-step boxes are in the markup and are never replaced, but
    // the blocks around them get rebuilt (a fresh run, a different service), so
    // this has to be idempotent or every rebuild stacks another listener on the
    // same input. The keys step builds new inputs each time and never hits this.
    const had = wzChkWired.get(els.inp);
    if (had) { wzChkPaint(els, 'idle', ''); return had; }
    let timer = null;
    els.inp.addEventListener('input', () => {
      els.inp.classList.remove('wz-need');
      clearTimeout(timer);
      const spec = getSpec(), val = (els.inp.value || '').trim();
      if (!val || !spec || !spec.verify) { wzChkPaint(els, 'idle', ''); return; }
      const seen = wzVerified.get(spec.verify + '\u0000' + val);
      if (seen) { wzChkPaint(els, seen.state, seen.msg); return; }
      wzChkPaint(els, 'idle', '');
      if (spec.shape && spec.shape.test(val)) timer = setTimeout(() => wzRunCheck(els, getSpec()), 350);
    });
    els.inp.addEventListener('blur', () => { clearTimeout(timer); if ((els.inp.value || '').trim()) wzRunCheck(els, getSpec()); });
    wzChkPaint(els, 'idle', '');
    // Re-ask when the thing being asked changes rather than the text — picking
    // Premiumize after typing a TorBox key has to drop the old verdict.
    const recheck = () => { clearTimeout(timer); wzRunCheck(els, getSpec()); };
    wzChkWired.set(els.inp, recheck);
    return recheck;
  }
  // Endpoints and status codes confirmed live 2026-09-11 with a deliberately
  // wrong key: TMDB 401 + status_code 7, MDBList 403 {"error":"Invalid API key"},
  // Anime Skip 200 with errors[0] "Invalid X-Client-ID header". All three send
  // Access-Control-Allow-Origin: * so a browser can make the call at all.
  async function wzAskProvider(kind, key) {
    if (kind === 'tmdb') {
      const r = await fetch('https://api.themoviedb.org/3/authentication?api_key=' + encodeURIComponent(key));
      if (r.status === 200) return { state: 'good', msg: 'TMDB recognises this key.' };
      if (r.status === 401) return { state: 'bad', msg: 'TMDB does not recognise this — check you copied the v3 key, not the v4 read access token.' };
      throw new Error('TMDB answered ' + r.status);
    }
    if (kind === 'mdblist') {
      const r = await fetch('https://api.mdblist.com/user?apikey=' + encodeURIComponent(key));
      if (r.status === 200) return { state: 'good', msg: 'MDBList recognises this key.' };
      if (r.status === 401 || r.status === 403) return { state: 'bad', msg: 'MDBList does not recognise this key.' };
      throw new Error('MDBList answered ' + r.status);
    }
    if (kind === 'animeskip') {
      const r = await fetch('https://api.anime-skip.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-ID': key },
        body: JSON.stringify({ query: '{__typename}' }),
      });
      const j = await r.json().catch(() => null);
      if (j && j.data && j.data.__typename) return { state: 'good', msg: 'Anime Skip accepted this Client ID.' };
      const err = j && j.errors && j.errors[0] && String(j.errors[0].message || '');
      if (err && /client.?id/i.test(err)) return { state: 'bad', msg: 'Anime Skip does not recognise this Client ID.' };
      throw new Error('Anime Skip answered ' + r.status + (err ? ': ' + err : ''));
    }
    // Premiumize answers any origin (Access-Control-Allow-Origin: *, measured
    // 2026-09-13 from a neutral page) and always answers 200 — the verdict is
    // in the body, not the status, so a status check here would pass every key.
    if (kind === 'premiumize') {
      const r = await fetch('https://www.premiumize.me/api/account/info?apikey=' + encodeURIComponent(key));
      const j = await r.json().catch(() => null);
      if (j && j.status === 'success') return { state: 'good', msg: 'Premiumize recognises this key.' };
      if (j && j.status === 'error') return { state: 'bad', msg: 'Premiumize does not recognise this key — copy it again from your account page.' };
      throw new Error('Premiumize answered ' + r.status);
    }
    // TorBox cannot be asked from here at all: api.torbox.app runs an origin
    // allowlist holding only https://torbox.app, and every other origin gets
    // 400 "Disallowed CORS origin" on the preflight (measured 2026-09-13). The
    // relay Worker already had to check TorBox keys for the "Do it all for me"
    // path, so it answers this too. A relay that predates that op replies 400
    // to this shape, which lands in the catch and shows "couldn't check" —
    // which is also what a TorBox outage shows. Never a cross it cannot prove.
    if (kind === 'torbox') {
      if (!WZ.RELAY) throw new Error('no relay to ask through');
      const r = await fetch(WZ.RELAY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'verify', provider: 'torbox', key }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j.ok === 'boolean') {
        return j.ok
          ? { state: 'good', msg: 'TorBox recognises this key.' }
          : { state: 'bad', msg: 'TorBox does not recognise this key — copy it again from torbox.app/settings.' };
      }
      throw new Error((j && j.error) || ('the relay answered ' + r.status));
    }
    throw new Error('no check available');
  }

  // Keys go to provider_credentials (the only place Nuvio actually reads them
  // from) and the matching feature switch goes into each platform blob that
  // exists. A platform with no blob is skipped and said out loud, rather than
  // inventing one — the app writes its own on first sync.
  async function wzSaveKeys() {
    const t = wzTarget(); if (!t) return false;
    const st = $('wz-keys-status'), res = $('wz-keys-res'), btn = $('wz-next');
    clr(res);
    const entered = WZ.KEYS.map(k => ({ k, v: ($('wz-key-' + k.id).value || '').trim() })).filter(x => x.v);
    const missingRequired = WZ.KEYS.filter(k => k.required && !entered.some(x => x.k.id === k.id) && !wzSavedKeys.has(k.id));
    if (missingRequired.length) {
      status(st, missingRequired.map(k => k.name).join(' and ') + ' is required — paste its key first.', 'err');
      missingRequired.forEach(k => { const i = $('wz-key-' + k.id); if (i) i.classList.add('wz-need'); });
      return false;
    }
    if (!entered.length) { status(st, 'Nothing typed in.', 'ok'); return true; }
    if (btn) btn.disabled = true;
    status(st, 'Saving keys…');
    const lines = [], problems = [];
    try {
      const c = A.client(store, t.aid);
      // Nothing is written until the previous state is safely recorded: Exit
      // promises to put this profile back, and a write we cannot reverse would
      // make that a lie.
      try { await wzSnapCreds(c, t.idx, entered.map(x => ({ provider: x.k.provider, field: x.k.field }))); }
      catch (e) {
        status(st, "Couldn't read this profile's existing keys first, and without that this could not be undone — nothing was written: " + e.message, 'err');
        return false;
      }
      // 1. the keys themselves
      const creds = entered.map(x => ({ provider: x.k.provider, credential_json: { [x.k.field]: x.v } }));
      await c.pushProviderCredentials(t.idx, creds, 'numax-web');
      // read back — a push answers 204, which proves nothing on its own
      let live = [];
      try { live = await c.pullProviderCredentials(t.idx); } catch (e) { problems.push("Couldn't read the keys back to confirm: " + e.message); }
      entered.forEach(x => {
        const row = live.find(r => r.provider === x.k.provider);
        const ok = row && String(row.credential_json[x.k.field] || '') === x.v;
        lines.push({ name: x.k.name, ok: live.length ? ok : null });
        if (live.length && !ok) problems.push(x.k.name + ': Nuvio accepted the key but it is not stored afterwards.');
        else wzSavedKeys.set(x.k.id, x.v);
      });
      // 2. the switches that make them do something
      const flipped = await wzApplyToggles(t, entered.reduce((acc, x) => acc.concat(
        Object.keys(x.k.toggles).map(pl => ({ platform: pl, sets: x.k.toggles[pl] }))), []));
      flipped.notes.forEach(n => lines.push({ name: n, ok: true, note: true }));
      flipped.problems.forEach(p => problems.push(p));
      const rep = el('div', 'report');
      lines.forEach(l => {
        const r = el('div', 'rline' + (l.note ? ' muted' : ''));
        r.innerHTML = '<span class="rk">' + esc(l.name) + '</span>' +
          (l.note ? '' : (l.ok === false ? '<span class="tag rem">not saved</span>' : l.ok === null ? '<span class="tag keep">saved, unverified</span>' : '<span class="tag add">saved</span>'));
        rep.appendChild(r);
      });
      res.appendChild(rep);
      if (problems.length) {
        status(st, problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ' — see below.', 'err');
        const ul = el('ul', 'modal-details'); problems.forEach(p => ul.appendChild(el('li', '', p))); res.appendChild(ul);
        logAct('Wizard: API keys — ' + problems.length + ' problem(s)', 'err');
        return false;
      } else {
        status(st, 'Saved ' + entered.length + ' key' + (entered.length === 1 ? '' : 's') + ' — checked and confirmed.', 'ok');
        wzLock();
        wzLog('Saved ' + entered.map(x => x.k.name).join(', ') + ' to this profile.');
        logAct('Wizard: saved ' + entered.length + ' API key(s) to ' + t.name, 'ok');
        celebrate(res);
      }
      inval(t.aid);
      return true;
    } catch (e) {
      status(st, "Couldn't save: " + e.message, 'err');
      logAct('Wizard: API key save failed — ' + e.message, 'err');
      return false;
    } finally { if (btn) btn.disabled = false; }
  }

  // Read-modify-write on each platform blob: pull the live one (with its
  // updated_at so the guarded RPC can reject a concurrent change), set only the
  // named leaves, push it back.
  //
  // When a platform has NO blob at all — which is the normal state of a
  // freshly created profile, confirmed live: all three platforms return [] —
  // one is created. An earlier version skipped those and merely said so, which
  // is why a TorBox key could land while "Resolve playable links" stayed off:
  // the switch lives in the blob, and there was no blob to put it in.
  //
  // Creating one is safe because a Nuvio blob is a SPARSE OVERLAY of defaults,
  // not a full dump — a real profile's TV blob holds only the handful of
  // leaves that differ from default. So { version, features:{ the leaves we
  // set } } is exactly the shape Nuvio itself writes.
  //
  // The version is per-platform and must not be guessed: read live off the test
  // account, tv is 1 while mobile and desktop are 3. Writing tv's 1 into a
  // mobile blob is the kind of thing that silently makes an app ignore it.
  const WZ_BLOB_VERSION = { tv: 1, mobile: 3, desktop: 3 };
  async function wzApplyToggles(t, wants) {
    const notes = [], problems = [];
    const byPlat = {};
    wants.forEach(w => { (byPlat[w.platform] = byPlat[w.platform] || []).push(...w.sets); });
    const c = A.client(store, t.aid);
    const created = [];
    for (const platform of PLATS) {
      const sets = byPlat[platform]; if (!sets || !sets.length) continue;
      let row;
      try { row = await c.pullSettings(t.idx, platform); }
      catch (e) { problems.push(wzPlatLabel(platform) + ' settings could not be read: ' + e.message); continue; }
      wzSnapBlob(platform, row);
      const fresh = !(row && row.settings_json);
      const blob = fresh
        ? { version: WZ_BLOB_VERSION[platform] || 1, features: {} }
        : JSON.parse(JSON.stringify(row.settings_json));
      let changed = 0;
      sets.forEach(([feat, key, val, type]) => { if (blobGet(blob, feat, key, undefined) !== val) { blobSet(blob, feat, key, val, type); changed++; } });
      if (!changed) { notes.push(wzPlatLabel(platform) + ' already switched on'); continue; }
      try {
        if (fresh) {
          // Nothing to guard against — there is no existing row to lose a race
          // with, and the guarded RPC has no "expect absent" form.
          await c.rpc('sync_push_profile_settings_blob', {
            p_profile_id: t.idx, p_settings_json: blob, p_platform: platform, p_origin_client_id: 'numax-web',
          });
        } else {
          await c.rpc('sync_push_profile_settings_blob_guarded', {
            p_profile_id: t.idx, p_settings_json: blob, p_platform: platform, p_expected_updated_at: row.updated_at || null,
          });
        }
        // A push answers 204, so read the switch back rather than assume.
        let ok = null;
        try {
          const check = await c.pullSettings(t.idx, platform);
          ok = !!(check && check.settings_json) && sets.every(([f, k, v]) => blobGet(check.settings_json, f, k, undefined) === v);
        } catch (e) { /* leave ok null — reported as unverified below */ }
        if (ok === false) problems.push(wzPlatLabel(platform) + ': Nuvio accepted the change but the switches are not on afterwards.');
        else {
          notes.push((fresh ? 'Created the ' : 'Switched the features on for ') + wzPlatLabel(platform) + (fresh ? ' settings and switched the features on' : ''));
          if (fresh) created.push(platform);
        }
      } catch (e) {
        const conflict = (A.ConflictError && e instanceof A.ConflictError) || /40001|409|another device/i.test(e.message || '');
        problems.push(wzPlatLabel(platform) + ': ' + (conflict ? 'changed on another device while saving — open this step again and retry' : e.message));
      }
    }
    if (created.length) logAct('Wizard: created settings for ' + created.join(', ') + ' on profile ' + t.idx, 'info');
    return { notes, problems };
  }
  const wzPlatLabel = p => ({ tv: 'Android TV', mobile: 'mobile', desktop: 'desktop' }[p] || p);

  // ======================================================================
  // step 3 — streams
  // ======================================================================
  // Two questions, one after the other: how much of this do you want to do
  // yourself, and then (only on the manual path) which route. The route cards
  // and both route panels are exactly what they were before; they just sit one
  // card further in.
  function wzRenderStreams() {
    const modes = $('wz-modes');
    if (modes && modes.dataset.built !== '1') {
      clr(modes);
      WZ.MODES.forEach(m => {
        const c = wzCard('', () => { wz.mode = m.id; wzRenderStreams(); wzPaintNext(); });
        c.dataset.wzmode = m.id;
        const h = el('div', 'wz-pick-h'); h.appendChild(el('span', 'wz-pick-n', m.name));
        if (m.tag) h.appendChild(wzTag(m.tag));
        h.appendChild(el('span', 'wz-pick-sp'));
        h.appendChild(wzWhyBtn(c, m.name));
        c.appendChild(h);
        c.appendChild(el('div', 'wz-pick-one', m.oneLiner));
        // The simple card's "?" opens the preset instead of pros and cons.
        const wrap = el('div', 'wz-pc-wrap');
        wrap.appendChild(m.id === 'simple' ? wzPresetBlock() : wzProsCons(m.pros, m.cons));
        c.appendChild(wrap);
        modes.appendChild(c);
      });
      modes.dataset.built = '1';
    }
    document.querySelectorAll('[data-wzmode]').forEach(b => b.classList.toggle('on', b.dataset.wzmode === wz.mode));
    $('wz-mode-simple').style.display = wz.mode === 'simple' ? '' : 'none';
    $('wz-mode-advanced').style.display = wz.mode === 'advanced' ? '' : 'none';

    const box = $('wz-routes');
    if (box && box.dataset.built !== '1') {
      clr(box);
      WZ.ROUTES.forEach(r => {
        const c = wzCard('', () => { wz.route = r.id; wzRenderStreams(); wzPaintNext(); });
        c.dataset.wzroute = r.id;
        const h = el('div', 'wz-pick-h');
        h.appendChild(wzLogo(r, 'sm'));
        h.appendChild(el('span', 'wz-pick-n', r.name));
        if (r.tag) h.appendChild(wzTag(r.tag));
        h.appendChild(el('span', 'wz-pick-sp'));
        h.appendChild(wzWhyBtn(c, r.name));
        c.appendChild(h);
        c.appendChild(el('div', 'wz-pick-one', r.oneLiner));
        const wrap = el('div', 'wz-pc-wrap'); wrap.appendChild(wzProsCons(r.pros, r.cons));
        c.appendChild(wrap);
        box.appendChild(c);
      });
      box.dataset.built = '1';
    }
    document.querySelectorAll('[data-wzroute]').forEach(b => b.classList.toggle('on', b.dataset.wzroute === wz.route));
    const adv = wz.mode === 'advanced';
    $('wz-route-aiostreams').style.display = adv && wz.route === 'aiostreams' ? '' : 'none';
    $('wz-route-native').style.display = adv && wz.route === 'native' ? '' : 'none';
    $('wz-route-plugins').style.display = adv && wz.route === 'plugins' ? '' : 'none';
    if (wz.mode === 'simple') wzRenderSimple();
    if (adv && wz.route === 'aiostreams') wzRenderAio();
    if (adv && wz.route === 'native') wzRenderNative();
    if (adv && wz.route === 'plugins') wzRenderPlugins();
  }

  // ======================================================================
  // step 3, simple — "do it all for me"
  // ======================================================================
  // Three things: a TorBox key, a host, one button. The button builds Furqan's
  // exported AIOStreams template with that key in it, has the relay create it on
  // the chosen host, and brings back the manifest link — which then goes into the
  // profile through wzInstallBox, i.e. the same engine.planTarget + api.applyPlan
  // path as every other write in this app. There is no second write mechanism.
  function wzRenderSimple() {
    const S = WZ.SIMPLE;
    const key = $('wz-sim-key');
    if (key.dataset.built !== '1') {
      $('wz-sim-key-b').textContent = S.keyBlurb;
      key.placeholder = S.keyPlaceholder;
      $('wz-sim-key-h').textContent = S.keyHint;
      $('wz-sim-key-no').textContent = S.noTorbox;
      $('wz-sim-run').textContent = S.runLabel;
      // Same live tick as the API-keys step, on the same TorBox descriptor —
      // which means it goes through the relay, because TorBox refuses to answer
      // a browser directly. See wzAskProvider('torbox').
      wzWireCheck(
        { inp: key, chk: $('wz-chk-sim'), val: $('wz-keyv-sim') },
        () => WZ.DEBRID.find(d => d.id === 'torbox')
      );
      key.dataset.built = '1';
    }
    // The relay is the one step a web page cannot take (see wizard.js RELAY).
    // Without it this path says so plainly instead of offering a dead button.
    const off = $('wz-sim-off');
    if (!WZ.RELAY) {
      off.textContent = S.notDeployed; off.style.display = '';
      $('wz-sim-run').disabled = true;
    } else { off.style.display = 'none'; }
    // Warm the host list now so pressing the button does not wait on it. A
    // failure here is silent on purpose — nothing on screen depends on it, and
    // wzSimRun asks again and reports properly if it still cannot be read.
    wzHosts().catch(() => {});
  }

  // ---- which AIOStreams host builds it ------------------------------------
  // This used to be a question, with twelve rows of answers. It was a question
  // nobody had the information to answer: the list is the uptime tracker's own,
  // already sorted best-first, and any of the leaders is equally fine. So the
  // wizard takes one of the four best itself — at random, which also stops
  // every Numax user piling onto whichever host happens to lead today.
  // Deliberately not narrated on screen: it is not a choice the user made.
  const WZ_HOST_POOL = 4;
  let _wzHosts = null;
  function wzHosts() {
    if (!_wzHosts) {
      _wzHosts = (async () => {
        if (!MK) throw new Error('the marketplace data layer did not load');
        const list = await MK.loadInstances('AIOStreams', true);
        if (!list.length) throw new Error('the uptime tracker listed no AIOStreams hosts');
        return list;
      })();
      // A failed read must not become the cached answer for the rest of the
      // session — the next press has to be allowed to try again.
      _wzHosts.catch(() => { _wzHosts = null; });
    }
    return _wzHosts;
  }
  function wzPickHost(list) {
    const pool = list.slice(0, WZ_HOST_POOL);
    return pool[Math.floor(Math.random() * pool.length)].url;
  }

  // The template is fetched rather than inlined so a newer export from Furqan's
  // own AIOStreams can simply replace the file. Cached for the session.
  let _wzTemplate = null;
  async function wzTemplate() {
    if (_wzTemplate) return JSON.parse(JSON.stringify(_wzTemplate));
    const r = await fetch(WZ.TEMPLATE_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error('the Numax preset file could not be read (HTTP ' + r.status + ')');
    const j = await r.json();
    if (!j || !j.config || typeof j.config !== 'object') throw new Error('the Numax preset file is not in the expected shape');
    _wzTemplate = j;
    return JSON.parse(JSON.stringify(j));
  }

  // AIOStreams needs a password on every configuration and cannot recover it.
  // Generated rather than asked for — it is one less field, and it is shown with
  // the result and flagged as the thing to write down.
  function wzPassword() {
    const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const n = new Uint32Array(20); crypto.getRandomValues(n);
    return Array.from(n, x => abc[x % abc.length]).join('');
  }

  // Every placeholder AIOStreams' own template wizard would have prompted for.
  // Left in place, the server reads the literal "<template_placeholder>" as a
  // real value — TMDB rejects it and the whole create fails.
  const WZ_PLACEHOLDER = /<(required_|optional_)?template_placeholder>/i;

  async function wzSimRun() {
    const t = wzTarget(); if (!t) return;
    const st = $('wz-sim-status'), btn = $('wz-sim-run'), out = $('wz-sim-result');
    const key = ($('wz-sim-key').value || '').trim();
    if (!WZ.RELAY) { status(st, WZ.SIMPLE.notDeployed, 'err'); return; }
    if (!key) { status(st, 'Paste your TorBox API key first.', 'err'); $('wz-sim-key').classList.add('wz-need'); return; }
    $('wz-sim-key').classList.remove('wz-need');

    btn.disabled = true; out.style.display = 'none'; clr(out);
    status(st, WZ.SIMPLE.running);

    // Chosen here rather than earlier, so a host that has gone down since the
    // step opened is not the one this run is committed to.
    let list;
    try { list = await wzHosts(); }
    catch (e) { status(st, WZ.SIMPLE.noHosts, 'err'); btn.disabled = false; return; }
    wz.host = wzPickHost(list);

    let base;
    try { base = new URL(wz.host).origin; }
    catch { status(st, 'That host address could not be read.', 'err'); btn.disabled = false; return; }

    const password = wzPassword();
    try {
      const tpl = await wzTemplate();
      const cfg = tpl.config;
      const svc = (cfg.services || []).find(s => s && s.id === 'torbox');
      if (!svc) throw new Error('the Numax preset does not have a TorBox service in it');
      svc.enabled = true;
      svc.credentials = Object.assign({}, svc.credentials, { apiKey: key });

      // The preset is NOT optional about TMDB: its title matching, year matching
      // and digital-release filter all need one, and AIOStreams refuses the whole
      // configuration without it (seen live, not assumed). So it is resolved here
      // and the run stops with something actionable if there isn't one, rather
      // than failing later with AIOStreams' own wording.
      if (WZ_PLACEHOLDER.test(String(cfg.tmdbApiKey || ''))) {
        status(st, 'Checking your TMDB key…');
        const tmdb = await wzTmdbKey(t);
        if (!tmdb) {
          status(st, 'This setup needs a TMDB key — it is what gets titles and years right. Add one on the API keys step, then come back.', 'err');
          btn.disabled = false; return;
        }
        cfg.tmdbApiKey = tmdb;
      }
      // Anything else the preset left as a placeholder is dropped: a placeholder
      // is not a value, and AIOStreams would try to authenticate it as one.
      Object.keys(cfg).forEach(k => { if (WZ_PLACEHOLDER.test(String(cfg[k] || ''))) delete cfg[k]; });

      status(st, WZ.SIMPLE.running);
      const r = await wzRelay(base, cfg, password);
      if (!r.ok) {
        status(st, /tmdb/i.test(r.error || '')
          ? 'TMDB would not accept that key, and this setup needs it. Fix it on the API keys step and try again — nothing was created.'
          : r.error, 'err');
        btn.disabled = false; return;
      }

      status(st, 'Done — your setup is ready on ' + host(base) + '.', 'ok');
      wzSimResult(r, password, base);
      logAct('Wizard: created an AIOStreams configuration on ' + host(base) + ' for profile ' + t.idx, 'info');
      wzLog('Built a tuned AIOStreams setup on ' + host(base) + '.');
      celebrate($('wz-sim-run'));
    } catch (e) {
      status(st, "Couldn't build it: " + e.message, 'err');
      btn.disabled = false;
    }
  }

  // The TMDB key for this run: what was typed on the keys step if it is still on
  // screen, otherwise what the profile already has stored. Coming back to the
  // wizard later leaves that input empty while the key is sitting in the profile,
  // and refusing to build at that point would be wrong.
  async function wzTmdbKey(t) {
    const typed = (($('wz-key-tmdb') || {}).value || '').trim();
    if (typed) return typed;
    try {
      const rows = await A.client(store, t.aid).pullProviderCredentials(t.idx);
      const row = (rows || []).find(r => r.provider === 'tmdb');
      const k = row && row.credential_json && row.credential_json.api_key;
      return (typeof k === 'string' && k.trim()) ? k.trim() : '';
    } catch (e) { return ''; }
  }

  // The one call a browser cannot make against AIOStreams directly. Returns a
  // flat {ok, ...} rather than throwing, so every failure carries a sentence.
  async function wzRelay(base, config, password) {
    let res;
    try {
      res = await fetch(WZ.RELAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: base, config, password }),
      });
    } catch (e) {
      return { ok: false, error: 'The Numax setup service could not be reached. Check your connection, or use the manual path below.' };
    }
    let j = null;
    try { j = await res.json(); } catch { /* reported just below */ }
    if (!res.ok || !j || !j.manifestUrl) {
      return { ok: false, error: (j && j.error) || ('The setup service answered HTTP ' + res.status + ' and nothing was created.') };
    }
    return { ok: true, url: j.manifestUrl, uuid: j.uuid, configureUrl: j.configureUrl, keyUnchecked: !!j.keyUnchecked };
  }

  function wzSimResult(r, password, base) {
    const out = $('wz-sim-result');
    clr(out); out.style.display = '';
    const w = el('div', 'wz-out');
    w.appendChild(wzOutRow('Your add-on link', r.url));
    w.appendChild(wzOutRow('Configuration ID', r.uuid));
    w.appendChild(wzOutRow('Password', password));
    out.appendChild(w);
    const warn = el('div', 'wz-catch'); warn.style.marginTop = '12px';
    warn.textContent = WZ.SIMPLE.saveWarn;
    out.appendChild(warn);
    if (r.keyUnchecked) {
      const n = el('p', 'muted sm'); n.style.marginTop = '10px';
      n.textContent = 'TorBox could not be reached to check that key, so it went in as typed. If nothing plays, check the key first.';
      out.appendChild(n);
    }
    const row = el('div'); row.style.marginTop = '12px';
    const openIt = el('button', 'btn btn-ghost btn-xs wz-out-open', 'Change it on ' + host(base));
    openIt.onclick = () => wzOpen(r.configureUrl || base);
    row.appendChild(openIt);
    out.appendChild(row);

    // Hand the link to the same install box every other add-on goes through, so
    // Next writes it in with Merge-vs-Overwrite and per-item reporting intact.
    const slot = $('wz-sim-install');
    slot.style.display = '';
    wzInstallBox(slot, {
      step: 'streams', label: 'AIOStreams',
      hint: WZ.SIMPLE.installHint,
      defaultName: 'AIOStreams',
      defaultUrl: r.url,
      sayWhere: true,
    });
  }

  function wzOutRow(label, value) {
    const r = el('div', 'wz-out-row');
    const tx = el('div');
    tx.appendChild(el('div', 'k', label));
    tx.appendChild(el('div', 'v', value));
    r.appendChild(tx);
    const b = el('button', 'btn btn-ghost btn-xs', 'Copy');
    b.onclick = async () => {
      const done = await wzCopy(value);
      b.textContent = done ? 'Copied' : 'Select it instead';
      setTimeout(() => { b.textContent = 'Copy'; }, 1800);
    };
    r.appendChild(b);
    return r;
  }
  // Clipboard access can be refused (no permission, insecure context). The value
  // is select-all-on-click in the markup, so a refusal has a plain fallback.
  async function wzCopy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  // No debrid picker here any more. AIOStreams asks for your service on its own
  // site, in its own Services menu, and applies the key there — so picking one
  // in Numax first changed nothing, wrote nothing and could not be acted on. It
  // was seven cards of reading in front of the two steps that actually do
  // something. (wizard.js still carries the DEBRID list; the Nuvio+TorBox route
  // uses the two entries Nuvio itself can drive.)
  function wzRenderAio() {
    // instances
    if ($('wz-instances').dataset.built !== '1') wzLoadInstances();
    // paste-back
    if ($('wz-aio-install').dataset.built !== '1') {
      wzInstallBox($('wz-aio-install'), {
        step: 'streams', label: 'AIOStreams',
        hint: 'The manifest link AIOStreams gave you — it ends in /manifest.json.',
        defaultName: 'AIOStreams',
        sayWhere: true,
      });
      $('wz-aio-install').dataset.built = '1';
    }
  }

  // The seven-step guide used to be a card sat permanently between "pick an
  // instance" and "paste the link back", which is most of a screen of reading
  // for people who have done this before. It is the same guide, on request.
  // `details` entries are authored copy from wizard.js, which is what uiModal's
  // HTML pass expects — nothing user-supplied goes through it.
  function wzShowGuide() {
    return uiModal({
      title: 'Setting up AIOStreams',
      message: 'All of this happens on the instance you opened. Come back here with one link at the end.',
      details: WZ.AIO_GUIDE.map((x, i) => '<b>' + (i + 1) + '. ' + esc(x.title) + '</b><br>' + x.body),
      okLabel: 'Close', noCancel: true,
    });
  }

  // Only the Nuvio+TorBox route builds these now, and only for the two services
  // Nuvio can drive itself, so `nativeOnly` is gone with the other caller.
  function wzDebridCard(d) {
    const c = wzCard('', () => { wz.debrid = d.id; wzMarkNativeDebrid(); });
    c.dataset.wzdebrid = d.id;
    const h = el('div', 'wz-pick-h');
    h.appendChild(wzLogo(d, 'sm'));
    h.appendChild(el('span', 'wz-pick-n', d.name));
    if (d.tag) h.appendChild(wzTag(d.tag));
    h.appendChild(el('span', 'wz-pick-sp'));
    h.appendChild(wzWhyBtn(c, d.name));
    const open = el('button', 'btn btn-ghost btn-xs', 'Open site');
    open.onclick = e => { e.stopPropagation(); wzOpen(d.url); };
    h.appendChild(open);
    c.appendChild(h);
    if (d.price) c.appendChild(el('div', 'wz-pick-price', d.price));
    // The reasoning folds away and only the "?" in the header opens it.
    const wrap = el('div', 'wz-pc-wrap');
    wrap.appendChild(wzProsCons(d.pros, d.cons));
    c.appendChild(wrap);
    return c;
  }

  async function wzLoadInstances() {
    const box = $('wz-instances'), st = $('wz-inst-status');
    clr(box); status(st, 'Reading the uptime tracker…');
    try {
      if (!MK) throw new Error('the marketplace data layer did not load');
      const list = await MK.loadInstances('AIOStreams', true);
      clr(box); status(st, '');
      $('wz-inst-count').textContent = list.length + ' public';
      if (!list.length) { box.appendChild(el('p', 'empty', 'No instances listed right now.')); return; }
      const openIt = i => () => { wzOpen(i.url); logAct('Wizard: opened AIOStreams instance ' + i.name, 'info'); };
      const upText = i => i.uptime != null ? i.uptime.toFixed(2) + '% up' : 'uptime unknown';
      const upCls = i => 'up' + (i.uptime != null && i.uptime < 99 ? ' low' : '');

      // The list is sorted best-uptime-first, so the top one is the recommendation.
      // It stays a full row; the rest are a choice you rarely need to make, so they
      // wait behind "See more" and open as a grid.
      const first = list[0];
      const r = el('div', 'wz-inst');
      r.appendChild(el('span', 'nm', first.name));
      r.appendChild(el('span', upCls(first), upText(first)));
      r.appendChild(el('span', 'spacer'));
      const fb = el('button', 'btn btn-solid btn-xs', 'Open');
      fb.onclick = openIt(first);
      r.appendChild(fb);
      box.appendChild(r);

      const rest = list.slice(1);
      if (rest.length) {
        const more = el('div', 'wz-inst-more'); more.style.display = 'none';
        rest.forEach(i => {
          const sq = el('div', 'wz-inst-sq');
          sq.appendChild(el('div', 'nm', i.name));
          sq.appendChild(el('div', upCls(i), upText(i)));
          sq.appendChild(el('span', 'sp'));
          const b = el('button', 'btn btn-solid btn-xs', 'Open');
          b.onclick = openIt(i);
          sq.appendChild(b);
          more.appendChild(sq);
        });
        const toggle = el('button', 'btn btn-ghost btn-xs wz-inst-seemore', 'See ' + rest.length + ' more');
        toggle.onclick = () => {
          if (more.style.display !== 'none') {
            more.classList.remove('in');
            more.style.display = 'none';
            toggle.textContent = 'See ' + rest.length + ' more';
            return;
          }
          // The delay only paces the animation; it never decides whether a card
          // is visible. See .wz-inst-more.in in the stylesheet.
          [...more.children].forEach((sq, n) => { sq.style.animationDelay = Math.min(n * 35, 420) + 'ms'; });
          more.style.display = '';
          more.classList.add('in');
          toggle.textContent = 'Show fewer';
        };
        box.appendChild(toggle);
        box.appendChild(more);
      }
      box.dataset.built = '1';
    } catch (e) {
      clr(box); status(st, "Couldn't read the instance list: " + e.message, 'err');
      box.appendChild(el('p', 'empty', 'Pick one from uptime.ibbylabs.dev instead.'));
    }
  }

  // Re-asks the tick when the SERVICE changes rather than the text. Set by
  // wzRenderNative on first build; see wzWireCheck's return value.
  let wzNativeRecheck = null;
  function wzRenderNative() {
    const c = $('wz-native-catch');
    if (c.dataset.built !== '1') { c.innerHTML = WZ.ROUTES.find(r => r.id === 'native').catch; c.dataset.built = '1'; }
    const box = $('wz-native-debrid');
    if (box.dataset.built !== '1') {
      clr(box);
      WZ.DEBRID.filter(d => d.native).forEach(d => box.appendChild(wzDebridCard(d)));
      // The live tick, same machinery as the API-keys step. Which service is
      // being asked depends on which card is on, so the spec is read fresh.
      wzNativeRecheck = wzWireCheck(
        { inp: $('wz-native-key'), chk: $('wz-chk-native'), val: $('wz-keyv-native') },
        () => WZ.DEBRID.find(d => d.id === wz.debrid && d.native)
      );
      box.dataset.built = '1';
    }
    wzMarkNativeDebrid();
    // Two options: the one that needs no configuring, and a way out to the
    // marketplace for anyone who already knows they want something else.
    const p = $('wz-p2p');
    if (p.dataset.built !== '1') {
      clr(p);
      WZ.P2P_ADDONS.forEach(a => {
        const card = el('div', 'wz-pick wz-pick-static');
        const h = el('div', 'wz-pick-h');
        h.appendChild(wzLogo(a, 'sm'));
        h.appendChild(el('span', 'wz-pick-n', a.name));
        if (a.tag) h.appendChild(wzTag(a.tag));
        h.appendChild(el('span', 'wz-pick-sp'));
        card.appendChild(h);
        card.appendChild(el('div', 'wz-pick-one', a.blurb));
        const act = el('div', 'wz-pick-act');
        const b = el('button', 'btn btn-ghost btn-xs', a.browse ? 'Browse add-ons' : 'Open site');
        b.onclick = () => a.browse ? wzShowInstancePicker() : wzOpen(a.url);
        act.appendChild(b); card.appendChild(act);
        p.appendChild(card);
      });
      p.dataset.built = '1';
    }
    if ($('wz-p2p-install').dataset.built !== '1') {
      wzInstallBox($('wz-p2p-install'), {
        step: 'streams', label: 'torrent add-on',
        hint: 'The manifest link from whichever add-on you configured — with no debrid key in it.',
        defaultName: 'Streams',
        sayWhere: true,
      });
      $('wz-p2p-install').dataset.built = '1';
    }
  }
  function wzMarkNativeDebrid() {
    document.querySelectorAll('#wz-native-debrid [data-wzdebrid]').forEach(b => b.classList.toggle('on', b.dataset.wzdebrid === wz.debrid));
    const d = WZ.DEBRID.find(x => x.id === wz.debrid && x.native);
    const key = $('wz-native-key');
    key.placeholder = d ? d.name + ' API key' : 'API key';
    status($('wz-native-status'), d
      ? 'Get the key from ' + host(d.keyUrl) + ', paste it above, and “Save and move to next step” connects it and switches resolving on.'
      : 'Pick TorBox or Premiumize first.');
    if (wzNativeRecheck) wzNativeRecheck();
    wzPaintNext();
  }
  // Reuses the marketplace's own instance bubble rather than a second one.
  function wzShowInstancePicker() { nav('market'); switchMkTab('addons'); }

  // Writes a debrid key the way Nuvio's own Connected Services screen ends up
  // storing it, and turns on the two switches that make it do anything.
  //
  // It has no button of its own any more. "Connect and turn on resolving" was a
  // second thing to press on a step that already ends in Next, and pressing
  // only Next quietly skipped it. Next is the one control that writes on every
  // step, and wzCommitStep calls this first — so filling in the key and the
  // add-on link and pressing Next once does both, in that order.
  async function wzSaveNativeKey() {
    const t = wzTarget(); if (!t) return false;
    const st = $('wz-native-status'), res = $('wz-native-res');
    clr(res);
    const d = WZ.DEBRID.find(x => x.id === wz.debrid && x.native);
    if (!d) { status(st, 'Pick TorBox or Premiumize first.', 'err'); return false; }
    const key = ($('wz-native-key').value || '').trim();
    if (!key) { status(st, 'Paste the API key first.', 'err'); return false; }
    status(st, 'Connecting…');
    const problems = [];
    try {
      const c = A.client(store, t.aid);
      try { await wzSnapCreds(c, t.idx, [{ provider: 'debrid:' + d.id, field: 'api_key' }]); }
      catch (e) {
        status(st, "Couldn't read what this profile already had first, and without that this could not be undone — nothing was written: " + e.message, 'err');
        return false;
      }
      await c.pushProviderCredentials(t.idx, [{ provider: 'debrid:' + d.id, credential_json: { api_key: key } }], 'numax-web');
      let live = [];
      try { live = await c.pullProviderCredentials(t.idx); } catch (e) { problems.push("Couldn't read it back to confirm: " + e.message); }
      const row = live.find(r => r.provider === 'debrid:' + d.id);
      if (live.length && !(row && row.credential_json.api_key === key)) problems.push('Nuvio accepted the key but it is not stored afterwards.');
      // debrid_enabled + which provider resolves. Leaf names differ on TV.
      const flipped = await wzApplyToggles(t, [
        { platform: 'tv', sets: [['debrid_settings', 'debrid_enabled', true, 'boolean'], ['debrid_settings', 'preferred_resolver_provider_id', d.id, 'string']] },
        { platform: 'mobile', sets: [['debrid_settings', 'debrid_enabled', true, 'boolean'], ['debrid_settings', 'debrid_preferred_resolver_provider_id', d.id, 'string']] },
        { platform: 'desktop', sets: [['debrid_settings', 'debrid_enabled', true, 'boolean'], ['debrid_settings', 'debrid_preferred_resolver_provider_id', d.id, 'string']] },
      ]);
      const rep = el('div', 'report');
      const r0 = el('div', 'rline');
      r0.innerHTML = '<span class="rk">' + esc(d.name) + '</span>' + (problems.length ? '<span class="tag rem">not saved</span>' : '<span class="tag add">connected</span>');
      rep.appendChild(r0);
      flipped.notes.forEach(n => { const r = el('div', 'rline muted'); r.innerHTML = '<span class="rk">' + esc(n) + '</span>'; rep.appendChild(r); });
      res.appendChild(rep);
      flipped.problems.forEach(p => problems.push(p));
      if (problems.length) {
        status(st, problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ' — see below.', 'err');
        const ul = el('ul', 'modal-details'); problems.forEach(p => ul.appendChild(el('li', '', p))); res.appendChild(ul);
        inval(t.aid);
        return false;
      } else {
        status(st, d.name + ' connected and link resolving is on. If Nuvio still shows it unlinked, use its own Connected Services screen — some builds only accept the key through their device-code flow.', 'ok');
        wzSavedKeys.set('debrid', key);
        wzLock();
        wzLog('Connected ' + d.name + ' and turned on link resolving.');
        logAct('Wizard: connected ' + d.name + ' on ' + t.name, 'ok');
        celebrate(res);
      }
      inval(t.aid);
      return true;
    } catch (e) {
      status(st, "Couldn't save: " + e.message, 'err');
      logAct('Wizard: debrid connect failed — ' + e.message, 'err');
      return false;
    }
  }

  // ======================================================================
  // step 3, third route — Nuvio plugins
  // ======================================================================
  // A plugin is not an add-on and the difference matters here: Nuvio downloads
  // the provider's code and runs it on the device in a sandboxed QuickJS
  // runtime, rather than asking a server for an answer (Nuvio wiki,
  // Integrations → Plugins). So this route needs no instance, no key and no
  // subscription — and no debrid either, which is why it sits alongside the
  // other two rather than competing with them.
  //
  // This pane is read-only. The write is wzAddPlugin, which is mkWrite —
  // engine.planTarget + api.applyPlan, the same path as everything else.
  function wzRenderPlugins() {
    const box = $('wz-plugins'); if (!box || box.dataset.built === '1') return;
    const P = WZ.PLUGINS;
    clr(box);
    box.appendChild(el('p', 'muted sm wz-sec-lead', P.lead));
    const warn = el('div', 'wz-catch'); warn.innerHTML = P.caveat; box.appendChild(warn);
    const note = el('div', 'mk-note wz-plug-note');
    note.innerHTML = MK_INFO_SVG + '<div>' + P.ondevice + '</div>';
    box.appendChild(note);
    box.appendChild(el('p', 'muted sm', P.trust));
    const run = el('div', 'wz-run');
    const b = el('button', 'btn btn-primary', P.browse);
    b.onclick = wzPluginDialog;
    run.appendChild(b);
    box.appendChild(run);
    box.dataset.built = '1';
  }

  // The repository browser. Deliberately the Marketplace's own dialog
  // (openMkPop) and not a second mechanism: it already carries this app's
  // entry/exit motion, focus trap, Escape handling and focus restore.
  // `mk-dlg-wide` is the only new thing — a repo row plus its provider list
  // needs more room than a profile picker does.
  async function wzPluginDialog() {
    const t = wzTarget(); if (!t || !MK) return;
    const P = WZ.PLUGINS;
    const pop = openMkPop(null, P.dlgTitle, 'Adding goes straight to ' + wzProfileName() + '. ' + P.dlgSub);
    pop.root.classList.add('mk-dlg-wide');
    const mine = pop;
    const stale = () => mkPop !== mine;

    const note = el('div', 'mk-note');
    note.innerHTML = MK_INFO_SVG + '<div>' + P.ondevice + '</div>';
    pop.body.appendChild(note);

    const bar = el('div', 'wz-plug-bar');
    // `modal-input` is not decoration: ui-motion's dialog trap focuses the last
    // focusable element in a card unless the card has one, which opened this
    // dialog scrolled to its own bottom (on "Show all"). Same class, same
    // reason, as openAddToProfile.
    const inp = el('input', 'wz-plug-search modal-input'); inp.type = 'search'; inp.autocomplete = 'off';
    inp.placeholder = 'Search repositories, publishers and providers…';
    const cnt = el('span', 'pill-count');
    bar.appendChild(inp); bar.appendChild(cnt);
    pop.body.appendChild(bar);
    const list = el('div', 'wz-plug-list'); pop.body.appendChild(list);

    // The report lives in the footer, not in the row, so it survives the
    // redraw that follows a write.
    const st = el('div', 'inline-status'); pop.foot.appendChild(st);
    const res = el('div', 'mk-res'); pop.foot.appendChild(res);

    const got = await loadInto(list, 'Reading the community index…',
      () => MK.loadPluginIndex(false), { stale, prefix: 'Could not read the plugin index: ' });
    if (!got) return;
    const rows = got.value;
    if (!rows.length) { list.appendChild(el('p', 'empty sm', P.empty)); return; }

    // What this profile already has, so a repository it carries is marked
    // rather than offered as new. Read-only; a failure costs nothing but the
    // badge, and the row simply does not claim to know.
    const have = new Set();
    try {
      const { backup } = await loadAccount(t.aid);
      (sliceProfile(backup, t.idx).plugins || []).forEach(x => have.add(String(x.url)));
    } catch (e) { /* no badge, no lie */ }

    // Search reaches provider names as well as repository ones, but only for
    // repositories whose manifest has already been read — a keystroke must not
    // fire nineteen fetches. Every visible row loads its own manifest as it
    // paints and market.js caches it, so in practice the whole index becomes
    // searchable a moment after the dialog opens.
    let timer = null;
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const hit = p => !q || (p.name + ' ' + p.lang + ' ' + ((p.owner && p.owner.login) || '') + ' ' + (p._names || ''))
        .toLowerCase().includes(q);
      const shown = rows.filter(hit);
      cnt.textContent = q ? shown.length + ' of ' + rows.length : rows.length + ' repositories';
      clr(list);
      if (!shown.length) { list.appendChild(el('p', 'mk-find-none', 'No repository matches “' + q + '”.')); return; }
      shown.forEach(p => list.appendChild(wzPlugRow(p, have, st, res, draw)));
    };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { draw(); pop.body.scrollTop = 0; }, 110); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; draw(); pop.body.scrollTop = 0; } });
    draw();
    pop.body.scrollTop = 0;
    setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }, 60);
  }

  // One repository. The provider list underneath is CONTEXT, never a picker:
  // Nuvio's sync stores one row per repository and the per-provider switches
  // are device-local, so a tick here would be a control Numax could not honour.
  // Open state is kept on the row object so a redraw does not close it.
  function wzPlugRow(p, have, st, res, redraw) {
    const on = have.has(String(p.manifestUrl));
    const row = el('div', 'wz-plug' + (on ? ' on' : ''));
    const head = el('div', 'wz-plug-h');
    const ic = mkLogo(p.name, p.logo);
    if (p.owner) ic.title = p.owner.login + ' on ' + p.owner.forge;
    head.appendChild(ic);
    const tx = el('div', 'wz-plug-tx');
    const nm = el('div', 'wz-plug-n');
    nm.appendChild(el('span', '', p.name));
    if (on) nm.appendChild(wzTag('On this profile'));
    tx.appendChild(nm);
    const meta = el('div', 'wz-plug-m', p._meta || 'checking…');
    if (p._err) meta.classList.add('bad');
    tx.appendChild(meta);
    head.appendChild(tx);
    const lang = String(p.lang || '').replace(/ language$/i, '');
    if (lang && lang !== 'Unknown') head.appendChild(el('span', 'mk-lang', lang));
    const see = el('button', 'btn btn-ghost btn-xs', p._open ? 'Hide providers' : 'Providers');
    const add = el('button', 'btn btn-primary btn-xs', on ? 'Add again' : 'Add');
    head.appendChild(see); head.appendChild(add);
    row.appendChild(head);

    const body = el('div', 'wz-plug-b'); body.style.display = p._open ? '' : 'none';
    row.appendChild(body);

    const fill = () => {
      clr(body);
      if (p._err) {
        body.appendChild(el('p', 'empty sm err-text', 'Could not read this repository from here: ' + p._err));
        body.appendChild(el('p', 'muted sm', 'That is not proof it is dead — Nuvio fetches these on the device, and its own Add Plugin dialog never checks a URL before storing it. Adding it is still allowed; only the list of providers is unavailable.'));
        return;
      }
      const m = p._m;
      if (!m) { body.appendChild(el('p', 'muted sm shimmer', 'Reading the manifest…')); return; }
      if (!m.scrapers.length) { body.appendChild(el('p', 'empty sm', 'This repository lists no providers.')); return; }
      const w = el('div', 'wz-plug-scr');
      m.scrapers.slice(0, 200).forEach(sc => {
        const r = el('div', 'mk-scr');
        r.appendChild(mkLogo(sc.name || sc.id, sc.logo, 'mk-ic-s'));
        const c = el('div'); c.style.minWidth = '0';
        c.appendChild(el('div', 'mk-sn', sc.name || sc.id || 'provider'));
        if (sc.description) c.appendChild(el('div', 'mk-sd', sc.description));
        r.appendChild(c);
        const langs = Array.isArray(sc.contentLanguage) ? sc.contentLanguage.join(' · ').toUpperCase() : '';
        if (langs) { const g = el('span', 'mk-lang', langs); g.style.marginLeft = 'auto'; r.appendChild(g); }
        w.appendChild(r);
      });
      body.appendChild(w);
      if (m.scrapers.length > 200) body.appendChild(el('p', 'muted sm', 'Showing the first 200 of ' + m.scrapers.length + '.'));
    };

    see.onclick = () => {
      p._open = !p._open;
      see.textContent = p._open ? 'Hide providers' : 'Providers';
      body.style.display = p._open ? '' : 'none';
      if (p._open) fill();
    };
    if (p._open) fill();

    // Reachability and the provider names the search box needs, in one read.
    // market.js caches it, so a redraw is free.
    if (!p._m && !p._err) {
      MK.loadManifest(p.manifestUrl).then(m => {
        p._m = m;
        p._names = m.scrapers.map(x => x.name || x.id || '').join(' ');
        p._meta = m.scrapers.length + ' provider' + (m.scrapers.length === 1 ? '' : 's') + (m.version ? ' · v' + m.version : '');
        meta.textContent = p._meta;
        if (p._open) fill();
      }).catch(e => {
        p._err = e.message;
        p._meta = 'could not preview from here';
        meta.textContent = p._meta; meta.classList.add('bad');
        row.classList.add('dead');
        if (p._open) fill();
      });
    }

    add.onclick = async () => {
      const r = await wzAddPlugin(p, { btn: add, st, res });
      if (r && r.ok && r.written) have.add(String(p.manifestUrl));
      // mkWrite leaves the button it drove in its finished state, so the row is
      // rebuilt rather than un-picked by hand. The status and the report are in
      // the dialog footer, so they survive it.
      redraw();
    };
    return row;
  }

  // The write. Snapshot first — a change the wizard cannot reverse is not one
  // it is allowed to make — then mkWrite, which plans with the engine, applies,
  // and reads the profile back to prove it landed. `auto` skips the second
  // click for exactly the reason the add-on box does: this is a single-item
  // MERGE, so mkWrite's removal gate is never reached.
  async function wzAddPlugin(p, o) {
    const t = wzTarget(); if (!t) return { written: false, ok: false };
    const name = String(p.name || 'Plugin repository').trim();
    try { await wzSnapPlugins(t); }
    catch (e) {
      status(o.st, "Couldn't read this profile's plugins first, and without that this could not be undone — nothing was written: " + e.message, 'err');
      return { written: false, ok: false };
    }
    return (await mkWrite({
      kind: 'plugins',
      master: [{ url: p.manifestUrl, name, enabled: true }],
      targets: [{ aid: t.aid, idx: t.idx, name: t.name }],
      mode: 'merge', st: o.st, res: o.res, btn: o.btn, label: name, aid: t.aid, auto: true,
      onDone: ok => {
        if (!ok) return;
        wzLock();
        wzLog('Added the ' + name + ' plugin repository — its providers still have to be switched on in the Nuvio app.');
      },
    })) || { written: false, ok: true };
  }

  // ======================================================================
  // step 4 - metadata
  // ======================================================================
  function wzRenderMeta() {
    if ($('wz-order-tip')) $('wz-order-tip').textContent = WZ.ORDER_TIP;
    const box = $('wz-meta'); if (!box) return;
    if (box.dataset.built !== '1') {
      clr(box);
      WZ.METADATA.forEach(m => {
        const w = el('div', 'wz-meta-card'); w.dataset.wzmeta = m.id;
        const top = el('div', 'wz-meta-top');
        top.appendChild(wzLogo(m, 'lg'));
        const hd = el('div', 'wz-meta-hd');
        const nm = el('div', 'nm');
        nm.appendChild(el('span', '', m.name));
        nm.appendChild(el('span', 'wz-meta-tag'));
        hd.appendChild(nm);
        top.appendChild(hd);
        // The tile's one button sits in its header row rather than on a line of
        // its own. Four of these are side by side on a step that now has to fit
        // a fixed column, and a whole row for a single ghost button was the
        // cheapest 40px in the tile to give back.
        const b = el('button', 'btn btn-ghost btn-xs wz-meta-go', m.instances ? 'Pick an instance' : 'Open site');
        b.onclick = () => m.instances ? wzMetaInstances(w, m) : wzOpen(m.url);
        top.appendChild(b);
        w.appendChild(top);
        w.appendChild(el('div', 'wz-meta-b', m.blurb));
        w.appendChild(el('div', 'wz-meta-w', m.body));
        const slot = el('div', 'wz-meta-slot'); w.appendChild(slot);
        wzInstallBox(slot, {
          step: 'meta', label: m.name,
          hint: 'The manifest link ' + m.name + ' gave you.',
          defaultName: m.installName || m.name,
          defaultUrl: m.check || '',
          top: true,
        });
        box.appendChild(w);
      });
      box.dataset.built = '1';
    }
    wzMarkMetaInstalled();
    wzRenderCollections();
  }

  // ---- collections: the optional tail of the metadata step ----------------
  // Last on this step and framed as optional, because a collection is only a
  // list of titles — the metadata add-ons above it are what draw the posters.
  function wzRenderCollections() {
    const box = $('wz-collections'); if (!box || box.dataset.built === '1') return;
    const C = WZ.COLLECTIONS_STEP;
    clr(box);
    box.appendChild(el('p', 'muted sm wz-sec-lead', C.lead));
    const run = el('div', 'wz-run');
    const b = el('button', 'btn btn-primary', C.browse);
    b.onclick = wzCollectionDialog;
    run.appendChild(b);
    box.appendChild(run);
    box.appendChild(el('p', 'muted sm wz-sec-foot', C.note));
    box.dataset.built = '1';
  }

  // Browsing is the Marketplace's own read (mkLoadCollections — live through
  // the relay, the captured snapshot as a stated fallback) shown in the
  // Marketplace's own dialog. The only difference from the Marketplace's
  // install is that there is no profile picker: the wizard already has one, and
  // Add goes to it.
  let wzCollShowAll = false;
  const WZ_COLL_PAGE = 24;
  async function wzCollectionDialog() {
    const t = wzTarget(); if (!t || !MK) return;
    const C = WZ.COLLECTIONS_STEP;
    const pop = openMkPop(null, C.dlgTitle, 'Adding goes straight to ' + wzProfileName() + '. ' + C.dlgSub);
    pop.root.classList.add('mk-dlg-wide');
    const mine = pop;
    const stale = () => mkPop !== mine;

    const bar = el('div', 'wz-plug-bar');
    const inp = el('input', 'wz-plug-search modal-input'); inp.type = 'search'; inp.autocomplete = 'off';
    inp.placeholder = 'Search collections…';
    const cnt = el('span', 'pill-count');
    bar.appendChild(inp); bar.appendChild(cnt);
    pop.body.appendChild(bar);
    const banner = el('div'); pop.body.appendChild(banner);
    const grid = el('div', 'mk-coll-grid wz-coll-grid'); pop.body.appendChild(grid);

    const st = el('div', 'inline-status'); pop.foot.appendChild(st);
    const res = el('div', 'mk-res'); pop.foot.appendChild(res);

    const got = await loadInto(grid, 'Reading community collections…',
      () => mkLoadCollections(false), { stale, prefix: 'Could not read the collections list: ' });
    if (!got) return;
    const cache = got.value;

    // Which of the two is on screen is always named. A snapshot presented as
    // live is the one thing this must never do.
    const note = el('div', 'mk-note' + (cache.live ? '' : ' mk-warn'));
    note.innerHTML = MK_INFO_SVG + '<div>' + (cache.live
      ? '<b>Live from Nuvio</b> — ' + cache.total + ' collections, read just now.'
        + (cache.short ? ' Nuvio lists ' + cache.short + '; the rest did not come back, so this is incomplete.' : '')
      : '<b>Snapshot, not live</b> — ' + cache.total + ' collections captured '
        + (cache.capturedAt ? esc(new Date(cache.capturedAt).toLocaleDateString()) : 'earlier')
        + (mkCollectionsFellBack ? '. The live read failed (' + esc(mkCollectionsFellBack) + ')' : '') + '.') + '</div>';
    banner.appendChild(note);

    wzCollShowAll = false;
    const all = cache.items || [];
    let timer = null;
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const hit = c => {
        if (!q) return true;
        const tags = Array.isArray(c.tags) ? c.tags.join(' ') : '';
        return (String(c.title || '') + ' ' + String(c.description || '') + ' ' + tags).toLowerCase().includes(q);
      };
      const items = all.filter(hit).sort((a, b) => (b.installs_count || 0) - (a.installs_count || 0));
      cnt.textContent = q ? items.length + ' of ' + all.length : all.length + ' collections';
      clr(grid);
      if (!items.length) { grid.appendChild(el('p', 'mk-find-none', 'No collection matches “' + q + '”.')); return; }
      const page = wzCollShowAll ? items.length : Math.min(items.length, WZ_COLL_PAGE);
      items.slice(0, page).forEach(c => grid.appendChild(wzCollCard(c, st, res)));
      if (page < items.length) {
        const more = el('button', 'btn btn-ghost mk-coll-more-btn', 'Show all ' + items.length);
        more.onclick = () => { wzCollShowAll = true; draw(); };
        grid.appendChild(more);
      }
    };
    draw.top = () => { pop.body.scrollTop = 0; };
    inp.addEventListener('input', () => { clearTimeout(timer); wzCollShowAll = false; timer = setTimeout(() => { draw(); draw.top(); }, 110); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; draw(); draw.top(); } });
    draw();
    draw.top();
    setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }, 60);
  }

  function wzCollCard(c, st, res) {
    const card = el('div', 'mk-coll-card');
    if (c.image_url) {
      const img = el('img', 'mk-coll-img');
      img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = c.image_url;
      card.appendChild(img);
    }
    const body = el('div', 'mk-coll-body');
    body.appendChild(el('div', 'mk-coll-title', c.title));
    if (c.description) body.appendChild(el('div', 'mk-coll-desc', mdStrip(c.description)));
    const s2 = c.stats || {};
    const bits = [
      s2.folderCount != null ? s2.folderCount + ' folders' : null,
      s2.sourceCount != null ? s2.sourceCount + ' sources' : null,
    ].filter(Boolean).join(' · ');
    if (bits) body.appendChild(el('div', 'mk-coll-stats', bits));
    if (Array.isArray(c.requiredAddons) && c.requiredAddons.length) {
      const names = c.requiredAddons.map(a => a.addonName || a.addonId);
      const req = el('div', 'mk-coll-req', 'Needs: ' + names.join(', '));
      req.title = names.join(', ');
      body.appendChild(req);
    }
    const foot = el('div', 'mk-coll-foot');
    foot.appendChild(el('span', 'muted sm', (c.installs_count || 0) + ' installs'));
    const add = el('button', 'btn btn-primary btn-xs', 'Add');
    add.onclick = () => wzAddCollection(c, { btn: add, st, res });
    foot.appendChild(add);
    body.appendChild(foot);
    card.appendChild(body);
    return card;
  }

  // Reads the collection's full payload, applies Nuvio's own install
  // transformation to it (market.js toInstalledCollection — without it the
  // write lands in a form Nuvio does not recognise as an installed community
  // collection), then plans and applies through engine.planTarget +
  // api.applyPlan and reads the profile back to prove it is there. Byte for
  // byte the Marketplace's install path; only the target differs.
  //
  // Always a MERGE, like the wizard's add-on box: this adds a collection, so it
  // can remove nothing, and there is no Overwrite to choose between.
  async function wzAddCollection(c, o) {
    const t = wzTarget(); if (!t) return;
    o.btn.disabled = true; clr(o.res); status(o.st, 'Reading “' + c.title + '”…');
    try {
      let doc = null;
      if (MK.COLLECTIONS.relayReady && MK.COLLECTIONS.relayReady()) {
        try { doc = await MK.loadCollectionInstallLive(c.public_id, await nuvioToken()); }
        catch (e) { /* fall through to the captured payload rather than dead-end */ }
      }
      if (!doc) doc = await MK.loadCollectionInstall(c.public_id);

      const version = (c.community && c.community.version) || 1;
      const at = Date.now();
      const collections = doc.collections.map(x =>
        MK.toInstalledCollection(x, { publicId: c.public_id, version, installedAt: at }));

      try {
        await wzSnapCollections(t);
        if (doc.requiredAddons.length) await wzSnapAddons(t);
      } catch (e) {
        status(o.st, "Couldn't read what this profile already had first, and without that this could not be undone — nothing was written: " + e.message, 'err');
        o.btn.disabled = false; return;
      }

      status(o.st, 'Reading the profile…');
      const { backup } = await loadAccount(t.aid, true);
      const state = sliceProfile(backup, t.idx);
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
      const plan = E.planTarget(master, state, {
        categories: cats, modes: { collections: 'merge', addons: 'merge' },
        profileId: t.idx, originClientId: 'numax-web',
      });
      if (!plan.hasChanges) {
        status(o.st, '“' + c.title + '” is already on ' + t.name + ' — nothing to do.', 'ok');
        o.btn.textContent = 'Already on it';
        return;
      }
      status(o.st, 'Writing…');
      const rr = await A.client(store, t.aid).applyPlan(plan, { dryRun: false });
      inval(t.aid);
      const bad = (rr.results || []).filter(x => !x.ok);
      if (bad.length) { status(o.st, 'Failed: ' + bad.map(b => b.error).join('; '), 'err'); o.btn.disabled = false; return; }

      // A push answers 204 with no body, so the profile is read back before any
      // of this is called a success.
      status(o.st, 'Checking it saved…');
      const problems = await verifyCollections(t.aid, t.idx, collections);
      if (problems.length) { status(o.st, problems.join(' '), 'err'); o.btn.disabled = false; return; }

      const extra = ((plan.report && plan.report.addons && plan.report.addons.added) || []).length;
      status(o.st, '“' + c.title + '” added to ' + t.name
        + (extra ? ', with ' + extra + ' add-on' + (extra === 1 ? '' : 's') + ' it needs' : '')
        + ' — checked and saved.', 'ok');
      o.btn.textContent = 'Added';
      wzLock();
      wzLog('Added the collection “' + c.title + '”'
        + (extra ? ' and ' + extra + ' add-on' + (extra === 1 ? '' : 's') + ' it needs.' : '.'));
      logAct('Wizard: added collection ' + c.title + ' to ' + t.name, 'ok');
      celebrate(mkPop && mkPop.box);
    } catch (e) {
      status(o.st, "Couldn't add it: " + e.message, 'err');
      o.btn.disabled = false;
    }
  }


  // Whether each metadata add-on is ACTUALLY on the profile, read live rather
  // than asserted. Nuvio does ship Cinemeta on a new profile, but a profile that
  // has been tidied up (or had AIOMetadata put in its place) will not have it,
  // and a card claiming "already installed" at that point is simply wrong.
  let wzMetaGen = 0;
  async function wzMarkMetaInstalled() {
    const t = wzTarget(); if (!t) return;
    const gen = ++wzMetaGen;
    document.querySelectorAll('#wz-meta .wz-meta-tag').forEach(slot => {
      clr(slot); slot.appendChild(el('span', 'wz-tag plain shimmer', 'checking\u2026'));
    });
    let urls = [];
    try {
      const { backup } = await loadAccount(t.aid);
      urls = (sliceProfile(backup, t.idx).addons || []).map(a => String(a.url || ''));
    } catch (e) {
      if (gen !== wzMetaGen) return;
      document.querySelectorAll('#wz-meta .wz-meta-tag').forEach(s2 => { clr(s2); s2.appendChild(el('span', 'wz-tag plain', 'could not check')); });
      return;
    }
    if (gen !== wzMetaGen) return;
    WZ.METADATA.forEach(m => {
      const card = document.querySelector('#wz-meta [data-wzmeta="' + m.id + '"]'); if (!card) return;
      const pats = m.matches || [];
      const on = urls.some(u => pats.some(re => re.test(u)) || (m.check && u === m.check));
      card.classList.toggle('on', on);
      const slot = card.querySelector('.wz-meta-tag'); clr(slot);
      // Installed is a fact worth stating; "not installed" is not, because the
      // open box below already says so. Otherwise just show what it is good for.
      if (on) slot.appendChild(wzTag('On this profile'));
      else if (m.tag) slot.appendChild(wzTag(m.tag, 'plain'));
      // Nothing to fill in for something already there - collapse the box
      // rather than inviting a pointless re-add.
      const s3 = card.querySelector('.wz-meta-slot');
      if (s3) s3.style.display = on ? 'none' : '';
    });
  }

  async function wzMetaInstances(card, m) {
    let holder = card.querySelector('.wz-inst-holder');
    if (holder) { holder.remove(); return; }
    holder = el('div', 'wz-inst-holder');
    holder.appendChild(el('span', 'muted sm shimmer', 'Reading the uptime tracker\u2026'));
    card.insertBefore(holder, card.querySelector('.wz-meta-slot'));
    try {
      if (!MK) throw new Error('the marketplace data layer did not load');
      const list = await MK.loadInstances(m.instances, false);
      clr(holder);
      list.forEach(i => {
        const r = el('div', 'wz-inst');
        r.appendChild(el('span', 'nm', i.name));
        r.appendChild(el('span', 'up' + (i.uptime != null && i.uptime < 99 ? ' low' : ''), i.uptime != null ? i.uptime.toFixed(2) + '%' : '\u2014'));
        r.appendChild(el('span', 'spacer'));
        const b = el('button', 'btn btn-solid btn-xs', 'Open'); b.onclick = () => wzOpen(i.url);
        r.appendChild(b); holder.appendChild(r);
      });
      if (!list.length) holder.appendChild(el('p', 'empty', 'No instances listed right now.'));
    } catch (e) { clr(holder); holder.appendChild(el('span', 'muted sm err-text', "Couldn't read the list: " + e.message)); }
  }

  // ======================================================================
  // shared "paste the link back" box
  // ======================================================================
  // The write is mkWrite - the Marketplace's own path (engine.planTarget +
  // api.applyPlan plus its read-back check). Two wizard-only extras: `top`,
  // which places a metadata add-on above what is installed because Nuvio reads
  // metadata add-ons top down, and registration with wzPending so Next can save
  // this box without the user having to press its own button first.
  const wzPending = { keys: [], streams: [], meta: [] };
  // What this run has already written, keyed by provider id ('tmdb', 'mdblist',
  // 'animeskip', 'debrid'). Next uses it to skip a field that is unchanged
  // since it was saved, so pressing Next twice is not two writes.
  const wzSavedKeys = new Map();
  function wzInstallBox(host_, opts) {
    clr(host_);
    const w = el('div', 'mk-install');
    const url = el('input'); url.type = 'url'; url.placeholder = 'https://\u2026/manifest.json'; url.autocomplete = 'off';
    if (opts.defaultUrl) url.value = opts.defaultUrl;
    w.appendChild(url);
    w.appendChild(el('div', 'muted sm mk-hint', opts.hint));
    const nm = el('input'); nm.type = 'text'; nm.placeholder = 'Name it in Nuvio';
    nm.value = opts.defaultName || ''; nm.maxLength = 60; nm.className = 'mk-name';
    w.appendChild(nm);
    let atTop = !!opts.top;
    if (opts.top) {
      const lab = el('label', 'switch-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true;
      cb.onchange = () => { atTop = cb.checked; };
      // The reason lives once in the step header (#wz-order-tip); repeating it
      // under every tile put the same sentence on screen four times.
      const tx = el('div', 'tx'); tx.appendChild(el('b', '', 'Put it at the top of the add-on list'));
      lab.appendChild(cb); lab.appendChild(tx); w.appendChild(lab);
    }
    // Where the save button went is said once per STEP, in that step's header,
    // not once per box. On the metadata step there are four of these side by
    // side and the same sentence appeared under every one of them.
    if (opts.sayWhere) {
      const go = el('div', 'muted sm mk-hint');
      go.textContent = 'Filled in? “Save and move to next step” at the bottom writes it in.';
      w.appendChild(go);
    }
    const st = el('div', 'inline-status');
    const res = el('div', 'mk-res');
    // The box has no button of its own any more: Next is the one thing that
    // writes, on every step, so there is never a question of which control
    // saves. mkWrite still needs a button to drive — it rewrites the label and
    // the handler as part of its preview-then-confirm protocol — so one exists,
    // hidden. That is safe here because the wizard only ever MERGES a single
    // add-on, so mkWrite's removal gate (the only path that genuinely needs a
    // visible second click) is never reached.
    const btn = el('button', 'btn btn-primary', 'Add to this profile');
    btn.style.display = 'none';
    let saved = '';                                   // the url this box last wrote
    // mkWrite is preview-then-confirm: it rewrites this button's label and
    // handler. Editing either field afterwards has to put the button back, or a
    // second click would re-run the plan built from the OLD link.
    const arm = () => {
      btn.disabled = false; btn.textContent = 'Add to this profile';
      btn.onclick = () => run(false);
    };
    const run = (auto) => wzAddAddon({
      url, nm, btn, st, res, label: opts.label, top: () => atTop, rearm: arm, auto,
      onSaved: u => { saved = u; },
    });
    [url, nm].forEach(i => i.addEventListener('input', () => { clr(res); status(st, ''); arm(); wzPaintNext(); }));
    arm();
    w.appendChild(btn); w.appendChild(st); w.appendChild(res);
    host_.appendChild(w);
    // A box can be rebuilt in place (the simple path rebuilds its own every time
    // it produces a link). clr() above detached the old inputs but its pending
    // entry would still be here, still reporting itself dirty, and Next would
    // commit from fields that are no longer on the page — so the old entry for
    // this same host goes first.
    const q = wzPending[opts.step];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].host === host_) q.splice(i, 1);
    q.push({
      host: host_,
      // offsetParent is null for a hidden box, which is how an already-installed
      // metadata card (its box collapsed) stays out of Next's way.
      dirty: () => { const u = url.value.trim(); return !!u && u !== saved && host_.offsetParent !== null; },
      commit: () => run(true),
      label: opts.label,
    });
  }

  async function wzAddAddon(o) {
    const t = wzTarget(); if (!t) return { written: false, ok: false };
    const u = (o.url.value || '').trim();
    if (!u) { status(o.st, 'Paste the link first.', 'err'); return { written: false, ok: false }; }
    if (!/^https?:\/\//i.test(u)) { status(o.st, 'That does not look like a link \u2014 it should start with https://', 'err'); return { written: false, ok: false }; }
    const name = (o.nm.value || '').trim() || o.label;
    try { await wzSnapAddons(t); }
    catch (e) {
      status(o.st, "Couldn't read this profile's add-ons first, and without that this could not be undone — nothing was written: " + e.message, 'err');
      return { written: false, ok: false };
    }
    const master = [{ url: u, name, enabled: true }];
    let keepOrder = false;
    // "Put it at the top" cannot be expressed by mkWrite's append arithmetic, so
    // the whole desired list is built here: the new add-on at 0 and everything
    // already installed shifted down one. Those shifts show up in the report as
    // updates, because that is exactly what they are.
    if (o.top()) {
      try {
        const { backup } = await loadAccount(t.aid, true);
        const have = (sliceProfile(backup, t.idx).addons || []).filter(a => a.url !== u);
        master[0].sort_order = 0;
        have.forEach((a, i) => master.push({ url: a.url, name: a.name ?? null, enabled: a.enabled !== false, sort_order: i + 1 }));
        keepOrder = true;
      } catch (e) {
        status(o.st, "Couldn't read the profile to reorder \u2014 adding it at the end instead.", 'err');
      }
    }
    const r = (await mkWrite({
      kind: 'addons', master, targets: [{ aid: t.aid, idx: t.idx, name: t.name }],
      mode: 'merge', st: o.st, res: o.res, btn: o.btn, label: name, aid: t.aid, keepOrder, auto: o.auto,
      onDone: ok => { if (ok) { wzLock(); wzLog('Added ' + name + ' to this profile.'); } else o.rearm(); },
    })) || { written: false, ok: true };
    if (r.ok) o.onSaved(u);
    if (r.ok && r.written) wzMarkMetaInstalled();
    return r;
  }

  // ======================================================================
  // Next = save, then move on
  // ======================================================================
  // Having to press a step's own save button and THEN Next is busywork. Next
  // commits whatever is filled in and unsaved on the current step first, and
  // only advances if that worked. The per-item buttons stay, because a step can
  // hold several things and you may want them one at a time.
  async function wzCommitStep(step) {
    if (step === 'keys') {
      const inp = $('wz-key-tmdb');
      const tmdb = (inp && inp.value || '').trim();
      if (!tmdb && !wzSavedKeys.has('tmdb')) {
        status($('wz-keys-status'), 'TMDB is required \u2014 paste its key before moving on.', 'err');
        if (inp) { inp.classList.add('wz-need'); inp.focus(); }
        return false;
      }
      const anyNew = WZ.KEYS.some(k => { const v = ($('wz-key-' + k.id).value || '').trim(); return v && wzSavedKeys.get(k.id) !== v; });
      return anyNew ? wzSaveKeys() : true;
    }
    if (step === 'streams' && wz.route === 'native') {
      const key = ($('wz-native-key').value || '').trim();
      if (key && wzSavedKeys.get('debrid') !== key && !(await wzSaveNativeKey())) return false;
    }
    for (const b of (wzPending[step] || []).filter(x => x.dirty())) {
      const r = await b.commit();
      if (!r || !r.ok) return false;
    }
    return true;
  }
  async function wzNext() {
    const btn = $('wz-next'); if (btn.disabled) return;
    if (wz.step === WZ_STEPS[WZ_STEPS.length - 1]) { wzFinish(); return; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    let ok = true;
    try { ok = await wzCommitStep(wz.step); }
    catch (e) { ok = false; logAct('Wizard: could not save this step \u2014 ' + e.message, 'err'); }
    btn.textContent = label; btn.disabled = false;
    if (ok) wzGo(1); else wzPaintNext();
  }

  // Finishing is not undoing, and the two must never be confused: everything
  // the run wrote stays exactly where it is. This clears only the wizard's own
  // state and lands on the profile picker — `entry = 'have'` so it opens on the
  // profile chips rather than back on the two front doors, because "set up the
  // next profile" is the whole reason anyone presses this.
  function wzFinish() {
    const name = wzProfileName();
    const wrote = wz.done.length;
    wzResetRun();
    wz.entry = 'have';
    wzShow('account');
    logAct('Wizard: finished on ' + name + ' — ' + wrote + ' change(s) kept', 'ok');
    status($('wz-profile-status'), 'Finished with ' + name + ' — nothing was undone. Pick another profile to set one up.', 'ok');
  }

  function wzRenderDone() {
    const box = $('wz-summary'); if (!box) return; clr(box);
    if (!wz.done.length) { box.appendChild(el('p', 'empty', 'Nothing written yet — go back through the steps and the changes will be listed here.')); return; }
    wz.done.forEach(d => {
      const r = el('div', 'wz-done');
      const ic = el('span', 'ic'); ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#7bd88f" stroke-width="2.4"><path d="m5 12 4.5 4.5L19 7"/></svg>';
      r.appendChild(ic); r.appendChild(el('span', '', d)); box.appendChild(r);
    });
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
    // ---- setup wizard ----
    // Guarded as a block: wizard.js is optional in exactly the way market.js is,
    // and a missing one must not take the rest of wire() down with it.
    if (WZ) {
      $('wz-next').onclick = wzNext;
      $('wz-account').onchange = () => wzRenderProfiles($('wz-account').value);
      $('wz-new-btn').onclick = wzCreateAccount;
      $('wz-new-pass2').addEventListener('keydown', e => { if (e.key === 'Enter') wzCreateAccount(); });
      $('wz-prof-create').onclick = wzCreateProfile;
      $('wz-prof-name').addEventListener('keydown', e => { if (e.key === 'Enter') wzCreateProfile(); });
      $('wz-prof-cancel').onclick = () => { $('wz-newprof').style.display = 'none'; status($('wz-profile-status'), ''); };
      $('wz-guide-btn').onclick = wzShowGuide;
      $('wz-inst-refresh').onclick = wzLoadInstances;
      $('wz-sim-run').onclick = wzSimRun;
      $('wz-sim-key-open').onclick = () => wzOpen('https://torbox.app/settings');
      // Editing the key means starting over, so the finished link and its install
      // box are put away: a stale link left on screen next to a new key is a lie,
      // and a hidden install box reports itself clean so Next won't write it.
      $('wz-sim-key').addEventListener('input', () => {
        $('wz-sim-key').classList.remove('wz-need');
        if (WZ.RELAY) $('wz-sim-run').disabled = false;
        status($('wz-sim-status'), '');
        $('wz-sim-result').style.display = 'none';
        $('wz-sim-install').style.display = 'none';
      });
      $('wz-sim-key').addEventListener('keydown', e => { if (e.key === 'Enter') wzSimRun(); });
      // One listener for the whole panel: every field on every step feeds the
      // same question — is there anything for Next to save right now.
      const wzPanel = document.querySelector('.panel[data-panel="wizard"]');
      if (wzPanel) wzPanel.addEventListener('input', () => wzPaintNext());
    } else {
      const b = document.querySelector('.navbtn[data-nav="wizard"]'); if (b) b.style.display = 'none';
    }
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
    // Carry-over categories. Ticking one selects everything in it; unticking one
    // clears its picks, so the count on the row can never claim items that are
    // not going to be carried. syMirrorCat() drives the tick the other way.
    ['addons', 'plugins', 'collections'].forEach(kind => {
      const cb = $('sy-cat-' + kind); if (!cb) return;
      cb.addEventListener('change', () => {
        cb.indeterminate = false;
        if (cb.checked) syList(kind).forEach(x => sySel[kind].add(syKey(kind, x)));
        else sySel[kind].clear();
        renderSyItem(kind); updateSyCounts(); scheduleLivePreview();
      });
    });
    // These two carry no per-item picks, so the tick is the whole story.
    ['sy-cat-watchprogress', 'sy-cat-watched'].forEach(id => {
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
