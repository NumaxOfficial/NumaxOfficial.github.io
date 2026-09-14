// ============================================================
// Numax Setup Wizard data layer (wizard.js)
//
// Read-only, exactly like market.js: this file owns NO application state and
// performs NO writes. It is the catalogue + copy the wizard renders — API-key
// providers and the settings toggles each one turns on, the debrid list, the
// two stream routes with their honest trade-offs, the adapted AIOStreams
// guide, and the metadata add-ons. Delete it and the rest of the app still
// works; only the Setup Wizard tab goes blank (app.js guards on
// window.NumaxWizard, same as it does for window.NumaxMarket).
//
// Every write the wizard performs goes through the paths that already exist:
//   - profiles          -> sync_push_profiles (pull, append, push; index-checked)
//   - API keys / debrid -> sync_push_provider_credentials (api.js)
//   - settings toggles  -> sync_push_profile_settings_blob(_guarded) (api.js)
//   - add-ons           -> engine.planTarget + api.applyPlan (same as Marketplace)
// There is no second write mechanism here and there must never be one.
//
// Field names below are NOT guessed. Provider ids and credential field names
// come from window.NUVIO_CREDENTIAL_FIELDS (nuvio-settings-schema.js, lifted
// verbatim from Nuvio's own bundle); the settings toggles come from
// window.NUVIO_SETTINGS. Both were re-checked against the live API 2026-09-03.
// ============================================================
(function () {
  'use strict';

  // ======================================================================
  // Step 2 — API keys
  // ======================================================================
  // `provider` / `field` address the provider_credentials table, which is the
  // ONLY place a key actually travels: mobile and desktop strip credential
  // leaves out of the settings blob on push and keep their own local values on
  // pull, so a key written inside a blob is silently ignored.
  //
  // `toggles` are the plain (non-secret) switches that make the key do
  // anything. They live in the settings blob and differ per platform —
  // Anime Skip is animeskip_settings on TV but player_settings on mobile and
  // desktop, which is exactly the kind of thing that looks like "it didn't
  // save" if you write the TV spelling everywhere.
  //
  // `shape` / `verify` drive the live tick next to each box. `shape` is what
  // counts as "fully typed in" and is the only thing that decides WHEN to ask;
  // `verify` names the provider's own check-this-key endpoint, which app.js
  // calls (the call is a write-shaped decision — it sends the key to that
  // provider — so it lives there, next to the other network code, not here).
  // All three were confirmed cross-origin-callable from a neutral origin on
  // 2026-09-11: each answers with Access-Control-Allow-Origin: *.
  //
  // `logo` is the provider's own mark, so a row is recognisable before it is
  // read. Every one below was fetched and looked at on 2026-09-13 (200, a real
  // image, square). They are drawn through app.js's wzLogo, which falls back to
  // `mono` if the host ever stops serving one — so a dead logo degrades to a
  // letter, never to a broken-image icon. TMDB's asset path carries a content
  // hash and will change when TMDB next redeploys; that is what the fallback is
  // for, and it is the only square "THE MOVIE DB" mark they publish.
  const KEYS = [
    {
      id: 'tmdb', name: 'TMDB', provider: 'tmdb', field: 'api_key',
      tag: 'Required', required: true,
      logo: 'https://www.themoviedb.org/assets/apple-touch-icon-57ed4b3b0450fd5e9a0c20f34e814b82adaa1085c79bdde2f00ca8787b63d2c4.png', mono: 'T',
      blurb: 'Better artwork, cast, episode titles and descriptions on every title.',
      shape: /^[A-Za-z0-9]{32}$/, verify: 'tmdb',
      getUrl: 'https://www.themoviedb.org/settings/api',
      getLabel: 'themoviedb.org',
      steps: [
        'Create a free account at themoviedb.org.',
        'Account Settings → API in the left sidebar.',
        'Request an API key, choose “Yes, this is for personal use”, fill the short form.',
        'Copy the <b>v3 API key</b> — not the v4 read access token.',
      ],
      placeholder: 'TMDB v3 API key',
      toggles: {
        tv: [['tmdb_settings', 'tmdb_enabled', true, 'boolean'], ['tmdb_settings', 'tmdb_modern_home_enabled', true, 'boolean']],
        mobile: [['tmdb_settings', 'tmdb_enabled', true, 'boolean']],
        desktop: [['tmdb_settings', 'tmdb_enabled', true, 'boolean']],
      },
    },
    {
      id: 'mdblist', name: 'MDBList', provider: 'mdblist', field: 'api_key',
      tag: 'Recommended',
      logo: 'https://mdblist.com/static/apple-touch-icon.png', mono: 'M',
      blurb: 'Ratings from IMDb, TMDB, Rotten Tomatoes, Metacritic, Trakt, Letterboxd and MyAnimeList.',
      shape: /^[A-Za-z0-9]{16,}$/, verify: 'mdblist',
      getUrl: 'https://mdblist.com/preferences/',
      getLabel: 'mdblist.com',
      steps: [
        'Register a free account at mdblist.com.',
        'Open your account preferences and generate a free API key.',
        'Copy the key string only — not the whole URL it sits in.',
      ],
      placeholder: 'MDBList API key',
      toggles: {
        tv: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
        mobile: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
        desktop: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
      },
    },
    {
      id: 'animeskip', name: 'Anime Skip', provider: 'animeskip', field: 'client_id',
      tag: 'Optional',
      logo: 'https://anime-skip.com/static/apple-touch-icon.png', mono: 'A',
      blurb: 'Skips anime intros, recaps and credits automatically.',
      shape: /^[A-Za-z0-9_-]{16,}$/, verify: 'animeskip',
      getUrl: 'https://anime-skip.com',
      getLabel: 'anime-skip.com',
      steps: [
        'Create an account at anime-skip.com and sign in.',
        'Open your profile → <b>API Clients</b> → <b>Add a New Client</b>.',
        'Name it “Nuvio” with a description of “Nuvio”, then Create.',
        'Copy the generated <b>Client ID</b> — a long string of letters and numbers.',
      ],
      placeholder: 'Anime Skip Client ID',
      toggles: {
        tv: [['animeskip_settings', 'animeskip_enabled', true, 'boolean']],
        mobile: [['player_settings', 'animeskip_enabled', true, 'boolean']],
        desktop: [['player_settings', 'animeskip_enabled', true, 'boolean']],
      },
    },
  ];

  // ======================================================================
  // Step 3 — debrid services
  // ======================================================================
  // Every entry is a service AIOStreams can use. `native: true` marks the two
  // Nuvio can also drive itself (Settings > Integrations > Connected Services)
  // — that list is exactly Torbox and Premiumize, and is why the second route
  // below can only offer those two.
  //
  // Prices are the community wiki's figures and move around; they're shown as
  // "roughly", never as a quote.
  //
  // `shape` / `verify` work exactly as they do on KEYS above, and only the two
  // native services carry them because they are the only two whose key Numax
  // ever writes. The two are NOT symmetrical, and this was measured on
  // 2026-09-13, not assumed:
  //   - Premiumize answers a plain cross-origin GET from any page
  //     (account/info?apikey=…), so its tick is a direct call from the browser.
  //   - TorBox runs an origin ALLOWLIST containing only https://torbox.app —
  //     every other origin gets "Disallowed CORS origin" on the preflight, so a
  //     page cannot check a TorBox key at all. Its tick therefore goes through
  //     the relay Worker, which already had to check TorBox keys for the
  //     "Do it all for me" path. If the deployed Worker predates that op the
  //     tick says "couldn't check" — it never shows a cross it cannot justify.
  const DEBRID = [
    {
      id: 'torbox', name: 'TorBox', tag: 'Recommended', native: true,
      logo: 'https://torbox.app/apple-touch-icon.png', mono: 'T',
      shape: /^[A-Za-z0-9-]{16,}$/, verify: 'torbox',
      price: 'from roughly $3/month',
      pros: ['No limit on how many connections or locations you use it from', 'Fast caching and a modern API', 'Usenet included on the top tier'],
      cons: ['Newer than the others, so occasional wobbles'],
      url: 'https://torbox.app/',
      keyUrl: 'https://torbox.app/settings',
    },
    {
      id: 'premiumize', name: 'Premiumize', tag: 'Also great', native: true,
      logo: 'https://www.premiumize.me/apple-touch-icon.png', mono: 'P',
      shape: /^[A-Za-z0-9_-]{8,}$/, verify: 'premiumize',
      price: 'roughly €10/month, cheaper yearly',
      pros: ['1TB of personal cloud storage included', 'Built-in VPN', 'Fine with multiple connections at once'],
      cons: ['Noticeably more expensive than the rest', 'Monthly points allowance rather than unlimited'],
      url: 'https://www.premiumize.me/',
      keyUrl: 'https://www.premiumize.me/account',
    },
    {
      id: 'realdebrid', name: 'Real-Debrid', tag: '', native: false,
      price: 'roughly €4/month',
      pros: ['Cheapest of the big names', 'Very fast servers'],
      cons: ['Strict one-connection-at-a-time rule', 'Has been blocking a growing number of files'],
      url: 'https://real-debrid.com/',
      keyUrl: 'https://real-debrid.com/apitoken',
    },
    {
      id: 'alldebrid', name: 'AllDebrid', tag: '', native: false,
      price: 'roughly €3/month',
      pros: ['Very reliable, good support', '7-day free trial (needs phone verification)'],
      cons: ['Smaller cache than TorBox or Premiumize', 'One connection at a time'],
      url: 'https://alldebrid.com/',
      keyUrl: 'https://alldebrid.com/apikeys',
    },
    {
      id: 'debridlink', name: 'Debrid-Link', tag: '', native: false,
      price: '',
      pros: ['Solid all-rounder', 'Supports a wide range of hosts'],
      cons: ['Smaller community, so fewer people to ask when something breaks'],
      url: 'https://debrid-link.com/',
      keyUrl: 'https://debrid-link.com/webapp/apikey',
    },
    {
      id: 'easydebrid', name: 'EasyDebrid', tag: '', native: false,
      price: '',
      pros: ['Very simple — one key, nothing to configure'],
      cons: ['Fewer features than the bigger services'],
      url: 'https://paradise-cloud.com/products/easydebrid',
      keyUrl: 'https://paradise-cloud.com/products/easydebrid',
    },
    {
      id: 'offcloud', name: 'Offcloud', tag: '', native: false,
      price: 'roughly $5/month',
      pros: ['Uses Premiumize’s cache at a lower price', 'No connection limit'],
      cons: ['1TB monthly usage cap'],
      url: 'https://offcloud.com/',
      keyUrl: 'https://offcloud.com/#/account',
    },
  ];

  // The honest case for paying for one, and the honest consequence of not.
  // Both halves matter: the "are you sure?" is not a scare screen, and skipping
  // is a supported choice, not a wrong answer.
  //
  // CURRENTLY UNUSED (2026-09-13). The advanced path's "pick a debrid service"
  // section was removed on Furqan's instruction — AIOStreams asks for the
  // service on its own site, so choosing one here was a question Numax could
  // not act on. Kept as copy rather than deleted, the same way market.js keeps
  // mkSelect; nothing reads it, so it costs nothing.
  const NO_DEBRID = {
    title: 'Carry on without a debrid service?',
    why: [
      '<b>Buffering.</b> Free sources are other people’s home connections. Debrid streams come from a datacentre, so they start instantly and hold up.',
      '<b>Big files.</b> 4K and REMUX releases (60GB+) are effectively unstreamable without one.',
      '<b>Your connection stays out of it.</b> The debrid service downloads the torrent on its own servers and hands you a private link. Without one, your own connection joins the swarm and is visible to everyone else in it — which is why people who go this route usually run a VPN.',
    ],
    ok: 'Skip debrid',
    cancel: 'Go back and pick one',
    after: 'No debrid selected — stick to HTTP sources like PenguPlay, or add a VPN before using torrent sources.',
  };

  // ======================================================================
  // Step 3 — simple or advanced
  // ======================================================================
  // The first thing the streams step asks. Everything that was here before is
  // still here, one card further in.
  //
  // The simple card deliberately carries NO pros/cons: behind its "?" app.js
  // renders PRESET instead, because "what am I actually getting" is the only
  // question anyone had about that card, and it used to sit in a separate box
  // below taking up a whole screen. PRESET is declared further down this file,
  // so app.js resolves it by id rather than this entry linking to it — a
  // reference here would read it before it exists.
  const MODES = [
    {
      id: 'simple', name: 'Do it all for me', tag: '',
      oneLiner: 'Paste your TorBox key and Numax builds and installs a tuned AIOStreams setup for you.',
    },
    {
      id: 'advanced', name: 'Advanced setup', tag: '',
      oneLiner: 'Set it up yourself, with any debrid service and full control over sources and filters.',
      pros: [
        'Any debrid service, or none at all',
        'Choose your own sources, filters and sorting from scratch',
        'Also covers putting the debrid key into Nuvio instead of AIOStreams',
      ],
      cons: ['A few minutes of setup on another website'],
    },
  ];

  // ======================================================================
  // Step 3, simple — the relay and the preset
  // ======================================================================
  // AIOStreams can build a whole configuration from a JSON config and hand back
  // a working manifest URL (POST <instance>/api/v1/user). A browser cannot make
  // that call: AIOStreams only mounts its cross-origin permission on /api when
  // an instance runs in development mode, and none of the 12 public instances
  // do (checked live 2026-09-10). One small Cloudflare Worker does it instead —
  // see relay/README.md, which is also where this URL comes from.
  //
  // Empty means "not deployed yet", and the wizard says exactly that rather
  // than letting the button fail. This is the ONLY address the TorBox key is
  // ever sent to besides the instance the user picked, so it is a constant on
  // purpose: nothing at runtime can point it somewhere else.
  const RELAY = 'https://numax-aio-create.nuviobaymax.workers.dev/';

  // Furqan's own exported template, kept as the file he exported so a newer
  // export can simply replace it. The wizard reads `.config`, fills in the
  // TorBox key, and fills or drops the TMDB placeholder.
  const TEMPLATE_URL = 'aiostreams-template.json';

  // What the preset actually does, in the user's words, so "do it all for me"
  // is not a black box. Kept in step with the template above.
  const PRESET = {
    title: 'What you’re getting',
    blurb: 'Enough quality to look good on a big screen, capped so it never sits there buffering.',
    points: [
      'TorBox does the finding and the resolving, through StremThru Torz',
      'Cached results first, then best resolution — so play is usually instant',
      'CAM, screener and telesync rips excluded, and 3D left out',
      'File size and bitrate capped, which is what stops mid-film buffering',
      'Duplicate copies of the same release collapsed into one row',
      'Tidy stream labels, and autoplay picks the matching file for you',
    ],
    note: 'It is your own configuration once it is made — change anything you like on the host afterwards.',
  };

  // Picking a host was a question with no wrong answer and no information to
  // answer it with, so it is no longer asked: app.js takes the uptime tracker's
  // four best AIOStreams hosts and uses one of them. Deliberately not announced
  // on screen — it is an implementation detail, not a decision the user made.
  const SIMPLE = {
    keyTitle: 'Your TorBox API key',
    keyBlurb: 'The only thing Numax needs from you, and it goes to the host that builds your setup and nowhere else.',
    keyHint: 'Sign in at torbox.app, open Settings, and copy the API key there.',
    keyPlaceholder: 'TorBox API key',
    noTorbox: 'No TorBox? Advanced setup works with every other debrid service.',
    runLabel: 'Set it up for me',
    running: 'Building your setup…',
    // Shown with the finished link. The UUID and password are the only way to
    // edit the configuration later, and AIOStreams cannot recover either.
    saveWarn: 'Write these two down — they are the only way to edit this setup later, and the host cannot recover them.',
    installHint: 'The link Numax just made — press Next and it goes into this profile.',
    notDeployed: 'Automatic setup is not switched on for this site yet — use “Advanced setup” above instead.',
    noHosts: 'No AIOStreams host is answering right now, so there is nowhere to build your setup. Try again in a minute, or use Advanced setup.',
  };

  // ======================================================================
  // Step 3, advanced — the two routes
  // ======================================================================
  // The framing that matters, and the one most guides get wrong: BOTH routes
  // need a source add-on. Nuvio's built-in debrid only *resolves* hashes — it
  // cannot find anything on its own (Nuvio wiki, Integrations > Debrid). So the
  // real question is where your debrid key lives and who does the resolving.
  const ROUTES = [
    {
      id: 'aiostreams', name: 'AIOStreams', tag: 'Recommended',
      logo: 'https://aiostreams.elfhosted.com/apple-icon.png', mono: 'A',
      oneLiner: 'Your debrid key lives in AIOStreams, which finds, filters and resolves everything and hands Nuvio one clean list.',
      pros: [
        'Works with every debrid service, not just two',
        'One place to filter and sort by quality, codec, size, language, seeders — applied to every source at once',
        'Deduplicates results, so no more six copies of the same release',
        'Add or remove sources from its own marketplace without touching Nuvio',
        'The same link works in Stremio and on every device and profile you paste it into',
      ],
      cons: [
        'Set up on a separate website first, which takes a few minutes',
        'Depends on the instance you pick staying online (or you self-host)',
      ],
    },
    {
      // Named for both services on purpose: these two are the whole list Nuvio
      // can drive itself, and calling the route "Nuvio + TorBox" read as though
      // Premiumize were not an option. `logos` (plural) draws both marks.
      id: 'native', name: 'Nuvio + TorBox/Premiumize', tag: '',
      logos: ['https://torbox.app/apple-touch-icon.png', 'https://www.premiumize.me/apple-touch-icon.png'],
      mono: 'N',
      oneLiner: 'Your debrid key lives in Nuvio, and a torrent add-on finds raw magnets for Nuvio to resolve.',
      pros: [
        'Nothing to configure on another website — the key goes straight into Nuvio',
        'No third-party instance to stay online',
        'Nuvio still does its own filtering and sorting on the results',
      ],
      cons: [
        'Only TorBox and Premiumize — no other debrid service is supported',
        '<b>You still need a torrent add-on</b> (Torrentio, Comet or AIOStreams) set to hand over raw magnets with no debrid key of its own',
        'The key is per-profile, so it has to be set on each profile separately',
        'Doesn’t carry over to Stremio or any other app',
      ],
      // Stated once, plainly, wherever this route is chosen.
      catch: 'Nuvio’s built-in debrid only <b>resolves</b> links — it can’t find anything on its own. So the add-on you use must return raw magnets with <b>its own debrid field empty</b>, or it resolves first and Nuvio’s side never gets used.',
    },
    {
      // The third route is not a debrid decision at all, which is why it does
      // not fit the sentence the other two share. A plugin is Nuvio's own
      // format: the scraper's code is downloaded and run on the device inside
      // a sandboxed QuickJS runtime, rather than a server being asked for an
      // answer. So there is no instance, no key and no subscription — and
      // equally no debrid, so it sits alongside either route above rather than
      // replacing one. (Nuvio wiki, Integrations → Plugins.)
      //
      // No third party to borrow a mark from, so this one carries a drawn one.
      // `svg` is the general-logo path in app.js's wzLogo; every other entry in
      // this file uses `logo` (a URL) or falls back to `mono`.
      id: 'plugins', name: 'Nuvio plugins', tag: 'Free',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.6v5.2M15 2.6v5.2"/><path d="M5.8 7.8h12.4v3.1a6.2 6.2 0 0 1-12.4 0Z"/><path d="M12 17.1v4.3"/></svg>',
      mono: 'P',
      oneLiner: 'Nuvio does the scraping itself, on your device — no add-on server, no debrid key, nothing to pay for.',
      pros: [
        'Nothing to set up on another website and nothing to subscribe to',
        'No third-party instance that has to stay online',
        'One repository can carry dozens of sources at once',
        'Sits alongside the two routes above rather than replacing either',
      ],
      cons: [
        '<b>Only sideloaded builds of Nuvio support plugins at all</b> — a copy installed from an app store has no plugins section',
        'A plugin is code that runs on your device, not data from a server — only add repositories you trust',
        'Free sources, so speed and reliability vary and links break as sites do',
        'Which providers inside a repository actually run is chosen on the device, not from here',
      ],
      catch: 'Numax can put a repository on this profile, and that syncs to your devices. It <b>cannot</b> turn the individual providers inside it on — Nuvio keeps that on the device, under <b>Settings → Content &amp; Discovery → Plugins</b>, and it is not part of what an account syncs.',
    },
  ];

  // The add-on half of the Nuvio+TorBox route: one recommendation and one way
  // out of it. Three near-identical options here was a choice nobody wanted to
  // make — Torrentio is the one that needs no configuring at all, and anyone
  // who already knows they want Comet or AIOStreams in P2P mode wants the
  // marketplace, not a third card. `browse: true` sends them there.
  const P2P_ADDONS = [
    {
      name: 'Torrentio', tag: 'Recommended',
      logo: 'https://torrentio.strem.fun/images/logo_v1.png', mono: 'T',
      blurb: 'The simplest option — leave every debrid field empty and it returns magnets.',
      url: 'https://torrentio.strem.fun/configure',
    },
    {
      name: 'Choose my own', mono: '+',
      blurb: 'Any add-on that returns raw magnets works — Comet and AIOStreams in P2P mode both do.',
      browse: true,
    },
  ];

  // ======================================================================
  // Step 3, third route — plugins
  // ======================================================================
  // Everything here is from the community Nuvio Wiki's own Plugins page
  // (github.com/haaihond/Nuvio-Wiki, docs/integrations/plugins.md, read
  // 2026-09-13) plus what the repo manifests actually contain, checked live
  // the same day. Nothing below is inferred from the name of anything.
  //
  // The two caveats are not hedging and must not be softened:
  //   - App-store builds of Nuvio have no plugin support at all, so a
  //     repository written to the profile would simply never appear. Saying so
  //     before the write is the difference between "it didn't work" and "this
  //     build can't".
  //   - The per-provider switches are device-local. Nuvio's sync stores one
  //     row per REPOSITORY — { url, name, enabled, sort_order, repo_type } and
  //     nothing else — so there is no field for them to travel in.
  const PLUGINS = {
    lead: 'A plugin repository is one manifest file listing many providers. Nuvio downloads each enabled provider\u2019s code and runs it on the device, so nothing here needs a server, a key or a subscription.',
    caveat: '<b>Sideloaded builds only.</b> App-store copies of Nuvio have no plugins section, so a repository added here would never show up on them.',
    ondevice: 'Adding a repository is all Numax can do, and it is all it claims to do. <b>Turning the individual providers on happens on the device</b>, under Settings \u2192 Content &amp; Discovery \u2192 Plugins \u2014 those switches are not part of what a Nuvio account syncs, so nothing on this page can reach them.',
    trust: 'A plugin runs code on your device rather than returning data like an add-on does. Only add repositories from a source you trust.',
    browse: 'Browse plugin repositories',
    dlgTitle: 'Plugin repositories',
    dlgSub: 'The community index, read live. Open one to see what is inside it before adding it.',
    empty: 'The community plugin index returned nothing.',
    added: 'Repository added to this profile.',
  };

  // ======================================================================
  // Step 4 — community collections (optional)
  // ======================================================================
  // Deliberately framed as the last, optional thing on the metadata step
  // rather than a step of its own: a collection is a list of titles, and it
  // has nothing to draw with until a metadata add-on above it is in place.
  const COLLECTIONS_STEP = {
    lead: 'Ready-made rows someone else has already put together \u2014 a genre, a franchise, a director. They land on the home screen of this profile.',
    note: 'Entirely optional, and you can add as many as you like. A collection is only a list of titles: the metadata add-ons above are what draw the posters for it.',
    browse: 'Browse collections',
    dlgTitle: 'Community collections',
    dlgSub: 'Read from Nuvio\u2019s own community catalogue. Add goes straight to the profile you are setting up.',
  };

  // ======================================================================
  // Adapted AIOStreams guide
  // ======================================================================
  // Rewritten for Nuvio from AIOStreams' own setup docs. Deliberately not a
  // copy: their guide starts by installing Stremio and ends at a Stremio
  // install button, neither of which applies here.
  const AIO_GUIDE = [
    {
      title: 'Open the instance you picked',
      body: 'It opens in a new tab. Everything from here happens on that page — come back to Numax at the end with one link.',
    },
    {
      title: 'Services — paste your debrid key',
      body: 'Find your service in the list, switch it on and paste its API key. You only do this once: AIOStreams applies the key to every source that can use it, so nothing else needs configuring with it again.',
    },
    {
      title: 'Add-ons — pick your sources',
      body: 'Open the built-in marketplace and enable the sources you want. If you’re not sure, its defaults are sensible — or load a community template (Tam-Taro / TAMS is the popular one) and let it choose for you.',
    },
    {
      title: 'Filters — decide what you never want to see',
      body: 'Set minimum resolution, exclude the qualities you don’t want (CAM, TS), and set a maximum file size if your connection needs it. These rules apply to every source at once, which is the whole point of doing it here.',
    },
    {
      title: 'Sorting — decide what lands at the top',
      body: 'Most people sort by resolution, then cached-first, then seeders. Cached-first matters: cached results play instantly, uncached ones have to download first.',
    },
    {
      title: 'Save and copy the link',
      body: 'Use Save &amp; Install, set a password and <b>write down the UUID and password it gives you</b> — that’s how you edit this config later. Then copy the <b>manifest URL</b> rather than pressing the Stremio install button.',
    },
    {
      title: 'Bring it back here',
      body: 'Paste that link into the box below and Numax writes it into the profile you’re setting up.',
    },
  ];

  // ======================================================================
  // Step 4 — metadata
  // ======================================================================
  // `builtin` = already on every new Nuvio profile, so the wizard shows it as
  // done rather than offering to install it again.
  // Rendered as tiles, so each one carries its own artwork. Logo URLs were
  // checked live 2026-09-11 (200, real image, small enough to be a tile):
  // Cinemeta has no logo in its own manifest, so it uses Stremio's add-on mark;
  // AIOMetadata's manifest logo is a 1.4MB PNG, so its favicon is used instead.
  // Every tile falls back to a monogram if the image does not load, so a dead
  // host degrades to a letter rather than a broken-image icon.
  const METADATA = [
    {
      // `check` means: look at what the profile actually has rather than assume.
      // Nuvio ships Cinemeta on a new profile, but a profile that has been
      // tidied up (or had AIOMetadata put in its place) may not have it, and
      // claiming "already installed" at that point is simply wrong.
      id: 'cinemeta', name: 'Cinemeta', check: 'https://v3-cinemeta.strem.io/manifest.json',
      matches: [/(^|\/\/)(v3-)?cinemeta\./i],
      logo: 'https://dl.strem.io/addon-logo.png', mono: 'C',
      blurb: 'Nuvio’s default metadata source — titles, posters and descriptions.',
      body: 'Already on a new profile, so there is usually nothing to do here.',
      url: 'https://v3-cinemeta.strem.io/',
      installName: 'Cinemeta',
    },
    {
      id: 'bingecat', name: 'BingeCat', tag: 'Recommended', builtin: false,
      logo: 'https://bingecat.com/static/logo.png', mono: 'B',
      blurb: 'Browse and build catalogs, with AI search and recommendations on top.',
      body: 'Over 100,000 public catalogs plus your own TMDB, Trakt and MDBList lists, free and with no API keys of its own.',
      url: 'https://bingecat.com/stremio/configure',
    },
    {
      id: 'aiometadata', name: 'AIOMetadata', tag: 'Most control', builtin: false,
      logo: 'https://aiometadata.elfhosted.com/favicon.png', mono: 'A',
      blurb: 'TMDB, TheTVDB and MyAnimeList in one add-on, with a separate source per content type.',
      body: 'Choose which source handles movies, series and anime, using your own keys.',
      instances: 'AIOMetadata',
    },
    {
      id: 'xperience', name: 'Xperience', tag: '', builtin: false,
      logo: 'https://xperience-app.com/icon-192.png', mono: 'X',
      blurb: 'Build your home screen visually — 364+ curated rows across 18 categories.',
      body: 'Pick the rows you want, tidy them into folders, and it keeps itself up to date.',
      url: 'https://xperience-app.com/',
    },
  ];

  // Nuvio processes metadata add-ons top to bottom, so a metadata add-on sat
  // below a stream add-on does less than it should. Surfaced as an opt-in tick
  // on metadata installs rather than a silent reorder.
  const ORDER_TIP = 'Nuvio reads metadata add-ons from the top of the list down, so metadata belongs above your stream sources.';

  // ======================================================================
  // The step headline — one question per screen
  // ======================================================================
  // Each step opens with the question it is actually asking, at size, instead
  // of a filing-cabinet label. This is half of what stops the sparse steps
  // reading as a page that failed to load; the live panel is the other half.
  const STEP_HEADS = {
    account: {
      q: 'Which profile are we setting up?',
      sub: 'Everything the wizard writes — keys, add-ons, settings — goes to this one profile.',
    },
    keys: {
      q: 'Which keys do you want to use?',
      sub: 'All three are free. TMDB is the only one Nuvio really needs; the other two are worth having.',
    },
    streams: {
      q: 'Where should Nuvio find things to play?',
      sub: 'Nuvio has no sources of its own — an add-on goes and finds them. This is the step that matters most.',
    },
    meta: {
      q: 'How should your home screen look?',
      sub: 'Posters, descriptions and the rows you see first, plus any community collections you want on it. All optional — a new profile already has the basics.',
    },
    done: {
      q: 'That’s the setup done.',
      sub: 'Here is everything the wizard changed, and what is worth doing next.',
    },
  };

  // ======================================================================
  // Recognising an installed add-on
  // ======================================================================
  // WHY THIS EXISTS, and why it is not the obvious thing: Nuvio stores an
  // add-on as nothing but `{url, name, enabled, sort_order}` — checked against
  // a real account's export on 2026-09-14, those are ALL the fields there are.
  // There is no type, no category, no cached manifest. And `name` is whatever
  // the user typed: the test account's two AIOStreams instances are called
  // "Main" and "Niche". So the name cannot classify anything, and the URL has
  // to.
  //
  // The authoritative answer is the add-on's own manifest — `resources` says
  // 'stream', 'subtitles', or 'catalog'/'meta' — and app.js reads that first,
  // straight from the stored URL (which works even for a self-hosted
  // AIOStreams whose URL carries an encoded config in the path). This table is
  // the fallback for the ones a browser cannot read cross-origin, plus the
  // handful whose manifest does not answer the question:
  //
  //   - Cinemeta publishes no `logo` at all.
  //   - AIOMetadata publishes an EMPTY `resources` array, so nothing but the
  //     host says what it is (checked live 2026-09-14).
  //
  // Every pattern below comes from a URL already hand-checked elsewhere in
  // this repo — market.js's ADDON_GROUPS (whose groups are stream sources
  // except its Subtitles group) and STAPLES, and this file's own METADATA and
  // P2P_ADDONS. Nothing here is a guessed host.
  const ADDON_KINDS = [
    // --- metadata / catalogs ---
    { re: /cinemeta/i, name: 'Cinemeta', kind: 'meta', logo: 'https://dl.strem.io/addon-logo.png' },
    { re: /aiometadata/i, name: 'AIOMetadata', kind: 'meta', logo: 'https://aiometadata.elfhosted.com/favicon.png' },
    { re: /bingecat/i, name: 'BingeCat', kind: 'meta', logo: 'https://bingecat.com/static/logo.png' },
    { re: /xperience-app/i, name: 'Xperience', kind: 'meta', logo: 'https://xperience-app.com/icon-192.png' },
    // --- subtitles ---
    // Its own manifest publishes an http: logo, which an https page blocks as
    // mixed content, so the https form is pinned here instead (checked live).
    { re: /opensubtitles/i, name: 'OpenSubtitles', kind: 'subs', logo: 'https://www.strem.io/images/addons/opensubtitles-logo.png' },
    { re: /subsource/i, name: 'SubSource', kind: 'subs' },
    { re: /submaker/i, name: 'SubMaker', kind: 'subs' },
    { re: /subsense/i, name: 'SubSense', kind: 'subs' },
    { re: /community-subtitles/i, name: 'Community Subtitles', kind: 'subs' },
    // --- stream sources ---
    { re: /aiostreams/i, name: 'AIOStreams', kind: 'stream', logo: 'https://aiostreams.elfhosted.com/apple-icon.png' },
    { re: /torrentio/i, name: 'Torrentio', kind: 'stream', logo: 'https://torrentio.strem.fun/images/logo_v1.png' },
    { re: /stremthru/i, name: 'StremThru', kind: 'stream' },
    { re: /peerflix/i, name: 'Peerflix', kind: 'stream' },
    { re: /torrentsdb/i, name: 'TorrentsDB', kind: 'stream' },
    { re: /torrentclaw/i, name: 'TorrentClaw', kind: 'stream' },
    { re: /(^|\.)comet\.|elfhosted\.com\/.*comet/i, name: 'Comet', kind: 'stream' },
    { re: /mediafusion/i, name: 'MediaFusion', kind: 'stream' },
    { re: /meteorfortheweebs/i, name: 'Meteor', kind: 'stream' },
    { re: /jackettio/i, name: 'Jackettio', kind: 'stream' },
    { re: /pengu\.uk|penguplay/i, name: 'PenguPlay', kind: 'stream' },
    { re: /sooti\.click|sootio/i, name: 'Sootio', kind: 'stream' },
    { re: /webstreamr/i, name: 'WebStreamr', kind: 'stream' },
    { re: /hdhub/i, name: 'HDHub', kind: 'stream' },
    { re: /flixnest/i, name: 'Flix-Streams', kind: 'stream' },
    { re: /torii\.nexioapp/i, name: 'Nexio Torii', kind: 'stream' },
    { re: /dramayo/i, name: 'Dramayo', kind: 'stream' },
    { re: /yukistreams/i, name: 'YukiStreams', kind: 'stream' },
    { re: /yastream/i, name: 'YaStream', kind: 'stream' },
    { re: /stravo/i, name: 'Stravo', kind: 'stream' },
  ];

  // The panel's section order and wording. 'other' is deliberately last and
  // deliberately vague — an add-on nobody could identify is reported as one,
  // not filed under a guess.
  const PANEL_SECTIONS = [
    { kind: 'stream', label: 'Streams', empty: 'nothing yet' },
    { kind: 'meta', label: 'Metadata', empty: 'nothing yet' },
    { kind: 'subs', label: 'Subtitles', empty: 'none' },
    { kind: 'other', label: 'Other add-ons', empty: '' },
  ];

  window.NumaxWizard = {
    KEYS, DEBRID, NO_DEBRID, MODES, RELAY, TEMPLATE_URL, PRESET, SIMPLE,
    ROUTES, P2P_ADDONS, PLUGINS, AIO_GUIDE, METADATA, COLLECTIONS_STEP, ORDER_TIP,
    STEP_HEADS, ADDON_KINDS, PANEL_SECTIONS,
  };
})();
