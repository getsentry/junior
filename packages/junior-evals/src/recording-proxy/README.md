# Recording Proxy

A recording HTTP proxy for tests. It records chosen requests to files in git
and replays them, so a second run of a test suite makes no live calls. The
proxy owns every read and write of the recordings. A test runner only gives
it rules and tells it when each test starts and ends.

This directory has no Junior code. It uses only Node built-ins and the
`openssl` command. Do not import anything from outside this directory, so
the proxy can move to its own package or repository.

## Use

```ts
import { spawnRecordingProxy, connectRecordingProxy } from "./client";
import { describeRecordingStats } from "./report";
import { VALUE_PATTERNS } from "./values";

// Once per run.
const proxy = await spawnRecordingProxy({
  directory: "recordings",
  mode: "auto",
  allow: ["https://ai-gateway.vercel.sh"],
  rules: [
    {
      name: "model",
      match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
      keyHeaders: ["ai-model-id"],
      values: { uuid: VALUE_PATTERNS.uuid, time: VALUE_PATTERNS.isoTime },
    },
  ],
});
spawn("vitest", { env: { ...process.env, ...proxy.env } });

// Once per test, in a worker that has the `url` and `token` of the proxy.
const session = await connectRecordingProxy({ url, token }).startSession(
  testName,
);
const { missed } = await session.end(passed);
// In `replay` mode, fail the test when `missed` is not 0.

// At the end of the run.
console.log(describeRecordingStats(await proxy.stats()));
await proxy.close();
```

- `proxy.env` has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
  `NODE_USE_ENV_PROXY`, and `NODE_EXTRA_CA_CERTS`. Node 24 reads the last two
  only at startup. A process that is already running must set its own
  agents.
- `spawnRecordingProxy(config, { launcher })` runs the proxy with a command
  prefix, such as `sudo`. Use it when the caller cannot reach the network,
  but the proxy must.

## Config

`types.ts` has the full types.

- `directory`: where the recordings are. Each rule has a subdirectory.
- `mode`: `auto` replays recordings and records misses. `replay` replays
  recordings and fails a miss with HTTP 412, so nothing goes live. `record`
  sends every request live and records it again. `off` records and replays
  nothing.
- `allow`: the only origins that the proxy sends requests to. It refuses all
  other origins with HTTP 403. The upstream host always comes from this
  list, not from the client.
- `rules`: the traffic to record. `match` has `method`, `url` (a prefix),
  and `headers`. `keyHeaders` adds request headers to the key. `values`
  names the values that change from run to run.
- `usedFile`: when the proxy stops, it lists here the recordings that
  sessions used. `cli.ts prune` takes these files.
- `missDirectory`: for each miss, the proxy writes the request as the key
  sees it, and its diagnosis, to `<missDirectory>/<rule>/<key>.json`. These
  files contain request bodies. Do not commit them.

Requests that match no rule go live without a change, and their responses
stream. Each response has an `x-recording-proxy` header: `replayed`, `live`,
`missed`, or `passthrough`.

## Recordings

A recording is `<directory>/<rule>/<key>.json`. The key is the hash of the
rule, the method, the URL, the key headers, and the body. A JSON body has
sorted keys. A recording keeps the response, the session that recorded it,
and a short hash of each part of the request. It does not keep the request
body.

- One session is open at a time. The proxy keeps the new recordings of a
  session in memory. A passed session writes them, and a failed session
  drops them, so a bad sample is never replayed.
- A request belongs to the session that was open when it started. If it
  ends after its session ended, it follows the result of that session.
- A request outside a session is written at once.
- A 429 or 5xx response is never recorded. A replay does not write the
  file again.

## Changing values

Ids and times change on each run, and a response often repeats them. For
example, the model archives the memory with the id that its request
showed. `values` of a rule maps a name to a regular expression source.
`VALUE_PATTERNS` in `values.ts` has `uuid`, `isoTime`, `date`, and
`epochMs`. When two patterns match at the same place, the first one wins.

- The key sees each value as `<<name>>`. So two runs with other ids or
  times use the same recording.
- When the proxy records a response, it writes each value of the request as
  `<<name:n>>`: the n-th value of that name in the request.
- On replay, the proxy writes the n-th value of the current request there.
  A replayed response thus uses the ids of this run.
- A value that the response makes itself, such as a date that a model
  calculates, stays as it was recorded.
- Values in thinking blocks of the request do not count for `n`. A replay
  keeps the recorded text of a thinking block, so when a later request sends
  it back, its values come from the recording run.

Model streams send a tool call in many small deltas, so a value can be
split over two events. Before it records a `text/event-stream`, the proxy
merges the deltas of each Anthropic Messages content block into one event.
Thinking blocks keep their recorded text, because their signature covers
it, and the provider refuses a changed thinking block.

Keep the patterns narrow. A broad pattern makes requests that differ in a
real way use the same recording.

## Misses

The parts of a request are the method, the URL, each key header, each
top-level field of a JSON body, and each item of a top-level array, such as
`messages[3]`. For a request without a recording, the proxy finds the
recording with the most equal parts, from the same session if it can. It
logs the parts that differ and adds the miss to `stats().misses`.
`describeRecordingMisses()` in `report.ts` gives the first miss of each
test, which is the one to fix.

## Command line

```sh
node --experimental-strip-types cli.ts serve < config.json
node --experimental-strip-types cli.ts prune <directory> <used-file>...
```

`serve` prints the address of the proxy as one JSON line. `client.ts` runs
it. `prune` deletes the recordings that no used file lists. Give it the used
files of every run that shares the directory, or it deletes recordings that
another run needs.

## Control API

All calls need `Authorization: Bearer <token>`. `client.ts` calls them.

- `POST /__recording-proxy/session` with `{"name": "..."}`: open a session.
- `POST /__recording-proxy/session/end` with `{"name": "...", "passed": true}`:
  end it. Returns `{"missed": 0}`, the misses that `replay` mode failed.
  Returns HTTP 409 when the session is not open.
- `GET /__recording-proxy/stats`: the totals of the run.

## Files

- `types.ts`: the configuration and the results.
- `server.ts`: sockets, HTTPS interception, the allow list, and the control
  API.
- `recorder.ts`: modes, sessions, replay, and misses.
- `request-key.ts`: the key and the parts of a request.
- `recordings.ts`: the recording files, the miss index, and prune.
- `values.ts`: changing values and their placeholders.
- `streams.ts`: merges the deltas of a recorded model stream.
- `certificates.ts`: the certificate authority for HTTPS.
- `client.ts`: starts the proxy in its own process and calls its control
  API.
- `report.ts`: text reports of a run.
- `cli.ts`: the command line.
