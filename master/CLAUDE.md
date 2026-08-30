# Numax Website — Working Rules

Numax is a companion web app for the Nuvio streaming platform. It lets users
save/apply addon, plugin, collection, and settings configurations as reusable
templates across Nuvio profiles, with optional Google Drive backup. Domain:
`numaxofficial.website`. This repo is the website; the browser extension
(same product family) lives in a separate repo.

## Ground truth / never modify without explicit sign-off

`api.js`, `store.js`, `engine.js`, `meta.js` are core modules — engine/safety
logic lives here. Do not edit these without asking first and explaining why.
`index.html` (and `app.js` if used) is the UI layer and is the normal rebuild
target.

Nuvio's backend is Supabase/PostgREST at `api.nuvio.tv`. Session token is
stored in localStorage under `nuvio.supabase.session`. Key RPCs (verified
2026-08-28 against the live PostgREST OpenAPI schema — `GET /rest/v1/`
with just the anon `apikey` header returns it, no login needed, and is the
fastest way to confirm a param name before trusting a guess):
`sync_export_account_backup`, `sync_push_profiles`, `sync_push_addons`,
`sync_push_plugins`, `sync_push_collections`,
`sync_push_profile_settings_blob`, `sync_push_watch_progress` (param
`p_entries`, not `p_watch_progress`), `sync_push_watched_items` (param
`p_items`, not `p_watched_items`).

`sync_push_profile_settings_blob_guarded` DOES exist (re-verified live
2026-08-29 by actually calling it, in addition to the earlier 401-vs-404
signature probe) — takes exactly `p_profile_id`, `p_settings_json`,
`p_platform`, `p_expected_updated_at` and nothing else; passing
`p_origin_client_id` to it 404s (PGRST202) because PostgREST resolves
functions by name+signature. The plain (unguarded) RPC is the one that
takes `p_origin_client_id`. engine.js's `planTarget` already builds the two
call shapes separately — don't merge them back into one conditional object.

`p_profile_id` on every settings/addons/plugins/collections RPC is the
small per-account integer `profile_index` (1, 2, 3…) shown in
`sync_pull_profiles`, NOT that same row's `id` (a UUID). Passing the UUID
gets `22P02 invalid input syntax for type integer`. app.js already gets
this right everywhere (`idx` = `profile_index`) — this is just a trap when
scripting against the API directly.

Settings schema shape: `features.<group>_settings.<field> = {type, value}`
for plain groups; mobile/desktop also have JSON-*string* `*_payload` groups
whose keys are the raw values directly (no `{type,value}` wrapper). Fields
are extracted into `window.NUVIO_SETTINGS` (`nuvio-settings-schema.js`) —
treat that file as ground truth over any inference. `nuvio-settings-dump.json`
is referenced by older notes but is NOT present in this repo checkout as of
2026-08-29 — don't assume it exists; use `nuvio-settings-schema.js` and, for
real current values, a live pull instead.

## Safety rules (non-negotiable)

- **Three-bucket settings model**: `SECRET_LEAF` (opt-in only, off by
  default — engine.js's `includeSecrets` option, surfaced as an explicit
  "include API keys?" prompt in Sync Desk and template saving),
  `ACCOUNT_GROUPS` (always skip), `PERSONAL_OPTIN_GROUPS` (opt-in only).
  Any code that copies/pushes settings must respect this.
- **API keys**: strip credential fields from settings blobs immediately on
  receipt, before touching state or UI. Track with an `_apiKeysStripped`
  flag per profile.
- **All destructive writes use read-modify-write guards.** Merge vs.
  Overwrite must always be an explicit user choice on every write surface —
  never silently default to one.
- **`sync_push_profiles` is a whole-account full replace.** Never call it
  without a prior pull that verifies all `profile_index` values are
  preserved.
- **No silent failures.** Every operation must surface explicit success
  confirmation or itemized per-item warnings.
- **No native browser dialogs.** Never use `confirm()`, `prompt()`, or
  `alert()` — all confirmations go through in-app modals.
- **Always back up before deletion.** Prefer atomic sequences (e.g. clear
  both → apply both) over sequential partial operations that can leave
  state half-migrated.

## How I (Furqan) work

- Terse, directive instructions. Don't pad responses.
- I don't read code. Never show me code, diffs, or technical jargon as the
  primary explanation — explain things in plain English.
- Diagnose root cause before proposing a fix — don't guess at selectors,
  field names, or behavior. Read actual source, network captures, or HTML
  dumps first.
- Get my sign-off before irreversible structural decisions (e.g. removing
  previously-preserved code, changing data shape).
- Prefer a single validated implementation pass over iterative patching:
  diagnose → plan → sign-off → implement once with full validation.
- If project-attached files look stale or contradict this repo's actual
  files, this repo (real git checkout) is ground truth — flag the
  discrepancy, don't silently trust the stale copy.

## Fix → approve → ship workflow (default, always follow this)

1. After making a fix, give me a short plain-English summary: what the
   problem was, and what changed to fix it. No code, no jargon.
2. Wait for me to say "good" or otherwise approve. Do not proceed without
   this.
3. Once I approve: run the full validation checklist (see below), then
   commit and push directly to `main`.
4. **Never create a Pull Request unless I explicitly ask for one.** Push
   straight to `main` so GitHub Pages redeploys automatically and I can
   just refresh the live site to test.
5. If validation fails after I've approved the plain-English summary, tell
   me clearly what failed before pushing anything — don't push broken
   validation just because I approved the idea.

## Validation checklist — run before calling anything done

- `node --check` on all touched JS files — **Node.js is NOT installed on
  this machine** (confirmed 2026-08-29: no `node` on PATH, no
  `C:\Program Files\nodejs`, no global npm dir). Python 3 is installed and
  can be used for anything that needs it instead. For JS syntax checking
  without Node, load the file in a browser context (e.g. via the live
  verification flow below, or a `<script>` tag) and see if it parses/runs.
- HTML tag balance check
- Cross-reference every `getElementById` / `$()` call in JS against `id=`
  attributes in HTML — no dangling references
- No duplicate screen names
- All `data-back` targets resolve
- If a settings/profile change is involved, prefer running the actual logic
  live against a real account (see "Live settings-sync verification"
  below) over synthetic fixtures — `nuvio-settings-dump.json` doesn't exist
  in this checkout (see above), so don't rely on it being available.

## Testing notes

- Playwright pattern for this app: `add_init_script` to seed localStorage →
  `ctx.route()` to intercept `api.nuvio.tv` calls → `page.goto()` →
  `wait_for_timeout(1800ms+)` before screenshotting.
- `api.nuvio.tv` IS reachable from at least this sandbox (confirmed
  2026-08-29 — plain `curl` to it got a real 401, and full RPC round-trips
  worked). Don't assume it's unreachable; check before defaulting to
  route-interception mocks. (Older note said otherwise — environment-
  dependent, so verify rather than trust either claim.)
- For file-protocol HTML pages loading external JS modules, intercept
  network routes rather than `page.evaluate()`-stubbing module internals —
  module-level assignments may not resolve once the real modules have
  already initialized.

## Live settings-sync verification

`verify-settings-sync.js` (repo root) is a real, repeatable end-to-end
check: it drives the actual shipped `engine.js`/`api.js` against the real
Nuvio API to push every field Nuvio's schema defines from one real profile
to another, then checks each field landed correctly (or was correctly
blocked) per the three-bucket model, then restores both profiles. It has
to run in a browser tab already logged into `https://nuvio.tv/account`,
because that's the only place the real session token lives. See the file's
header comment for exact usage.

Why it's built the way it is (worth knowing before touching it):
- `nuvio.tv` sends CSP `script-src 'self' 'unsafe-inline'`. That blocks
  `<script src="other-origin">` AND `eval()`/`new Function()` of fetched
  text, but does NOT block an inline `<script>` element whose
  `.textContent` is set programmatically before `appendChild`. That's how
  the tool loads the live `engine.js`/`api.js`/`nuvio-settings-schema.js`
  onto the `nuvio.tv` origin — `fetch()` the source as text (fetch is
  allowed), then inject it as inline script content.
- It fetches those files from `https://numaxofficial.website/master/...`
  (the live deployment) rather than embedding a copy, specifically so the
  test always exercises exactly what's shipped, not a snapshot that can
  drift from it. `https://numaxofficial.github.io/...` (the raw Pages
  domain) does NOT work for this — `fetch` to it fails outright (no CORS
  headers), while the custom domain does send permissive CORS.
- The ANON key baked into `api.js` is the public Supabase anon JWT the app
  already ships to every browser — safe to reuse in tooling, not a secret.
- Every write is wrapped in try/finally: both profiles are pulled and
  backed up before any write, and restored (with a byte-for-byte verify)
  even if a step in between throws.

Last confirmed run: 2026-08-29, Test 1 -> Test 2 (profile_index 2 -> 3),
tv+mobile, real account. Result: 301 leaves checked, 0 failures — 292
fields copied correctly, 9 correctly blocked (API-key-shaped leaves) on a
default merge, 1 correctly blocked account-identity leaf
(`dismissedNextUpKeys`), both platform pushes used the guarded RPC and
succeeded. This confirms the `sync_push_profile_settings_blob_guarded`
fix (commit `0e819b1`) actually works live, and that Sync Desk's default
settings merge is currently working correctly end to end. If a future
"settings aren't applying" report comes in, re-run this first — it'll show
whether it's a regression or something more specific (a field this sweep
doesn't cover, e.g. desktop platform or addons/plugins/collections/watch
state, none of which this tool exercises yet).

**API key copy (TMDB/MDBList/debrid) verified working 2026-08-29**,
including the "overwrite matching keys" case: Test 1 -> Test 2, keys
marked with a test value, copied via `sync_copy_profile_setup` with
`p_replace_provider_credentials: true`, confirmed changed server-side,
then restored. Both Numax's push and Nuvio's own server-side copy work
correctly for this.

If a future "mobile [feature] didn't sync" report comes in and the data
checks out server-side (as above), **check the reporter's actual app
build before re-diagnosing the sync logic.** Root-caused once already:
an old sideloaded iOS build (pulled from the App Store before Nuvio was
taken down, can't auto-update) predates Nuvio's sync feature entirely and
silently keeps using its own locally-cached values — indistinguishable
from a real sync failure unless you check the account page's own version
banner ("Data sync requires Android TV 0.7.9 Beta or newer, mobile 0.2.9
Beta or newer... older clients will not sync account data at all"). A
newer sideloaded build on the same device synced correctly.

## Current known in-progress items

- API keys badge on Accounts tab renders before `loadAccount()` resolves —
  async timing fix in progress.
- Sync Desk preview panel should update live on selection change (currently
  requires a manual "Preview" click).
- `avatarId`-based preset avatars fall back to initial letter — hook exists
  but the catalog mapping data isn't wired up yet.

## Motion layer (`ui-motion.js`)

Added 2026-08-30. There is no framework, bundler or npm in this repo — the
Animate UI / Motion Primitives components were reproduced as plain CSS + JS,
not installed. **`ui-motion.js` owns no application state.** It observes the
classes and inline `display` flips `app.js` already performs and animates
around them, so it can be deleted and the app still works identically.

The contract, in both directions:

- **It reads:** `.on` (nav buttons, tabs, platform bar, sync sections),
  `[data-panel]` / `.pf-pane` / `.mo-enterable` display flips,
  `.sy-carry-chooser.open`, `.modal-root` display, `#sy-apply[disabled]`,
  `#sy-pv-status.shimmer`, and `data-bg` attributes.
- **`app.js` calls into it** only via `window.NumaxMotion` — `avatarGroup()`,
  `celebrate()`, `rail()`, `mountBg()` — always through the optional `M.` /
  `celebrate()` guards near the top of `app.js`, never as a hard dependency.
- Loaded **before** `app.js` in `index.html`.

Things that will silently break if changed without care:

- **The trailing-ellipsis convention.** `status()` adds the shimmer class only
  when a message ends in `…` and has no ok/err class. Every in-progress message
  in `app.js` ends in `…` and no static label does — keep it that way, or
  shimmer will land on a label that never stops.
- **The `.sy-carry-chooser` elements are moved, never rebuilt.** The morphing
  popover relocates the live node into a floating surface and puts it back on
  close. `renderSyItem()` / `renderSyTree()` clearing and refilling them is
  fine; replacing the node itself, or changing its `id`, is not.
- **The sliding indicators replace per-item backgrounds.** `.navbtn.on`,
  `.set-tab.on`, `.set-platbar button.on`, `.sy-set-sec.on` have had their own
  backgrounds overridden to transparent — the shared `.mo-ind` draws them. Bars
  that `app.js` destroys and rebuilds (settings tabs, platform bar, sync
  sections) still slide because `lastBox` remembers the previous geometry.
- Backgrounds are one canvas engine, one look per screen, paused by
  IntersectionObserver and `visibilitychange`. Verified 2026-08-30: exactly one
  canvas draws at a time, ~60fps visible, **zero** draws while the tab is
  hidden. Don't add a second `data-bg` to a screen that already has one.

## Verifying UI changes without Node

`file://` won't work — the browser pane serves it as a `data:` snapshot and the
relative `<script src>` tags never load, so every module reads as `undefined`.
Serve it instead (Python is present, Node is not):

```
python -m http.server 8731
```

then drive it at `http://localhost:8731/`. Measurement beats screenshots here:
the pane scales oddly, and `requestAnimationFrame` is throttled while the pane
is hidden, so a `getBoundingClientRect()` taken too soon after a click will
read a stale position and look like a bug that isn't one.

## Style

- Solid dark-navy background, Fraunces / Space Grotesk / Space Mono
  typography, glass blur reserved for topbar and modal only, deliberate
  card hierarchy (`pf-head-card`, `pf-name-card`, `pf-tabs-card`, etc.).
- Viewport-fit layouts — no page-level scroll — on Accounts, Profiles, and
  Sync Desk tabs.
- No animated mascot — it was fully removed (state machine, SVG assets,
  CSS, settings card) and should not be reintroduced without being asked.
