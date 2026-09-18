// ============================================================
// Numax mascot (mascot.js)
//
// The white-headed character in the black cap, suit and red tie — built from
// Furqan's own renders in mascot/reference/, not redrawn. The first version
// was an SVG re-drawing and it never looked like him (Furqan, 2026-09-17), so
// the renders themselves are used, rigged the way a 2D animator would:
//
//   mascot/<pose>.webp        the render (from Furqan's clean-background PNGs,
//                             not keyed off a backdrop), with the eyes painted
//                             out (filled in from the surrounding shading)
//   mascot/<pose>-eyes.webp   the render's own eyes, alone, on transparency
//   mascot/wave-arm.webp      wave only: the raised arm, so it can wave alone
//
// Stacked, the two reproduce the render exactly. Apart, the eyes can blink
// (squash to a line) and follow the pointer without touching the face.
// The cut-outs and the eye boxes below were produced once, offline, from the
// four reference renders; if a render changes, regenerate both together.
//
// Like market.js and wizard.js this owns no application state and makes no
// network calls beyond its own images. Delete the file and the app still
// works: every caller guards on window.NumaxMascot, and any [data-mascot]
// placeholder simply stays empty.
//
// ---- use it ------------------------------------------------------------
// In markup (upgraded automatically, including nodes added later):
//   <span data-mascot="wave" data-mascot-size="96" data-mascot-anim="idle blink"></span>
//
// From code:
//   const m = NumaxMascot.create({ pose: 'ledge', size: 90, follow: true });
//   host.appendChild(m);
//   NumaxMascot.play(m, 'hop');      // one-shot: hop | nod | pop | wiggle
//   NumaxMascot.pose(m, 'wave');     // switch pose in place
//   NumaxMascot.create({ pose: 'ledge', hide: true })  // rests below its edge
//   NumaxMascot.peek(m, true|false)  // ...comes up / goes back down
//
// Poses:  wave (standing, one hand up; `stand` is the same render)
//         ledge (peeking up over an edge: put the element's bottom ON the edge;
//                it is clipped there, so a hop ducks behind the edge)
//         peek (leaning out from behind an edge; side:'left'|'right' names the
//               side the edge is on)
//         hang (hanging from an edge: put the element's top on the edge)
// Loops:  idle (breathing / bob / sway, per pose) | blink | wave (the arm waves)
//         | swing (hang) | look (glances about when not following)
//         | sleep (eyes held shut, slow breathing, Z's drifting up; wake(m, on)
//           opens his eyes while the caller says so)
//         | lift (hang pose only: arms up is a barbell overhead — the bar is
//           drawn behind the fists so they grip it, and he stands to press it)
// follow: true makes the eyes and a slight lean track the pointer.
// size:   the rendered WIDTH, as before.
// Everything that moves stops under prefers-reduced-motion, and nothing runs
// while the tab is hidden.
// ============================================================
(function () {
  'use strict';
  var D = document, W = window;

  var POSES = ['stand', 'wave', 'ledge', 'peek', 'hang'];
  var LOOPS = ['idle', 'blink', 'wave', 'swing', 'look', 'sleep', 'lift'];
  var ONESHOTS = ['hop', 'nod', 'pop', 'wiggle'];
  var ALIAS = { stand: 'wave' };

  // Next to this file, whatever the page's own path is. The script tag may
  // carry a ?v= stamp; the regex drops the whole last segment either way.
  var cur = D.currentScript && D.currentScript.src;
  var BASE = (cur ? cur.replace(/[^/]*$/, '') : '') + 'mascot/';

  // Per render: its size (for the aspect ratio) and each eye's box as
  // [left, top, width, height] in percent of the figure, padded so a moved or
  // squashed eye never shows the edge of its own box.
  // `arm` (wave only): the raised arm is its own layer, mascot/wave-arm.webp,
  // figure-sized, turning about the shoulder at [left, top] percent. The body
  // under it keeps a shoulder stub so the joint never opens. It only swings
  // OUTWARD far — past about +6deg the sleeve's underside parts from the torso.
  // Rebuilt 2026-09-17 from Furqan's own clean-background renders (the earlier
  // cut-outs had been keyed off a studio backdrop and some of it showed).
  var ART = {
    wave:  { w: 326, h: 440, eyes: [[17.82, 29.89, 22.14, 19.38], [56.65, 36.7, 22.82, 19.21]], arm: [24.45, 69.13] },
    ledge: { w: 396, h: 440, eyes: [[18.68, 40.51, 23.03, 25.53], [59.26, 46.29, 24.02, 25.74]] },
    hang:  { w: 324, h: 440, eyes: [[16.68, 28.29, 23.27, 20.51], [56.95, 33.07, 23.64, 20.87]] },
    peek:  { w: 280, h: 440, eyes: [[7.17, 27.58, 30.55, 17.73], [46.67, 39.24, 30.55, 17.56]] },
  };
  // Bumped whenever the webp files change: the images are replaced under the
  // same names, and a cached old picture under new eye boxes looks broken.
  var ART_V = '?v=3';

  var reduce = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function h(tag, cls, parent) {
    var n = D.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function pct(v) { return (+v.toFixed(3)) + '%'; }

  // The barbell for `lift`, drawn in units of 1% of the figure's width. The
  // hang render's fists sit at about 10% and 90% across and 4% down, so the
  // bar runs through both at that height; the SVG is inserted BEHIND the
  // render, which is what puts the fists in front of the bar — a grip.
  var BARBELL = '<svg class="nxm-bar" viewBox="0 0 148 26" aria-hidden="true">' +
    '<defs><linearGradient id="nxmSteel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f4"/>' +
    '<stop offset=".55" stop-color="#a3a8b3"/><stop offset="1" stop-color="#5d626e"/></linearGradient>' +
    '<linearGradient id="nxmPlate" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3d45"/>' +
    '<stop offset=".5" stop-color="#1b1d22"/><stop offset="1" stop-color="#101114"/></linearGradient></defs>' +
    '<rect x="5" y="11.6" width="138" height="2.8" rx="1.4" fill="url(#nxmSteel)"/>' +
    '<rect x="9" y="1" width="7" height="24" rx="2.2" fill="url(#nxmPlate)"/>' +
    '<rect x="132" y="1" width="7" height="24" rx="2.2" fill="url(#nxmPlate)"/>' +
    '<rect x="16" y="4.5" width="4.5" height="17" rx="1.6" fill="#c8202b"/>' +
    '<rect x="127.5" y="4.5" width="4.5" height="17" rx="1.6" fill="#c8202b"/>' +
    '<rect x="20.5" y="9.5" width="2.2" height="7" rx=".8" fill="url(#nxmSteel)"/>' +
    '<rect x="125.3" y="9.5" width="2.2" height="7" rx=".8" fill="url(#nxmSteel)"/></svg>';

  function build(m, art, name, loops) {
    var hider = h('span', 'nxm-hider', m);      // hiding: resting down / peeking up
    var stage = h('span', 'nxm-stage', hider);  // one-shots
    h('span', 'nxm-shadow', stage);             // contact shadow (standing only)
    var body = h('span', 'nxm-body', stage);    // loops
    var lean = h('span', 'nxm-lean', body);     // pointer lean
    if (loops.indexOf('lift') >= 0 && name === 'hang') lean.insertAdjacentHTML('beforeend', BARBELL);
    if (loops.indexOf('sleep') >= 0) {
      // Outside the lean, so the Z's drift straight up whatever he is doing.
      var zz = h('span', 'nxm-zzz', stage);
      ['z', 'z', 'Z'].forEach(function (t, i) { var s = h('span', 'nxm-z nxm-z' + i, zz); s.textContent = t; });
    }
    var img = h('img', 'nxm-img', lean);
    img.alt = ''; img.draggable = false; img.decoding = 'async';
    // Not loading="lazy": a lazy image never starts while the document is
    // hidden, the same measured trap wzLogo and mkLogo document.
    img.src = BASE + name + '.webp' + ART_V;
    img.width = art.w; img.height = art.h;
    if (art.arm) {
      var arm = h('img', 'nxm-arm', lean);
      arm.alt = ''; arm.draggable = false; arm.decoding = 'async';
      arm.src = BASE + name + '-arm.webp' + ART_V;
      arm.style.transformOrigin = pct(art.arm[0]) + ' ' + pct(art.arm[1]);
    }
    var url = 'url("' + BASE + name + '-eyes.webp' + ART_V + '")';
    art.eyes.forEach(function (e) {
      var eye = h('span', 'nxm-eye', lean);
      var L = e[0], T = e[1], w = e[2], hh = e[3];
      eye.style.left = pct(L); eye.style.top = pct(T);
      eye.style.width = pct(w); eye.style.height = pct(hh);
      // The eye layer is figure-sized; this window shows exactly its own box.
      eye.style.backgroundImage = url;
      eye.style.backgroundSize = pct(10000 / w) + ' ' + pct(10000 / hh);
      eye.style.backgroundPosition = pct(L / (100 - w) * 100) + ' ' + pct(T / (100 - hh) * 100);
    });
  }

  // ---- styles, injected once so this file stands on its own ------------------
  function ensureStyle() {
    if (D.getElementById('nxm-style')) return;
    var st = D.createElement('style');
    st.id = 'nxm-style';
    st.textContent = [
      '.nx-mascot{display:inline-block;position:relative;line-height:0;vertical-align:bottom;width:var(--nxm-size,120px);flex:none;',
      '  -webkit-user-select:none;user-select:none;--nxm-ex:0px;--nxm-ey:0px;--nxm-lean:0deg}',
      '.nx-mascot .nxm-hider,.nx-mascot .nxm-stage,.nx-mascot .nxm-body,.nx-mascot .nxm-lean{display:block;position:relative}',
      /* the waving arm: its own layer over the body, turning at the shoulder */
      '.nx-mascot .nxm-arm{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;',
      '  filter:drop-shadow(0 6px 10px rgba(0,0,0,.28))}',
      /* hiding: resting below its edge with only the cap showing; .up brings it
         up (springy), and it sinks back without the overshoot */
      '.nx-mascot .nxm-hider{transition:translate .6s cubic-bezier(.3,1.3,.5,1)}',
      '.nx-mascot.hiding .nxm-hider{translate:0 var(--nxm-hide,80%);transition-duration:.38s;transition-timing-function:cubic-bezier(.5,0,.7,.4)}',
      '.nx-mascot.hiding.up .nxm-hider{translate:0 0;transition-duration:.6s;transition-timing-function:cubic-bezier(.3,1.3,.5,1)}',
      '.nx-mascot .nxm-img{display:block;width:100%;height:auto;pointer-events:none;',
      '  filter:drop-shadow(0 1px 0 rgba(255,255,255,.10)) drop-shadow(0 10px 18px rgba(0,0,0,.35))}',
      '.nx-mascot .nxm-eye{position:absolute;display:block;background-repeat:no-repeat;',
      '  translate:var(--nxm-ex) var(--nxm-ey);transition:translate .22s cubic-bezier(.3,.7,.4,1);transform-origin:50% 55%}',
      '.nx-mascot .nxm-shadow{display:none}',
      '.nx-mascot:is([data-pose="wave"]) .nxm-shadow{display:block;position:absolute;left:18%;right:18%;bottom:-3%;height:7%;',
      '  border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.42),rgba(0,0,0,0));transform-origin:50% 50%}',
      ':root[data-theme="light"] .nx-mascot .nxm-shadow{background:radial-gradient(closest-side,rgba(18,26,43,.22),rgba(18,26,43,0))}',
      /* the lean follows the pointer; each pose leans from where it is held */
      '.nx-mascot .nxm-lean{rotate:var(--nxm-lean);transition:rotate .5s cubic-bezier(.3,.7,.4,1);transform-origin:50% 100%}',
      '.nx-mascot[data-pose="hang"] .nxm-lean{transform-origin:50% 0}',
      '.nx-mascot[data-pose="ledge"] .nxm-lean{transform-origin:50% 100%}',
      /* ledge and peek sit behind their edge: clip at it */
      /* ONLY at the edge. These used overflow:hidden, which also cut the soft
         drop shadow off in a hard rectangle on the other three sides — on a
         light card that rectangle was the "grey background" behind him
         (Furqan, 2026-09-18). clip-path with negative insets clips the one
         side the edge is on and leaves the rest free. Mirroring (scale) comes
         after the clip, so a right-side peek is clipped on the right. */
      '.nx-mascot[data-pose="ledge"]{clip-path:inset(-60% -40% 0 -40%);padding-top:6%;margin-top:-6%}',
      '.nx-mascot[data-pose="peek"]{clip-path:inset(-40% -40% 0 0)}',
      /* A white face on a white card needs an edge, not a haze: light mode
         gets a tight contact shadow rather than a spread one. */
      ':root[data-theme="light"] .nx-mascot .nxm-img{filter:drop-shadow(0 1px 1.5px rgba(18,26,43,.28)) drop-shadow(0 4px 8px rgba(18,26,43,.10))}',
      /* mirrored as a whole, so every inner origin and animation still holds */
      '.nx-mascot[data-pose="peek"][data-side="right"]{scale:-1 1}',
      '.nx-mascot[data-pose="peek"] .nxm-lean{transform-origin:0 100%}',
      /* blink: the eye squashes to a line, which is what a closed eye is */
      '@keyframes nxm-blink{0%,100%{scale:1 1}45%,55%{scale:1.06 .08}}',
      '.nx-mascot.blinking .nxm-eye{animation:nxm-blink .16s ease-in-out}',
      /* loops */
      '@keyframes nxm-breathe{0%,100%{scale:1 1}50%{scale:.992 1.014}}',
      '@keyframes nxm-bob{0%,100%{translate:0 0}50%{translate:0 2.5%}}',
      '@keyframes nxm-sway{0%,100%{rotate:0deg;translate:0 0}50%{rotate:1.6deg;translate:-2% 0}}',
      /* a wave is the arm, not the body: two quick swings out, then a rest */
      '@keyframes nxm-arm{0%,70%,100%{rotate:0deg}12%{rotate:-17deg}24%{rotate:4deg}37%{rotate:-15deg}50%{rotate:3deg}60%{rotate:-4deg}}',
      '@keyframes nxm-swing{0%,100%{rotate:-3deg}50%{rotate:3deg}}',
      '.nx-mascot.a-idle .nxm-body{animation:nxm-breathe 3.6s ease-in-out infinite;transform-origin:50% 100%}',
      '.nx-mascot[data-pose="ledge"].a-idle .nxm-body{animation:nxm-bob 3.8s ease-in-out infinite}',
      '.nx-mascot[data-pose="peek"].a-idle .nxm-body{animation:nxm-sway 4.4s ease-in-out infinite;transform-origin:0 100%}',
      '.nx-mascot[data-pose="wave"].a-wave .nxm-arm{animation:nxm-arm 2.8s ease-in-out infinite}',
      '.nx-mascot.a-swing .nxm-body{animation:nxm-swing 2.8s ease-in-out infinite;transform-origin:50% 0}',
      /* one-shots: anticipation, action, overshoot, settle */
      '@keyframes nxm-hop{0%{scale:1 1;translate:0 0}14%{scale:1.07 .9;translate:0 0}38%{scale:.94 1.08;translate:0 -14%}',
      '  56%{scale:1 1;translate:0 -17%}76%{scale:1.06 .92;translate:0 0}88%{scale:.98 1.03;translate:0 0}100%{scale:1 1;translate:0 0}}',
      '@keyframes nxm-hop-shadow{0%,14%,76%,100%{scale:1;opacity:1}56%{scale:.6;opacity:.45}}',
      '@keyframes nxm-duck{0%{translate:0 0;scale:1 1}30%{translate:0 38%;scale:1 1}62%{translate:0 0;scale:.96 1.06}80%{scale:1.02 .98}100%{translate:0 0;scale:1 1}}',
      '@keyframes nxm-nod{0%,100%{rotate:0deg;translate:0 0}30%{rotate:4deg;translate:0 2%}60%{rotate:-2deg;translate:0 0}}',
      '@keyframes nxm-pop{0%{scale:.55;opacity:0}60%{scale:1.07;opacity:1}100%{scale:1}}',
      '@keyframes nxm-wiggle{0%,100%{rotate:0deg}20%{rotate:-6deg}40%{rotate:5deg}60%{rotate:-3deg}80%{rotate:2deg}}',
      '.nx-mascot .nxm-stage{transform-origin:50% 100%}',
      '.nx-mascot[data-pose="hang"] .nxm-stage{transform-origin:50% 0}',
      '.nx-mascot.o-hop .nxm-stage{animation:nxm-hop .78s cubic-bezier(.3,.7,.4,1)}',
      '.nx-mascot.o-hop .nxm-shadow{animation:nxm-hop-shadow .78s cubic-bezier(.3,.7,.4,1)}',
      '.nx-mascot[data-pose="ledge"].o-hop .nxm-stage,.nx-mascot[data-pose="peek"].o-hop .nxm-stage{animation:nxm-duck .8s cubic-bezier(.3,.7,.4,1)}',
      '.nx-mascot.o-nod .nxm-lean{animation:nxm-nod .6s ease-in-out}',
      '.nx-mascot.o-pop .nxm-stage{animation:nxm-pop .5s cubic-bezier(.34,1.56,.64,1)}',
      '.nx-mascot.o-wiggle .nxm-stage{animation:nxm-wiggle .6s ease-in-out}',
      /* entrances */
      '@keyframes nxm-rise{from{translate:0 100%}to{translate:0 0}}',
      '@keyframes nxm-slide{from{translate:-70% 0}to{translate:0 0}}',
      '@keyframes nxm-drop{from{translate:0 -30%;rotate:-8deg;opacity:0}to{translate:0 0;rotate:0deg;opacity:1}}',
      '.nx-mascot[data-pose="ledge"].enter .nxm-stage{animation:nxm-rise .75s cubic-bezier(.3,1.25,.5,1) both}',
      '.nx-mascot[data-pose="peek"].enter .nxm-stage{animation:nxm-slide .75s cubic-bezier(.3,1.25,.5,1) both}',
      '.nx-mascot[data-pose="hang"].enter .nxm-stage{animation:nxm-drop .7s cubic-bezier(.3,1.3,.5,1) both}',
      '.nx-mascot[data-pose="wave"].enter .nxm-stage{animation:nxm-pop .55s cubic-bezier(.34,1.56,.64,1) both}',
      /* sleep: the eyes held as the closed line a blink passes through, a slow
         breath with the head settling, and Z's drifting up off the cap.
         .awake opens the eyes and lets the Z's fade. */
      '.nx-mascot.a-sleep .nxm-eye{scale:1.06 .08;transition:translate .22s cubic-bezier(.3,.7,.4,1),scale .3s ease}',
      '.nx-mascot.a-sleep.awake .nxm-eye{scale:1 1}',
      '@keyframes nxm-snooze{0%,100%{translate:0 0;rotate:0deg;scale:1 1}50%{translate:0 1.6%;rotate:-1.4deg;scale:1.012 .99}}',
      '.nx-mascot.a-sleep .nxm-body{animation:nxm-snooze 4.6s ease-in-out infinite;transform-origin:50% 100%}',
      '.nx-mascot.a-sleep.awake .nxm-body{animation-play-state:paused}',
      /* the box sits off the cap's top right corner; the Z's rise out of it */
      '.nx-mascot .nxm-zzz{position:absolute;left:74%;top:-34%;width:44%;height:44%;pointer-events:none;',
      '  container-type:size;font:800 1em/1 "Space Grotesk",system-ui,sans-serif;color:rgba(var(--ink,255,255,255),.82);',
      '  transition:opacity .3s ease}',
      '.nx-mascot.a-sleep.awake .nxm-zzz{opacity:0}',
      '.nx-mascot .nxm-z{position:absolute;left:0;bottom:0;font-size:30cqw;opacity:0;animation:nxm-z 3.6s ease-in-out infinite}',
      '.nx-mascot .nxm-z1{animation-delay:1.2s;font-size:38cqw}',
      '.nx-mascot .nxm-z2{animation-delay:2.4s;font-size:48cqw}',
      '@keyframes nxm-z{0%{translate:0 0;rotate:-8deg;opacity:0}15%{opacity:.95}70%{opacity:.7}',
      '  100%{translate:55cqw -95cqh;rotate:12deg;opacity:0}}',
      /* lift: stands (so it turns about the feet, not the fists) and presses
         the bar up, the bar tipping a touch as it goes */
      '.nx-mascot .nxm-bar{position:absolute;left:-24%;top:-5.3%;width:148%;height:auto;display:block;pointer-events:none;',
      '  filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))}',
      '.nx-mascot.a-lift .nxm-lean,.nx-mascot.a-lift .nxm-stage,.nx-mascot.a-lift .nxm-body{transform-origin:50% 100%}',
      '.nx-mascot.a-lift .nxm-shadow{display:block;position:absolute;left:14%;right:14%;bottom:-3%;height:7%;',
      '  border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.42),rgba(0,0,0,0))}',
      '@keyframes nxm-press{0%,18%,100%{translate:0 0;scale:1 1}34%{translate:0 1.5%;scale:1.03 .96}',
      '  52%,70%{translate:0 -4%;scale:.99 1.02}84%{translate:0 0;scale:1.01 .99}}',
      '@keyframes nxm-tip{0%,18%,100%{rotate:0deg}52%{rotate:-2.4deg}70%{rotate:1.6deg}}',
      '.nx-mascot.a-lift .nxm-body{animation:nxm-press 2.6s cubic-bezier(.4,0,.3,1) infinite}',
      '.nx-mascot.a-lift .nxm-lean{animation:nxm-tip 2.6s ease-in-out infinite;transform-origin:50% 100%}',
      /* nothing moves when motion is unwanted, or while the tab is hidden */
      '.nx-mascot.paused,.nx-mascot.paused *{animation-play-state:paused!important}',
      '@media (prefers-reduced-motion:reduce){.nx-mascot,.nx-mascot *{animation:none!important;transition:none!important}',
      '  .nx-mascot{--nxm-ex:0px!important;--nxm-ey:0px!important;--nxm-lean:0deg!important}}',
    ].join('\n');
    (D.head || D.documentElement).appendChild(st);
  }

  function toList(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).filter(function (x) { return LOOPS.indexOf(x) >= 0; });
  }

  // ---- blinking and glancing: scheduled, not looped ----------------------
  // A metronome blink reads as mechanical. Real blinks come every two to six
  // seconds, and now and then twice in a row.
  function later(m, key, ms, fn) {
    clearTimeout(m[key]);
    m[key] = setTimeout(function () {
      if (!m.isConnected) return;
      if (D.hidden || reduce.matches) { later(m, key, 1500, fn); return; }
      fn();
    }, ms);
  }
  // A blink runs the eye from open to shut and back, so on a sleeping mascot
  // it would flash his eyes open. Neither blinks nor glances while asleep.
  function asleep(m) { return m.classList.contains('a-sleep') && !m.classList.contains('awake'); }
  function blinkOnce(m) {
    m.classList.remove('blinking'); void m.offsetWidth; m.classList.add('blinking');
    setTimeout(function () { m.classList.remove('blinking'); }, 170);
  }
  function scheduleBlink(m) {
    if (!m.classList.contains('a-blink')) return;
    later(m, '__nxmBlink', 2200 + Math.random() * 3800, function () {
      if (asleep(m)) { scheduleBlink(m); return; }
      blinkOnce(m);
      if (Math.random() < 0.22) setTimeout(function () { blinkOnce(m); }, 260);
      scheduleBlink(m);
    });
  }
  function scheduleLook(m) {
    if (!m.classList.contains('a-look')) return;
    later(m, '__nxmLook', 3500 + Math.random() * 4000, function () {
      if (asleep(m)) { scheduleLook(m); return; }
      if (!m.classList.contains('following') || !lastPt) {
        var dir = Math.random() < 0.5 ? -1 : 1;
        setEyes(m, dir * 0.8, (Math.random() - 0.5) * 0.4);
        setTimeout(function () { if (!m.classList.contains('following') || !lastPt) setEyes(m, 0, 0); }, 1100 + Math.random() * 700);
      }
      scheduleLook(m);
    });
  }

  // ---- pointer following ----------------------------------------------------
  // dx, dy in -1..1. The eyes move up to about a fifth of their own width; the
  // figure leans at most a couple of degrees.
  function setEyes(m, dx, dy) {
    var art = ART[m.getAttribute('data-pose')] || ART.wave;
    var wpx = m.getBoundingClientRect().width || 0;
    var eyeW = wpx * art.eyes[0][2] / 100;
    var flip = (m.getAttribute('data-pose') === 'peek' && m.getAttribute('data-side') === 'right') ? -1 : 1;
    m.style.setProperty('--nxm-ex', (dx * eyeW * 0.2 * flip).toFixed(2) + 'px');
    m.style.setProperty('--nxm-ey', (dy * eyeW * 0.16).toFixed(2) + 'px');
  }
  var followers = new Set();
  var lastPt = null, raf = 0;
  function aim() {
    raf = 0;
    if (!lastPt || D.hidden || reduce.matches) return;
    followers.forEach(function (m) {
      if (!m.isConnected) { followers.delete(m); return; }
      if (asleep(m)) return;
      var r = m.getBoundingClientRect();
      if (!r.width) return;
      var cx = r.left + r.width / 2, cy = r.top + r.height * 0.4;
      var dx = lastPt.x - cx, dy = lastPt.y - cy;
      var len = Math.max(1, Math.hypot(dx, dy));
      var k = Math.min(1, len / 260);
      setEyes(m, dx / len * k, dy / len * k);
      var pose = m.getAttribute('data-pose');
      var lean = pose === 'hang' ? -dx / len * k * 2.5 : dx / len * k * 2.2;
      if (pose === 'peek' || pose === 'ledge') lean *= 0.6;
      m.style.setProperty('--nxm-lean', lean.toFixed(2) + 'deg');
    });
  }
  function onMove(e) {
    lastPt = { x: e.clientX, y: e.clientY };
    if (!raf) raf = W.requestAnimationFrame(aim);
  }

  function apply(m, o) {
    var want = ALIAS[o.pose] || o.pose;
    var pose = ART[want] ? want : 'wave';
    var art = ART[pose];
    m.setAttribute('data-pose', pose);
    m.classList.toggle('hiding', !!o.hide);
    if (!o.hide) m.classList.remove('up');
    if (o.side === 'right') m.setAttribute('data-side', 'right'); else m.removeAttribute('data-side');
    if (o.size) m.style.setProperty('--nxm-size', typeof o.size === 'number' ? o.size + 'px' : o.size);
    while (m.firstChild) m.removeChild(m.firstChild);
    var loops = toList(o.anim);
    if (!o.anim) loops = pose === 'hang' ? ['swing', 'blink'] : pose === 'wave' ? ['wave', 'idle', 'blink'] : ['idle', 'blink', 'look'];
    build(m, art, pose, loops);
    LOOPS.forEach(function (l) { m.classList.remove('a-' + l); });
    m.classList.remove('awake');
    loops.forEach(function (l) { m.classList.add('a-' + l); });
    if (o.follow) { m.classList.add('following'); followers.add(m); } else { m.classList.remove('following'); followers.delete(m); }
    m.style.setProperty('--nxm-ex', '0px'); m.style.setProperty('--nxm-ey', '0px'); m.style.setProperty('--nxm-lean', '0deg');
    m.__nxm = { pose: o.pose, side: o.side, size: o.size, anim: o.anim, follow: !!o.follow, label: o.label, hide: !!o.hide };
    scheduleBlink(m);
    scheduleLook(m);
  }

  function create(opts) {
    ensureStyle();
    var o = opts || {};
    var m = D.createElement('span');
    m.className = 'nx-mascot' + (o.className ? ' ' + o.className : '');
    if (o.label) { m.setAttribute('role', 'img'); m.setAttribute('aria-label', o.label); }
    else m.setAttribute('aria-hidden', 'true');
    apply(m, o);
    // A hiding mascot is already where it belongs; rising in would give it away.
    if (o.enter !== false && !o.hide) {
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
    if (!m || ONESHOTS.indexOf(name) < 0 || reduce.matches) return;
    // One at a time: a hop restarted mid-air snaps back to the ground.
    if (m.__nxmBusy) return;
    var c = 'o-' + name;
    m.classList.remove(c);
    void m.offsetWidth;
    m.classList.add(c);
    m.__nxmBusy = true;
    clearTimeout(m.__nxmT);
    m.__nxmT = setTimeout(function () { m.classList.remove(c); m.__nxmBusy = false; }, 850);
  }

  // A hiding mascot (hide:true) rests below its edge; peek(m, true) brings it
  // up and it stays up until peek(m, false). The caller decides what "hover"
  // means — usually the card around it.
  function peek(m, up) {
    if (!m || !m.classList.contains('hiding')) return;
    m.classList.toggle('up', !!up);
  }

  // A sleeping mascot (anim 'sleep') opens his eyes while wake(m, true) holds,
  // and nods back off on wake(m, false). Again the caller decides what wakes
  // him — usually hovering the card he is asleep on.
  function wake(m, on) {
    if (!m || !m.classList.contains('a-sleep')) return;
    m.classList.toggle('awake', !!on);
    if (!on) { m.style.setProperty('--nxm-ex', '0px'); m.style.setProperty('--nxm-ey', '0px'); m.style.setProperty('--nxm-lean', '0deg'); }
  }

  // [data-mascot] placeholders, now and later.
  function upgradeOne(n) {
    if (!n || n.__nxmDone) return;
    n.__nxmDone = true;
    ensureStyle();
    var o = {
      pose: n.getAttribute('data-mascot') || 'wave',
      size: n.getAttribute('data-mascot-size') ? Number(n.getAttribute('data-mascot-size')) : null,
      anim: n.getAttribute('data-mascot-anim'),
      side: n.getAttribute('data-mascot-side'),
      follow: n.hasAttribute('data-mascot-follow'),
      label: n.getAttribute('data-mascot-label'),
      hide: n.hasAttribute('data-mascot-hide'),
    };
    n.classList.add('nx-mascot');
    if (o.label) { n.setAttribute('role', 'img'); n.setAttribute('aria-label', o.label); }
    else n.setAttribute('aria-hidden', 'true');
    apply(n, o);
    if (o.hide) return;
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

  W.NumaxMascot = { create: create, mount: mount, pose: pose, play: play, peek: peek, wake: wake, upgrade: upgrade,
    poses: POSES.slice(), loops: LOOPS.slice(), oneshots: ONESHOTS.slice() };
})();
