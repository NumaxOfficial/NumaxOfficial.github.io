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
  const KEYS = [
    {
      id: 'tmdb', name: 'TMDB', provider: 'tmdb', field: 'api_key',
      tag: 'Required', required: true,
      blurb: 'Better artwork, cast, episode titles and descriptions on every title.',
      why: 'Nuvio’s own metadata is thin without it, and almost everything else you add reads better with it in place. The wizard asks for this one before it will move on.',
      getUrl: 'https://www.themoviedb.org/settings/api',
      getLabel: 'themoviedb.org',
      steps: [
        'Create a free account at themoviedb.org.',
        'Account Settings → API in the left sidebar.',
        'Request an API key, choose “Yes, this is for personal use”, fill the short form.',
        'Copy the <b>v3 API key</b> — not the v4 read access token.',
      ],
      placeholder: 'TMDB v3 API key',
      note: 'Mobile and desktop need your own key. Android TV doesn’t — but turning enrichment on there still helps.',
      toggles: {
        tv: [['tmdb_settings', 'tmdb_enabled', true, 'boolean'], ['tmdb_settings', 'tmdb_modern_home_enabled', true, 'boolean']],
        mobile: [['tmdb_settings', 'tmdb_enabled', true, 'boolean']],
        desktop: [['tmdb_settings', 'tmdb_enabled', true, 'boolean']],
      },
    },
    {
      id: 'mdblist', name: 'MDBList', provider: 'mdblist', field: 'api_key',
      tag: 'Recommended',
      blurb: 'Ratings from IMDb, TMDB, Rotten Tomatoes, Metacritic, Trakt, Letterboxd and MyAnimeList.',
      why: 'One key, every rating source at once. Nothing else in Nuvio shows critic and audience scores together.',
      getUrl: 'https://mdblist.com/preferences/',
      getLabel: 'mdblist.com',
      steps: [
        'Register a free account at mdblist.com.',
        'Open your account preferences and generate a free API key.',
        'Copy the key string only — not the whole URL it sits in.',
      ],
      placeholder: 'MDBList API key',
      note: '',
      toggles: {
        tv: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
        mobile: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
        desktop: [['mdblist_settings', 'mdblist_enabled', true, 'boolean']],
      },
    },
    {
      id: 'animeskip', name: 'Anime Skip', provider: 'animeskip', field: 'client_id',
      tag: 'Optional',
      blurb: 'Skips anime intros, recaps and credits automatically.',
      why: 'Only worth it if you watch anime. Nuvio already checks IntroDB and AniSkip for free — this is the third source, and the only one that needs signing up for.',
      getUrl: 'https://anime-skip.com',
      getLabel: 'anime-skip.com',
      steps: [
        'Create an account at anime-skip.com and sign in.',
        'Open your profile → <b>API Clients</b> → <b>Add a New Client</b>.',
        'Name it “Nuvio” with a description of “Nuvio”, then Create.',
        'Copy the generated <b>Client ID</b> — a long string of letters and numbers.',
      ],
      placeholder: 'Anime Skip Client ID',
      note: 'This is a Client ID, not an API key.',
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
  const DEBRID = [
    {
      id: 'torbox', name: 'TorBox', tag: 'Recommended', native: true,
      price: 'from roughly $3/month',
      pros: ['No limit on how many connections or locations you use it from', 'Fast caching and a modern API', 'Usenet included on the top tier'],
      cons: ['Newer than the others, so occasional wobbles'],
      url: 'https://torbox.app/',
      keyUrl: 'https://torbox.app/settings',
    },
    {
      id: 'premiumize', name: 'Premiumize', tag: 'Also great', native: true,
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
  const NO_DEBRID = {
    title: 'Carry on without a debrid service?',
    why: [
      '<b>Buffering.</b> Free sources are other people’s home connections. Debrid streams come from a datacentre, so they start instantly and hold up.',
      '<b>Big files.</b> 4K and REMUX releases (60GB+) are effectively unstreamable without one.',
      '<b>Your connection stays out of it.</b> The debrid service downloads the torrent on its own servers and hands you a private link. Without one, your own connection joins the swarm and is visible to everyone else in it — which is why people who go this route usually run a VPN.',
    ],
    ok: 'Skip debrid',
    cancel: 'Go back and pick one',
    after: 'No debrid selected. Stick to HTTP sources like PenguPlay, which stream directly and need no debrid — or add a VPN before using torrent sources.',
  };

  // ======================================================================
  // Step 3 — the two routes
  // ======================================================================
  // The framing that matters, and the one most guides get wrong: BOTH routes
  // need a source add-on. Nuvio's built-in debrid only *resolves* hashes — it
  // cannot find anything on its own (Nuvio wiki, Integrations > Debrid). So the
  // real question is where your debrid key lives and who does the resolving.
  const ROUTES = [
    {
      id: 'aiostreams', name: 'AIOStreams', tag: 'Recommended',
      oneLiner: 'Your debrid key lives in AIOStreams. It finds, filters and resolves everything, and hands Nuvio one clean list.',
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
      id: 'native', name: 'Nuvio + TorBox', tag: '',
      oneLiner: 'Your debrid key lives in Nuvio. A torrent add-on finds raw magnets, Nuvio hands them to TorBox to resolve.',
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
      catch: 'Nuvio’s built-in debrid only <b>resolves</b> links — it can’t find anything on its own. Whichever add-on you use must be set to return raw magnets, with its own debrid field left empty. If you put your key into the add-on as well, the add-on resolves first and Nuvio’s side never gets used.',
    },
  ];

  // The add-on half of the Nuvio+TorBox route. These are the ones that can
  // hand back raw magnets; ElfHosted's AIOStreams is deliberately absent
  // because that instance disables P2P.
  const P2P_ADDONS = [
    { name: 'Torrentio', blurb: 'The simplest option — leave every debrid field empty and it returns magnets.', url: 'https://torrentio.strem.fun/configure' },
    { name: 'Comet', blurb: 'Broader coverage than Torrentio. Same rule: no debrid key in it.', url: 'https://comet.elfhosted.com/stremio/configure' },
    { name: 'AIOStreams (P2P mode)', blurb: 'Skip the Services menu entirely, then set P2P to Required and exclude the cached/uncached debrid stream types.', instances: 'AIOStreams' },
  ];

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
  const METADATA = [
    {
      // `check` means: look at what the profile actually has rather than assume.
      // Nuvio ships Cinemeta on a new profile, but a profile that has been
      // tidied up (or had AIOMetadata put in its place) may not have it, and
      // claiming "already installed" at that point is simply wrong.
      id: 'cinemeta', name: 'Cinemeta', check: 'https://v3-cinemeta.strem.io/manifest.json',
      matches: [/(^|\/\/)(v3-)?cinemeta\./i],
      blurb: 'Nuvio’s default metadata source — titles, posters and descriptions.',
      body: 'Nuvio installs this on a new profile, so usually there is nothing to do. If you add AIOMetadata below, it is worth turning Cinemeta off afterwards so the two don’t disagree — you can do that on the Profile tab.',
      url: 'https://v3-cinemeta.strem.io/',
      installName: 'Cinemeta',
    },
    {
      id: 'bingecat', name: 'BingeCat', tag: 'Recommended', builtin: false,
      blurb: 'Browse and build catalogs, with AI search and recommendations on top.',
      body: 'Over 100,000 public catalogs you can import and merge, plus your own lists from TMDB, Trakt or MDBList. Free, and needs no API keys of its own.',
      url: 'https://bingecat.com/stremio/configure',
    },
    {
      id: 'aiometadata', name: 'AIOMetadata', tag: 'Most control', builtin: false,
      blurb: 'TMDB, TheTVDB and MyAnimeList in one add-on, with a separate source per content type.',
      body: 'The usual pick for people who want metadata exactly their way — you choose which source handles movies, which handles series, and which handles anime. Give it your own TMDB and TheTVDB keys so you’re not sharing rate limits with everyone else.',
      instances: 'AIOMetadata',
    },
    {
      id: 'xperience', name: 'Xperience', tag: '', builtin: false,
      blurb: 'Build your home screen visually — 364+ curated rows across 18 categories.',
      body: 'Pick the rows you want (Trending, genres, your Trakt lists, AI picks), tidy them into folders, and it stays up to date on its own. No JSON, no config file.',
      url: 'https://xperience-app.com/',
    },
  ];

  // Nuvio processes metadata add-ons top to bottom, so a metadata add-on sat
  // below a stream add-on does less than it should. Surfaced as an opt-in tick
  // on metadata installs rather than a silent reorder.
  const ORDER_TIP = 'Nuvio reads metadata add-ons from the top of the list down, so metadata belongs above your stream sources.';

  window.NumaxWizard = { KEYS, DEBRID, NO_DEBRID, ROUTES, P2P_ADDONS, AIO_GUIDE, METADATA, ORDER_TIP };
})();
