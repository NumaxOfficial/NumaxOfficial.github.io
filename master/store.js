// ============================================================
// Numax account vault  (store.js)
//
// On-device only. Stores each linked Nuvio account's Supabase session
// (access + refresh token) in the browser's localStorage. Nothing leaves the
// device; no server. Keyed by the account's Supabase user id (JWT "sub").
//
// Each account also carries a user-assigned `label` (a friendly name) so the
// UI can show "Mum's TV" instead of a raw email. `email` is still kept as a
// fallback and for reference.
//
// A storage backend can be injected (for tests); defaults to window.localStorage.
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NumaxStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'numax.accounts.v1';

  function decodeSub(accessToken) {
    if (typeof accessToken !== 'string') return null;
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decode = typeof atob === 'function'
        ? atob
        : (s) => Buffer.from(s, 'base64').toString('binary');
      const payload = JSON.parse(decode(b64));
      return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
    } catch (e) { return null; }
  }

  function makeStore(backend) {
    const store = backend || (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) throw new Error('No storage backend available.');

    const readAll = () => {
      try { return JSON.parse(store.getItem(KEY)) || {}; } catch (e) { return {}; }
    };
    const writeAll = (obj) => store.setItem(KEY, JSON.stringify(obj));

    return {
      /**
       * Link (or refresh the stored copy of) an account from a session object
       * as returned by GoTrue: { access_token, refresh_token, expires_at, ... }.
       * meta may carry { email, label }. Returns the stored record.
       */
      add(session, meta = {}) {
        if (!session || !session.access_token) throw new Error('Session has no access_token.');
        const id = decodeSub(session.access_token);
        if (!id) throw new Error('Could not read account id from token.');
        const all = readAll();
        const prev = all[id] || {};
        all[id] = {
          accountId: id,
          label: (meta.label != null && String(meta.label).trim())
            ? String(meta.label).trim().slice(0, 40)
            : (prev.label || null),
          email: meta.email || prev.email || null,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token || (prev.session && prev.session.refresh_token) || null,
            expires_at: session.expires_at || 0, // seconds since epoch
          },
          addedAt: prev.addedAt || Date.now(),
          updatedAt: Date.now(),
        };
        writeAll(all);
        return all[id];
      },

      /** Rename an account (the friendly label the UI shows). */
      setLabel(id, label) {
        const all = readAll();
        if (!all[id]) throw new Error('Unknown account: ' + id);
        all[id].label = (label != null && String(label).trim())
          ? String(label).trim().slice(0, 40) : null;
        all[id].updatedAt = Date.now();
        writeAll(all);
        return all[id];
      },

      /** Replace just the session for an account (after a token refresh). */
      updateSession(id, session) {
        const all = readAll();
        if (!all[id]) throw new Error('Unknown account: ' + id);
        all[id].session = {
          access_token: session.access_token,
          refresh_token: session.refresh_token || all[id].session.refresh_token,
          expires_at: session.expires_at || 0,
        };
        all[id].updatedAt = Date.now();
        writeAll(all);
        return all[id];
      },

      list() { return Object.values(readAll()); },
      get(id) { return readAll()[id] || null; },

      remove(id) {
        const all = readAll();
        const existed = !!all[id];
        delete all[id];
        writeAll(all);
        return existed;
      },

      clear() { writeAll({}); },
    };
  }

  return { makeStore, decodeSub, KEY };
});
