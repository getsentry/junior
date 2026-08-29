---
title: Config & Environment
description: Required and optional environment variables for the Junior runtime.
type: reference
summary: Look up core runtime, dashboard, sandbox, and createApp configuration without plugin-specific setup.
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/
  - /concepts/security-and-authority/
  - /operate/security-hardening/
---

## Core runtime

| Variable                                    | Required    | Purpose                                                                                                                                                                     |
| ------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack request signatures.                                                                                                                                          |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts thread replies and calls Slack APIs.                                                                                                                                  |
| `REDIS_URL`                                 | Yes         | Runtime state, locks, and durable background task records. Vercel Queues only deliver wakeups.                                                                              |
| `DATABASE_URL`                              | Yes         | Standard Neon/Vercel Postgres URL for Junior SQL records and reporting.                                                                                                     |
| `JUNIOR_DATABASE_DRIVER`                    | No          | SQL client driver for Junior records: `neon` or `postgres`. Defaults to `neon`; set `postgres` for local Postgres or node-postgres deployments.                             |
| `JUNIOR_SQL_STATEMENT_TIMEOUT_MS`           | No          | PostgreSQL runtime statement timeout in milliseconds. Defaults to `30000` (30 seconds); set `0` to disable. This does not limit `junior upgrade` migrations.                |
| `JUNIOR_CONVERSATION_WORK_ENABLED`          | No          | Operational kill switch for queue processing and heartbeat recovery. Defaults to `true`; set `false` to acknowledge wakes without running or recovering conversation work.  |
| `JUNIOR_SECRET`                             | Yes         | Signs internal queue/callback payloads and sandbox egress actor context.                                                                                                    |
| `JUNIOR_BOT_NAME`                           | No          | Bot display/config naming.                                                                                                                                                  |
| `JUNIOR_SLASH_COMMAND`                      | No          | Slack slash command for account-management flows. Defaults to `/jr`; the Slack app command must match this value.                                                           |
| `JUNIOR_CROSS_ACTOR_MID_RUN_MODE`           | No          | Cross-actor Slack steering policy. Defaults to `follow_up`; see below.                                                                                                      |
| `AI_MODEL`                                  | No          | Deprecated profile setting. Creates `standard` and remains the fallback for `AI_FAST_MODEL`. Defaults to `xai/grok-4.5`.                                                    |
| `AI_REASONING_LEVEL`                        | No          | Fixed main-agent reasoning level: `none`, `low`, `medium`, `high`, or `xhigh`. Unset by default; only the unset state enables per-turn reasoning routing.                   |
| `AI_FAST_MODEL`                             | No          | Faster model for lightweight tasks and routing/classification passes before the main turn begins. Defaults to `anthropic/claude-haiku-4.5`.                                 |
| `AI_GUARDIAN_MODEL`                         | No          | Model for Guardian action review. Defaults to `openai/gpt-5.6-luna`.                                                                                                        |
| `AI_HANDOFF_MODEL`                          | No          | Deprecated profile setting. Creates `handoff`. Defaults to `openai/gpt-5.6-sol`.                                                                                            |
| `AI_MODEL_PROFILES`                         | No          | Deprecated JSON map of profile names to model IDs for env-only setup. Names must match `^[a-z][a-z0-9_-]*$`.                                                                |
| `AI_EMBEDDING_MODEL`                        | No          | Embedding model for plugin-owned vector retrieval. Defaults to `openai/text-embedding-3-small`; memory v1 stores fixed 1536-dimensional vectors.                            |
| `AI_VISION_MODEL`                           | No          | Dedicated image-understanding model; unset disables vision features.                                                                                                        |
| `AI_WEB_SEARCH_MODEL`                       | No          | Override for the `webSearch` tool model. Defaults to `openai/gpt-5.4`; does not fall through to `AI_MODEL`.                                                                 |
| `SANDBOX_VCPUS`                             | No          | Legacy fallback for sandbox vCPUs and the build-time snapshot command. Prefer `createApp({ sandbox: { vcpus } })` for runtime sandboxes. Each vCPU provides 2 GB of memory. |
| `VERCEL_SANDBOX_KEEPALIVE_MS`               | No          | Extends an active sandbox by this duration on each tool acquire. Disabled when unset or `0`; `900000` (15 minutes) is recommended for production Vercel deployments.        |
| `JUNIOR_BASE_URL`                           | No          | Main base URL for callback and authorization URLs.                                                                                                                          |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Optional namespace prepended to all state-adapter keys, locks, and queues. Use separate prefixes when sharing one Redis database across environments.                       |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET`  | Conditional | Bearer token for the internal heartbeat route; use `CRON_SECRET` with Vercel Cron, or `JUNIOR_SCHEDULER_SECRET` for a non-Vercel heartbeat caller.                          |
| `JUNIOR_TIMEZONE`                           | No          | Default IANA timezone for scheduler authoring when the scheduler plugin is enabled. Defaults to `America/Los_Angeles`.                                                      |
| `AI_GATEWAY_API_KEY`                        | No          | Fallback AI Gateway auth when Vercel OIDC is unavailable (local/CI/non-Vercel hosts). On Vercel, prefer project OIDC so usage attributes to the project.                    |
| `BLOB_STORE_ID`                             | Conditional | Vercel Blob store for durable conversation attachments and published public artifacts. Vercel sets this when an OIDC-enabled Blob store is connected to the project.        |
| `BLOB_READ_WRITE_TOKEN`                     | Conditional | Static Vercel Blob credential when OIDC is unavailable. Vercel sets this for a token-connected store.                                                                       |

For Vercel deployments, create a private Blob store and connect it to the
project before using `sendFiles` or `publishImage`. Prefer an OIDC connection.
It supplies `BLOB_STORE_ID` and uses Vercel's short-lived OIDC credential. Use
`BLOB_READ_WRITE_TOKEN` for local development, CI, non-Vercel hosts, or as a
fallback. See [Deploy to Vercel](/start-here/deploy-to-vercel/#configure-attachment-storage).

Junior applies `JUNIOR_SQL_STATEMENT_TIMEOUT_MS` through PostgreSQL `statement_timeout` for both the Neon and node-postgres drivers. `junior upgrade` does not apply this runtime limit because schema migrations can legitimately take longer.

`JUNIOR_CROSS_ACTOR_MID_RUN_MODE=follow_up` keeps another actor's mid-run ask
for its own turn. Set it to `steer` to preserve collaborative steering across
actors. In `follow_up` mode, a user can start one message with `!!` to steer the
active turn explicitly.

Model profile names are durable conversation bindings. Each later turn resolves
the stored name through current configuration; the exact model ID recorded when
an epoch opens is audit evidence, not a runtime pin. Changing a mapping retargets
existing conversations, while removing or renaming a referenced profile makes
those conversations fail until that name is configured again.

Guardian action review sends the configured Guardian model a bounded review request with
hook-adjusted semantic input (starting from validated tool arguments and
excluding hook-injected environment values), current actor and destination
context, and bounded user, assistant, tool-call, and tool-result evidence using
the Codex Guardian transcript selection rules. Guardian defaults to
`openai/gpt-5.6-luna`; set `AI_GUARDIAN_MODEL` to override it. Input and output
payloads from this review are excluded from telemetry.

Generate `JUNIOR_SECRET` with Node, then store the generated value in every environment that runs the same app:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use one stable value per deployment. Rotating it invalidates pending internal queue callbacks and sandbox actor context signed with the previous value.

## Dashboard auth

If you mount `@sentry/junior-dashboard`, set these browser-auth variables:

| Variable               | Required | Purpose                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes      | Google OAuth client ID.                                               |
| `GOOGLE_CLIENT_SECRET` | Yes      | Google OAuth client secret.                                           |
| `BETTER_AUTH_SECRET`   | No       | Optional override for dashboard cookies. Defaults to `JUNIOR_SECRET`. |

Configure allowed Google Workspace domains in `createApp({ dashboard })` and `juniorNitro({ dashboard })` for normal deployments. Set these optional policy variables when you prefer environment-managed dashboard authorization:

| Variable                              | Required | Purpose                                                                                 |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `JUNIOR_DASHBOARD_GOOGLE_DOMAINS`     | No       | Comma-separated or JSON array of allowed Google domains.                                |
| `JUNIOR_DASHBOARD_ALLOWED_EMAILS`     | No       | Comma-separated or JSON array of explicit email allowlist.                              |
| `JUNIOR_DASHBOARD_TRUSTED_ORIGINS`    | No       | Comma-separated or JSON array of Better Auth trusted origins.                           |
| `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS` | No       | Set to `true` to replace conversation API responses with local/demo visual-QA fixtures. |

For local/demo dashboard visual QA, set `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true` to replace conversation API responses with sample fixtures.

## Build-time snapshot warmup

If your build command runs `junior snapshot create`:

- `REDIS_URL` must be available during build.
- `VERCEL_OIDC_TOKEN` must be available during build (via Vercel OIDC settings).

| Variable                               | Required | Purpose                                                                              |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS` | No       | Maximum cached age for snapshots with floating dependencies. Defaults to seven days. |
| `SANDBOX_SNAPSHOT_REBUILD_EPOCH`       | No       | Operator-controlled value that forces a new snapshot profile when changed.           |

## Sandbox credential egress

If enabled plugins use host-managed credentials inside Vercel Sandbox, Junior forwards registered provider domains through its credential egress proxy. The proxy verifies each Vercel-signed sandbox request and requires a signed actor context before it injects credentials lazily.

The egress proxy verifies Vercel-signed Sandbox OIDC tokens per request to authenticate the sandbox VM; actor authorization comes from the forwarding-route context signed with `JUNIOR_SECRET` and bound to that VM session. No separate audience, project, or team env vars are required for the proxy.

| Variable          | Required    | Purpose                                                                      |
| ----------------- | ----------- | ---------------------------------------------------------------------------- |
| `JUNIOR_BASE_URL` | Conditional | Public URL for the credential egress proxy, unless Vercel URL envs cover it. |

## Plugin environment variables

Provider credentials and other plugin-specific variables live on each plugin setup page under [Extend](/extend/). Keep this page limited to core runtime configuration.

## Experimental features

Unstable product surfaces opt in through `createApp({ experimental })`, the same
pattern used by frameworks such as Next.js. Features default off, may change
without a stable migration path, and should stay unset in production unless you
are deliberately dogfooding them. There is no environment-variable opt-in.

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  experimental: {
    // Prepare the visible reply with the fast model before delivery.
    // Can stay silent for [[NO_REPLY]] and shorten long replies. Off by default.
    // Original agent text stays in history; only the visible reply may change.
    "output-router": true,
    // Reply to non-mention messages in Slack threads Junior already joined.
    // Off by default. Without this, Junior only replies to explicit @mentions
    // and resource-event notifications in those threads.
    "passive-routing": true,
    // Model-facing spawnAgent for durable child agent work. Incomplete; keep off
    // unless you are testing the #879 runtime.
    subagents: true,
  },
});
```

`junior chat` enables experimental `subagents` automatically because it is the
local createApp-equivalent entrypoint and already wires the child-worker path.

## Remote ACP

Every Junior app mounts `GET`, `POST`, and `DELETE /api/acp`. No app option
enables the route. Configure the dashboard to let ACP clients authenticate with
Google. The client must support ACP URL elicitation. Junior asks the user to
enter the verification code shown by the client, then uses the dashboard Google
sign-in flow. Personal tokens do not grant access to this route.

ACP stores short-lived connection, authorization, and stream records in the
configured `StateAdapter`. Production Redis state lets requests reach different
app instances. It does not need process affinity. Memory state remains local to
one process. A client must reconnect and call `session/load` when its live SSE
request reaches the deployment request limit. Run `pnpm acp:local` in this
repository for a loopback test with the official ACP SDK client. ACP remains a
pre-stable surface.

`output-router` uses the fast model (`AI_FAST_MODEL`) to prepare the visible
reply for each completed tool-free assistant message. Exact `[[NO_REPLY]]` stays
silent. Mixed marker text goes through the model: internal work notes can stay
silent; a real answer that mentions the marker still delivers. Long replies can
be shortened while keeping the `SOUL.md` personality voice. The original agent
text remains in conversation history. Leave it unset unless you are testing that
path.

`passive-routing` turns on replies to non-mention messages in threads Junior
already joined. Leave it unset in production unless you are testing that path.

## Profiles

Pass named profiles to `createApp()`. The `handoff` tool can switch to any configured profile except the active one:

```ts
const app = await createApp({
  defaultProfile: "gpt-5",
  profiles: {
    "gpt-5": "openai/gpt-5.6-sol",
    "opus-5": "anthropic/claude-opus-5",
  },
});
```

Set `profiles` and `defaultProfile` together. App config replaces profiles from env settings. If app config omits both options, the deprecated env settings create `standard` and `handoff` profiles. `AI_MODEL_PROFILES` can add or replace those profiles.

## Install-wide config defaults

Pass `configDefaults` to `createApp()` to set provider defaults across all conversations:

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  configDefaults: {
    "sentry.org": "sentry",
    "github.org": "myorg",
    "github.repo": "myorg/myrepo",
  },
});
```

Keys should be registered plugin config keys. Junior retains unregistered defaults but warns at startup because they usually indicate missing plugin wiring. Channel-scoped overrides (`jr-rpc config set`) take precedence.

## Sandbox configuration

Pass sandbox sizing to `createApp()`. Each vCPU provides 2 GB of memory, so this creates 8 GB runtime sandboxes:

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  sandbox: {
    vcpus: 4,
  },
});
```

The app setting takes precedence over `SANDBOX_VCPUS`. Snapshot warmup runs before `createApp()`, so `junior snapshot create` still reads `SANDBOX_VCPUS` when its build sandbox also needs explicit sizing.

Pass `sandbox.egressTracePropagationDomains` when sandboxed commands should keep Sentry trace context across sandbox network egress:

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  sandbox: {
    egressTracePropagationDomains: ["sentry.io", "*.sentry.io"],
  },
});
```

Configured non-provider domains receive trace-header transforms without requiring credential proxying.

Entries may be exact domains or leading wildcard domains. The wildcard form matches subdomains, not the apex domain, so include both forms when needed.

## Verification

- Validate required variables exist in deployment environment.
- Redeploy after variable changes.
- Run one end-to-end Slack thread action per enabled integration.

## Next step

Use [Plugin Auth & Context](/reference/runtime-commands/) to verify plugin auth and target-context behavior after env changes, then monitor with [Observability](/operate/observability/).
