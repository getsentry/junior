# @sentry/junior-sentry

`@sentry/junior-sentry` adds Sentry investigation workflows and explicitly requested alert/monitor creation to Junior via per-user OAuth.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

Add the package name to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-sentry"]);
```

## Sentry CLI Surface

The plugin installs the npm `sentry` package as a runtime dependency and injects the current user's OAuth token as `SENTRY_AUTH_TOKEN` for Sentry skill commands. The OAuth grant includes `alerts:write`; existing connections must reconnect after upgrading to grant it.

As of 2026-07-13, `sentry@latest` is `0.38.0`. The verified command groups used by the bundled skill are:

- `sentry issue list|events|explain|plan|view`
- `sentry org list|view`
- `sentry log list|view`
- `sentry trace list|view|logs`
- `sentry alert metrics list|view|create|edit|delete`
- `sentry api <endpoint>` as a fallback when no first-class command covers the request

The skill must verify live `sentry --help` output before declaring a Sentry data surface unavailable. Prefer singular command groups such as `sentry org list`; do not use stale forms such as `sentry organizations list`.

Full setup guide: https://junior.sentry.dev/extend/sentry-plugin/
