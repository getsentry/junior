# Recording Proxy

A recording HTTP proxy for tests. It records chosen requests to files and
replays them. Other requests go live without a change. The proxy owns every
read and write of the recordings. A test runner only gives it rules and
tells it when each test starts and ends.

This directory has no Junior code. It uses only Node built-ins and the
`openssl` command. Do not import anything from outside this directory, so
the proxy can move to its own package or repository.

- `recording-proxy.ts`: the server, and the `prune` command.
- `client.ts`: starts the server in its own process and calls its control
  API.

## Use

```ts
import {
  connectRecordingProxy,
  describeRecordingStats,
  spawnRecordingProxy,
} from "./client";

const proxy = await spawnRecordingProxy({
  directory: "recordings",
  mode: "auto",
  allow: ["https://ai-gateway.vercel.sh"],
  rules: [
    {
      name: "model",
      match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
      key: { headers: ["ai-model-id"], ignore: [ISO_TIME] },
    },
  ],
});
// Give `proxy.env` to the processes that send traffic.
spawn("vitest", { env: { ...process.env, ...proxy.env } });

// In a test worker, with the `url` and `token` of the proxy:
const control = connectRecordingProxy({ url, token });
await control.startSession(testName);
await control.endSession(passed);

console.log(describeRecordingStats(await proxy.stats()));
await proxy.close();
```

- `proxy.env` has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
  `NODE_USE_ENV_PROXY`, and `NODE_EXTRA_CA_CERTS`. Node 24 reads the last two
  only at startup. A process that is already running must set its own
  agents.
- The proxy intercepts HTTPS with its own certificate authority, so clients
  must trust `caCert`.
- One session is open at a time. The proxy keeps the new recordings of a
  session in memory. A passed session writes them, and a failed session
  drops them. A request outside a session is written at once.
- `spawnRecordingProxy(config, { launcher })` runs the proxy with a command
  prefix, such as `sudo`. Use it when the caller cannot reach the network,
  but the proxy must.

## Config

- `directory`: where the recordings are. Each rule has a subdirectory.
- `mode`: `auto` replays recordings and records misses. `record` sends every
  request live and records it again. `off` records and replays nothing.
- `allow`: the only origins that the proxy sends requests to, such as
  `https://ai-gateway.vercel.sh`. It refuses all other origins with HTTP 403.
  The upstream host always comes from this list, not from the client.
- `rules`: the traffic to record. `match` has `method`, `url` (a prefix),
  and `headers`. `key.headers` adds request headers to the key.
  `key.ignore` lists regular expressions that the key ignores in the body,
  such as times.
- `usedFile`: when the proxy stops, it lists here the recordings that passed
  sessions used.

## Prune

```sh
node --experimental-strip-types recording-proxy.ts prune <directory> <used-file>...
```

Deletes the recordings that no used file lists. Give it the used files of
every run that shares the directory, or it deletes recordings that another
run needs.

## Control API

All calls need `Authorization: Bearer <token>`.

- `POST /__recording-proxy/session` with `{"name": "..."}`: open a session.
- `POST /__recording-proxy/session/end` with `{"passed": true}`: end it.
- `GET /__recording-proxy/stats`: the totals of the run.
