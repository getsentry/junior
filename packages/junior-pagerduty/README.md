# @sentry/junior-pagerduty

`@sentry/junior-pagerduty` adds read-only PagerDuty lookups to Junior through the PagerDuty REST API. Use it to answer on-call, handoff, schedule, escalation policy, service, team, and incident questions.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-pagerduty
```

## Configure

Add the package name to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-pagerduty"]);
```

Set a PagerDuty REST API key in the Junior deployment environment:

```bash
PAGERDUTY_API_KEY=...
```

Use an account-level General Access REST API key with **Read-only API Key** enabled. An admin or account owner creates it in **Integrations > Developer Tools > API Access Keys**.

## Auth model

- The plugin uses one deployment-level PagerDuty API key. Users do not connect individual PagerDuty accounts.
- The real key stays on the host. Junior adds `Authorization: Token token=<key>` to sandbox requests to `api.pagerduty.com`.
- The key is the read-only boundary. The bundled skill also uses only `GET` requests.

The manifest covers the US service region only. EU-region accounts (`api.eu.pagerduty.com`) need a manifest change.

Full setup guide: https://junior.sentry.dev/extend/pagerduty-plugin/
