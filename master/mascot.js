// ============================================================
// Numax mascot (mascot.js)
//
// The little white-headed character in the black cap, suit and red tie,
// drawn in vector from Furqan's renders in mascot/reference/. Those renders
// are RGB with the grey studio floor and the white ledge/wall baked in — no
// transparency — so they cannot sit on the app's own backgrounds. Drawing it
// also means the arms, eyes and cap are separate parts that can move.
//
// Like market.js and wizard.js this owns no application state and makes no
// network calls. Delete the file and the app still works: every caller
// guards on window.NumaxMascot, and any [data-mascot] placeholder simply
// stays empty.
//
// ---- use it ------------------------------------------------------------
// In markup (upgraded automatically, including nodes added later):
//   <span data-mascot="wave" data-mascot-size="96" data-mascot-anim="idle blink"></span>
//
// From code:
//   const m = NumaxMascot.create({ pose: 'ledge', size: 90, anim: ['blink'], follow: true });
//   host.appendChild(m);
//   NumaxMascot.play(m, 'hop');      // one-shot: hop | nod | pop | wiggle
//   NumaxMascot.pose(m, 'wave');     // switch pose in place
//
// Poses:  stand | wave | ledge (peeking over an edge below it)
//         peek (leaning out from behind an edge; side:'left'|'right')
//         hang (hanging from an edge above it)
// Loops:  idle (gentle bob) | blink | wave (arm) | swing (hang) | look (glances)
// follow: true makes the eyes track the pointer.
// Everything that moves stops under prefers-reduced-motion, and nothing
// runs while the tab is hidden.
// ============================================================
(function () {
  'use strict';
  var D = document, W = window;
  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  var POSES = ['stand', 'wave', 'ledge', 'peek', 'hang'];
  var LOOPS = ['idle', 'blink', 'wave', 'swing', 'look'];
  var ONESHOTS = ['hop', 'nod', 'pop', 'wiggle'];

  // The character's own colours. Deliberately fixed rather than themed: it is
  // a brand mark, and a navy-suited mascot in light mode would be someone
  // else. The only concession to the page is the faint rim on the black parts,
  // which stops the cap and suit dissolving into a near-black background.
  var INK = '#141316', INK2 = '#26242a', RED = '#E3262F';

  // Each pose is a viewBox plus the arm angles and a few offsets. The arms are
  // drawn hanging straight down and rotated about the shoulder.
  var POSE = {
    stand: { vb: '0 0 200 250', armL: 8, armR: -8, body: true, shadow: true },
    wave:  { vb: '0 0 200 250', armL: 122, armR: -8, body: true, shadow: true, headTilt: 4 },
    peek:  { vb: '0 0 200 250', armL: 58, armR: -6, body: true, shadow: true, headTilt: -9, lean: -6 },
    hang:  { vb: '0 -14 200 262', armL: 0, armR: 0, body: true, shadow: false, reach: true, legsDangle: true },
    ledge: { vb: '0 0 200 172', armL: 0, armR: 0, body: false, shadow: false, ledgeHands: true },
  };

  function s(tag, attrs, parent) {
    var n = D.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function arm(g, side, angle) {
    // Shoulder pivot; the sleeve hangs from it and the hand ends it.
    var x = side === 'L' ? 66 : 134;
    var a = s('g', { 'class': 'nxm-arm nxm-arm-' + side, style: '--nxm-arm:' + angle + 'deg;transform-origin:' + x + 'px 150px' }, g);
    s('rect', { x: x - 9, y: 144, width: 18, height: 38, rx: 9, fill: INK, 'class': 'nxm-dark' }, a);
    s('circle', { cx: x, cy: 186, r: 11, fill: 'url(#nxm-skin-' + g.__id + ')' }, a);
    return a;
  }

  function build(opts) {
    var pose = POSE[opts.pose] ? opts.pose : 'stand';
    var P = POSE[pose];
    var id = ++uid;

    var svg = s('svg', { viewBox: P.vb, 'class': 'nxm-svg', 'aria-hidden': 'true', focusable: 'false' });
    var defs = s('defs', {}, svg);
    var skin = s('radialGradient', { id: 'nxm-skin-' + id, cx: '38%', cy: '30%', r: '78%' }, defs);
    s('stop', { offset: '0', 'stop-color': '#ffffff' }, skin);
    s('stop', { offset: '.62', 'stop-color': '#f6f4f7' }, skin);
    s('stop', { offset: '1', 'stop-color': '#dcd8de' }, skin);
    var cloth = s('linearGradient', { id: 'nxm-cloth-' + id, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    s('stop', { offset: '0', 'stop-color': INK2 }, cloth);
    s('stop', { offset: '1', 'stop-color': INK }, cloth);

    if (P.shadow) s('ellipse', { 'class': 'nxm-shadow', cx: 100, cy: 241, rx: 44, ry: 5.5, fill: 'rgba(0,0,0,.28)' }, svg);

    var fig = s('g', { 'class': 'nxm-fig', style: P.lean ? 'transform:rotate(' + P.lean + 'deg);transform-origin:100px 240px' : null }, svg);
    fig.__id = id;

    // ---- legs, shorts, arms behind the body when reaching up -------------
    if (P.body) {
      var legs = s('g', { 'class': 'nxm-legs' }, fig);
      if (P.legsDangle) {
        s('rect', { x: 76, y: 194, width: 21, height: 36, rx: 10.5, fill: 'url(#nxm-skin-' + id + ')', transform: 'rotate(6 86 196)' }, legs);
        s('rect', { x: 104, y: 194, width: 21, height: 34, rx: 10.5, fill: 'url(#nxm-skin-' + id + ')', transform: 'rotate(-8 114 196)' }, legs);
      } else {
        s('rect', { x: 76, y: 196, width: 21, height: 40, rx: 10.5, fill: 'url(#nxm-skin-' + id + ')' }, legs);
        s('rect', { x: 103, y: 196, width: 21, height: 40, rx: 10.5, fill: 'url(#nxm-skin-' + id + ')' }, legs);
      }
      s('rect', { x: 70, y: 184, width: 60, height: 22, rx: 8, fill: INK, 'class': 'nxm-dark' }, fig);
    }
    if (P.reach) {
      // Hanging: long sleeves up the sides of the head, hands over the edge.
      // Drawn as thick round-capped lines from each shoulder to above the
      // head; the head, drawn later, covers the middle, so the sleeves read as
      // coming up behind it the way the render shows.
      var up = s('g', { 'class': 'nxm-reach' }, fig);
      [['M68 150 L30 0', 30], ['M132 150 L170 0', 170]].forEach(function (a) {
        s('path', { d: a[0], stroke: 'rgba(255,255,255,.16)', 'stroke-width': 21.4, 'stroke-linecap': 'round', fill: 'none', 'class': 'nxm-rim' }, up);
        s('path', { d: a[0], stroke: INK, 'stroke-width': 19, 'stroke-linecap': 'round', fill: 'none' }, up);
        s('circle', { cx: a[1], cy: -5, r: 12, fill: 'url(#nxm-skin-' + id + ')' }, up);
      });
    }

    // ---- jacket, shirt, tie ------------------------------------------------
    var torso = s('g', { 'class': 'nxm-torso' }, fig);
    s('rect', { x: 62, y: 138, width: 76, height: 60, rx: 18, fill: 'url(#nxm-cloth-' + id + ')', 'class': 'nxm-dark' }, torso);
    s('path', { d: 'M86 138 L114 138 L100 168 Z', fill: '#ffffff' }, torso);
    s('path', { d: 'M86 138 L100 170 M114 138 L100 170', stroke: '#3a373e', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }, torso);
    s('path', { d: 'M95.5 140 L104.5 140 L102.6 147.5 L97.4 147.5 Z', fill: RED, 'class': 'nxm-tie' }, torso);
    s('path', { d: 'M97.4 147.5 L102.6 147.5 L106.5 169 L100 177 L93.5 169 Z', fill: RED, 'class': 'nxm-tie' }, torso);
    if (P.body) s('circle', { cx: 109, cy: 182, r: 2.4, fill: '#0b0a0c', stroke: '#3a373e', 'stroke-width': 0.8 }, torso);

    // ---- arms (hanging ones behind the head, raised ones in front) --------
    var raised = [];
    if (P.body && !P.reach) {
      if (Math.abs(P.armL) > 60) raised.push(['L', P.armL]); else arm(fig, 'L', P.armL);
      if (Math.abs(P.armR) > 60) raised.push(['R', P.armR]); else arm(fig, 'R', P.armR);
    }

    // ---- head --------------------------------------------------------------
    var head = s('g', { 'class': 'nxm-head', style: 'transform-origin:100px 150px' + (P.headTilt ? ';--nxm-tilt:' + P.headTilt + 'deg' : '') }, fig);
    s('rect', { x: 27, y: 40, width: 146, height: 116, rx: 50, fill: 'url(#nxm-skin-' + id + ')' }, head);
    var face = s('g', { 'class': 'nxm-face' }, head);
    var eyes = s('g', { 'class': 'nxm-eyes' }, face);
    s('rect', { x: 67, y: 90, width: 11, height: 25, rx: 5.5, fill: INK }, eyes);
    s('rect', { x: 122, y: 90, width: 11, height: 25, rx: 5.5, fill: INK }, eyes);
    s('path', { d: 'M92.5 117.5 Q100 126 107.5 117.5', stroke: INK, 'stroke-width': 3.6, fill: 'none', 'stroke-linecap': 'round', 'class': 'nxm-mouth' }, face);

    // ---- cap: crown, seams, button, brim out to the left ------------------
    var cap = s('g', { 'class': 'nxm-cap' }, head);
    s('path', { d: 'M26 82 C24 44 62 22 106 22 C150 22 180 46 176 86 C160 78 132 72 104 72 C74 72 46 76 26 82 Z', fill: 'url(#nxm-cloth-' + id + ')', 'class': 'nxm-dark' }, cap);
    s('path', { d: 'M106 24 C98 40 94 56 94 70 M106 24 C124 40 136 58 140 74', stroke: '#3a373e', 'stroke-width': 1.3, fill: 'none' }, cap);
    s('path', { d: 'M32 76 C16 78 4 86 2 96 C20 93 44 90 70 88 C72 84 70 78 66 74 C54 74 42 74 32 76 Z', fill: INK, 'class': 'nxm-dark' }, cap);
    s('ellipse', { cx: 106, cy: 22.5, rx: 7, ry: 3.4, fill: INK, 'class': 'nxm-dark' }, cap);

    raised.forEach(function (a) { arm(fig, a[0], a[1]); });

    if (P.ledgeHands) {
      // Peeking over: two hands resting on the edge the element sits on.
      s('ellipse', { cx: 50, cy: 163, rx: 15, ry: 11, fill: 'url(#nxm-skin-' + id + ')', 'class': 'nxm-hand' }, fig);
      s('ellipse', { cx: 150, cy: 163, rx: 15, ry: 11, fill: 'url(#nxm-skin-' + id + ')', 'class': 'nxm-hand' }, fig);
    }
    return svg;
  }

  // ---- styles, injected once so this file stands on its own ------------------
  function ensureStyle() {
    if (D.getElementById('nxm-style')) return;
    var st = D.createElement('style');
    st.id = 'nxm-style';
    st.textContent = [
      '.nx-mascot{display:inline-block;position:relative;line-height:0;vertical-align:bottom;width:var(--nxm-size,120px);flex:none}',
      '.nx-mascot .nxm-svg{width:100%;height:auto;display:block;overflow:visible}',
      '.nx-mascot[data-side="right"] .nxm-svg{transform:scaleX(-1)}',
      '.nx-mascot .nxm-dark{stroke:rgba(255,255,255,.16);stroke-width:1.2;paint-order:stroke}',
      ':root[data-theme="light"] .nx-mascot .nxm-dark{stroke:none}',
      '.nx-mascot .nxm-fig,.nx-mascot .nxm-head,.nx-mascot .nxm-arm,.nx-mascot .nxm-eyes{transform-box:view-box}',
      '.nx-mascot .nxm-arm{transform:rotate(var(--nxm-arm,0deg));transition:transform .45s cubic-bezier(.34,1.4,.64,1)}',
      '.nx-mascot .nxm-head{transform:rotate(var(--nxm-tilt,0deg))}',
      '.nx-mascot .nxm-eyes{transform-origin:100px 102px;transform:translate(var(--nxm-ex,0px),var(--nxm-ey,0px));transition:transform .18s ease-out}',
      '.nx-mascot .nxm-eyes rect{transform-box:fill-box;transform-origin:center}',
      /* peek: only the part past the edge shows */
      '.nx-mascot[data-pose="peek"]{overflow:hidden}',
      '.nx-mascot[data-pose="peek"] .nxm-svg{margin-left:-17%}',
      '.nx-mascot[data-pose="peek"][data-side="right"] .nxm-svg{margin-left:17%}',
      ':root[data-theme="light"] .nx-mascot .nxm-rim{display:none}',
      /* loops */
      '@keyframes nxm-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      '@keyframes nxm-blink{0%,90%,100%{transform:scaleY(1)}93%{transform:scaleY(.12)}96%{transform:scaleY(1)}}',
      '@keyframes nxm-wave{0%,100%{transform:rotate(var(--nxm-arm))}50%{transform:rotate(calc(var(--nxm-arm) + 16deg))}}',
      '@keyframes nxm-swing{0%,100%{transform:rotate(-3.5deg)}50%{transform:rotate(3.5deg)}}',
      '@keyframes nxm-look{0%,38%,100%{transform:translate(0,0)}44%,62%{transform:translate(-4px,1px)}68%,86%{transform:translate(4px,-1px)}}',
      '.nx-mascot.a-idle .nxm-fig{animation:nxm-bob 3.2s ease-in-out infinite}',
      '.nx-mascot.a-blink .nxm-eyes rect{animation:nxm-blink 4.6s ease-in-out infinite}',
      '.nx-mascot.a-blink .nxm-eyes rect+rect{animation-delay:.02s}',
      '.nx-mascot.a-wave .nxm-arm-L{animation:nxm-wave .9s ease-in-out infinite;transform-origin:66px 150px}',
      '.nx-mascot.a-swing .nxm-fig{animation:nxm-swing 2.6s ease-in-out infinite;transform-origin:100px -10px}',
      '.nx-mascot.a-look:not(.following) .nxm-eyes{animation:nxm-look 7s ease-in-out infinite}',
      /* one-shots */
      '@keyframes nxm-hop{0%,100%{transform:translateY(0)}35%{transform:translateY(-16px)}60%{transform:translateY(0)}75%{transform:translateY(-4px)}}',
      '@keyframes nxm-nod{0%,100%{transform:rotate(var(--nxm-tilt,0deg))}30%{transform:rotate(calc(var(--nxm-tilt,0deg) + 7deg))}60%{transform:rotate(calc(var(--nxm-tilt,0deg) - 3deg))}}',
      '@keyframes nxm-pop{0%{transform:scale(.55);opacity:0}60%{transform:scale(1.07);opacity:1}100%{transform:scale(1)}}',
      '@keyframes nxm-wiggle{0%,100%{transform:rotate(0)}20%{transform:rotate(-6deg)}40%{transform:rotate(5deg)}60%{transform:rotate(-3deg)}80%{transform:rotate(2deg)}}',
      '.nx-mascot.o-hop .nxm-svg{animation:nxm-hop .7s cubic-bezier(.3,.7,.4,1)}',
      '.nx-mascot.o-nod .nxm-head{animation:nxm-nod .6s ease-in-out}',
      '.nx-mascot.o-pop .nxm-svg{animation:nxm-pop .5s cubic-bezier(.34,1.56,.64,1);transform-origin:50% 100%}',
      '.nx-mascot.o-wiggle .nxm-svg{animation:nxm-wiggle .6s ease-in-out;transform-origin:50% 100%}',
      /* entrances */
      '@keyframes nxm-rise{from{transform:translateY(55%);opacity:0}to{transform:none;opacity:1}}',
      '@keyframes nxm-slide{from{transform:translateX(-45%)}to{transform:none}}',
      '@keyframes nxm-drop{from{transform:translateY(-30%) rotate(-8deg);opacity:0}to{transform:none;opacity:1}}',
      '.nx-mascot[data-pose="ledge"].enter .nxm-svg{animation:nxm-rise .7s cubic-bezier(.3,1.3,.5,1) both}',
      '.nx-mascot[data-pose="peek"].enter .nxm-svg{animation:nxm-slide .7s cubic-bezier(.3,1.3,.5,1) both}',
      '.nx-mascot[data-pose="peek"][data-side="right"].enter .nxm-svg{animation-name:nxm-slide-r}',
      '@keyframes nxm-slide-r{from{transform:scaleX(-1) translateX(-45%)}to{transform:scaleX(-1)}}',
      '.nx-mascot[data-pose="hang"].enter .nxm-svg{animation:nxm-drop .7s cubic-bezier(.3,1.3,.5,1) both;transform-origin:50% 0}',
      '.nx-mascot:is([data-pose="stand"],[data-pose="wave"]).enter .nxm-svg{animation:nxm-pop .55s cubic-bezier(.34,1.56,.64,1) both;transform-origin:50% 100%}',
      /* nothing moves when motion is unwanted, or while the tab is hidden */
      '.nx-mascot.paused *{animation-play-state:paused!important}',
      '@media (prefers-reduced-motion:reduce){.nx-mascot *,.nx-mascot .nxm-svg{animation:none!important;transition:none!important}}',
    ].join('\n');
    (D.head || D.documentElement).appendChild(st);
  }

  function toList(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).filter(function (x) { return LOOPS.indexOf(x) >= 0; });
  }

  var followers = new Set();
  var lastPt = null, raf = 0;
  function aim() {
    raf = 0;
    if (!lastPt || D.hidden) return;
    followers.forEach(function (m) {
      if (!m.isConnected) { followers.delete(m); return; }
      var r = m.getBoundingClientRect();
      if (!r.width) return;
      var cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
      var dx = lastPt.x - cx, dy = lastPt.y - cy;
      var len = Math.max(1, Math.hypot(dx, dy));
      var k = Math.min(1, len / 240);
      var flip = m.getAttribute('data-side') === 'right' ? -1 : 1;
      m.style.setProperty('--nxm-ex', (dx / len * 4.5 * k * flip).toFixed(2) + 'px');
      m.style.setProperty('--nxm-ey', (dy / len * 3.2 * k).toFixed(2) + 'px');
    });
  }
  function onMove(e) {
    lastPt = { x: e.clientX, y: e.clientY };
    if (!raf) raf = W.requestAnimationFrame(aim);
  }

  function apply(m, o) {
    var pose = POSE[o.pose] ? o.pose : 'stand';
    m.setAttribute('data-pose', pose);
    if (o.side === 'right') m.setAttribute('data-side', 'right'); else m.removeAttribute('data-side');
    if (o.size) m.style.setProperty('--nxm-size', typeof o.size === 'number' ? o.size + 'px' : o.size);
    while (m.firstChild) m.removeChild(m.firstChild);
    m.appendChild(build({ pose: pose }));
    LOOPS.forEach(function (l) { m.classList.remove('a-' + l); });
    var loops = toList(o.anim);
    if (!o.anim) loops = pose === 'hang' ? ['swing', 'blink'] : pose === 'wave' ? ['wave', 'blink'] : ['idle', 'blink'];
    loops.forEach(function (l) { m.classList.add('a-' + l); });
    if (o.follow) { m.classList.add('following'); followers.add(m); } else { m.classList.remove('following'); followers.delete(m); }
    m.__nxm = { pose: pose, side: o.side, size: o.size, anim: o.anim, follow: !!o.follow, label: o.label };
  }

  function create(opts) {
    ensureStyle();
    var o = opts || {};
    var m = D.createElement('span');
    m.className = 'nx-mascot' + (o.className ? ' ' + o.className : '');
    if (o.label) { m.setAttribute('role', 'img'); m.setAttribute('aria-label', o.label); }
    else m.setAttribute('aria-hidden', 'true');
    apply(m, o);
    if (o.enter !== false) {
      m.classList.add('enter');
      setTimeout(function () { m.classList.remove('enter'); }, 900);
    }
    return m;
  }

  function mount(host, opts) {
    if (!host) return null;
    var m = create(opts);
    host.appendChild(m);
    return m;
  }

  function pose(m, p, extra) {
    if (!m || !m.__nxm) return;
    var o = Object.assign({}, m.__nxm, extra || {}, { pose: p });
    // A pose change keeps the other options but re-derives the default loops.
    if (!extra || !extra.anim) o.anim = m.__nxm.anim;
    apply(m, o);
  }

  function play(m, name) {
    if (!m || ONESHOTS.indexOf(name) < 0) return;
    var c = 'o-' + name;
    m.classList.remove(c);
    void m.offsetWidth;
    m.classList.add(c);
    clearTimeout(m.__nxmT);
    m.__nxmT = setTimeout(function () { m.classList.remove(c); }, 800);
  }

  // [data-mascot] placeholders, now and later.
  function upgradeOne(n) {
    if (!n || n.__nxmDone) return;
    n.__nxmDone = true;
    ensureStyle();
    var o = {
      pose: n.getAttribute('data-mascot') || 'stand',
      size: n.getAttribute('data-mascot-size') ? Number(n.getAttribute('data-mascot-size')) : null,
      anim: n.getAttribute('data-mascot-anim'),
      side: n.getAttribute('data-mascot-side'),
      follow: n.hasAttribute('data-mascot-follow'),
      label: n.getAttribute('data-mascot-label'),
    };
    n.classList.add('nx-mascot');
    if (o.label) { n.setAttribute('role', 'img'); n.setAttribute('aria-label', o.label); }
    else n.setAttribute('aria-hidden', 'true');
    apply(n, o);
    n.classList.add('enter');
    setTimeout(function () { n.classList.remove('enter'); }, 900);
  }
  function upgrade(root) {
    var r = root || D;
    if (r.nodeType === 1 && r.hasAttribute('data-mascot')) upgradeOne(r);
    if (r.querySelectorAll) Array.prototype.forEach.call(r.querySelectorAll('[data-mascot]'), upgradeOne);
  }

  function pauseAll() {
    var hidden = D.hidden;
    Array.prototype.forEach.call(D.querySelectorAll('.nx-mascot'), function (m) { m.classList.toggle('paused', hidden); });
  }

  function start() {
    ensureStyle();
    upgrade(D);
    new MutationObserver(function (list) {
      list.forEach(function (rec) {
        Array.prototype.forEach.call(rec.addedNodes, function (n) { if (n.nodeType === 1) upgrade(n); });
      });
    }).observe(D.body, { childList: true, subtree: true });
    D.addEventListener('visibilitychange', pauseAll);
    W.addEventListener('pointermove', onMove, { passive: true });
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', start); else start();

  W.NumaxMascot = { create: create, mount: mount, pose: pose, play: play, upgrade: upgrade,
    poses: POSES.slice(), loops: LOOPS.slice(), oneshots: ONESHOTS.slice() };
})();
