/* ============================================================================
   Numax Studio - the editing overlay.

   Loaded ONLY by studio/studio_server.py, which injects it while serving.
   index.html never references it, so it cannot reach the live site.

   It owns no application state and never calls into app.js. It reads the
   data-sx stamps the server injected, writes CSS into its own <style>, and
   hands a plain description of the changes back to the server on Save.

   The live preview uses the exact same CSS text the server will write to
   index.html, injected at the same point in the cascade - so what you see
   while editing is what the file ends up doing. Where a rule loses to
   something more specific, Studio detects that and says so instead of
   pretending it worked.
   ========================================================================= */
(function () {
  'use strict';
  if (!window.__SX__) return;

  var SX = window.__SX__;
  var pending = {
    css: JSON.parse(JSON.stringify(window.__STUDIO_EDITS__ || {})),
    text: {},
    orders: {}
  };
  var savedCss = JSON.stringify(pending.css);
  var mode = 'off';           // off | pick | move | note
  var sel = null;             // { el, selector, scope, sx }
  var origOrder = new Map();  // parentSx -> [child elements] as first seen

  // Classes app.js toggles at runtime - never build a selector out of these.
  var VOLATILE = /^(on|open|current|active|shimmer|ok|err|info|dirty|busy|hidden|show|hide|sel|selected|done|locked|sxu-[\w-]*|mo-ind[\w-]*)$/;

  // --------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s; }
  function camel(p) { return p.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }
  function classesOf(node) {
    return (node.className && node.className.baseVal !== undefined
      ? node.className.baseVal : (node.className || '') + '')
      .split(/\s+/).filter(function (c) { return c && !VOLATILE.test(c); });
  }
  function isOverlay(node) { return !!(node && node.closest && node.closest('.sxu')); }

  // --------------------------------------------------------------------
  // Selectors
  // --------------------------------------------------------------------
  function uniqueSelector(node) {
    if (node.id) {
      var byId = '#' + esc(node.id);
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    var parts = [], cur = node, guard = 0;
    while (cur && cur !== document.body && guard++ < 12) {
      var part = cur.tagName.toLowerCase();
      var cls = classesOf(cur);
      if (cls.length) part += '.' + cls.slice(0, 3).map(esc).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var kids = Array.prototype.slice.call(parent.children);
        var twins = kids.filter(function (k) { try { return k.matches(part); } catch (e) { return false; } });
        if (twins.length > 1) part += ':nth-child(' + (kids.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (parent && parent.id) { parts.unshift('#' + esc(parent.id)); break; }
      cur = parent;
    }
    var s = parts.join(' > ');
    try {
      var hit = document.querySelectorAll(s);
      if (hit.length === 1 && hit[0] === node) return s;
    } catch (e) { /* fall through */ }
    return nthPath(node);
  }
  function nthPath(node) {
    var parts = [], cur = node;
    while (cur && cur !== document.body) {
      var parent = cur.parentElement;
      if (!parent) break;
      var i = Array.prototype.slice.call(parent.children).indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + i + ')');
      if (parent.id) { parts.unshift('#' + esc(parent.id)); return parts.join(' > '); }
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  }
  /* The class that best captures "everything like this one". */
  function groupSelector(node) {
    var best = null;
    classesOf(node).forEach(function (c) {
      var s = '.' + esc(c), n;
      try { n = document.querySelectorAll(s).length; } catch (e) { return; }
      if (n > 1 && (!best || n < best.count)) best = { sel: s, count: n };
    });
    return best;
  }

  // --------------------------------------------------------------------
  // Live CSS - identical text to what the server writes
  // --------------------------------------------------------------------
  var liveTag = null;
  function cssText(map) {
    return Object.keys(map).sort().map(function (s) {
      var props = map[s], keys = Object.keys(props).sort();
      if (!keys.length) return '';
      return s + '{ ' + keys.map(function (k) { return k + ':' + props[k] + ';'; }).join(' ') + ' }';
    }).filter(Boolean).join('\n');
  }
  function paint() {
    if (!liveTag) {
      liveTag = el('style');
      liveTag.id = 'sxu-live';
      document.head.appendChild(liveTag);
    }
    // Keep it last in <head> so it sits where the saved block will sit.
    if (liveTag.nextSibling) document.head.appendChild(liveTag);
    liveTag.textContent = cssText(pending.css);
    markDirty();
  }

  /* Does this rule actually win, or is something more specific beating it?
     Probe with two clearly different values and see whether the computed
     style moves at all. Studio's own live sheet is switched off during the
     probe, otherwise it answers its own question and always says "no". */
  var SENTINEL = { len: '911px', num: '0.137', color: 'rgb(3, 5, 7)' };
  function ruleWins(selector, prop, value, type, def) {
    var node;
    try { node = document.querySelector(selector); } catch (e) { return true; }
    if (!node) return true;
    var plain = String(value).replace(/\s*!important$/, '');
    var alt = SENTINEL[type];
    if (type === 'opt') {
      var opts = (def && def.opts) || [];
      alt = null;
      for (var i = 0; i < opts.length; i++) { if (opts[i] !== plain) { alt = opts[i]; break; } }
    }
    if (!alt) return true;                       // nothing safe to compare against
    if (/!important$/.test(value)) alt += ' !important';

    var wasOff = liveTag ? liveTag.disabled : false;
    if (liveTag) liveTag.disabled = true;
    var probe = el('style');
    document.head.appendChild(probe);
    function read(v) {
      probe.textContent = selector + '{ ' + prop + ':' + v + '; }';
      return getComputedStyle(node)[camel(prop)];
    }
    var a = read(value), b = read(alt);
    probe.remove();
    if (liveTag) liveTag.disabled = wasOff;
    return a !== b;
  }

  function setProp(selector, prop, value, type, def) {
    if (!pending.css[selector]) pending.css[selector] = {};
    if (value == null || value === '') delete pending.css[selector][prop];
    else pending.css[selector][prop] = value;
    if (!Object.keys(pending.css[selector]).length) delete pending.css[selector];
    paint();
    if (value && !ruleWins(selector, prop, value, type, def)) {
      pending.css[selector][prop] = value + ' !important';
      paint();
      if (!ruleWins(selector, prop, value + ' !important', type, def)) {
        delete pending.css[selector][prop];
        if (!Object.keys(pending.css[selector]).length) delete pending.css[selector];
        paint();
        return 'blocked';
      }
      return 'forced';
    }
    return 'ok';
  }
  function getProp(selector, prop) {
    var v = pending.css[selector] && pending.css[selector][prop];
    return v ? String(v).replace(/\s*!important$/, '') : null;
  }

  // --------------------------------------------------------------------
  // Property catalogue
  // --------------------------------------------------------------------
  var PROPS = [
    { g: 'Size', p: 'width', t: 'len' },
    { g: 'Size', p: 'height', t: 'len' },
    { g: 'Size', p: 'min-height', t: 'len' },
    { g: 'Size', p: 'max-width', t: 'len' },

    { g: 'Spacing', p: 'padding', t: 'len', sides: true },
    { g: 'Spacing', p: 'margin', t: 'len', sides: true, neg: true },
    { g: 'Spacing', p: 'gap', t: 'len' },

    { g: 'Text', p: 'font-size', t: 'len' },
    { g: 'Text', p: 'font-weight', t: 'opt', opts: ['300', '400', '500', '600', '700', '800', '900'] },
    { g: 'Text', p: 'letter-spacing', t: 'len', neg: true, unit: 'em', step: 0.01 },
    { g: 'Text', p: 'line-height', t: 'num', step: 0.05, max: 4 },
    { g: 'Text', p: 'text-align', t: 'opt', opts: ['left', 'center', 'right', 'justify'] },
    { g: 'Text', p: 'text-transform', t: 'opt', opts: ['none', 'uppercase', 'lowercase', 'capitalize'] },
    { g: 'Text', p: 'color', t: 'color' },

    { g: 'Look', p: 'background', t: 'color' },
    { g: 'Look', p: 'border-color', t: 'color' },
    { g: 'Look', p: 'border-width', t: 'len' },
    { g: 'Look', p: 'border-radius', t: 'len' },
    { g: 'Look', p: 'opacity', t: 'num', step: 0.05, max: 1 },
    {
      g: 'Look', p: 'box-shadow', t: 'opt',
      opts: ['none', '0 2px 10px rgba(0,0,0,.25)', '0 10px 40px rgba(0,0,0,.45)'],
      labels: ['none', 'soft', 'strong']
    },

    { g: 'Layout', p: 'display', t: 'opt', opts: ['block', 'flex', 'inline-flex', 'grid', 'inline-block'] },
    { g: 'Layout', p: 'flex-direction', t: 'opt', opts: ['row', 'column'] },
    { g: 'Layout', p: 'justify-content', t: 'opt', opts: ['flex-start', 'center', 'space-between', 'flex-end', 'space-around'] },
    { g: 'Layout', p: 'align-items', t: 'opt', opts: ['stretch', 'flex-start', 'center', 'flex-end'] },
    { g: 'Layout', p: 'flex-wrap', t: 'opt', opts: ['nowrap', 'wrap'] }
  ];
  var UNITS = ['px', '%', 'em', 'rem', 'vh', 'vw', 'auto'];

  // --------------------------------------------------------------------
  // Chrome: styles, toolbar, panel, highlight
  // --------------------------------------------------------------------
  var CHROME = [
    '.sxu,.sxu *{box-sizing:border-box;font-family:Inter,system-ui,sans-serif}',
    '.sxu-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483600;',
    '  display:flex;gap:6px;align-items:center;padding:7px 9px;border-radius:14px;',
    '  background:rgba(16,18,26,.94);border:1px solid rgba(255,255,255,.14);',
    '  box-shadow:0 18px 60px rgba(0,0,0,.6);backdrop-filter:blur(14px)}',
    '.sxu-bar b{font:700 11px Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;',
    '  color:#8ab4ff;padding:0 8px 0 4px}',
    '.sxu-b{font:600 12px Inter,sans-serif;color:#dfe4f2;background:rgba(255,255,255,.07);',
    '  border:1px solid rgba(255,255,255,.10);border-radius:9px;padding:7px 11px;cursor:pointer;white-space:nowrap}',
    '.sxu-b:hover{background:rgba(255,255,255,.14)}',
    '.sxu-b.on{background:#3b6fe0;border-color:#5c8bf5;color:#fff}',
    '.sxu-b.go{background:#1f7a45;border-color:#2fa661;color:#fff}',
    '.sxu-b:disabled{opacity:.4;cursor:default}',
    '.sxu-count{font:600 11px Inter,sans-serif;color:#ffd479;padding:0 6px}',
    '.sxu-hl{position:fixed;z-index:2147483500;pointer-events:none;border:1px solid #5c8bf5;',
    '  border-radius:4px;background:rgba(92,139,245,.12)}',
    '.sxu-hl.pick{border-color:#ffd479;background:rgba(255,212,121,.12)}',
    '.sxu-tag{position:fixed;z-index:2147483550;pointer-events:none;font:600 10px/1 Inter,sans-serif;',
    '  background:#5c8bf5;color:#fff;padding:3px 6px;border-radius:4px;white-space:nowrap}',
    '.sxu-drop{position:fixed;z-index:2147483550;pointer-events:none;background:#3ad07a;border-radius:2px}',
    '.sxu-panel{position:fixed;top:0;right:0;bottom:0;width:330px;z-index:2147483580;',
    '  background:rgba(13,15,22,.97);border-left:1px solid rgba(255,255,255,.12);',
    '  color:#e6eaf5;display:flex;flex-direction:column;backdrop-filter:blur(16px)}',
    '.sxu-panel header{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}',
    '.sxu-panel header h3{margin:0 0 3px;font:700 13px Inter,sans-serif}',
    '.sxu-crumbs{display:flex;flex-wrap:wrap;gap:3px;margin-top:7px}',
    '.sxu-crumb{font:500 10px Inter,sans-serif;color:#9fb0d0;background:rgba(255,255,255,.06);',
    '  border:0;border-radius:5px;padding:3px 6px;cursor:pointer}',
    '.sxu-crumb:hover{background:rgba(255,255,255,.14);color:#fff}',
    '.sxu-scope{display:flex;gap:5px;margin-top:9px}',
    '.sxu-scope button{flex:1;font:600 11px Inter,sans-serif;color:#cfd8ee;background:rgba(255,255,255,.06);',
    '  border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:6px;cursor:pointer;min-width:0}',
    '.sxu-scope button.on{background:#3b6fe0;border-color:#5c8bf5;color:#fff}',
    '.sxu-body{flex:1;overflow-y:auto;padding:10px 14px 24px}',
    '.sxu-grp{margin-top:14px}',
    '.sxu-grp>h4{margin:0 0 6px;font:700 10px Inter,sans-serif;letter-spacing:.14em;',
    '  text-transform:uppercase;color:#7e8db0}',
    '.sxu-row{display:flex;align-items:center;gap:6px;margin-bottom:5px}',
    '.sxu-row>label{flex:0 0 92px;font:500 11px Inter,sans-serif;color:#aab6d4;min-width:0;',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sxu-row input[type=number],.sxu-row input[type=text],.sxu-row select{flex:1;min-width:0;',
    '  font:500 11px Inter,sans-serif;color:#e6eaf5;background:rgba(255,255,255,.06);',
    '  border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:5px 7px}',
    '.sxu-row select.u{flex:0 0 62px}',
    '.sxu-row input[type=color]{flex:0 0 30px;height:26px;padding:0;border:1px solid rgba(255,255,255,.14);',
    '  border-radius:6px;background:none;cursor:pointer}',
    '.sxu-x{flex:0 0 20px;height:20px;border:0;border-radius:5px;background:rgba(255,255,255,.05);',
    '  color:#8b98b8;font:700 12px/1 Inter,sans-serif;cursor:pointer}',
    '.sxu-x.set{background:#3b6fe0;color:#fff}',
    '.sxu-row.blocked>label{color:#ff9a8f}',
    '.sxu-note{margin:10px 0 0;font:500 11px/1.5 Inter,sans-serif;color:#9fb0d0;',
    '  background:rgba(255,255,255,.05);border-radius:8px;padding:8px 10px}',
    '.sxu-note.warn{color:#ffcf8a;background:rgba(255,180,60,.10)}',
    '.sxu-note.bad{color:#ff9a8f;background:rgba(255,90,80,.10)}',
    '.sxu-body textarea{width:100%;min-height:70px;font:500 12px/1.5 Inter,sans-serif;color:#e6eaf5;',
    '  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;resize:vertical}',
    '.sxu-wide{width:100%;margin-top:7px;font:600 12px Inter,sans-serif;color:#fff;background:#3b6fe0;',
    '  border:0;border-radius:8px;padding:8px;cursor:pointer}',
    '.sxu-wide.ghost{background:rgba(255,255,255,.07);color:#cfd8ee}',
    '.sxu-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);z-index:2147483600;',
    '  font:600 12px Inter,sans-serif;color:#fff;background:#1f7a45;padding:9px 14px;border-radius:10px;',
    '  box-shadow:0 12px 40px rgba(0,0,0,.5);max-width:70vw;text-align:center}',
    '.sxu-toast.bad{background:#a8352c}',
    'body.sxu-picking *{cursor:crosshair !important}',
    'body.sxu-moving [data-sx]{cursor:grab}'
  ].join('\n');

  var chrome = el('style');
  chrome.textContent = CHROME;
  document.head.appendChild(chrome);

  var hl = el('div', 'sxu sxu-hl'); hl.style.display = 'none';
  var tag = el('div', 'sxu sxu-tag'); tag.style.display = 'none';
  var drop = el('div', 'sxu sxu-drop'); drop.style.display = 'none';
  document.body.appendChild(hl); document.body.appendChild(tag); document.body.appendChild(drop);

  var bar = el('div', 'sxu sxu-bar');
  var bTitle = el('b', null, 'Studio');
  var bPick = el('button', 'sxu-b', 'Select');
  var bMove = el('button', 'sxu-b', 'Move');
  var bNote = el('button', 'sxu-b', 'Note');
  var bApp = el('button', 'sxu-b', 'Open app view');
  var bCount = el('span', 'sxu-count', '');
  var bSave = el('button', 'sxu-b go', 'Save');
  var bUndo = el('button', 'sxu-b', 'Undo last save');
  [bTitle, bPick, bMove, bNote, bApp, bCount, bSave, bUndo].forEach(function (n) { bar.appendChild(n); });
  document.body.appendChild(bar);

  var panel = el('div', 'sxu sxu-panel'); panel.style.display = 'none';
  var pHead = el('header');
  var pTitle = el('h3', null, '');
  var pCrumbs = el('div', 'sxu-crumbs');
  var pScope = el('div', 'sxu-scope');
  pHead.appendChild(pTitle); pHead.appendChild(pCrumbs); pHead.appendChild(pScope);
  var pBody = el('div', 'sxu-body');
  panel.appendChild(pHead); panel.appendChild(pBody);
  document.body.appendChild(panel);

  function toast(msg, bad) {
    var t = el('div', 'sxu sxu-toast' + (bad ? ' bad' : ''), msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, bad ? 5200 : 2600);
  }
  function dirtyCount() {
    return (JSON.stringify(pending.css) !== savedCss ? 1 : 0)
      + Object.keys(pending.text).length + Object.keys(pending.orders).length;
  }
  function markDirty() {
    var n = dirtyCount();
    bCount.textContent = n ? 'unsaved changes' : '';
    try { sessionStorage.setItem('sxu.pending', JSON.stringify(pending)); } catch (e) { }
  }

  // --------------------------------------------------------------------
  // Highlighting
  // --------------------------------------------------------------------
  function friendly(node) {
    var name = node.tagName.toLowerCase();
    var cls = classesOf(node)[0];
    if (node.id) name += ' #' + node.id;
    else if (cls) name += ' .' + cls;
    var txt = (node.textContent || '').trim().replace(/\s+/g, ' ');
    if (txt && txt.length < 34) name += '  "' + txt + '"';
    else if (txt) name += '  "' + txt.slice(0, 30) + '..."';
    return name;
  }
  function outline(node, kind) {
    if (!node) { hl.style.display = 'none'; tag.style.display = 'none'; return; }
    var r = node.getBoundingClientRect();
    hl.className = 'sxu sxu-hl' + (kind ? ' ' + kind : '');
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    tag.textContent = friendly(node);
    tag.style.display = 'block';
    var ty = r.top > 22 ? r.top - 20 : r.bottom + 4;
    tag.style.left = Math.max(4, Math.min(r.left, innerWidth - 260)) + 'px';
    tag.style.top = ty + 'px';
  }

  // --------------------------------------------------------------------
  // Panel rendering
  // --------------------------------------------------------------------
  function targetSelector() {
    if (!sel) return null;
    return sel.scope === 'group' && sel.group ? sel.group.sel : sel.selector;
  }
  function lenRow(def, selector) {
    var row = el('div', 'sxu-row');
    row.appendChild(el('label', null, def.p));
    var cur = getProp(selector, def.p);
    var num = el('input'); num.type = 'number'; num.step = def.step || 1;
    if (!def.neg) num.min = 0;
    var unit = el('select', 'u');
    UNITS.forEach(function (u) { var o = el('option', null, u); o.value = u; unit.appendChild(o); });
    var m = cur && /^(-?[\d.]+)(px|%|em|rem|vh|vw)$/.exec(cur);
    if (m) { num.value = m[1]; unit.value = m[2]; }
    else if (cur === 'auto') { unit.value = 'auto'; }
    else {
      unit.value = def.unit || 'px';
      var live = getComputedStyle(sel.el)[camel(def.p)];
      var lm = /^(-?[\d.]+)px$/.exec(live);
      num.placeholder = lm ? Math.round(parseFloat(lm[1]) * 100) / 100 : (live || '');
    }
    function push() {
      var v = unit.value === 'auto' ? 'auto'
        : (num.value === '' ? null : num.value + unit.value);
      apply(def, selector, v, row);
    }
    num.oninput = push; unit.onchange = push;
    row.appendChild(num); row.appendChild(unit);
    row.appendChild(clearBtn(def, selector, row, cur));
    return row;
  }
  function numRow(def, selector) {
    var row = el('div', 'sxu-row');
    row.appendChild(el('label', null, def.p));
    var cur = getProp(selector, def.p);
    var num = el('input'); num.type = 'number'; num.step = def.step || 0.1;
    num.min = 0; if (def.max) num.max = def.max;
    if (cur) num.value = cur; else num.placeholder = getComputedStyle(sel.el)[camel(def.p)] || '';
    num.oninput = function () { apply(def, selector, num.value === '' ? null : num.value, row); };
    row.appendChild(num);
    row.appendChild(clearBtn(def, selector, row, cur));
    return row;
  }
  function optRow(def, selector) {
    var row = el('div', 'sxu-row');
    row.appendChild(el('label', null, def.p));
    var cur = getProp(selector, def.p);
    var s = el('select');
    var blank = el('option', null, '(unchanged)'); blank.value = ''; s.appendChild(blank);
    def.opts.forEach(function (o, i) {
      var opt = el('option', null, (def.labels && def.labels[i]) || o);
      opt.value = o; s.appendChild(opt);
    });
    s.value = cur || '';
    s.onchange = function () { apply(def, selector, s.value || null, row); };
    row.appendChild(s);
    row.appendChild(clearBtn(def, selector, row, cur));
    return row;
  }
  function colorRow(def, selector) {
    var row = el('div', 'sxu-row');
    row.appendChild(el('label', null, def.p));
    var cur = getProp(selector, def.p);
    var pick = el('input'); pick.type = 'color';
    var text = el('input'); text.type = 'text';
    text.placeholder = getComputedStyle(sel.el)[camel(def.p === 'background' ? 'background-color' : def.p)] || '';
    if (cur) text.value = cur;
    var hex = /^#[0-9a-f]{3,8}$/i.exec(cur || '');
    pick.value = hex ? cur : '#888888';
    pick.oninput = function () { text.value = pick.value; apply(def, selector, pick.value, row); };
    text.oninput = function () { apply(def, selector, text.value.trim() || null, row); };
    row.appendChild(pick); row.appendChild(text);
    row.appendChild(clearBtn(def, selector, row, cur));
    return row;
  }
  function clearBtn(def, selector, row, cur) {
    var b = el('button', 'sxu-x' + (cur ? ' set' : ''), '×');
    b.title = 'Remove this override';
    b.onclick = function () { setProp(selector, def.p, null, def.t); openPanel(sel.el, true); };
    return b;
  }
  function apply(def, selector, value, row) {
    var res = setProp(selector, def.p, value, def.t, def);
    row.classList.toggle('blocked', res === 'blocked');
    var x = row.querySelector('.sxu-x');
    if (x) x.classList.toggle('set', !!getProp(selector, def.p));
    if (res === 'blocked') {
      toast(def.p + ' is pinned by styling written directly into this element - '
        + 'Studio cannot win that from a stylesheet. Use Note to ask for a code change.', true);
    }
  }

  /* Warn when the element also has width-specific styling: a Studio rule
     applies at every screen size and will win over those. */
  function mediaWarning(node) {
    var hits = 0;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (!r.media || !r.cssRules) continue;
        for (var k = 0; k < r.cssRules.length; k++) {
          var sr = r.cssRules[k];
          if (!sr.selectorText) continue;
          try { if (node.matches(sr.selectorText)) hits++; } catch (e) { }
        }
      }
    }
    return hits;
  }

  function openPanel(node, keepScroll) {
    var scroll = keepScroll ? pBody.scrollTop : 0;
    var sx = node.getAttribute('data-sx');
    var info = sx != null ? SX[sx] : null;
    var dupe = sx != null && document.querySelectorAll('[data-sx="' + sx + '"]').length > 1;
    sel = {
      el: node,
      sx: (info && !dupe) ? sx : null,
      selector: uniqueSelector(node),
      group: groupSelector(node),
      scope: (sel && sel.el === node) ? sel.scope : 'one'
    };
    panel.style.display = 'flex';
    pTitle.textContent = friendly(node);

    pCrumbs.innerHTML = '';
    var chain = [], cur = node.parentElement;
    while (cur && cur !== document.body && chain.length < 6) { chain.unshift(cur); cur = cur.parentElement; }
    chain.forEach(function (a) {
      var c = el('button', 'sxu-crumb', (a.id ? '#' + a.id : (classesOf(a)[0] ? '.' + classesOf(a)[0] : a.tagName.toLowerCase())));
      c.onclick = function () { openPanel(a); outline(a, 'pick'); };
      pCrumbs.appendChild(c);
    });

    pScope.innerHTML = '';
    var one = el('button', sel.scope === 'one' ? 'on' : '', 'Just this one');
    one.onclick = function () { sel.scope = 'one'; openPanel(node, true); };
    pScope.appendChild(one);
    if (sel.group) {
      var all = el('button', sel.scope === 'group' ? 'on' : '', 'All ' + sel.group.count + ' like it');
      all.onclick = function () { sel.scope = 'group'; openPanel(node, true); };
      pScope.appendChild(all);
    }

    var selector = targetSelector();
    pBody.innerHTML = '';

    var mq = mediaWarning(node);
    if (mq) {
      pBody.appendChild(el('div', 'sxu-note warn',
        'This element also has narrow-screen styling (' + mq + ' rule' + (mq > 1 ? 's' : '') +
        '). Changes here apply at every window size and will win over those.'));
    }

    // Text content
    if (info && info.textOnly && sel.sx != null) {
      var g = el('div', 'sxu-grp');
      g.appendChild(el('h4', null, 'Wording'));
      var ta = el('textarea');
      ta.value = pending.text[sel.sx] != null ? pending.text[sel.sx] : node.textContent;
      var was = node.textContent;
      ta.oninput = function () {
        node.textContent = ta.value;
        if (ta.value === was) delete pending.text[sel.sx]; else pending.text[sel.sx] = ta.value;
        markDirty();
      };
      g.appendChild(ta);
      pBody.appendChild(g);
    } else if (info && info.editable && sel.sx != null) {
      pBody.appendChild(el('div', 'sxu-note',
        'This box holds other elements, so its wording is edited by picking the piece of text inside it.'));
    } else {
      pBody.appendChild(el('div', 'sxu-note',
        'This part is drawn by the app while it runs, so its wording and position come from code. Styling it still works normally.'));
    }

    // Hide / show
    var vis = el('div', 'sxu-grp');
    vis.appendChild(el('h4', null, 'Visibility'));
    var hidden = getProp(selector, 'display') === 'none';
    var hb = el('button', 'sxu-wide ghost', hidden ? 'Show this again' : 'Hide this');
    hb.onclick = function () {
      setProp(selector, 'display', hidden ? null : 'none', 'opt', { opts: ['block', 'flex', 'none'] });
      openPanel(node, true);
    };
    vis.appendChild(hb);
    pBody.appendChild(vis);

    // Property groups
    var groups = {};
    PROPS.forEach(function (d) { (groups[d.g] = groups[d.g] || []).push(d); });
    Object.keys(groups).forEach(function (name) {
      var g = el('div', 'sxu-grp');
      g.appendChild(el('h4', null, name));
      groups[name].forEach(function (d) {
        g.appendChild(d.t === 'len' ? lenRow(d, selector)
          : d.t === 'num' ? numRow(d, selector)
            : d.t === 'color' ? colorRow(d, selector) : optRow(d, selector));
        if (d.sides) {
          ['top', 'right', 'bottom', 'left'].forEach(function (s) {
            g.appendChild(lenRow({ p: d.p + '-' + s, t: 'len', neg: d.neg }, selector));
          });
        }
      });
      pBody.appendChild(g);
    });

    var reset = el('button', 'sxu-wide ghost', 'Reset everything on this element');
    reset.onclick = function () { delete pending.css[selector]; paint(); openPanel(node, true); };
    pBody.appendChild(reset);
    pBody.scrollTop = scroll;
  }

  // --------------------------------------------------------------------
  // Modes
  // --------------------------------------------------------------------
  function setMode(m) {
    mode = (mode === m) ? 'off' : m;
    bPick.classList.toggle('on', mode === 'pick');
    bMove.classList.toggle('on', mode === 'move');
    bNote.classList.toggle('on', mode === 'note');
    document.body.classList.toggle('sxu-picking', mode === 'pick' || mode === 'note');
    document.body.classList.toggle('sxu-moving', mode === 'move');
    outline(null); drop.style.display = 'none';
    if (mode === 'off') panel.style.display = 'none';
  }
  bPick.onclick = function () { setMode('pick'); };
  bMove.onclick = function () { setMode('move'); };
  bNote.onclick = function () { setMode('note'); };
  bApp.onclick = function () {
    var app = document.getElementById('view-app');
    var land = document.getElementById('view-landing');
    if (!app) return;
    var showing = app.classList.contains('current');
    app.classList.toggle('current', !showing);
    if (land) land.classList.toggle('current', showing);
    bApp.textContent = showing ? 'Open app view' : 'Back to landing';
  };

  document.addEventListener('mousemove', function (e) {
    if (mode === 'off' || dragging) return;
    var node = e.target;
    if (isOverlay(node)) { outline(null); return; }
    if (mode === 'move') { while (node && !node.hasAttribute('data-sx')) node = node.parentElement; }
    outline(node, mode === 'note' ? 'pick' : null);
  }, true);

  document.addEventListener('click', function (e) {
    if (mode === 'off' || isOverlay(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (mode === 'pick') { openPanel(e.target); outline(e.target, 'pick'); }
    else if (mode === 'note') { noteFor(e.target); }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { setMode('off'); }
  });

  // ---- Move mode --------------------------------------------------
  var dragging = null, dropInfo = null;
  /* The static, file-backed children of a container - the only things a
     reorder can move, since everything else is drawn by app.js at runtime. */
  function staticKids(parent) {
    return Array.prototype.slice.call(parent.children).filter(function (c) {
      var sx = c.getAttribute && c.getAttribute('data-sx');
      return sx != null && SX[sx] && SX[sx].ci != null && !isOverlay(c)
        && document.querySelectorAll('[data-sx="' + sx + '"]').length === 1;
    });
  }
  function siblingsOf(node) { return staticKids(node.parentElement); }
  /* Is this container laid out side by side rather than stacked? */
  function isRow(items) {
    if (items.length < 2) return false;
    var a = items[0].getBoundingClientRect(), b = items[1].getBoundingClientRect();
    return Math.abs(a.top - b.top) < Math.min(a.height, b.height) / 2;
  }
  document.addEventListener('mousedown', function (e) {
    if (mode !== 'move' || isOverlay(e.target)) return;
    var node = e.target;
    while (node && !node.hasAttribute('data-sx')) node = node.parentElement;
    if (!node || !node.parentElement) return;
    var parent = node.parentElement;
    if (!parent.hasAttribute('data-sx')) return;
    if (siblingsOf(node).length < 2) { toast('Nothing to swap this with - it is the only item in its box.', true); return; }
    if (!origOrder.has(parent)) origOrder.set(parent, siblingsOf(node).slice());
    dragging = node;
    e.preventDefault(); e.stopPropagation();
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var sibs = siblingsOf(dragging);
    var row = isRow(sibs);
    var best = null, bestD = Infinity, after = false;
    sibs.forEach(function (s) {
      if (s === dragging) return;
      var r = s.getBoundingClientRect();
      var p = row ? e.clientX : e.clientY;
      var dA = Math.abs(p - (row ? r.left : r.top));
      var dB = Math.abs(p - (row ? r.right : r.bottom));
      if (dA < bestD) { bestD = dA; best = s; after = false; }
      if (dB < bestD) { bestD = dB; best = s; after = true; }
    });
    if (!best) return;
    dropInfo = { ref: best, after: after };
    var r = best.getBoundingClientRect();
    drop.style.display = 'block';
    if (row) {
      drop.style.left = ((after ? r.right : r.left) - 1) + 'px';
      drop.style.top = r.top + 'px';
      drop.style.width = '3px';
      drop.style.height = r.height + 'px';
    } else {
      drop.style.left = r.left + 'px';
      drop.style.top = ((after ? r.bottom : r.top) - 1) + 'px';
      drop.style.width = r.width + 'px';
      drop.style.height = '3px';
    }
    outline(dragging);
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!dragging) return;
    var node = dragging; dragging = null; drop.style.display = 'none';
    if (!dropInfo || dropInfo.ref === node) return;
    var parent = node.parentElement;
    if (dropInfo.after) dropInfo.ref.after(node); else dropInfo.ref.before(node);
    dropInfo = null;
    recordOrder(parent);
    toast('Moved. Press Save to keep it.');
  }, true);

  /* Express the new arrangement the way the file understands it: a full
     permutation of the parent's element children. Positions that Studio
     cannot address (a bare <br>, say) stay exactly where they are; only the
     static children swap around them. */
  function recordOrder(parent) {
    var psx = parent.getAttribute('data-sx');
    var info = SX[psx];
    if (!info || info.nk == null) return;
    var start = origOrder.get(parent);
    var now = staticKids(parent);
    if (!start || start.length !== now.length) {
      toast('Could not record that move - the page changed underneath it.', true);
      return;
    }
    var slots = start.map(function (c) { return SX[c.getAttribute('data-sx')].ci; })
      .sort(function (a, b) { return a - b; });
    var order = [];
    for (var i = 0; i < info.nk; i++) order.push(i);
    now.forEach(function (c, i) { order[slots[i]] = SX[c.getAttribute('data-sx')].ci; });
    var sorted = order.slice().sort(function (a, b) { return a - b; });
    if (!sorted.every(function (v, i) { return v === i; })) {
      toast('Could not record that move safely - leaving the file alone.', true);
      return;
    }
    if (order.every(function (v, i) { return v === i; })) delete pending.orders[psx];
    else pending.orders[psx] = order;
    markDirty();
  }

  // ---- Notes ------------------------------------------------------
  function noteFor(node) {
    sel = { el: node, selector: uniqueSelector(node), group: groupSelector(node), scope: 'one', sx: null };
    panel.style.display = 'flex';
    pTitle.textContent = 'Note about: ' + friendly(node);
    pCrumbs.innerHTML = ''; pScope.innerHTML = '';
    pBody.innerHTML = '';
    pBody.appendChild(el('div', 'sxu-note',
      'Describe what you want here in plain English - a new button, a different behaviour, anything Studio cannot do itself. It goes into studio/requests.md for Claude to build.'));
    var ta = el('textarea'); ta.placeholder = 'e.g. put a "Copy to all profiles" button next to this one';
    pBody.appendChild(ta);
    var send = el('button', 'sxu-wide', 'Pin this note');
    send.onclick = function () {
      send.disabled = true;
      post('/__studio/note', { where: friendly(node), selector: sel.selector, text: ta.value })
        .then(function (r) {
          if (r.ok) { toast('Note pinned.'); panel.style.display = 'none'; }
          else { toast(r.error || 'Could not save the note.', true); send.disabled = false; }
        });
    };
    pBody.appendChild(send);
    setTimeout(function () { ta.focus(); }, 30);
  }

  // ---- Save / undo ------------------------------------------------
  function post(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e) }; });
  }
  bSave.onclick = function () {
    bSave.disabled = true; bSave.textContent = 'Saving…';
    post('/__studio/save', pending).then(function (r) {
      bSave.disabled = false; bSave.textContent = 'Save';
      if (!r.ok) { toast(r.error || 'Save failed.', true); return; }
      try { sessionStorage.removeItem('sxu.pending'); } catch (e) { }
      toast('Saved to index.html (backup ' + r.backup + '). Reloading…');
      setTimeout(function () { location.replace('/?r=' + Date.now()); }, 700);
    });
  };
  bUndo.onclick = function () {
    bUndo.disabled = true;
    post('/__studio/undo', {}).then(function (r) {
      bUndo.disabled = false;
      if (!r.ok) { toast(r.error || 'Nothing to undo.', true); return; }
      try { sessionStorage.removeItem('sxu.pending'); } catch (e) { }
      toast('Rolled back to ' + r.restored + '. Reloading…');
      setTimeout(function () { location.replace('/?r=' + Date.now()); }, 700);
    });
  };
  window.addEventListener('beforeunload', function (e) {
    if (dirtyCount()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Restore anything unsaved from a reload.
  try {
    var stash = JSON.parse(sessionStorage.getItem('sxu.pending') || 'null');
    if (stash && stash.css && JSON.stringify(stash.css) !== savedCss) {
      pending = stash;
      toast('Restored unsaved changes from before the reload.');
    }
  } catch (e) { }

  paint();
  console.log('%cNumax Studio ready', 'color:#8ab4ff;font-weight:700',
    '- Select to style, Move to reorder, Note to ask for code.');
})();
