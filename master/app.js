<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Numax — Your Nuvio companion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500;1,9..144,600&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<script src="https://accounts.google.com/gsi/client" async></script>
<style>
  :root{
    /* palette drawn from the toucan */
    --ink:#0b0d13; --ink-2:#0f121a; --card:#151925; --card-2:#1c2130; --line:#262c3a;
    --paper:#f3eee2; --paper-dim:#b7b3a8; --paper-mute:#807d76;
    --amber:#ff7a1a; --marigold:#ffc42e; --claret:#d8503a;
    --teal:#35c6a8; --blue:#5b9dff; --purple:#a98bff; --green:#63d68f;
    --serif:'Fraunces',Georgia,serif; --sans:'Space Grotesk',system-ui,sans-serif; --mono:'Space Mono',ui-monospace,monospace;
    --r:14px; --r-sm:10px;
  }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; }
  body{
    font-family:var(--sans); color:var(--paper); background:var(--ink);
    /* very subtle texture — not a loud gradient */
    background-image:
      radial-gradient(1200px 700px at 80% -10%, rgba(43,52,74,.35), transparent 60%),
      radial-gradient(900px 600px at -10% 110%, rgba(30,26,20,.4), transparent 55%);
    background-attachment:fixed;
    -webkit-font-smoothing:antialiased; font-size:15px; line-height:1.5;
  }
  a{ color:inherit; }
  h1,h2,h3,h4{ margin:0; font-family:var(--serif); font-weight:600; letter-spacing:-.01em; }
  .eyebrow{ font-family:var(--mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:var(--amber); }
  .mono{ font-family:var(--mono); }
  button{ font-family:var(--sans); cursor:pointer; }
  input,select{ font-family:var(--sans); }
  ::selection{ background:var(--amber); color:#1a1206; }
  :focus-visible{ outline:2px solid var(--marigold); outline-offset:2px; border-radius:6px; }

  /* ---------------- buttons / fields ---------------- */
  .btn{ display:inline-flex; align-items:center; gap:9px; justify-content:center; border:none; border-radius:var(--r-sm);
        padding:11px 18px; font-size:14px; font-weight:600; color:var(--paper); background:var(--card-2); transition:.15s; }
  .btn:hover{ background:#242a3a; }
  .btn.primary{ background:var(--amber); color:#1a1206; }
  .btn.primary:hover{ background:#ff8c38; }
  .btn.primary:disabled{ background:#3a2f22; color:#8a7d6a; cursor:not-allowed; }
  .btn.ghost{ background:transparent; border:1px solid var(--line); color:var(--paper); }
  .btn.ghost:hover{ background:var(--card); }
  .btn.ghost.sm{ padding:6px 11px; font-size:12.5px; border-radius:8px; }
  .linkbtn{ background:none; border:none; color:var(--amber); font-size:12.5px; font-weight:600; padding:2px 0; }
  .linkbtn:hover{ text-decoration:underline; }
  .linkbtn:disabled{ color:var(--paper-mute); cursor:not-allowed; text-decoration:none; }
  label.fld{ display:block; margin:0 0 10px; }
  label.fld span{ display:block; font-size:12px; color:var(--paper-dim); margin-bottom:5px; }
  input[type=text],input[type=email],input[type=password],textarea,select{
    width:100%; background:var(--ink-2); color:var(--paper); border:1px solid var(--line);
    border-radius:9px; padding:10px 12px; font-size:14px; }
  textarea{ resize:vertical; min-height:76px; font-family:var(--mono); font-size:12.5px; }
  input:focus,select:focus,textarea:focus{ border-color:var(--amber); outline:none; }
  .status{ font-size:12.5px; color:var(--paper-mute); min-height:16px; }
  .status.ok{ color:var(--green); } .status.err{ color:var(--claret); }
  .empty{ color:var(--paper-mute); font-style:italic; font-size:13px; margin:6px 0; }

  /* ---------------- google gate ---------------- */
  .gate{ position:fixed; inset:0; z-index:50; display:grid; grid-template-columns:1.05fr .95fr; background:var(--ink);
         background-image:radial-gradient(900px 600px at 78% 30%, rgba(43,52,74,.5), transparent 60%); }
  .gate.hide{ display:none; }
  .gate-hero{ position:relative; display:flex; align-items:center; justify-content:center; border-right:1px solid var(--line); overflow:hidden; }
  .gate-hero .glow{ position:absolute; width:520px; height:520px; border-radius:50%;
        background:radial-gradient(circle, rgba(255,122,26,.18), transparent 62%); filter:blur(6px); }
  .hero-bird{ position:relative; width:340px; z-index:1; transform-origin:60% 80%; animation:settle 1s cubic-bezier(.2,1,.3,1) both; }
  .hero-bird .inner{ transform-origin:60% 80%; }
  @keyframes settle{ from{ transform:translateY(-14px) rotate(-3deg); opacity:0; } to{ transform:none; opacity:1; } }
  .gate-panel{ display:flex; flex-direction:column; justify-content:center; padding:0 8% 0 7%; max-width:560px; }
  .gate-panel .brand{ display:flex; align-items:center; gap:10px; margin-bottom:34px; }
  .gate-panel .display{ font-family:var(--serif); font-size:clamp(30px,3.6vw,46px); line-height:1.05; font-weight:600; margin-top:14px; }
  .gate-panel .display em{ font-style:italic; color:var(--marigold); }
  .gate-panel .lede{ color:var(--paper-dim); font-size:16px; margin:18px 0 0; max-width:44ch; }
  .gate-panel .tiny{ color:var(--paper-mute); font-size:12.5px; margin-top:16px; max-width:46ch; }
  .btn-google{ background:var(--paper); color:#1c1c1c; margin-top:28px; align-self:flex-start; padding:12px 20px; }
  .btn-google:hover{ background:#fff; }

  /* brand mark */
  .brand b{ font-family:var(--serif); font-size:21px; font-weight:600; letter-spacing:-.02em; }
  .brand .dot{ color:var(--amber); }
  .markhead{ width:26px; height:26px; flex:none; }

  /* ---------------- app shell ---------------- */
  .app{ display:none; min-height:100vh; }
  .app.on{ display:block; }
  .topbar{ position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between;
           padding:14px 30px; border-bottom:1px solid var(--line);
           background:rgba(11,13,19,.72); backdrop-filter:blur(14px) saturate(1.3); -webkit-backdrop-filter:blur(14px) saturate(1.3); }
  .topbar .brand{ display:flex; align-items:center; gap:9px; }
  .who{ display:flex; align-items:center; gap:14px; font-size:13px; color:var(--paper-dim); }
  .who .gmail{ font-family:var(--mono); font-size:12px; }
  #drivePill{ display:inline-flex; align-items:center; gap:7px; }
  #drivePill.ok{ color:var(--green); } #drivePill.fail{ color:var(--claret); }

  .wrap{ max-width:1320px; margin:0 auto; padding:30px; }
  .pane-grid{ display:grid; grid-template-columns:minmax(400px,460px) 1fr; gap:30px; align-items:start; }

  .card{ background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:22px; margin-bottom:22px; }
  .card > .card-h{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:16px; }
  .card-h h2{ font-size:19px; }
  .card-h .count{ font-family:var(--mono); font-size:12px; color:var(--paper-mute); }
  .card .sub{ color:var(--paper-dim); font-size:13px; margin:-8px 0 16px; }
  .divider{ height:1px; background:var(--line); margin:18px 0; border:0; }

  /* accounts */
  #accounts{ display:flex; flex-direction:column; gap:9px; margin-bottom:4px; }
  .acct{ display:flex; align-items:center; gap:10px; background:var(--ink-2); border:1px solid var(--line); border-radius:var(--r-sm); padding:10px 12px; }
  .abody{ flex:1; min-width:0; }
  .aname{ font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .amail{ font-family:var(--mono); font-size:11px; color:var(--paper-mute); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .link-form{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .link-form .full{ grid-column:1 / -1; }
  .paste-toggle{ margin-top:12px; }
  #paste-wrap{ display:none; margin-top:12px; }
  #paste-wrap.open{ display:block; }

  /* profile chips */
  .chips{ display:flex; flex-wrap:wrap; gap:12px; }
  .pchip{ background:none; border:none; padding:4px; display:flex; flex-direction:column; align-items:center; gap:7px; width:82px; }
  .pchip .ring{ position:relative; width:60px; height:60px; border-radius:50%; display:grid; place-items:center;
                border:2px solid transparent; transition:.15s; }
  .pchip:hover .ring{ border-color:var(--line); }
  .pchip.on .ring{ border-color:var(--amber); }
  .pchip .check{ position:absolute; right:-2px; bottom:-2px; width:20px; height:20px; border-radius:50%; background:var(--amber);
                 color:#1a1206; font-size:12px; font-weight:700; display:none; place-items:center; border:2px solid var(--card); }
  .pchip.on .check{ display:grid; }
  .pchip.multi .check{ background:var(--blue); }
  .pchip .lbl{ font-size:12px; color:var(--paper-dim); max-width:82px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; }
  .pchip.on .lbl{ color:var(--paper); }
  .av{ position:relative; border-radius:50%; display:inline-grid; place-items:center; color:#fff; font-family:var(--sans); font-weight:600; overflow:hidden; }
  .av img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }

  /* category rows */
  .cat{ border:1px solid var(--line); border-radius:var(--r-sm); padding:14px; margin-bottom:12px; background:var(--ink-2); }
  .cat-top{ display:flex; align-items:center; gap:12px; }
  .cat-top .swatch{ width:9px; height:9px; border-radius:50%; flex:none; }
  .cat-top .cname{ font-weight:600; font-size:14.5px; flex:1; }
  .cat-top .cnt{ font-family:var(--mono); font-size:11.5px; color:var(--paper-mute); }
  .switch{ position:relative; width:42px; height:24px; flex:none; }
  .switch input{ position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .switch .track{ position:absolute; inset:0; background:#333a4c; border-radius:999px; transition:.18s; pointer-events:none; }
  .switch .knob{ position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:.18s; pointer-events:none; }
  .switch input:checked ~ .track{ background:var(--amber); }
  .switch input:checked ~ .knob{ transform:translateX(18px); }
  .cat-ctl{ display:flex; align-items:center; gap:12px; margin-top:12px; flex-wrap:wrap; }
  .cat-ctl select{ width:auto; padding:6px 10px; font-size:12.5px; }
  .cat-ctl .mode-lbl{ font-size:12px; color:var(--paper-mute); }
  .note{ display:none; margin-top:10px; font-size:12px; color:var(--claret); }
  .note.show{ display:block; }
  .items{ display:none; margin-top:12px; border-top:1px solid var(--line); padding-top:12px; max-height:280px; overflow:auto; }
  .items.open{ display:block; }
  .allrow{ display:flex; gap:16px; margin-bottom:8px; }
  .item{ display:flex; align-items:center; gap:10px; padding:7px 2px; cursor:pointer; }
  .item input{ width:16px; height:16px; accent-color:var(--amber); flex:none; }
  .it-body{ flex:1; min-width:0; }
  .it-name{ font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .it-sub{ font-family:var(--mono); font-size:11px; color:var(--paper-mute); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .it-tag{ font-family:var(--mono); font-size:10px; text-transform:uppercase; color:var(--paper-mute); border:1px solid var(--line); border-radius:4px; padding:2px 5px; }

  /* targets */
  #targets{ display:flex; flex-wrap:wrap; gap:12px; }
  .chipacc{ width:100%; font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--paper-mute); margin-top:6px; }

  /* actions / reports */
  .actionbar{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  #confirm-wrap{ display:none; margin:14px 0; padding:12px 14px; border:1px solid var(--claret); border-radius:var(--r-sm); background:rgba(216,80,58,.08); }
  #confirm-wrap label{ display:flex; gap:10px; align-items:flex-start; font-size:13px; color:#f0b3a6; }
  #confirm-wrap input{ margin-top:2px; accent-color:var(--claret); }
  #results{ margin-top:16px; display:flex; flex-direction:column; gap:12px; }
  .report{ border:1px solid var(--line); border-radius:var(--r-sm); padding:14px; background:var(--ink-2); }
  .report h3{ font-family:var(--sans); font-size:14px; font-weight:600; display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .badge{ font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; padding:2px 7px; border-radius:5px; }
  .badge.chg{ background:rgba(255,122,26,.16); color:var(--amber); }
  .badge.no{ background:#22272f; color:var(--paper-mute); }
  .sumline{ display:flex; align-items:center; gap:8px; font-size:12.5px; margin-top:6px; flex-wrap:wrap; }
  .sumline .k{ color:var(--paper-dim); min-width:88px; }
  .tag-a,.tag-u,.tag-r,.tag-k,.tag-h{ font-family:var(--mono); font-size:11px; padding:1px 6px; border-radius:4px; }
  .tag-a{ color:var(--green); background:rgba(99,214,143,.12); }
  .tag-u{ color:var(--marigold); background:rgba(255,196,46,.12); }
  .tag-r{ color:var(--claret); background:rgba(216,80,58,.14); }
  .tag-k{ color:var(--paper-dim); background:#22272f; }
  .tag-h{ color:var(--blue); background:rgba(91,157,255,.12); }

  /* preview pane */
  .pv-head{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:16px; }
  .pv-head .selwrap{ display:flex; align-items:center; gap:9px; flex:1; min-width:220px; }
  .pv-head select{ flex:1; }
  #pv-tabs{ display:flex; gap:4px; background:var(--ink-2); padding:4px; border-radius:10px; }
  #pv-tabs button{ border:none; background:none; color:var(--paper-dim); font-size:13px; font-weight:600; padding:7px 14px; border-radius:7px; }
  #pv-tabs button.on{ background:var(--card-2); color:var(--paper); }
  #overview-toggle{ display:flex; gap:4px; margin-bottom:14px; }
  #overview-toggle button{ border:1px solid var(--line); background:none; color:var(--paper-dim); font-size:12.5px; font-weight:600; padding:6px 14px; border-radius:8px; }
  #overview-toggle button.on{ background:var(--amber); color:#1a1206; border-color:var(--amber); }
  .pv-note{ font-size:13px; color:var(--paper-dim); margin:0 0 14px; }
  .pv-note b{ color:var(--paper); }
  .pv-blank{ color:var(--paper-mute); font-style:italic; padding:40px 0; text-align:center; }
  .pv-cols{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .pv-card{ border:1px solid var(--line); border-radius:var(--r-sm); background:var(--ink-2); overflow:hidden; }
  .pv-card .h{ display:flex; align-items:center; gap:8px; padding:11px 14px; border-bottom:1px solid var(--line); font-family:var(--sans); font-weight:600; font-size:13.5px; }
  .pv-card .h .dotc{ width:8px; height:8px; border-radius:50%; }
  .pv-card .h .n{ margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--paper-mute); }
  .pv-list{ padding:6px 10px; max-height:240px; overflow:auto; }
  .pv-item{ display:flex; align-items:center; gap:8px; padding:6px 4px; font-size:13px; }
  .pv-item .mk{ font-family:var(--mono); width:12px; text-align:center; color:var(--paper-mute); }
  .pv-item.added .mk{ color:var(--green); } .pv-item.added .txt{ color:var(--green); }
  .pv-item.removed .mk{ color:var(--claret); } .pv-item.removed .txt{ color:var(--claret); text-decoration:line-through; opacity:.8; }
  .pv-item .dot{ width:6px; height:6px; border-radius:50%; background:var(--paper-mute); flex:none; }
  .pv-item .dot.off{ background:transparent; border:1px solid var(--paper-mute); }
  .pv-item .txt{ flex:none; }
  .pv-item .sub{ font-family:var(--mono); font-size:11px; color:var(--paper-mute); margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pv-empty{ color:var(--paper-mute); font-style:italic; font-size:12.5px; padding:10px 4px; }

  /* watched / progress cards */
  .wcard{ border:1px solid var(--line); border-radius:var(--r-sm); background:var(--ink-2); padding:6px 12px; }
  .wrow{ display:flex; align-items:center; gap:12px; padding:10px 2px; border-top:1px solid var(--line); font-size:13px; }
  .wrow:first-child{ border-top:none; }
  .wbody{ flex:1; min-width:0; }
  .wtitle{ font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .wsub{ font-family:var(--mono); font-size:11px; color:var(--paper-mute); }
  .wtype{ font-family:var(--mono); font-size:10px; text-transform:uppercase; color:var(--paper-mute); border:1px solid var(--line); border-radius:4px; padding:2px 6px; }
  .prog{ display:flex; align-items:center; gap:8px; width:150px; flex:none; }
  .prog .bar{ flex:1; height:5px; background:#2a3040; border-radius:3px; overflow:hidden; }
  .prog .bar span{ display:block; height:100%; background:var(--amber); }
  .prog .pct{ font-family:var(--mono); font-size:11px; color:var(--paper-dim); width:34px; text-align:right; }

  /* ---------------- settings modal ---------------- */
  #settings-modal{ position:fixed; inset:0; z-index:40; display:none; align-items:center; justify-content:center;
                   background:rgba(6,7,11,.6); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); padding:24px; }
  #settings-modal.open{ display:flex; }
  .modal-card{ width:min(640px,100%); max-height:86vh; display:flex; flex-direction:column; background:var(--card); border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
  .modal-h{ display:flex; align-items:center; justify-content:space-between; padding:18px 22px; border-bottom:1px solid var(--line); }
  .modal-h h3{ font-size:18px; } .modal-h .sub{ font-size:12px; color:var(--paper-mute); margin-top:2px; }
  .modal-x{ background:none; border:none; color:var(--paper-dim); font-size:22px; line-height:1; }
  #settings-platforms{ display:flex; gap:4px; padding:12px 22px 0; }
  #settings-platforms button{ border:1px solid var(--line); background:none; color:var(--paper-dim); font-size:12.5px; font-weight:600; padding:6px 14px; border-radius:8px; }
  #settings-platforms button.on{ background:var(--card-2); color:var(--paper); border-color:var(--card-2); }
  #settings-tree{ padding:14px 22px; overflow:auto; flex:1; }
  .sgroup{ border:1px solid var(--line); border-radius:var(--r-sm); margin-bottom:8px; overflow:hidden; }
  .sgroup-h{ display:flex; align-items:center; gap:10px; padding:11px 13px; cursor:pointer; background:var(--ink-2); }
  .sgroup-h input{ width:16px; height:16px; accent-color:var(--amber); }
  .sgroup-h .chev{ color:var(--paper-mute); transition:.15s; display:inline-block; }
  .sgroup.open .sgroup-h .chev{ transform:rotate(90deg); }
  .sgroup-h .gname{ font-weight:600; font-size:13.5px; flex:1; }
  .sgroup-h .gcount{ font-family:var(--mono); font-size:11px; color:var(--paper-mute); }
  .sgroup-body{ display:none; padding:4px 13px 10px; }
  .sgroup.open .sgroup-body{ display:block; }
  .sleaf{ display:flex; align-items:center; gap:10px; padding:6px 2px; font-size:13px; }
  .sleaf input{ width:15px; height:15px; accent-color:var(--amber); }
  .sleaf.locked{ opacity:.72; }
  .sleaf .lname{ flex:1; }
  .sleaf .lval{ font-family:var(--mono); font-size:11px; color:var(--paper-dim); }
  .ltag{ font-family:var(--mono); font-size:10px; text-transform:uppercase; padding:2px 6px; border-radius:4px; }
  .ltag.secret{ color:var(--claret); background:rgba(216,80,58,.12); }
  .ltag.account{ color:var(--blue); background:rgba(91,157,255,.12); }
  .ltag.personal{ color:var(--marigold); background:rgba(255,196,46,.12); }
  .modal-f{ display:flex; align-items:center; justify-content:space-between; padding:16px 22px; border-top:1px solid var(--line); }
  #settings-count{ font-family:var(--mono); font-size:12px; color:var(--paper-dim); }

  /* toucan blink lid */
  #t-lid{ transform-box:fill-box; transform-origin:center; transform:scaleY(0); }
  #t-lid.blink{ animation:blink .22s ease; }
  @keyframes blink{ 0%,100%{ transform:scaleY(0); } 45%{ transform:scaleY(1); } }

  /* responsive: collapse to one column on laptops narrower than the two-pane comfortably fits */
  @media (max-width:1080px){
    .pane-grid{ grid-template-columns:1fr; }
    .gate{ grid-template-columns:1fr; }
    .gate-hero{ display:none; }
    .gate-panel{ max-width:none; padding:0 8%; }
  }
  @media (max-width:640px){
    .wrap{ padding:18px; } .pv-cols{ grid-template-columns:1fr; } .link-form{ grid-template-columns:1fr; }
  }
  @media (prefers-reduced-motion:reduce){
    .hero-bird{ animation:none; } #t-lid.blink{ animation:none; }
  }
</style>
</head>
<body>

<!-- ============ GOOGLE FRONT DOOR ============ -->
<div class="gate" id="gate">
  <div class="gate-hero">
    <div class="glow"></div>
    <div class="hero-bird"><div class="inner" id="heroInner">
  <svg viewBox="0 0 260 280" width="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="beak" x1="0" y1="0" x2="1" y2="0.25">
        <stop offset="0" stop-color="#ff6a00"/>
        <stop offset="0.35" stop-color="#ff9e12"/>
        <stop offset="0.6" stop-color="#ffb020"/>
        <stop offset="0.82" stop-color="#ff7a10"/>
        <stop offset="1" stop-color="#ff6a00"/>
      </linearGradient>
      <linearGradient id="chest" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f6f0e2"/>
        <stop offset="0.4" stop-color="#fbe27a"/>
        <stop offset="0.72" stop-color="#ffc42e"/>
        <stop offset="1" stop-color="#f0a80e"/>
      </linearGradient>
      <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#20222b"/>
        <stop offset="0.5" stop-color="#0d0e13"/>
        <stop offset="1" stop-color="#050507"/>
      </linearGradient>
      <linearGradient id="wingg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2a2c35"/>
        <stop offset="0.6" stop-color="#121319"/>
        <stop offset="1" stop-color="#060608"/>
      </linearGradient>
    </defs>

    <!-- branch (perch) -->
    <g id="t-branch">
      <path d="M20 250 Q120 232 244 258 L244 268 Q120 244 20 262 Z" fill="#6b4f38"/>
      <path d="M20 250 Q120 232 244 258" fill="none" stroke="#836348" stroke-width="2"/>
    </g>

    <!-- tail -->
    <path d="M96 168 Q70 210 74 262 Q86 250 104 224 Q112 196 108 172 Z" fill="url(#body)"/>
    <path d="M138 214 q4 12 -2 20" stroke="#c6402e" stroke-width="7" stroke-linecap="round" fill="none"/>

    <!-- feet -->
    <g stroke="#4a4d55" stroke-width="6" stroke-linecap="round" fill="none">
      <path d="M118 236 l-6 18 M118 236 l4 20 M118 236 l12 16"/>
      <path d="M150 236 l-4 20 M150 236 l6 18 M150 236 l14 14"/>
    </g>

    <!-- body -->
    <path d="M96 118 Q78 150 90 200 Q108 244 152 240 Q188 236 190 188 Q190 150 172 122 Z" fill="url(#body)"/>

    <!-- chest -->
    <path d="M138 108 Q112 120 108 172 Q106 214 140 226 Q176 224 180 176 Q182 132 160 110 Q150 104 138 108 Z" fill="url(#chest)"/>
    <path d="M138 108 Q122 116 116 150 Q140 132 160 138 Q158 120 148 110 Q143 105 138 108 Z" fill="#f6f0e2" opacity=".95"/>

    <!-- wing (animatable) -->
    <g id="t-wing">
      <path d="M104 116 Q80 138 84 186 Q92 226 130 232 Q120 200 118 168 Q118 138 128 118 Z" fill="url(#wingg)"/>
      <g stroke="#000" stroke-opacity=".35" stroke-width="1.4" fill="none">
        <path d="M100 140 Q100 172 116 208"/>
        <path d="M92 158 Q94 186 110 216"/>
      </g>
    </g>

    <!-- head -->
    <path d="M118 78 Q112 108 142 118 Q176 122 182 96 Q186 72 168 60 Q140 50 124 62 Q118 68 118 78 Z" fill="url(#body)"/>

    <!-- eye -->
    <ellipse cx="150" cy="80" rx="12.5" ry="12" fill="#ff8a00" opacity=".55"/>
    <circle cx="150" cy="80" r="8.5" fill="#0a0a0a"/>
    <circle cx="150" cy="80" r="8.5" fill="none" stroke="#ff8a00" stroke-width="1.6"/>
    <circle cx="153" cy="77" r="2.6" fill="#fff"/>
    <rect id="t-lid" x="139.5" y="72" width="21" height="16" rx="8" fill="#141014"/>

    <!-- beak -->
    <path d="M166 66 Q214 60 250 92 Q244 104 224 108 Q210 96 178 96 Q168 84 166 66 Z" fill="url(#beak)"/>
    <path d="M172 98 Q206 96 224 108 Q206 116 184 112 Q174 108 172 98 Z" fill="#ff7a10"/>
    <path d="M250 92 Q258 100 250 110 Q240 112 224 108 Q244 104 250 92 Z" fill="#171412"/>
    <path d="M166 66 Q210 62 246 90" stroke="#ffd27a" stroke-width="2" fill="none" opacity=".6"/>
    <path d="M175 96 Q205 94 223 105" stroke="#5a2c00" stroke-width="1.4" fill="none" opacity=".5"/>
  </svg>
    </div></div>
  </div>
  <div class="gate-panel">
    <div class="brand"><span class="markhead"><svg viewBox="0 0 32 32" width="26" height="26" xmlns="http://www.w3.org/2000/svg"><path d="M6 12 Q5 22 14 24 Q22 24 22 15 Q22 8 15 7 Q8 7 6 12 Z" fill="#12141b"/><path d="M18 9 Q29 8 31 15 Q29 18 24 18 Q20 14 18 9 Z" fill="#ff7a1a"/><path d="M31 15 Q32 17 30 19 Q27 18 24 18 Q29 17 31 15 Z" fill="#171412"/><circle cx="15" cy="13" r="2.4" fill="#0a0a0a"/><circle cx="15" cy="13" r="2.4" fill="none" stroke="#ff9e12" stroke-width="1"/></svg></span><b>Numax<span class="dot">.</span></b></div>
    <span class="eyebrow">Your Nuvio companion</span>
    <div class="display">Set one profile up right,<br>then hand it to <em>everyone.</em></div>
    <p class="lede">Sign in once with Google. Numax remembers the Nuvio accounts you link, so your setup is waiting on every device.</p>
    <button class="btn btn-google" id="btnGoogle" onclick="numaxSignIn()">
      <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"/></svg>
      Continue with Google
    </button>
    <p class="tiny">Google signs you in to Numax and (optionally) backs up your list of linked accounts to your Drive. Your Nuvio data itself is read straight from Nuvio once you link an account inside.</p>
  </div>
</div>

<!-- ============ APP ============ -->
<div class="app" id="app">
  <div class="topbar">
    <div class="brand"><span class="markhead"><svg viewBox="0 0 32 32" width="26" height="26" xmlns="http://www.w3.org/2000/svg"><path d="M6 12 Q5 22 14 24 Q22 24 22 15 Q22 8 15 7 Q8 7 6 12 Z" fill="#12141b"/><path d="M18 9 Q29 8 31 15 Q29 18 24 18 Q20 14 18 9 Z" fill="#ff7a1a"/><path d="M31 15 Q32 17 30 19 Q27 18 24 18 Q29 17 31 15 Z" fill="#171412"/><circle cx="15" cy="13" r="2.4" fill="#0a0a0a"/><circle cx="15" cy="13" r="2.4" fill="none" stroke="#ff9e12" stroke-width="1"/></svg></span><b>Numax<span class="dot">.</span></b></div>
    <div class="who">
      <span id="drivePill"></span>
      <span class="gmail" id="gmail"></span>
      <button class="btn ghost sm" id="btnBackupVault" onclick="backupVault()">Back up list</button>
      <button class="btn ghost sm" onclick="numaxSignOut()">Sign out</button>
    </div>
  </div>

  <div class="wrap">
    <div class="pane-grid">

      <!-- ---------- LEFT: config ---------- -->
      <div class="col-left">

        <!-- accounts -->
        <div class="card">
          <div class="card-h"><h2>Nuvio accounts</h2><span class="count"><span id="acct-count">0</span> linked</span></div>
          <p class="sub">Link each family member's Nuvio account. Sessions stay on this device.</p>
          <div id="accounts"></div>
          <hr class="divider">
          <div class="link-form">
            <label class="fld full"><span>Label (optional)</span><input type="text" id="link-name" placeholder="e.g. Mum's account" maxlength="40"></label>
            <label class="fld"><span>Nuvio email</span><input type="email" id="link-email" placeholder="name@email.com" autocomplete="off"></label>
            <label class="fld"><span>Password</span><input type="password" id="link-password" placeholder="••••••••" autocomplete="off"></label>
          </div>
          <div class="actionbar">
            <button class="btn primary" id="btn-link">Link account</button>
            <button class="linkbtn" id="paste-toggle-btn" type="button">Paste a session token instead</button>
          </div>
          <div id="paste-wrap">
            <label class="fld full" style="margin-top:12px;"><span>Session JSON (access_token + refresh_token)</span><textarea id="paste-json" placeholder='{"access_token":"...","refresh_token":"..."}'></textarea></label>
            <button class="btn ghost sm" id="btn-link-paste">Link from token</button>
          </div>
          <p class="status" id="link-status" style="margin-top:10px;"></p>
        </div>

        <!-- master -->
        <div class="card">
          <div class="card-h"><h2>Master profile</h2></div>
          <p class="sub">The profile everything else copies from.</p>
          <label class="fld"><span>Account</span><select id="master-account"></select></label>
          <div id="master-profiles" class="chips" style="margin-top:6px;"></div>
        </div>

        <!-- what to copy -->
        <div class="card">
          <div class="card-h"><h2>What to copy</h2></div>
          <p class="sub">Pick surfaces, choose exactly which items, and how they merge.</p>

          <!-- addons -->
          <div class="cat">
            <div class="cat-top">
              <span class="swatch" style="background:var(--blue)"></span>
              <span class="cname">Addons</span>
              <span class="cnt" id="cnt-addons">0</span>
              <label class="switch"><input type="checkbox" id="cat-addons"><span class="track"></span><span class="knob"></span></label>
            </div>
            <div class="cat-ctl">
              <span class="mode-lbl">Mode</span>
              <select id="mode-addons"><option value="merge">Merge (keep theirs, add master's)</option><option value="mirror">Mirror (make identical)</option></select>
              <button class="linkbtn" id="choose-addons" type="button" disabled>Choose items</button>
            </div>
            <div class="note" id="note-addons">Mirror with a subset will remove their other addons.</div>
            <div class="items" id="items-addons"></div>
          </div>

          <!-- plugins -->
          <div class="cat">
            <div class="cat-top">
              <span class="swatch" style="background:var(--purple)"></span>
              <span class="cname">Plugins</span>
              <span class="cnt" id="cnt-plugins">0</span>
              <label class="switch"><input type="checkbox" id="cat-plugins"><span class="track"></span><span class="knob"></span></label>
            </div>
            <div class="cat-ctl">
              <span class="mode-lbl">Mode</span>
              <select id="mode-plugins"><option value="merge">Merge (keep theirs, add master's)</option><option value="mirror">Mirror (make identical)</option></select>
              <button class="linkbtn" id="choose-plugins" type="button" disabled>Choose items</button>
            </div>
            <div class="note" id="note-plugins">Mirror with a subset will remove their other plugins.</div>
            <div class="items" id="items-plugins"></div>
          </div>

          <!-- collections -->
          <div class="cat">
            <div class="cat-top">
              <span class="swatch" style="background:var(--teal)"></span>
              <span class="cname">Collections</span>
              <span class="cnt" id="cnt-collections">0</span>
              <label class="switch"><input type="checkbox" id="cat-collections"><span class="track"></span><span class="knob"></span></label>
            </div>
            <div class="cat-ctl">
              <span class="mode-lbl">Mode</span>
              <select id="mode-collections"><option value="merge">Merge (keep theirs, add master's)</option><option value="mirror">Mirror (make identical)</option></select>
              <button class="linkbtn" id="choose-collections" type="button" disabled>Choose items</button>
            </div>
            <div class="note" id="note-collections">Mirror with a subset will remove their other collections.</div>
            <div class="items" id="items-collections"></div>
          </div>

          <!-- settings -->
          <div class="cat">
            <div class="cat-top">
              <span class="swatch" style="background:var(--amber)"></span>
              <span class="cname">Settings</span>
              <span class="cnt" id="cnt-settings">0 selected</span>
              <label class="switch"><input type="checkbox" id="cat-settings"><span class="track"></span><span class="knob"></span></label>
            </div>
            <div class="cat-ctl">
              <button class="linkbtn" id="choose-settings" type="button" disabled>Choose fields…</button>
              <span class="mode-lbl">API keys &amp; account fields are always held back.</span>
            </div>
          </div>
        </div>

        <!-- targets -->
        <div class="card">
          <div class="card-h"><h2>Apply to</h2></div>
          <p class="sub">Every other profile is ticked by default. Untick any you want to leave alone.</p>
          <div id="targets"></div>
        </div>

        <!-- actions -->
        <div class="card">
          <div class="actionbar">
            <button class="btn ghost" id="btn-preview">Preview changes</button>
            <button class="btn primary" id="btn-apply" disabled>Apply</button>
          </div>
          <div id="confirm-wrap"><label><input type="checkbox" id="confirm-removals"><span>Some profiles will have items <b>removed</b> (mirror mode). I've reviewed the preview and want to proceed.</span></label></div>
          <p class="status" id="global-status" style="margin-top:12px;"></p>
          <div id="results"></div>
        </div>

      </div>

      <!-- ---------- RIGHT: preview ---------- -->
      <div class="col-right">
        <div class="card" style="position:sticky; top:88px;">
          <div class="pv-head">
            <div class="selwrap">
              <span class="av" id="preview-av" style="width:26px;height:26px;font-size:11px;background:#5b3fa0;"></span>
              <select id="preview-profile"></select>
            </div>
            <div id="pv-tabs">
              <button data-tab="overview" class="on">Overview</button>
              <button data-tab="watched">Watched</button>
              <button data-tab="progress">In progress</button>
            </div>
          </div>
          <div id="overview-toggle">
            <button id="pv-current" class="on">Current</button>
            <button id="pv-after">After apply</button>
          </div>
          <div id="preview-body"></div>
          <div id="watched-body" style="display:none;"></div>
          <div id="progress-body" style="display:none;"></div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- ============ SETTINGS MODAL ============ -->
<div id="settings-modal">
  <div class="modal-card">
    <div class="modal-h">
      <div><h3>Choose settings to copy</h3><div class="sub" id="settings-sub"></div></div>
      <button class="modal-x" id="settings-close">×</button>
    </div>
    <div id="settings-platforms"></div>
    <div id="settings-tree"></div>
    <div class="modal-f">
      <div style="display:flex; gap:14px; align-items:center;">
        <button class="linkbtn" id="settings-selall" type="button">Select all shareable</button>
        <button class="linkbtn" id="settings-none" type="button">Clear</button>
        <span id="settings-count">0 selected</span>
      </div>
      <button class="btn primary" id="btn-settings-done">Done</button>
    </div>
  </div>
</div>

<!-- ============ GOOGLE + SHELL GLUE ============ -->
<script>
  const GOOGLE = {
    clientId: '841898218953-c5f3ide5lcsg8g2opn1ucrekvlq335rs.apps.googleusercontent.com',
    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
    backupName: 'numax-vault.json'
  };
  let googleToken = null, googleClient = null;

  function numaxSignIn(){
    if(!(window.google && google.accounts && google.accounts.oauth2)){
      // library blocked (offline/preview) — let the app open so linking still works
      revealApp('(offline — Google unavailable)'); return;
    }
    if(!googleClient){
      googleClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE.clientId, scope: GOOGLE.scope,
        callback: async (resp)=>{
          if(resp && resp.error){ console.error('[Numax] auth error:', resp.error); return; }
          googleToken = resp;
          let email = '';
          try{
            const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
              { headers:{ Authorization:'Bearer '+resp.access_token } }).then(r=>r.json());
            email = (who && who.email) || '';
          }catch(e){ console.warn('[Numax] userinfo failed:', e); }
          revealApp(email);
        }
      });
    }
    googleClient.requestAccessToken();
  }

  function revealApp(email){
    document.getElementById('gmail').textContent = email || '';
    document.getElementById('gate').classList.add('hide');
    document.getElementById('app').classList.add('on');
  }
  function numaxSignOut(){
    googleToken = null;
    document.getElementById('app').classList.remove('on');
    document.getElementById('gate').classList.remove('hide');
  }

  // Back up the linked-account list (labels/emails only — never tokens) to Drive.
  async function backupVault(){
    const pill = document.getElementById('drivePill');
    if(!googleToken){ pill.className='fail'; pill.textContent='Sign in with Google to back up'; setTimeout(()=>pill.textContent='',2600); return; }
    pill.className=''; pill.textContent='Backing up…';
    try{
      const raw = JSON.parse(localStorage.getItem('numax.accounts.v1') || '{}');
      const safe = Object.values(raw).map(r=>({ accountId:r.accountId, label:r.label, email:r.email, addedAt:r.addedAt }));
      const res = await saveToDrive({ savedAt:new Date().toISOString(), accounts:safe });
      if(res && res.id){ pill.className='ok'; pill.textContent='List backed up ✓'; }
      else { pill.className='fail'; pill.textContent='Backup failed'; }
    }catch(e){ console.error(e); pill.className='fail'; pill.textContent='Backup failed'; }
    setTimeout(()=>{ pill.textContent=''; pill.className=''; }, 2600);
  }
  async function saveToDrive(dataObj){
    const auth={ Authorization:'Bearer '+googleToken.access_token };
    const q=encodeURIComponent(`name='${GOOGLE.backupName}' and trashed=false`);
    const found=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`,{headers:auth}).then(r=>r.json()).catch(()=>({}));
    const id=found&&found.files&&found.files[0]&&found.files[0].id;
    const boundary='numax'+Date.now();
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`+JSON.stringify({name:GOOGLE.backupName,mimeType:'application/json'})+`\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`+JSON.stringify(dataObj,null,2)+`\r\n--${boundary}--`;
    const url=id?`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart`:`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    return fetch(url,{method:id?'PATCH':'POST',headers:{...auth,'Content-Type':`multipart/related; boundary=${boundary}`},body}).then(r=>r.json());
  }

  // paste-token disclosure + occasional toucan blink
  document.addEventListener('DOMContentLoaded', ()=>{
    const pt=document.getElementById('paste-toggle-btn'), pw=document.getElementById('paste-wrap');
    if(pt&&pw) pt.onclick=()=>pw.classList.toggle('open');
    const lid=document.getElementById('t-lid');
    if(lid && !matchMedia('(prefers-reduced-motion: reduce)').matches){
      setInterval(()=>{ lid.classList.remove('blink'); void lid.offsetWidth; lid.classList.add('blink'); }, 5600);
    }
  });
</script>

<!-- real Nuvio modules (unchanged) + app controller -->
<script src="store.js"></script>
<script src="api.js"></script>
<script src="meta.js"></script>
<script src="engine.js"></script>
<script src="app.js"></script>
</body>
</html>
