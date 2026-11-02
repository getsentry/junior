# Roach client

- This is a copy of the client side of
  [`getsentry/roach`](https://github.com/getsentry/roach) at commit `9c623c0`.
  Delete it when `@sentry/roach` is on npm.
- Do not add Junior code or dependencies other than Node built-ins.
- Local changes from upstream: `client.ts` has `CONTROL_PATH` as a constant
  (no `server.ts`); `types.ts` adds `RunConfig` and `RemoteRun` from
  `src/service.ts`; `values.ts` drops the functions that only the service uses.
- To update, copy `client.ts`, `types.ts`, `values.ts`, and `report.ts` again,
  keep the local changes, and change the commit above.
