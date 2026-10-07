# Recording Proxy

A recording HTTP proxy for tests. It records chosen requests to files and
replays them. Other requests go live without a change.

This directory has no Junior code. `recording-proxy.ts` uses only Node
built-ins and the `openssl` command. Do not import anything from outside this
directory, so the proxy can move to its own package or repository.

## Use

- Start it with `spawnRecordingProxy(config)`, or run
  `node recording-proxy.ts <config.json>`. The command writes one JSON line
  with `url` and `caCert` when the proxy is ready.
- Send traffic through `url` with `HTTPS_PROXY` or an undici `ProxyAgent`.
- The client must trust `caCert`. The proxy signs a certificate for each
  HTTPS host, so it can read the requests.
- Give each test its own session. Put the session id in the user name of the
  proxy credentials. Commit the session when the test passes, and discard it
  when the test fails.

## Config

- `directory`: where the recordings are. Each rule has a subdirectory.
- `rules`: the traffic to record. A rule matches on `method`, `urlPrefix`,
  and `headers`. `ignore` lists regular expressions that the key ignores in
  the body, such as times. `mode` is `off`, `auto`, or `record`.

The comment at the top of `recording-proxy.ts` has the full behavior and the
control API.
