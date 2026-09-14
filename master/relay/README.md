# The AIOStreams relay

One small Cloudflare Worker. It is the only piece of Numax that runs anywhere
other than the browser, and it exists for exactly one reason: the Setup Wizard's
**Do it all for me** path has to create an AIOStreams configuration, and a web
page is not allowed to make that call.

AIOStreams switches its cross-origin permission on only when an instance runs in
development mode. Checked against all 12 public instances on 2026-09-10: none of
them allow it. Everything else the wizard does, it does from the page.

It forwards to nothing except `/api/v1/user` on a hostname the uptime tracker
currently lists as a public AIOStreams instance. It keeps no data and never logs
a request body, because that body carries the user's TorBox key.

## Deploy it (about two minutes, once)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Start with Hello
   World** → **Deploy**. Name it something like `numax-aio-create`.
2. Press **Edit code**, select everything in the editor, paste in the whole of
   [`aio-create.js`](aio-create.js), and **Deploy**.
3. Copy the URL it gives you — it looks like
   `https://numax-aio-create.<your-subdomain>.workers.dev`.
4. Put that URL into `RELAY` near the top of [`../wizard.js`](../wizard.js),
   then commit and push.

There is nothing to configure: no secrets, no environment variables, no KV, no
database. The free plan covers it many times over — one request per wizard run.

Until step 4 is done the wizard behaves correctly: the "Do it all for me" card
says the automatic setup is not switched on yet and points at the manual path.
It does not fail silently.

## Check it is working

    curl -i -X POST https://numax-aio-create.<your-subdomain>.workers.dev \
      -H 'Content-Type: application/json' \
      -d '{"instance":"https://example.com","config":{},"password":"abcdef"}'

A correct deployment answers **403** with
`example.com is not on the public AIOStreams instance list…`. That single reply
proves the Worker is live, parsing JSON, and enforcing its allowlist.

## Re-paste it after 2026-09-13

`aio-create.js` gained a second, much smaller job on 2026-09-13: answering
"is this TorBox API key real?" for the wizard's **Nuvio + TorBox** path. The
page cannot ask TorBox itself — `api.torbox.app` only accepts cross-origin
calls from `https://torbox.app` and refuses every other origin outright.

Nothing breaks if you do not re-paste it. The tick next to the TorBox key box
simply says **couldn't check** instead of going green, which is what it also
says when TorBox itself is down. Re-pasting is steps 2 and 3 above again.

Check it worked:

    curl -i -X POST https://numax-aio-create.<your-subdomain>.workers.dev \
      -H 'Content-Type: application/json' \
      -d '{"op":"verify","provider":"torbox","key":"notarealkey"}'

The new version answers **200** with `{"ok":false}`. The old one answers
**400** with `No instance was given.`

## If you ever want it on your own domain instead

Add a route for `numaxofficial.website/relay/aio-create` pointing at the Worker,
and set `RELAY` to that path. Keep it outside whatever Cloudflare Access rule
covers `/master`, or Access will intercept the call before the Worker sees it.


---

# The community-collections relay

A second Worker, the same shape as the one above and just as small. It exists
because Nuvio's community-collections API lives on `nuvio.tv` (not
`api.nuvio.tv`), needs a real Nuvio login, and sends **no CORS headers** — a
cross-origin request fails before it even reaches the auth check. Numax's own
tab therefore cannot read it, which is why the Collections tab browses a
snapshot that was captured by hand and has to be re-captured by hand.

Deploying this makes that tab **live**.

## Deploy it (about two minutes, once)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Start with Hello
   World** → **Deploy**. Name it something like `numax-collections`.
2. Press **Edit code**, select everything in the editor, paste in the whole of
   [`collections.js`](collections.js), and **Deploy**.
3. Copy the URL it gives you.
4. Put that URL into `COLLECTIONS_RELAY` near the top of
   [`../market.js`](../market.js), then commit and push.

Until step 4 is done the Collections tab behaves exactly as it does today: it
browses the captured snapshot and says so on screen. Nothing fails, and nothing
pretends to be live that isn't.

## What it does, and what it does not

It forwards two GETs and nothing else — the collection list, and one
collection's detail. It has no KV, no database, no secrets and no
configuration. It keeps nothing between requests and never logs a request body,
because that body carries the caller's own Nuvio session token — the same token
this browser already sends to `api.nuvio.tv` on every other call. Every reply
goes out with `Cache-Control: no-store` and Cloudflare caching explicitly off,
because every reply is scoped to one person's login.

## Check it is working

    curl -i -X POST https://numax-collections.<your-subdomain>.workers.dev \
      -H 'Content-Type: application/json' -d '{"op":"list","token":"x"}'

A correct deployment answers **400** with `Missing or malformed Nuvio session
token.` — that single reply proves the Worker is live, parsing JSON, and
validating its input before it forwards anything.

# The plugin-provider filter

A third Worker, and the only one that carries an ongoing cost worth
understanding before you deploy it. **Read this section before pasting the URL
in.**

## Why it has to exist

Nuvio syncs a plugin repository as one row — `{url, name, enabled, …}` — with
no per-provider field of any kind, and the per-provider switches live on the
device and never reach the account. So "install only 6 of these 61 providers"
cannot be written to Nuvio directly. The only thing that can carry a selection
is the manifest itself, because the manifest is the only thing the stored row
points at.

This Worker serves a copy of a public repository's manifest with the providers
you did not tick removed. Nuvio sees a repository that simply contains 6
providers.

## The cost, stated plainly

A provider's `filename` in a manifest is **relative** (`providers/4khdhub.js`),
so whoever serves the manifest must also serve the provider code sitting next
to it. That means: **a device using a filtered repository downloads that
repository's JavaScript through your Cloudflare account.** It is a
pass-through — nothing is rewritten and nothing is stored — but it is your
bandwidth and your account's name on the request.

Two things keep that bounded, and both are deliberate:

- Numax writes a filtered URL **only when the user picks a subset**. Tick every
  provider and it writes the plain upstream URL, and this Worker is not in the
  path at all.
- The Worker only fetches from an allowlist of forges (`raw.githubusercontent.com`,
  `codeberg.org`, `gitlab.com` and a few more). It is not a general proxy, and
  a request for anything outside a repository's own directory is refused.

## Deploy it (about two minutes, once)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Start with Hello
   World** → **Deploy**. Name it something like `numax-plugin-filter`.
2. Press **Edit code**, select everything in the editor, paste in the whole of
   [`plugins.js`](plugins.js), and **Deploy**.
3. Copy the URL it gives you.
4. Put that URL into `PLUGIN_FILTER_RELAY` near the top of
   [`../market.js`](../market.js), then commit and push.

Until step 4 is done, the provider tick-boxes **do not appear at all** —
neither in the Setup Wizard nor in the Marketplace. Repositories install whole,
exactly as they do today. A tick Numax cannot honour is worse than no tick, so
the picker hides itself rather than offering one.

## Check it is working

    curl -i https://numax-plugin-filter.<your-subdomain>.workers.dev/

A correct deployment answers **404** with `This Worker serves filtered Nuvio
plugin manifests.` — that proves it is live and routing. For a real end-to-end
check, tick two providers of a repository in Numax, add it to a test profile,
open the stored URL in a browser, and confirm the manifest that comes back
lists exactly those two.

## The one thing only the Nuvio app can confirm

Numax cannot verify how Nuvio resolves a provider's relative `filename` — that
happens inside the app. Everything points one way (the filenames are relative,
and both plausible resolutions land back on this Worker), but the proof is:
add a filtered repository to a profile, open Nuvio, enable one of its providers
under **Settings → Content & Discovery → Plugins**, and play something. If the
provider returns results, the whole path works.

**Note that adding a repository still does not switch its providers on.** The
filter changes which providers Nuvio can see, not whether they run — that
switch is on the device either way.
