# @sentry/junior-sentry

`@sentry/junior-sentry` adds read-only Sentry investigation workflows to Junior via per-user OAuth.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

## Sentry CLI Surface

The plugin installs the npm `sentry` package as a runtime dependency and injects the current user's OAuth token as `SENTRY_AUTH_TOKEN` for Sentry skill commands.

As of 2026-04-30, `sentry@latest` is `0.30.0`. The verified command groups used by the bundled skill are:

- `sentry issue list|events|explain|plan|view`
- `sentry org list|view`
- `sentry log list|view`
- `sentry trace list|view|logs`
- `sentry api <endpoint>`

The skill must verify live `sentry --help` output before declaring a Sentry data surface unavailable. Prefer singular command groups such as `sentry org list`; do not use stale forms such as `sentry organizations list`.

Full setup guide: https://junior.sentry.dev/extend/sentry-plugin/
