/* Numax — the collection model.
 *
 * WHAT THIS IS
 * A faithful port of the model behind Nuvio's own collection builder
 * (nuvio.tv/account -> Collections -> Create/Edit Collection), so a collection
 * Numax writes is indistinguishable from one Nuvio writes. Every constant,
 * default, coercion and error message below was read off Nuvio's shipped code
 * on 2026-09-15 and cross-checked against the 99 captured community
 * collections in community-collections/ — not guessed, and not inferred from
 * what the fields are called.
 *
 * WHY IT IS ITS OWN FILE
 * Same contract as market.js and wizard.js: THIS MODULE OWNS NO APPLICATION
 * STATE AND PERFORMS NO WRITES. It is constants, factories, coercion and
 * validation. app.js renders the editor and commits the result into pfEdit,
 * which "Save to profile" pushes through the one existing write path. Delete
 * this file and the collection editor hides itself; nothing else changes.
 *
 * THE ONE DELIBERATE DIFFERENCE FROM NUVIO
 * Nuvio has no way to reorder a collection's folders. Numax does, and that
 * ordering is just the order of the `folders` array, so it needs nothing here.
 *
 * SHAPE, in the words of the stored JSON:
 *   collection { id, title, viewMode, pinToTop, showAllTab, focusGlowEnabled,
 *                backdropImageUrl?, folders[] }
 *   folder     { id, title, tileShape, hideTitle, focusGifEnabled, sources[],
 *                catalogSources[], coverImageUrl?, titleLogoUrl?,
 *                heroBackdropUrl?, heroVideoUrl?, focusGifUrl?, coverEmoji? }
 *   source     tmdb  { provider, tmdbSourceType, title, tmdbId, mediaType, sortBy, filters{} }
 *              trakt { provider, title, traktListId, mediaType, sortBy, sortHow }
 *              addon { provider, addonId, type, catalogId, genre? }
 *
 * The optional keys are omitted entirely when empty rather than written as "",
 * because that is what Nuvio does and a diff against a Nuvio-written
 * collection is the only way to know this port is right.
 */
(function () {
  'use strict';

  // ---- constants (Nuvio's own arrays, same order) -------------------------
  var VIEW_MODES = ['TABBED_GRID', 'ROWS', 'FOLLOW_LAYOUT'];
  var TILE_SHAPES = ['POSTER', 'LANDSCAPE', 'SQUARE'];
  var TMDB_TYPES = ['LIST', 'COLLECTION', 'COMPANY', 'NETWORK', 'DISCOVER', 'PERSON', 'DIRECTOR'];
  var MEDIA_TYPES = ['MOVIE', 'TV'];
  var TMDB_SORTS = ['original', 'popularity.desc', 'vote_average.desc',
                    'primary_release_date.desc', 'first_air_date.desc'];
  var TRAKT_SORTS = ['rank', 'added', 'title', 'released', 'runtime',
                     'popularity', 'percentage', 'votes'];
  var SORT_DIRS = ['asc', 'desc'];

  // The names Nuvio prints. Two different sets for the TMDB source type: the
  // short one it uses inside a source's own summary line, and the longer one
  // it puts in the picker. Both are kept because both are visible.
  var TMDB_TYPE_NAME = {
    LIST: 'TMDB List', COLLECTION: 'TMDB Movie Collection', COMPANY: 'Production',
    NETWORK: 'Network', DISCOVER: 'TMDB Discover', PERSON: 'Person Credits',
    DIRECTOR: 'Director Credits',
  };
  var TMDB_TYPE_CHOICE = {
    LIST: 'Public list', COMPANY: 'Production company', NETWORK: 'Network',
    COLLECTION: 'Movie collection', DISCOVER: 'Custom discover',
    PERSON: 'Person credits', DIRECTOR: 'Director credits',
  };
  // The order the picker offers them in — not the order of TMDB_TYPES.
  var TMDB_TYPE_ORDER = ['LIST', 'COMPANY', 'NETWORK', 'COLLECTION', 'PERSON', 'DIRECTOR', 'DISCOVER'];
  var TMDB_SORT_NAME = {
    original: 'Original', 'popularity.desc': 'Popular', 'vote_average.desc': 'Top Rated',
    'primary_release_date.desc': 'Recent', 'first_air_date.desc': 'Recent',
  };
  var TRAKT_SORT_NAME = {
    rank: 'List Order', added: 'Recently Added', title: 'Title', released: 'Released',
    runtime: 'Runtime', popularity: 'Popular', percentage: 'Percentage', votes: 'Votes',
  };
  var SORT_DIR_NAME = { asc: 'Ascending', desc: 'Descending' };

  // The TMDB "Custom discover" filter set: key, label, and the placeholder
  // Nuvio shows, which is doing real work — it is the only thing that says a
  // genre field wants comma-separated numeric ids and a provider field wants
  // pipes. `kind` drives the coercion in cleanFilters below.
  var DISCOVER_FILTERS = [
    { key: 'withGenres', label: 'Genres', ph: '28,12', kind: 'text' },
    { key: 'withoutGenres', label: 'Exclude genres', ph: '16 for Animation', kind: 'text' },
    { key: 'releaseDateGte', label: 'Date from', ph: '2020-01-01', kind: 'text' },
    { key: 'releaseDateLte', label: 'Date to', ph: '2024-12-31', kind: 'text' },
    { key: 'voteAverageGte', label: 'Rating min', ph: '7.0', kind: 'num' },
    { key: 'voteAverageLte', label: 'Rating max', ph: '10', kind: 'num' },
    { key: 'voteCountGte', label: 'Votes min', ph: '100', kind: 'int' },
    { key: 'withOriginalLanguage', label: 'Language', ph: 'en', kind: 'text' },
    { key: 'withOriginCountry', label: 'Country', ph: 'US', kind: 'text' },
    { key: 'withKeywords', label: 'Keywords', ph: '9715', kind: 'text' },
    { key: 'withoutKeywords', label: 'Exclude keywords', ph: '9715', kind: 'text' },
    { key: 'withCompanies', label: 'Companies', ph: '420', kind: 'text' },
    { key: 'withoutCompanies', label: 'Exclude companies', ph: '420', kind: 'text' },
    { key: 'withNetworks', label: 'Networks', ph: '213', kind: 'text' },
    { key: 'year', label: 'Year', ph: '2024', kind: 'int' },
    { key: 'watchRegion', label: 'Watch region', ph: 'US', kind: 'text' },
    { key: 'withWatchProviders', label: 'Watch providers', ph: '8|337|350', kind: 'text' },
    { key: 'withoutWatchProviders', label: 'Exclude watch providers', ph: '8|337|350', kind: 'text' },
  ];

  // ---- small coercions ----------------------------------------------------
  var s = function (v) { return String(v == null ? '' : v).trim(); };
  var pick = function (list, v, fallback) { var t = s(v); return list.indexOf(t) >= 0 ? t : fallback; };
  var upper = function (list, v, fallback) { var t = s(v).toUpperCase(); return list.indexOf(t) >= 0 ? t : fallback; };
  var lower = function (list, v, fallback) { var t = s(v).toLowerCase(); return list.indexOf(t) >= 0 ? t : fallback; };

  function uid(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return prefix + '-' + crypto.randomUUID().slice(0, 8);
    }
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // "Take the LAST run of digits." A Trakt list pasted as a URL ends in its
  // id, and a TMDB id pasted with a slug does too — which is why this is not
  // parseInt.
  function lastNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
    var m = String(v).match(/\d+/g);
    if (!m || !m.length) return null;
    var n = Number(m[m.length - 1]);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  function tmdbType(v) { return upper(TMDB_TYPES, v, 'DISCOVER'); }
  // Two of the seven source types can only mean one medium, and Nuvio forces
  // it rather than letting the field disagree with the type.
  function mediaFor(v, type) {
    if (type === 'NETWORK') return 'TV';
    if (type === 'LIST' || type === 'COLLECTION') return 'MOVIE';
    return upper(MEDIA_TYPES, v, 'MOVIE');
  }
  // A list or a collection has an order of its own, so "popularity" is not a
  // meaningful answer for it and is replaced by 'original'.
  function tmdbSort(v, type, media) {
    var t = s(v);
    if (type === 'LIST' || type === 'COLLECTION') {
      return (t && t !== 'popularity.desc' && TMDB_SORTS.indexOf(t) >= 0) ? t : 'original';
    }
    if (TMDB_SORTS.indexOf(t) >= 0) return t;
    return media === 'TV' ? 'first_air_date.desc' : 'popularity.desc';
  }
  function traktMedia(v) { return upper(MEDIA_TYPES, v, 'MOVIE'); }
  function traktSort(v) { return lower(TRAKT_SORTS, v, 'rank'); }
  function traktDir(v) { return lower(SORT_DIRS, v, 'asc'); }

  function cleanFilters(f) {
    var src = (f && typeof f === 'object') ? f : {};
    var out = {};
    DISCOVER_FILTERS.forEach(function (d) {
      var raw = src[d.key];
      var v;
      if (d.kind === 'text') { v = s(raw) || null; }
      else {
        if (raw == null || raw === '') v = null;
        else { var n = Number(raw); v = Number.isFinite(n) ? (d.kind === 'int' ? Math.trunc(n) : n) : null; }
      }
      if (v != null && v !== '') out[d.key] = v;
    });
    return out;
  }

  // ---- which provider is this source? -------------------------------------
  // A source with no provider at all is an addon source: that is the oldest
  // shape and the default Nuvio falls back to.
  function isTmdb(x) { return s(x && x.provider).toLowerCase() === 'tmdb'; }
  function isTrakt(x) { return s(x && x.provider).toLowerCase() === 'trakt'; }
  function isAddon(x) { var p = s(x && x.provider).toLowerCase(); return !p || p === 'addon'; }
  function providerOf(x) { return isTmdb(x) ? 'tmdb' : isTrakt(x) ? 'trakt' : 'addon'; }

  // A folder written before `sources` existed carries `catalogSources` only.
  function sourcesOf(folder) {
    var f = folder || {};
    if (Array.isArray(f.sources)) return f.sources;
    if (Array.isArray(f.catalogSources)) {
      return f.catalogSources.map(function (c) {
        return newAddonSource({
          addonId: s(c && c.addonId), type: s(c && c.type) || 'movie',
          catalogId: s(c && c.catalogId), genre: s(c && c.genre),
        });
      });
    }
    return [];
  }

  // `catalogSources` is not a second list to maintain — it is the addon
  // sources, derived. Nuvio recomputes it on every write and so does this.
  function catalogSourcesFrom(list) {
    return (Array.isArray(list) ? list : []).filter(isAddon).map(function (x) {
      var addonId = s(x && x.addonId), type = s(x && x.type), catalogId = s(x && x.catalogId);
      if (!addonId || !type || !catalogId) return null;
      var out = { addonId: addonId, type: type, catalogId: catalogId };
      var g = s(x && x.genre); if (g) out.genre = g;
      return out;
    }).filter(Boolean);
  }

  // ---- factories ----------------------------------------------------------
  function newAddonSource(o) {
    return Object.assign({ provider: 'addon', addonId: '', type: '', catalogId: '', genre: '' }, o || {});
  }
  function newTmdbSource(o) {
    var e = o || {};
    var type = tmdbType(e.tmdbSourceType || e.sourceType || 'DISCOVER');
    return Object.assign({ provider: 'tmdb', title: '', tmdbId: '', filters: {} }, e, {
      tmdbSourceType: type,
      mediaType: e.mediaType || (type === 'NETWORK' ? 'TV' : 'MOVIE'),
      sortBy: e.sortBy || ((type === 'LIST' || type === 'COLLECTION') ? 'original' : 'popularity.desc'),
    });
  }
  function newTraktSource(o) {
    return Object.assign({ provider: 'trakt', title: '', traktListId: '', mediaType: 'MOVIE',
                           sortBy: 'rank', sortHow: 'asc' }, o || {});
  }
  function newSource(kind, o) {
    if (kind === 'tmdb') return newTmdbSource(o);
    if (kind === 'trakt') return newTraktSource(o);
    return newAddonSource(o);
  }
  function newFolder(o) {
    return Object.assign({
      originalId: '', isNew: true, id: uid('folder'), title: '',
      coverImageUrl: '', titleLogoUrl: '', heroBackdropUrl: '', heroVideoUrl: '',
      focusGifUrl: '', focusGifEnabled: false, coverEmoji: '',
      tileShape: 'LANDSCAPE', hideTitle: false, sources: [], catalogSources: [],
    }, o || {});
  }
  function newCollection(o) {
    return Object.assign({
      originalId: '', isNew: true, id: uid('collection'), title: '',
      backdropImageUrl: '', focusGlowEnabled: false, pinToTop: false,
      viewMode: 'TABBED_GRID', showAllTab: true, folders: [newFolder()],
    }, o || {});
  }

  // ---- normalise a STORED collection into the editor's working shape ------
  // Lossless in the direction that matters: unknown keys are carried through
  // (`...e` in Nuvio, Object.assign here), so editing a collection written by
  // a newer Nuvio cannot silently drop a field this port has never heard of.
  function normalizeSource(x) {
    var e = x || {};
    if (isTmdb(e)) {
      var type = tmdbType(e.tmdbSourceType || e.sourceType);
      var media = mediaFor(e.mediaType, type);
      return newTmdbSource(Object.assign({}, e, {
        tmdbSourceType: type, title: s(e.title),
        tmdbId: (e.tmdbId == null || e.tmdbId === '') ? '' : s(e.tmdbId),
        mediaType: media, sortBy: tmdbSort(e.sortBy, type, media), filters: cleanFilters(e.filters),
      }));
    }
    if (isTrakt(e)) {
      return newTraktSource(Object.assign({}, e, {
        title: s(e.title),
        traktListId: (e.traktListId == null || e.traktListId === '') ? '' : s(e.traktListId),
        mediaType: traktMedia(e.mediaType), sortBy: traktSort(e.sortBy), sortHow: traktDir(e.sortHow),
      }));
    }
    return newAddonSource(Object.assign({}, e, {
      addonId: s(e.addonId), type: s(e.type) || 'movie',
      catalogId: s(e.catalogId), genre: s(e.genre),
    }));
  }
  function normalizeFolder(x) {
    var e = x || {};
    var list = sourcesOf(e).map(normalizeSource);
    return Object.assign({}, e, {
      originalId: s(e.id), isNew: false, id: s(e.id) || uid('folder'), title: s(e.title),
      coverImageUrl: s(e.coverImageUrl), titleLogoUrl: s(e.titleLogoUrl),
      heroBackdropUrl: s(e.heroBackdropUrl), heroVideoUrl: s(e.heroVideoUrl),
      focusGifUrl: s(e.focusGifUrl), focusGifEnabled: !!e.focusGifEnabled,
      coverEmoji: s(e.coverEmoji), tileShape: pick(TILE_SHAPES, e.tileShape, 'LANDSCAPE'),
      hideTitle: !!e.hideTitle, sources: list, catalogSources: catalogSourcesFrom(list),
    });
  }
  function normalizeCollection(x) {
    var e = x || {};
    var folders = Array.isArray(e.folders) ? e.folders.map(normalizeFolder) : [];
    return Object.assign({}, e, {
      originalId: s(e.id), isNew: false, id: s(e.id) || uid('collection'), title: s(e.title),
      backdropImageUrl: s(e.backdropImageUrl), focusGlowEnabled: !!e.focusGlowEnabled,
      pinToTop: !!e.pinToTop, viewMode: pick(VIEW_MODES, e.viewMode, 'TABBED_GRID'),
      showAllTab: e.showAllTab == null ? true : !!e.showAllTab, folders: folders,
    });
  }

  // ---- serialise back to what gets stored ---------------------------------
  // Throws on the first real problem, with Nuvio's own wording, so a message
  // shown here is the same message Nuvio would have shown.
  function serializeCollection(x) {
    var e = x || {};
    var id = s(e.id), title = s(e.title), view = s(e.viewMode);
    if (!id) throw new Error('Collection ID is required.');
    if (!title) throw new Error('Collection title is required.');

    var folders = (Array.isArray(e.folders) ? e.folders : []).map(function (f, fi) {
      var fid = s(f && f.id), ftitle = s(f && f.title), shape = s(f && f.tileShape);
      if (!fid) throw new Error('Folder ' + (fi + 1) + ' is missing an ID.');
      if (!ftitle) throw new Error('Folder ' + (fi + 1) + ' is missing a title.');
      var label = ftitle || fid || ('Folder ' + (fi + 1));

      var list = sourcesOf(f).map(function (src, si) {
        if (isTmdb(src)) {
          var type = tmdbType(src.tmdbSourceType || src.sourceType);
          var media = mediaFor(src.mediaType, type);
          var tid = (src.tmdbId == null || src.tmdbId === '') ? null : lastNumber(src.tmdbId);
          if (type !== 'DISCOVER' && (!tid || tid < 1)) {
            throw new Error('Folder "' + label + '" has an incomplete TMDB source at row ' + (si + 1) + '.');
          }
          return Object.assign({}, src, {
            provider: 'tmdb', tmdbSourceType: type,
            title: s(src.title) || (TMDB_TYPE_NAME[type] || type),
            tmdbId: tid, mediaType: media,
            sortBy: tmdbSort(src.sortBy, type, media), filters: cleanFilters(src.filters),
          });
        }
        if (isTrakt(src)) {
          var lid = (src.traktListId == null || src.traktListId === '') ? null : lastNumber(src.traktListId);
          if (!lid || lid < 1) {
            throw new Error('Folder "' + label + '" has an incomplete Trakt source at row ' + (si + 1) + '.');
          }
          return Object.assign({}, src, {
            provider: 'trakt', title: s(src.title) || ('Trakt List ' + lid).trim(),
            traktListId: lid, mediaType: traktMedia(src.mediaType),
            sortBy: traktSort(src.sortBy), sortHow: traktDir(src.sortHow),
          });
        }
        var addonId = s(src && src.addonId), type2 = s(src && src.type), catalogId = s(src && src.catalogId);
        if (!addonId || !type2 || !catalogId) {
          throw new Error('Folder "' + label + '" has an incomplete catalog source at row ' + (si + 1) + '.');
        }
        var a = Object.assign({}, src, { provider: 'addon', addonId: addonId, type: type2, catalogId: catalogId });
        // Set when there is one, and otherwise LEAVE WHATEVER WAS THERE. Not
        // delete: Nuvio spreads the source and only overwrites a non-empty
        // genre, so a source carrying genre:"" keeps it. Deleting instead
        // rewrites 1,995 sources across the captured collections that Nuvio
        // itself would have left alone — measured, not assumed.
        var g = s(src && src.genre); if (g) a.genre = g;
        return a;
      });

      var out = Object.assign({}, f, {
        id: fid, title: ftitle, tileShape: pick(TILE_SHAPES, shape, 'LANDSCAPE'),
        hideTitle: !!(f && f.hideTitle), focusGifEnabled: !!(f && f.focusGifEnabled),
        sources: list, catalogSources: catalogSourcesFrom(list),
      });
      // Same rule as genre: set when present, leave alone when not. Nuvio
      // spreads the folder first, so a field it was given as "" stays "" and a
      // field that was absent stays absent. The only two keys it really does
      // remove are its own editor bookkeeping.
      ['coverImageUrl', 'titleLogoUrl', 'heroBackdropUrl', 'heroVideoUrl', 'focusGifUrl', 'coverEmoji']
        .forEach(function (k) { var v = s(f && f[k]); if (v) out[k] = v; });
      delete out.originalId; delete out.isNew;
      return out;
    });

    var coll = Object.assign({}, e, {
      id: id, title: title, focusGlowEnabled: !!e.focusGlowEnabled, pinToTop: !!e.pinToTop,
      viewMode: pick(VIEW_MODES, view, 'TABBED_GRID'),
      showAllTab: e.showAllTab == null ? true : !!e.showAllTab, folders: folders,
    });
    var bd = s(e.backdropImageUrl); if (bd) coll.backdropImageUrl = bd;
    delete coll.originalId; delete coll.isNew;
    return coll;
  }

  // Everything wrong with it, rather than only the first thing — this is what
  // the Review step lists and what the step rail counts. Blocking problems are
  // exactly the ones serialize would throw on; the empty-folder note is a
  // warning, because Nuvio saves a folder with no sources.
  function problems(x) {
    var out = [];
    var e = x || {};
    if (!s(e.id)) out.push({ blocking: true, text: 'Collection ID is required.' });
    if (!s(e.title)) out.push({ blocking: true, text: 'Collection title is required.' });
    (Array.isArray(e.folders) ? e.folders : []).forEach(function (f, fi) {
      var fid = s(f && f.id), ftitle = s(f && f.title);
      var label = ftitle || fid || ('Folder ' + (fi + 1));
      if (!fid) out.push({ blocking: true, folder: fi, text: 'Folder ' + (fi + 1) + ' is missing an ID.' });
      if (!ftitle) out.push({ blocking: true, folder: fi, text: label + ' is missing a title.' });
      var list = sourcesOf(f);
      if (!list.length) out.push({ blocking: false, folder: fi, text: label + ' has no sources attached.' });
      list.forEach(function (src, si) {
        if (isTmdb(src)) {
          var type = tmdbType(src.tmdbSourceType || src.sourceType);
          var tid = lastNumber(src.tmdbId);
          if (type !== 'DISCOVER' && (!tid || tid < 1)) {
            out.push({ blocking: true, folder: fi, source: si,
              text: 'Folder "' + label + '" has an incomplete TMDB source at row ' + (si + 1) + '.' });
          }
        } else if (isTrakt(src)) {
          var lid = lastNumber(src.traktListId);
          if (!lid || lid < 1) {
            out.push({ blocking: true, folder: fi, source: si,
              text: 'Folder "' + label + '" has an incomplete Trakt source at row ' + (si + 1) + '.' });
          }
        } else if (!s(src && src.addonId) || !s(src && src.type) || !s(src && src.catalogId)) {
          out.push({ blocking: true, folder: fi, source: si,
            text: 'Folder "' + label + '" has an incomplete catalog source at row ' + (si + 1) + '.' });
        }
      });
    });
    return out;
  }
  function blockingCount(x) { return problems(x).filter(function (p) { return p.blocking; }).length; }

  // ---- the names a source shows in a list ---------------------------------
  function sourceTitle(x) {
    var e = x || {};
    if (isTmdb(e)) return s(e.title) || (TMDB_TYPE_NAME[tmdbType(e.tmdbSourceType || e.sourceType)] || 'TMDB');
    if (isTrakt(e)) {
      var id = (e.traktListId == null || e.traktListId === '') ? '' : ' ' + e.traktListId;
      return s(e.title) || ('Trakt List' + id).trim();
    }
    return s(e.title) || s(e.catalogName) || s(e.catalogId) || 'Catalog';
  }
  function sourceDetail(x) {
    var e = x || {};
    if (isTmdb(e)) {
      var type = tmdbType(e.tmdbSourceType || e.sourceType);
      var media = mediaFor(e.mediaType, type) === 'TV' ? 'Series' : 'Movies';
      var sort = TMDB_SORT_NAME[tmdbSort(e.sortBy, type, media === 'Series' ? 'TV' : 'MOVIE')] || 'Popular';
      if (type === 'LIST') return 'TMDB List';
      if (type === 'COLLECTION') return 'TMDB Movie Collection';
      if (type === 'NETWORK') return ['Network', 'Series', sort].join(' - ');
      if (type === 'COMPANY') return ['Production', media, sort].join(' - ');
      if (type === 'PERSON') return ['Person Credits', media, sort].join(' - ');
      if (type === 'DIRECTOR') return ['Director Credits', media, sort].join(' - ');
      return ['TMDB Discover', media, sort].join(' - ');
    }
    if (isTrakt(e)) {
      return ['Trakt List', traktMedia(e.mediaType) === 'TV' ? 'Series' : 'Movies',
              TRAKT_SORT_NAME[traktSort(e.sortBy)] || 'List Order',
              SORT_DIR_NAME[traktDir(e.sortHow)] || 'Ascending'].join(' - ');
    }
    var bits = [s(e.addonName) || s(e.addonId), s(e.catalogName) || s(e.catalogId), s(e.type)];
    return bits.filter(Boolean).join(' - ') || 'Installed addon catalog';
  }
  // Templates name their folder after the studio plus the medium, without
  // doubling the word when the title already ends in it.
  function titleWithMedia(title, media) {
    var t = s(title), word = s(media).toUpperCase() === 'TV' ? 'Series' : 'Movies';
    if (!t) return word;
    return t.slice(-word.length) === word ? t : t + ' ' + word;
  }

  // ---- templates ----------------------------------------------------------
  // Nuvio's eleven, with the TMDB ids it ships. These are real ids, checked
  // against its own code — not looked up and not guessed.
  var PRESETS = [
    { title: 'Marvel Studios', type: 'COMPANY', tmdbId: '420', media: 'MOVIE' },
    { title: 'Walt Disney Pictures', type: 'COMPANY', tmdbId: '2', media: 'MOVIE' },
    { title: 'Pixar', type: 'COMPANY', tmdbId: '3', media: 'MOVIE' },
    { title: 'Lucasfilm', type: 'COMPANY', tmdbId: '1', media: 'MOVIE' },
    { title: 'Warner Bros.', type: 'COMPANY', tmdbId: '174', media: 'MOVIE' },
    { title: 'Netflix', type: 'NETWORK', tmdbId: '213', media: 'TV' },
    { title: 'HBO', type: 'NETWORK', tmdbId: '49', media: 'TV' },
    { title: 'Disney+', type: 'NETWORK', tmdbId: '2739', media: 'TV' },
    { title: 'Prime Video', type: 'NETWORK', tmdbId: '1024', media: 'TV' },
    { title: 'Hulu', type: 'NETWORK', tmdbId: '453', media: 'TV' },
    { title: 'Apple TV+', type: 'NETWORK', tmdbId: '2552', media: 'TV' },
  ];
  function presetSource(p) {
    return newTmdbSource({ tmdbSourceType: p.type, title: p.title, tmdbId: p.tmdbId, mediaType: p.media });
  }
  // A template builds the collection, its first folder and its first source —
  // and every field stays editable afterwards, which is the point of it.
  //
  // The three details here were got wrong first time and are Nuvio's, read off
  // its template handlers rather than guessed: the folder takes the preset's
  // OWN title (not the title with "Movies"/"Series" appended — that suffixing
  // belongs to a different control), and the tile shape is LANDSCAPE for a TV
  // preset and POSTER for a film one, which is the opposite way round from
  // what "series are boxy" would suggest.
  function fromPreset(p) {
    return newCollection({
      title: p.title,
      folders: [newFolder({ title: p.title, sources: [presetSource(p)],
                            tileShape: p.media === 'TV' ? 'LANDSCAPE' : 'POSTER' })],
    });
  }
  // `cat` is the first add-on catalog available on the profile, which only the
  // app can know. Nuvio disables its own Addon template when there is none, and
  // so does app.js.
  function fromKind(kind, cat) {
    if (kind === 'trakt') {
      return newCollection({ title: 'Trakt Collection',
        folders: [newFolder({ title: 'Trakt List', sources: [newTraktSource()] })] });
    }
    if (kind === 'addon') {
      var c = cat || {};
      var name = s(c.catalogName) || s(c.addonName) || 'Addon Collection';
      var src = newAddonSource({ addonId: s(c.addonId), type: s(c.type), catalogId: s(c.catalogId), genre: '' });
      if (s(c.addonName)) src.addonName = s(c.addonName);
      if (s(c.catalogName)) src.catalogName = s(c.catalogName);
      return newCollection({ title: name, folders: [newFolder({ title: name, sources: [src] })] });
    }
    return newCollection({ title: '' });
  }

  window.NumaxCollections = {
    VIEW_MODES: VIEW_MODES, TILE_SHAPES: TILE_SHAPES, TMDB_TYPES: TMDB_TYPES,
    TMDB_TYPE_ORDER: TMDB_TYPE_ORDER, MEDIA_TYPES: MEDIA_TYPES,
    TMDB_SORTS: TMDB_SORTS, TRAKT_SORTS: TRAKT_SORTS, SORT_DIRS: SORT_DIRS,
    TMDB_TYPE_NAME: TMDB_TYPE_NAME, TMDB_TYPE_CHOICE: TMDB_TYPE_CHOICE,
    TMDB_SORT_NAME: TMDB_SORT_NAME, TRAKT_SORT_NAME: TRAKT_SORT_NAME, SORT_DIR_NAME: SORT_DIR_NAME,
    DISCOVER_FILTERS: DISCOVER_FILTERS, PRESETS: PRESETS,
    uid: uid, lastNumber: lastNumber,
    isTmdb: isTmdb, isTrakt: isTrakt, isAddon: isAddon, providerOf: providerOf,
    sourcesOf: sourcesOf, catalogSourcesFrom: catalogSourcesFrom,
    newCollection: newCollection, newFolder: newFolder, newSource: newSource,
    normalizeCollection: normalizeCollection, normalizeFolder: normalizeFolder, normalizeSource: normalizeSource,
    serializeCollection: serializeCollection, problems: problems, blockingCount: blockingCount,
    sourceTitle: sourceTitle, sourceDetail: sourceDetail, titleWithMedia: titleWithMedia,
    mediaFor: mediaFor, tmdbSort: tmdbSort, tmdbType: tmdbType,
    fromPreset: fromPreset, fromKind: fromKind, presetSource: presetSource,
  };
})();
