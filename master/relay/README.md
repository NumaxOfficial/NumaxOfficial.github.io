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

## If you ever want it on your own domain instead

Add a route for `numaxofficial.website/relay/aio-create` pointing at the Worker,
and set `RELAY` to that path. Keep it outside whatever Cloudflare Access rule
covers `/master`, or Access will intercept the call before the Worker sees it.
