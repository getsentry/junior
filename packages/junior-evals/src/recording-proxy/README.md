# Recording Proxy

A recording HTTP proxy for tests. It records chosen requests to files and
replays them. Other requests go live without a change.

This directory has no Junior code. `recording-proxy.ts` uses only Node
built-ins and the `openssl` command. Do not import anything from outside this
directory, so the proxy can move to its own package or repository.

## Use

- Start it with `spawnRecordingProxy(config)`, or run
  `node recording-proxy.ts <config.json>`. The command writes one JSON line
  with `url`, `caCert`, and `secret` when the proxy is ready.
- Send traffic through `url` with `HTTPS_PROXY` or an undici `ProxyAgent`.
  The proxy ignores proxy variables in its own environment.
- `spawnRecordingProxy(config, { launcher })` runs the proxy with a command
  prefix, such as `sudo`. Use it when the caller cannot reach the network,
  but the proxy must.
- The client must trust `caCert`. The proxy signs a certificate for each
  HTTPS host, so it can read the requests.
- Send proxy credentials with `secret` as the password. The control API
  needs `Authorization: Bearer <secret>`. Without the secret, the proxy sends
  no request. It listens only on 127.0.0.1.
- Give each test its own session. Put the session id in the user name of the
  proxy credentials. Commit the session when the test passes, and discard it
  when the test fails.

## Config

- `directory`: where the recordings are. Each rule has a subdirectory.
- `origins`: the allow list, such as `https://ai-gateway.vercel.sh`. The
  proxy sends requests only to these origins. It refuses all other origins
  with HTTP 403. The upstream host always comes from this list, not from the
  client.
- `rules`: the traffic to record. A rule matches on `method`, `urlPrefix`,
  and `headers`. `ignore` lists regular expressions that the key ignores in
  the body, such as times. `keyHeaders` lists request headers that are part
  of the key. `mode` is `off`, `auto`, or `record`.

`GET /__recording-proxy/stats` returns the totals of the run: replayed and
live counts by rule, how many recordings were new or changed, how many were
dropped, and the origins of requests that matched no rule.

The comment at the top of `recording-proxy.ts` has the full behavior and the
control API.
