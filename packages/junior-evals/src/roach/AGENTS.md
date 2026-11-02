# Roach Client

- This directory is a copy of the client side of
  [`getsentry/roach`](https://github.com/getsentry/roach) at commit `9c623c0`
  (getsentry/roach#11). The service owns every read and write of recordings.
- It has no Junior code and uses only Node built-ins. Keep it that way.
- `@sentry/roach` is not on npm, and pnpm cannot install it from git because
  its `prepare` script must run. When it is on npm, use it and delete this
  directory.
- Local changes from upstream: `client.ts` has `CONTROL_PATH` as a constant
  (no `server.ts`); `types.ts` adds `RunConfig` and `RemoteRun` from
  `src/service.ts`; `values.ts` drops the functions that only the service uses.
- To update, copy `client.ts`, `types.ts`, `values.ts`, and `report.ts` again,
  keep the local changes, and change the commit above.
- Junior rules for recordings are in `packages/junior-evals/AGENTS.md`.
