// ============================================================
// Numax presentation / motion layer (ui-motion.js)
//
// This file owns NO application state. It reacts to the CSS classes and
// inline display flips that app.js already performs, and animates around
// them. Nothing here decides what the app does — it only decides how a
// change that already happened is shown.
//
// Loaded BEFORE app.js. Exposes window.NumaxMotion for the handful of
// places app.js opts in explicitly (avatar groups, success bursts, rails).
// ============================================================
(function () {
  'use strict';
  var W = window, D = document;
  var RMQ = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(RMQ && RMQ.matches); }
  var raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : function (f) { return setTimeout(f, 16); };

  // ---------------------------------------------------------------
  // shared frame-coalesced sync pass
  // Every observer below only flips a dirty bit; all measurement and
  // writing happens once per frame, so a render that touches hundreds of
  // nodes still costs exactly one layout read.
  // ---------------------------------------------------------------
  var pending = false, syncers = [];
  function schedule() { if (pending) return; pending = true; raf(function () { pending = false; runSync(); }); }
  function onSync(fn) { syncers.push(fn); }
  function runSync() { for (var i = 0; i < syncers.length; i++) { try { syncers[i](); } catch (e) {} } }

  // ===============================================================
  // 1. Sliding active indicators
  //
  // One shared background/underline per bar that moves between items,
  // instead of a background appearing and disappearing per item. Driven
  // purely off the ".on" class app.js already sets.
  //
  // Some bars (settings tabs, platform bar, sync sections) are destroyed
  // and rebuilt by their render function on every click, which would
  // normally make the indicator jump. lastBox remembers where it was so a
  // rebuilt bar can start from the old position and slide to the new one.
  // ===============================================================
  var BARS = [
    { key: 'sidebar', host: '.sidebar', item: '.navbtn', kind: 'rail' },
    { key: 'pftabs', host: '.pf-tabs-bar', item: '.pf-editor-tab', kind: 'underline' },
    { key: 'settabs', host: '.set-tabs', item: '.set-tab', kind: 'pill' },
    { key: 'platbar', host: '.set-platbar', item: 'button', kind: 'pill' },
    { key: 'sysec', host: '.sy-set-sections', item: '.sy-set-sec', kind: 'ghost' }
  ];
  var lastBox = {};

  function syncBars() {
    for (var i = 0; i < BARS.length; i++) {
      var spec = BARS[i];
      var hosts = D.querySelectorAll(spec.host);
      for (var h = 0; h < hosts.length; h++) syncBar(hosts[h], spec);
    }
  }
  function syncBar(host, spec) {
    var ind = host.__moInd;
    if (!ind || ind.parentNode !== host) {
      ind = D.createElement('span');
      ind.className = 'mo-ind mo-ind-' + spec.kind;
      ind.setAttribute('aria-hidden', 'true');
      host.classList.add('mo-bar');
      host.insertBefore(ind, host.firstChild);
      host.__moInd = ind;
      host.__moFresh = true;
    }
    var on = host.querySelector(spec.item + '.on');
    if (!on) { ind.classList.remove('mo-ind-live'); return; }
    var hr = host.getBoundingClientRect(), ir = on.getBoundingClientRect();
    var box = {
      left: Math.round(ir.left - hr.left + host.scrollLeft),
      top: Math.round(ir.top - hr.top + host.scrollTop),
      w: Math.round(ir.width), h: Math.round(ir.height)
    };
    if (!box.w && !box.h) return; // bar not laid out yet (hidden panel)

    if (host.__moFresh) {
      host.__moFresh = false;
      var prev = lastBox[spec.key];
      // rebuilt bar: start where the old one was so the move still reads as a slide
      ind.style.transition = 'none';
      place(ind, (prev && prev.w) ? prev : box);
      void ind.offsetWidth; // force the "no transition" frame to commit
      ind.style.transition = '';
    }
    place(ind, box);
    ind.classList.add('mo-ind-live');
    lastBox[spec.key] = box;
  }
  function place(ind, b) {
    ind.style.left = b.left + 'px'; ind.style.top = b.top + 'px';
    ind.style.width = b.w + 'px'; ind.style.height = b.h + 'px';
  }
  onSync(syncBars);

  // ===============================================================
  // 2. Page + pane content transitions
  //
  // nav() and switchPfEditorTab() flip inline display. We watch for the
  // hidden -> visible edge and run a short enter animation. Nothing is
  // delayed: the content is already in the DOM and interactive.
  // ===============================================================
  var visSeen = new WeakMap();
  function syncEnter() {
    if (reduced()) return;
    var list = [].slice.call(D.querySelectorAll('[data-panel]'))
      .concat([].slice.call(D.querySelectorAll('.pf-pane')))
      .concat([].slice.call(D.querySelectorAll('.mo-enterable')));
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var vis = n.style.display !== 'none' && n.offsetParent !== null;
      var was = visSeen.get(n);
      visSeen.set(n, vis);
      if (vis && was === false) {
        n.classList.remove('mo-enter'); void n.offsetWidth; n.classList.add('mo-enter');
        clearTimeout(n.__moEnterT);
        n.__moEnterT = setTimeout(makeRemover(n, 'mo-enter'), 420);
      }
    }
  }
  function makeRemover(node, cls) { return function () { node.classList.remove(cls); }; }
  onSync(syncEnter);

  // ===============================================================
  // 3. Dialogs — entry/exit motion, focus trap, focus restore
  //
  // app.js shows a modal by clearing inline display. We add the motion and
  // the accessibility scaffolding around that, without touching how the
  // dialog resolves. Escape/Enter handling stays in app.js.
  // ===============================================================
  var modalSeen = new WeakMap(), modalReturn = null, trapRoot = null;
  function focusables(root) {
    return [].slice.call(root.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
  }
  function onTrapKey(e) {
    if (e.key !== 'Tab' || !trapRoot) return;
    var f = focusables(trapRoot); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && D.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function syncModals() {
    var roots = D.querySelectorAll('.modal-root');
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (r.classList.contains('mo-closing')) continue;   // mid-exit, not a real state change
      var open = r.style.display !== 'none';
      var was = modalSeen.get(r);
      if (open === was) continue;
      modalSeen.set(r, open);
      var card = r.querySelector('.modal-card');
      if (!card) continue;
      if (open) {
        clearTimeout(r.__moCloseT);
        r.classList.remove('mo-closing'); r.classList.add('mo-open');
        card.setAttribute('role', 'alertdialog');
        card.setAttribute('aria-modal', 'true');
        var msg = card.querySelector('.modal-msg');
        if (msg) { if (!msg.id) msg.id = 'mo-dlg-msg-' + i; card.setAttribute('aria-labelledby', msg.id); }
        modalReturn = D.activeElement;
        trapRoot = card; D.addEventListener('keydown', onTrapKey, true);
        // app.js focuses the text input itself when the dialog has one;
        // only take focus when it does not, so the two never fight.
        var inp = card.querySelector('.modal-input');
        if (!inp || inp.style.display === 'none') {
          var f = focusables(card); if (f.length) f[f.length - 1].focus();
        }
      } else {
        r.classList.remove('mo-open');
        if (!reduced()) {
          r.style.display = ''; r.classList.add('mo-closing');
          r.__moCloseT = setTimeout(makeCloser(r), 130);
        }
        if (trapRoot && r.contains(trapRoot)) { D.removeEventListener('keydown', onTrapKey, true); trapRoot = null; }
        if (modalReturn && modalReturn.focus) { try { modalReturn.focus(); } catch (e) {} }
        modalReturn = null;
      }
    }
  }
  function makeCloser(r) {
    return function () { r.classList.remove('mo-closing'); r.style.display = 'none'; modalSeen.set(r, false); };
  }
  onSync(syncModals);

  // ===============================================================
  // 4. Morphing popover for Sync Desk's "Choose" panels
  //
  // The chooser element is MOVED into a floating surface, never rebuilt —
  // so every checkbox handler inside it survives, and app.js re-rendering
  // its contents (renderSyItem / renderSyTree) keeps working unchanged.
  // Open/close is still expressed as the ".open" class app.js toggles;
  // Escape and outside-click just remove that class, so there is exactly
  // one code path for closing.
  // ===============================================================
  var pop = null; // { chooser, slot, layer, surface, trigger, ro }

  function popLayer() {
    var l = D.getElementById('mo-pop-layer');
    if (l) return l;
    l = D.createElement('div'); l.id = 'mo-pop-layer'; l.className = 'mo-pop-layer'; l.hidden = true;
    var scrim = D.createElement('div'); scrim.className = 'mo-pop-scrim';
    var surf = D.createElement('div'); surf.className = 'mo-pop';
    surf.setAttribute('role', 'dialog');
    var head = D.createElement('div'); head.className = 'mo-pop-head';
    var ttl = D.createElement('span'); ttl.className = 'mo-pop-title';
    var x = D.createElement('button'); x.type = 'button'; x.className = 'mo-pop-x';
    x.setAttribute('aria-label', 'Close'); x.textContent = '×';
    head.appendChild(ttl); head.appendChild(x); surf.appendChild(head);
    l.appendChild(scrim); l.appendChild(surf); D.body.appendChild(l);
    scrim.onclick = closePop; x.onclick = closePop;
    return l;
  }
  function closePop() { if (pop) pop.chooser.classList.remove('open'); }
  function triggerFor(chooser) { return D.querySelector('.sy-tgl[data-target="' + chooser.id + '"]'); }

  function openPop(chooser) {
    if (pop) { if (pop.chooser === chooser) return; teardownPop(true); }
    var trigger = triggerFor(chooser); if (!trigger) return;
    var layer = popLayer(), surf = layer.querySelector('.mo-pop');
    var row = trigger.closest ? trigger.closest('.sy-carry-row') : null;
    var lbl = row && row.querySelector('.sy-carry-lbl');
    var name = lbl ? lbl.textContent : 'Choose';
    layer.querySelector('.mo-pop-title').textContent = name;
    surf.setAttribute('aria-label', name + ' selection');

    var slot = D.createElement('span'); slot.className = 'mo-pop-slot'; slot.hidden = true;
    chooser.parentNode.insertBefore(slot, chooser);
    surf.appendChild(chooser);
    layer.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');

    pop = { chooser: chooser, slot: slot, layer: layer, surface: surf, trigger: trigger, ro: null };
    positionPop();
    if (!reduced()) { surf.classList.remove('mo-pop-out'); void surf.offsetWidth; surf.classList.add('mo-pop-in'); }
    if (W.ResizeObserver) { pop.ro = new ResizeObserver(positionPop); pop.ro.observe(chooser); }
    var first = focusables(surf)[0]; if (first) first.focus();
  }
  function positionPop() {
    if (!pop) return;
    var t = pop.trigger.getBoundingClientRect(), s = pop.surface;
    var vw = W.innerWidth, vh = W.innerHeight, pad = 12;
    var w = Math.min(440, vw - pad * 2);
    s.style.width = w + 'px';
    s.style.maxHeight = Math.min(vh - pad * 2, 480) + 'px';
    var left = Math.min(Math.max(pad, t.right - w), vw - w - pad);
    var h = s.offsetHeight || 260;
    var below = t.bottom + 8, above = t.top - 8 - h;
    var top = (below + h <= vh - pad || above < pad) ? Math.min(below, vh - h - pad) : above;
    top = Math.max(pad, top);
    s.style.left = left + 'px'; s.style.top = top + 'px';
    // grow from wherever the trigger actually sits relative to the surface
    s.style.transformOrigin = Math.round(t.left + t.width / 2 - left) + 'px ' + (top > t.top ? '0px' : h + 'px');
  }
  function teardownPop(immediate) {
    if (!pop) return;
    var p = pop; pop = null;
    if (p.ro) p.ro.disconnect();
    p.trigger.setAttribute('aria-expanded', 'false');
    var finish = function () {
      if (p.slot.parentNode) {
        p.slot.parentNode.insertBefore(p.chooser, p.slot);
        p.slot.parentNode.removeChild(p.slot);
      }
      if (!pop) p.layer.hidden = true;
      p.surface.classList.remove('mo-pop-in', 'mo-pop-out');
    };
    if (immediate || reduced()) { finish(); return; }
    p.surface.classList.remove('mo-pop-in'); p.surface.classList.add('mo-pop-out');
    setTimeout(finish, 150);
    try { p.trigger.focus(); } catch (e) {}
  }
  function syncPop() {
    // navigating away from Sync Desk hides the trigger — the floating surface
    // lives on <body>, so close it rather than leaving it stranded over another screen
    if (pop && pop.trigger.offsetParent === null) { closePop(); teardownPop(true); return; }
    var list = D.querySelectorAll('.sy-carry-chooser');
    var openEl = null, i;
    for (i = 0; i < list.length; i++) if (list[i].classList.contains('open')) { openEl = openEl || list[i]; }
    // popover semantics: only one open at a time
    for (i = 0; i < list.length; i++) if (list[i] !== openEl) list[i].classList.remove('open');
    if (openEl && (!pop || pop.chooser !== openEl)) openPop(openEl);
    else if (!openEl && pop) teardownPop(false);
  }
  onSync(syncPop);
  D.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pop) { e.stopPropagation(); closePop(); } }, true);
  W.addEventListener('scroll', function () { if (pop) positionPop(); }, true);
  W.addEventListener('resize', function () { if (pop) positionPop(); });

  // ===============================================================
  // 5. One-shot glow when the primary action becomes available,
  //    and a flow pulse on recipients while a preview is computing.
  // ===============================================================
  var applyWasDisabled = null;
  function syncGlow() {
    var b = D.getElementById('sy-apply');
    if (b) {
      var dis = !!b.disabled;
      if (applyWasDisabled === true && dis === false && !reduced()) {
        b.classList.remove('mo-glow'); void b.offsetWidth; b.classList.add('mo-glow');
        clearTimeout(b.__moGlowT);
        b.__moGlowT = setTimeout(makeRemover(b, 'mo-glow'), 1000);
      }
      applyWasDisabled = dis;
    }
    var st = D.getElementById('sy-pv-status'), tg = D.getElementById('sy-targets');
    if (st && tg) tg.classList.toggle('mo-flowing', st.classList.contains('shimmer'));
  }
  onSync(syncGlow);

  // ===============================================================
  // 6. Snap rails — horizontal profile pickers
  // ===============================================================
  var rails = [];
  function rail(scroller) {
    if (!scroller || scroller.__moRail) return;
    scroller.__moRail = true;
    scroller.classList.add('mo-rail');
    var wrap = scroller.parentNode; if (!wrap) return;
    wrap.classList.add('mo-rail-wrap');
    var mk = function (dir) {
      var b = D.createElement('button');
      b.type = 'button'; b.className = 'mo-rail-btn mo-rail-' + dir;
      b.setAttribute('aria-label', dir === 'prev' ? 'Scroll left' : 'Scroll right');
      b.textContent = dir === 'prev' ? '‹' : '›';
      b.onclick = function () {
        scroller.scrollBy({ left: (dir === 'prev' ? -1 : 1) * Math.max(140, scroller.clientWidth * 0.7), behavior: reduced() ? 'auto' : 'smooth' });
      };
      wrap.appendChild(b); return b;
    };
    var rec = { s: scroller, wrap: wrap, prev: mk('prev'), next: mk('next') };
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      scroller.scrollBy({ left: e.key === 'ArrowLeft' ? -170 : 170, behavior: reduced() ? 'auto' : 'smooth' });
    });
    rails.push(rec); schedule();
  }
  function syncRails() {
    for (var i = 0; i < rails.length; i++) {
      var r = rails[i], s = r.s;
      var over = s.scrollWidth - s.clientWidth > 4;
      var l = s.offsetLeft, t = s.offsetTop, w = s.offsetWidth, h = s.offsetHeight;
      r.prev.style.display = r.next.style.display = over ? '' : 'none';
      r.prev.style.top = r.next.style.top = (t + h / 2) + 'px';
      r.prev.style.left = l + 'px';
      r.next.style.left = (l + w) + 'px';
      r.prev.classList.toggle('mo-rail-off', s.scrollLeft <= 2);
      r.next.classList.toggle('mo-rail-off', s.scrollLeft >= s.scrollWidth - s.clientWidth - 2);
      s.classList.toggle('mo-rail-fade-l', s.scrollLeft > 2);
      s.classList.toggle('mo-rail-fade-r', over && s.scrollLeft < s.scrollWidth - s.clientWidth - 2);
    }
  }
  onSync(syncRails);

  // keep the chosen profile visible when selection moves inside a rail
  function revealSelected() {
    for (var i = 0; i < rails.length; i++) {
      var on = rails[i].s.querySelector('.pchip.on');
      if (!on) continue;
      var sr = rails[i].s.getBoundingClientRect(), br = on.getBoundingClientRect();
      if (br.left < sr.left - 1 || br.right > sr.right + 1) {
        try { on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {}
      }
    }
  }
  onSync(revealSelected);

  // ===============================================================
  // 7. Avatar group — overlapping avatars that spread on hover/focus.
  //
  // Names stay in the DOM (collapsed by width/opacity, never display:none
  // or aria-hidden) so assistive tech still reads every profile name.
  // ===============================================================
  function avatarGroup(box, max) {
    if (!box) return;
    max = max || 6;
    box.classList.add('mo-avgroup');
    var chips = [].slice.call(box.querySelectorAll('.pmini'));
    var extra = [];
    chips.forEach(function (c, i) {
      if (c.classList.contains('mo-av-more')) return;
      var t = (c.textContent || '').trim();
      if (t) { c.title = t; c.setAttribute('aria-label', t); }
      c.style.setProperty('--mo-i', i);
      if (i >= max) { c.classList.add('mo-av-hidden'); extra.push(t); }
    });
    var old = box.querySelector('.mo-av-more'); if (old && old.parentNode) old.parentNode.removeChild(old);
    if (extra.length) {
      var more = D.createElement('span');
      more.className = 'pmini mo-av-more';
      more.textContent = '+' + extra.length;
      more.title = extra.join(', ');
      more.setAttribute('aria-label', extra.length + ' more: ' + extra.join(', '));
      more.style.setProperty('--mo-i', max);
      box.appendChild(more);
    }
  }

  // ===============================================================
  // 8. Canvas backgrounds
  //
  // One engine, four looks. Each pauses when scrolled out of view or when
  // the tab is hidden, is capped at 2x device pixel ratio, sits behind
  // content and never takes pointer events. Under reduced motion each one
  // paints a single static frame instead of running a loop.
  // ===============================================================
  var TAU = Math.PI * 2;
  function mountBg(host, kind) {
    if (!host || host.__moBg) return;
    if (kind === 'bubble' && reduced()) return;
    host.__moBg = true;
    host.classList.add('mo-bg-host');
    var c = D.createElement('canvas');
    c.className = 'mo-bg'; c.setAttribute('aria-hidden', 'true');
    host.insertBefore(c, host.firstChild);
    var ctx = c.getContext('2d');
    if (!ctx) return;
    var holeCol = (kind === 'hole') ? (host.getAttribute('data-bg-color') || '229,57,53') : '';
    var w = 0, h = 0, dpr = 1, t = 0, id = 0, live = false, seen = true, parts = null, frame = 0, last = 0;

    function size() {
      var r = host.getBoundingClientRect();
      var nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
      dpr = Math.min(2, W.devicePixelRatio || 1);
      if (nw === w && nh === h) return false;
      w = nw; h = nh;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      parts = null;
      return true;
    }
    function init() {
      var n, i; parts = [];
      if (kind === 'hole') {
        n = Math.min(170, Math.round(w * h / 2600));
        for (i = 0; i < n; i++) parts.push({ a: Math.random() * TAU, r: 0.13 + Math.random() * 1.1, sp: 0.05 + Math.random() * 0.11, z: 0.5 + Math.random() * 1.4 });
      } else if (kind === 'stars') {
        n = Math.min(110, Math.round(w * h / 5200));
        for (i = 0; i < n; i++) parts.push({ x: Math.random() * w, y: Math.random() * h, z: 0.4 + Math.random() * 1.1, ph: Math.random() * TAU, sp: 0.4 + Math.random() * 0.9 });
      } else if (kind === 'bubble') {
        n = Math.min(34, Math.round(w * h / 16000));
        for (i = 0; i < n; i++) parts.push({ x: Math.random() * w, y: Math.random() * h, r: 6 + Math.random() * 34, sp: 4 + Math.random() * 12, ph: Math.random() * TAU });
      }
    }
    function draw(dt) {
      ctx.clearRect(0, 0, w, h);
      if (!parts) init();
      var i, p;
      if (kind === 'hole') {
        var cx = w * 0.5, cy = h * 0.5, R = Math.max(w, h) * 0.52;
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.62);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.62, 'rgba(' + holeCol + ',0.055)');
        g.addColorStop(1, 'rgba(' + holeCol + ',0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.15, 0, TAU);
        ctx.strokeStyle = 'rgba(' + holeCol + ',0.20)'; ctx.lineWidth = 1; ctx.stroke();
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.r -= p.sp * dt;
          p.a += (0.30 + (1.2 - Math.min(p.r, 1.2)) * 1.5) * dt;
          if (p.r < 0.13) { p.r = 1.05 + Math.random() * 0.25; p.a = Math.random() * TAU; }
          var fade = Math.min(1, (p.r - 0.13) * 4.5) * Math.min(1, (1.25 - p.r) * 3.2);
          ctx.globalAlpha = Math.max(0, fade) * 0.5;
          ctx.fillStyle = p.z > 1.2 ? 'rgba(255,255,255,0.75)' : 'rgba(' + holeCol + ',0.95)';
          ctx.beginPath(); ctx.arc(cx + Math.cos(p.a) * p.r * R, cy + Math.sin(p.a) * p.r * R, p.z * 0.9, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (kind === 'stars') {
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.y -= 1.6 * dt; if (p.y < -2) { p.y = h + 2; p.x = Math.random() * w; }
          ctx.globalAlpha = 0.16 + 0.20 * Math.abs(Math.sin(t * p.sp + p.ph));
          ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.z * 0.7, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (kind === 'bubble') {
        ctx.lineWidth = 1;
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.y -= p.sp * dt; p.x += Math.sin(t * 0.5 + p.ph) * 5 * dt;
          if (p.y < -p.r) { p.y = h + p.r; p.x = Math.random() * w; }
          ctx.globalAlpha = 0.07;
          ctx.strokeStyle = 'rgba(229,57,53,0.9)';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (kind === 'hexagon') {
        var s = 26, hy = s * 0.866, ox = (t * 3) % (s * 1.5);
        var fx = w * (0.5 + 0.42 * Math.cos(t * 0.32)), fy = h * (0.5 + 0.42 * Math.sin(t * 0.24));
        var reach = Math.max(w, h) * 0.45;
        ctx.lineWidth = 1;
        var col = -1;
        for (var x = -s; x < w + s * 2; x += s * 1.5) {
          col++;
          for (var y = (col % 2 ? hy : 0) - hy; y < h + hy * 2; y += hy * 2) {
            var xx = x - ox;
            var d = Math.sqrt((xx - fx) * (xx - fx) + (y - fy) * (y - fy));
            var a = 0.030 + 0.075 * Math.max(0, 1 - d / reach);
            ctx.strokeStyle = 'rgba(229,57,53,' + a.toFixed(3) + ')';
            ctx.beginPath();
            for (var k = 0; k < 6; k++) {
              var ang = TAU / 6 * k;
              var nx = xx + s * 0.5 * Math.cos(ang), ny = y + s * 0.5 * Math.sin(ang);
              if (k) ctx.lineTo(nx, ny); else ctx.moveTo(nx, ny);
            }
            ctx.closePath(); ctx.stroke();
          }
        }
      }
    }
    function loop(now) {
      if (!live) return;
      id = raf(loop);
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      // hexagon is the most expensive look; run it at half rate
      if (kind === 'hexagon' && (frame++ & 1)) return;
      t += dt; draw(dt);
    }
    function start() { if (live || reduced()) return; live = true; last = 0; id = raf(loop); }
    function stop() {
      live = false;
      if (id) { if (W.cancelAnimationFrame) W.cancelAnimationFrame(id); else clearTimeout(id); id = 0; }
    }
    function still() { size(); parts = null; t = 0.6; draw(0.016); }

    if (W.ResizeObserver) {
      new ResizeObserver(function () { if (size() && (reduced() || !live)) still(); }).observe(host);
    }
    if (W.IntersectionObserver) {
      new IntersectionObserver(function (es) {
        seen = es[0].isIntersecting;
        if (seen) { size(); if (reduced()) still(); else start(); } else stop();
      }, { threshold: 0 }).observe(host);
    } else { size(); if (reduced()) still(); else start(); }
    D.addEventListener('visibilitychange', function () {
      if (D.hidden) stop(); else if (seen && !reduced()) start();
    });
    size();
    if (reduced()) still();
  }
  function scanBg(root) {
    root = root || D;
    if (root.getAttribute && root.getAttribute('data-bg')) mountBg(root, root.getAttribute('data-bg'));
    if (!root.querySelectorAll) return;
    var n = root.querySelectorAll('[data-bg]');
    for (var i = 0; i < n.length; i++) mountBg(n[i], n[i].getAttribute('data-bg'));
  }

  // ===============================================================
  // 9. Fireworks — transient success celebration only.
  //    One shot, ~1.1s, never blocks a control, off under reduced motion.
  // ===============================================================
  var celebrating = false;
  function celebrate(host) {
    if (reduced() || celebrating) return;
    host = host || D.body; if (!host || !host.getBoundingClientRect) return;
    var r = host.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    celebrating = true;
    var c = D.createElement('canvas');
    c.className = 'mo-fw'; c.setAttribute('aria-hidden', 'true');
    var dpr = Math.min(2, W.devicePixelRatio || 1);
    var w = Math.round(r.width), h = Math.round(r.height);
    c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px';
    var posed = getComputedStyle(host).position !== 'static';
    if (!posed) host.classList.add('mo-fw-host');
    host.appendChild(c);
    var ctx = c.getContext('2d');
    if (!ctx) { c.remove(); celebrating = false; return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var COL = ['#E53935', '#ff8a80', '#ffffff', '#f0c060'];
    var ps = [];
    var bursts = [[w * 0.32, h * 0.42, 0], [w * 0.68, h * 0.34, 240], [w * 0.5, h * 0.58, 480]];
    var timers = bursts.map(function (b) {
      return setTimeout(function () {
        for (var i = 0; i < 42; i++) {
          var a = Math.random() * TAU, sp = 60 + Math.random() * 190;
          ps.push({ x: b[0], y: b[1], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: COL[(Math.random() * COL.length) | 0] });
        }
      }, b[2]);
    });
    var t0 = performance.now(), last = t0;
    function step(now) {
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      ctx.clearRect(0, 0, w, h);
      for (var i = ps.length - 1; i >= 0; i--) {
        var p = ps[i];
        p.vy += 220 * dt; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 0.95;
        if (p.life <= 0) { ps.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life) * 0.9;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.9, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (now - t0 < 1400) raf(step);
      else {
        timers.forEach(clearTimeout);
        if (c.parentNode) c.parentNode.removeChild(c);
        host.classList.remove('mo-fw-host');
        celebrating = false;
      }
    }
    raf(step);
  }

  // ===============================================================
  // 9b. Drag-reorder insertion line
  //
  // A single shared spacer div. app.js still owns dragover/drop and the
  // real array splice — this only previews the target slot. The "magnetic
  // snap" is just the spacer's own height/margin transition: as it grows
  // from 0, the browser reflows the surrounding rows frame by frame, which
  // reads as the list sliding to make room.
  // ===============================================================
  var dlLine = null;
  function dropline(container, before) {
    if (!container) {
      if (dlLine) {
        dlLine.classList.remove('show');
        var l = dlLine;
        setTimeout(function () { if (!l.classList.contains('show') && l.parentNode) l.parentNode.removeChild(l); }, 200);
      }
      return;
    }
    if (!dlLine) { dlLine = D.createElement('div'); dlLine.className = 'mo-dropline'; dlLine.setAttribute('aria-hidden', 'true'); }
    if (dlLine.nextSibling !== before && dlLine !== before) container.insertBefore(dlLine, before || null);
    raf(function () { dlLine.classList.add('show'); });
  }

  // ===============================================================
  // 10. Observers — the only inputs to everything above
  // ===============================================================
  var mo = new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.type === 'childList') {
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType === 1) scanBg(n);
        }
      }
    }
    schedule();
  });

  function boot() {
    scanBg(D);
    rail(D.querySelector('.pf-picker-scroll'));
    rail(D.getElementById('sy-source'));
    mo.observe(D.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'disabled'] });
    schedule();
    // bars inside a panel that starts hidden have no geometry on first pass
    setTimeout(schedule, 120);
    setTimeout(schedule, 600);
  }
  W.addEventListener('resize', schedule);
  if (RMQ && RMQ.addEventListener) RMQ.addEventListener('change', schedule);
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();

  W.NumaxMotion = {
    celebrate: celebrate,
    avatarGroup: avatarGroup,
    rail: rail,
    mountBg: mountBg,
    dropline: dropline,
    reduced: reduced,
    refresh: schedule
  };
})();
