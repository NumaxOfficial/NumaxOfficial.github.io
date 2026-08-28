// ============================================================
// Numax Nuvio API client  (api.js)
//
// Talks to api.nuvio.tv exactly like the extension's baymax.js, but adds:
//   - GoTrue email/password sign-in and refresh-token rotation (for linking
//     multiple accounts on-device)
//   - reads a whole account in one sync_export_account_backup() call
//   - pulls each target's LIVE settings blob (unredacted + updated_at) for
//     guarded writes — never sourced from the backup, which may redact secrets
//   - executes an engine plan, with a dry-run mode that writes nothing
//
// Browser + node compatible (attaches window.NumaxApi).
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NumaxApi = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.' +
    'tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';
  const REST_BASE = 'https://api.nuvio.tv/rest/v1/rpc';
  const AUTH_BASE = 'https://api.nuvio.tv/auth/v1';

  class ConflictError extends Error {} // guarded settings write lost a race (40001/409)
  class AuthError extends Error {}

  // ---- GoTrue auth ----
  function normalizeSession(raw) {
    if (!raw || !raw.access_token) throw new AuthError('No access_token in auth response.');
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token || null,
      expires_at: raw.expires_at || (raw.expires_in ? nowSec + raw.expires_in : 0),
    };
  }

  async function signIn(email, password) {
    const res = await fetch(AUTH_BASE + '/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AuthError('Sign-in failed (' + res.status + '): ' + t.slice(0, 160));
    }
    return normalizeSession(await res.json());
  }

  async function refresh(refreshToken) {
    const res = await fetch(AUTH_BASE + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) throw new AuthError('Token refresh failed (' + res.status + ').');
    return normalizeSession(await res.json());
  }

  // ---- per-account client ----
  // store: the NumaxStore instance; accountId: which linked account to act as.
  function client(store, accountId) {
    const rec = store.get(accountId);
    if (!rec) throw new Error('Account not linked: ' + accountId);
    let session = rec.session;

    // throttle (mirrors baymax.js)
    const MIN_GAP = 120, MAX_PER_MIN = 90;
    let lastAt = 0, stamps = [];
    async function throttle() {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < 60000);
      if (stamps.length >= MAX_PER_MIN) throw new Error('Rate limit — wait a minute and retry.');
      const gap = now - lastAt;
      if (gap < MIN_GAP) await new Promise((r) => setTimeout(r, MIN_GAP - gap));
      lastAt = Date.now(); stamps.push(lastAt);
    }

    async function ensureFresh() {
      const nowSec = Math.floor(Date.now() / 1000);
      if (session.expires_at && session.expires_at - nowSec > 60) return;
      if (!session.refresh_token) throw new AuthError('Session expired and no refresh token — re-link this account.');
      session = await refresh(session.refresh_token);
      store.updateSession(accountId, session); // persist rotated token immediately
    }

    async function rpc(fn, params = {}, _retried = false) {
      await ensureFresh();
      await throttle();
      let res;
      try {
        res = await fetch(REST_BASE + '/' + fn, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + session.access_token, apikey: ANON, 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
      } catch (e) { throw new Error("Couldn't reach Nuvio — check your connection."); }

      if (res.status === 401 && !_retried && session.refresh_token) {
        session = await refresh(session.refresh_token);
        store.updateSession(accountId, session);
        return rpc(fn, params, true);
      }
      if (res.status === 409) throw new ConflictError('Settings changed on another device — re-preview and try again.');
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1200));
          if (!_retried) return rpc(fn, params, true);
        }
        throw new Error('Nuvio ' + res.status + ' on ' + fn + ': ' + t.slice(0, 200));
      }
      return res.status === 204 ? null : res.json();
    }

    // reads
    async function exportBackup() {
      const b = await rpc('sync_export_account_backup', {});
      return (b && b.data && Array.isArray(b.data.addons)) ? b.data : (b || {});
    }
    async function pullProfiles() { return rpc('sync_pull_profiles'); }
    async function pullSettings(profileId, platform) {
      const rows = await rpc('sync_pull_profile_settings_blob', { p_profile_id: profileId, p_platform: platform });
      return Array.isArray(rows) && rows[0] ? rows[0] : null; // { settings_json, updated_at } or null
    }
    // Whether this account currently has an active Nuvio Supporter / Supporter
    // Plus membership — same RPC and gating rule (recognized tier + status
    // "active") that Nuvio's own web client uses to unlock supporter-only
    // theme colors, avatars, and profile backgrounds.
    const SUPPORTER_TIERS = new Set(['SUPPORTER', 'SUPPORTER_PLUS']);
    async function getMembership() {
      const rows = await rpc('get_my_membership_overview', {});
      const row = Array.isArray(rows) ? (rows[0] || null) : (rows || null);
      const tier = row && SUPPORTER_TIERS.has(row.tier) ? row.tier : null;
      return { isSupporter: !!tier && row.status === 'active', tier, status: (row && row.status) || 'inactive' };
    }

    // slice one profile's addon/plugin/collection state out of a backup.data
    function sliceProfile(backup, profileId) {
      const pick = (arr) => (Array.isArray(arr) ? arr.filter((r) => r.profile_id === profileId) : []);
      const collRow = pick(backup.collections)[0];
      return {
        addons: pick(backup.addons),
        plugins: pick(backup.plugins),
        collections: (collRow && collRow.collections_json) || [],
      };
    }

    // execute (or, if dryRun, just return) an engine plan's operations.
    async function applyPlan(plan, { dryRun = true } = {}) {
      if (dryRun) return { profileId: plan.profileId, executed: false, report: plan.report, operations: plan.operations };
      const results = [];
      for (const op of plan.operations) {
        try { await rpc(op.rpc, op.params); results.push({ surface: op.surface, ok: true }); }
        catch (e) { results.push({ surface: op.surface, ok: false, error: e.message, conflict: e instanceof ConflictError }); }
      }
      return { profileId: plan.profileId, executed: true, report: plan.report, results };
    }

    return { rpc, exportBackup, pullProfiles, pullSettings, sliceProfile, applyPlan, getMembership, get accountId() { return accountId; } };
  }

  // Fetch the built-in avatar catalog (avatar_id -> image URL) from Nuvio.
  // This is an RPC (get_avatar_catalog), not a plain table — it returns rows
  // with a relative storage_path that must be resolved against the public
  // storage bucket. Readable with the anon key; no auth needed.
  // Falls back to empty object on failure — never breaks the app.
  const AVATAR_STORAGE_BASE = 'https://api.nuvio.tv/storage/v1/object/public/avatars/';
  let _avatarCache = null;
  async function fetchAvatarCatalog() {
    if (_avatarCache) return _avatarCache;
    try {
      const res = await fetch(REST_BASE + '/get_avatar_catalog', {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!res.ok) { _avatarCache = {}; return _avatarCache; }
      const rows = await res.json();
      const map = {};
      if (Array.isArray(rows)) rows.forEach(r => { if (r.id && r.storage_path) map[r.id] = AVATAR_STORAGE_BASE + r.storage_path; });
      _avatarCache = map;
    } catch { _avatarCache = {}; }
    return _avatarCache;
  }

  return { signIn, refresh, client, fetchAvatarCatalog, ANON, REST_BASE, AUTH_BASE, ConflictError, AuthError };
});
