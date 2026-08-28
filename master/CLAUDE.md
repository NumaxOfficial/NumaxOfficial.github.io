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
stored in localStorage under `nuvio.supabase.session`. Key RPCs:
`sync_export_account_backup`, `sync_push_profiles`, `sync_push_addons`,
`sync_push_settings`.

Settings schema shape: `features.<group>_settings.<field> = {type, value}`.
243 fields are extracted into `window.NUVIO_SETTINGS` — treat this and
`nuvio-settings-dump.json` as ground truth over any inference.

## Safety rules (non-negotiable)

- **Three-bucket settings model**: `SECRET_LEAF` (never copy),
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

## Validation checklist — run before calling anything done

- `node --check` on all touched JS files
- HTML tag balance check
- Cross-reference every `getElementById` / `$()` call in JS against `id=`
  attributes in HTML — no dangling references
- No duplicate screen names
- All `data-back` targets resolve
- If a settings/profile change is involved, run the logic against real data
  in `nuvio-settings-dump.json`, not synthetic fixtures

## Testing notes

- Playwright pattern for this app: `add_init_script` to seed localStorage →
  `ctx.route()` to intercept `api.nuvio.tv` calls → `page.goto()` →
  `wait_for_timeout(1800ms+)` before screenshotting.
- `api.nuvio.tv` is not reachable from most sandboxes — always mock it via
  route interception rather than assuming live network access.
- For file-protocol HTML pages loading external JS modules, intercept
  network routes rather than `page.evaluate()`-stubbing module internals —
  module-level assignments may not resolve once the real modules have
  already initialized.

## Current known in-progress items

- API keys badge on Accounts tab renders before `loadAccount()` resolves —
  async timing fix in progress.
- Watch Progress and Watched tabs need to become saveable as templates in
  Sync Desk.
- Sync Desk preview panel should update live on selection change (currently
  requires a manual "Preview" click).
- `avatarId`-based preset avatars fall back to initial letter — hook exists
  but the catalog mapping data isn't wired up yet.

## Style

- Solid dark-navy background, Fraunces / Space Grotesk / Space Mono
  typography, glass blur reserved for topbar and modal only, deliberate
  card hierarchy (`pf-head-card`, `pf-name-card`, `pf-tabs-card`, etc.).
- Viewport-fit layouts — no page-level scroll — on Accounts, Profiles, and
  Sync Desk tabs.
- No animated mascot — it was fully removed (state machine, SVG assets,
  CSS, settings card) and should not be reintroduced without being asked.
