# Roach client

Roach is a recording HTTPS proxy for tests. It records chosen requests and
replays them, so a second run of a test suite makes no live calls. Roach is
a shared service: [`getsentry/roach`](https://github.com/getsentry/roach).
Sentry runs it at `https://roach-proxy.getsentry.net`. The service owns every
read and write of the recordings. It keeps them in a GCS bucket, which
deletes each one 30 days after it was written.

This directory is a copy of the client side of `getsentry/roach` at commit
`653c28e`. It has no Junior code and uses only Node built-ins. The package
`@sentry/roach` is not on npm, and pnpm does not install it from git,
because its `prepare` script must run. When the package is on npm, use it
and delete this directory.

## Files

- `client.ts`: `startRemoteRun()` starts a run on the service.
  `connectRoach()` opens and ends the session of each test from a test
  worker. From `src/client.ts` of `getsentry/roach`. `CONTROL_PATH` is a
  constant here, because `server.ts` is not copied.
- `types.ts`: rules, modes, runs, and the results of a run. From
  `src/types.ts`, with `RunConfig` and `RemoteRun` from `src/service.ts`.
- `values.ts`: `VALUE_PATTERNS` and `NOT_AFTER_WORD`. From `src/values.ts`,
  without the functions that only the service uses.
- `report.ts`: text reports of a run. From `src/report.ts`.

To update the copy, copy these files again from `getsentry/roach`, keep
the changes above, and change the commit in this file.

The `README.md` of `getsentry/roach` tells how the service keys, records,
and replays requests, and how its control API works.
