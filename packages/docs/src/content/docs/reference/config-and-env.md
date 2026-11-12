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
| `JUNIOR_CACHE_WARMING_ENABLED`              | No          | Operational kill switch for [prompt cache warming](#prompt-cache-warming). Defaults to `true`; set `false` to stop storing requests and drop queued warmups.                |
| `JUNIOR_SECRET`                             | Yes         | Signs internal queue/callback payloads and sandbox egress actor context.                                                                                                    |
| `JUNIOR_ENCRYPTION_KEYS`                    | Yes         | Keys that encrypt stored provider credentials, as comma-separated `<id>:<key>` entries. See [Encryption keys](#encryption-keys).                                            |
| `JUNIOR_ENCRYPTION_KEY_ID`                  | Conditional | Id of the key for new values. Required when `JUNIOR_ENCRYPTION_KEYS` has more than one key.                                                                                 |
| `JUNIOR_BOT_NAME`                           | No          | Bot display/config naming.                                                                                                                                                  |
| `AI_MODEL`                                  | No          | Model for every agent Turn. Also the fallback for `AI_FAST_MODEL`. Defaults to `anthropic/claude-opus-5.5`.                                                                 |
| `AI_REASONING_LEVEL`                        | No          | Main-agent reasoning level: `none`, `low`, `medium`, `high`, or `xhigh`. Defaults to `high`.                                                                                |
| `AI_FAST_MODEL`                             | No          | Faster model for lightweight tasks and classification passes. Defaults to `openai/gpt-6-luna`.                                                                              |
| `AI_GUARDIAN_MODEL`                         | No          | Model for Guardian action review. Defaults to `openai/gpt-6-luna`.                                                                                                          |
| `AI_DECISION_MODEL`                         | No          | Decision model for passive reply routing in subscribed threads. Uses the AI SDK decision API. Defaults to `typesafe-ai/jev`.                                                |
| `AI_EMBEDDING_MODEL`                        | No          | Embedding model for plugin-owned vector retrieval. Defaults to `openai/text-embedding-3-small`; memory stores 1024- or 1536-dimensional vectors.                            |
| `AI_RERANKING_MODEL`                        | No          | Reranking model that scores plugin retrieval candidates, such as memory recall. Defaults to `voyage/rerank-2.5-lite`.                                                       |
| `AI_VISION_MODEL`                           | No          | Image summary model for thread history and a text-only `AI_MODEL`. Defaults to `openai/gpt-5.6-sol` when absent; an explicitly empty value disables it.                     |
| `AI_WEB_SEARCH_MODEL`                       | No          | Override for the `webSearch` tool model. Defaults to `openai/gpt-6-luna`; does not fall through to `AI_MODEL`.                                                              |
| `AI_REFUSAL_FALLBACK_MODEL`                 | No          | Model that continues an agent Turn when `AI_MODEL` refuses it, for example after a provider safety block. Unset by default: a refusal ends the Turn.                        |
| `SANDBOX_VCPUS`                             | No          | Legacy fallback for sandbox vCPUs and the build-time snapshot command. Prefer `createApp({ sandbox: { vcpus } })` for runtime sandboxes. Each vCPU provides 2 GB of memory. |
| `VERCEL_SANDBOX_KEEPALIVE_MS`               | No          | Extends an active sandbox by this duration on each tool acquire. Disabled when unset or `0`; `900000` (15 minutes) is recommended for production Vercel deployments.        |
| `JUNIOR_BASE_URL`                           | No          | Main base URL for callback and authorization URLs.                                                                                                                          |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Optional namespace prepended to all state-adapter keys, locks, and queues. Use separate prefixes when sharing one Redis database across environments.                       |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET`  | Conditional | Bearer token for the internal heartbeat route; use `CRON_SECRET` with Vercel Cron, or `JUNIOR_SCHEDULER_SECRET` for a non-Vercel heartbeat caller.                          |
| `JUNIOR_TIMEZONE`                           | No          | Default IANA timezone when Junior does not know a person's timezone, such as for schedules and Calendar tools. Defaults to `America/Los_Angeles`.                           |
| `AI_GATEWAY_API_KEY`                        | No          | Fallback AI Gateway auth when Vercel OIDC is unavailable (local/CI/non-Vercel hosts). On Vercel, prefer project OIDC so usage attributes to the project.                    |
| `BLOB_STORE_ID`                             | Conditional | Vercel Blob store for durable conversation attachments and published public artifacts. Vercel sets this when an OIDC-enabled Blob store is connected to the project.        |
| `BLOB_READ_WRITE_TOKEN`                     | Conditional | Static Vercel Blob credential when OIDC is unavailable. Vercel sets this for a token-connected store.                                                                       |
| `JUNIOR_ATTACHMENT_STORAGE_PROVIDER`        | No          | Object storage for attachments and public artifacts: `vercel-blob`, `s3`, or `memory`. Defaults to `vercel-blob`. Use `memory` only for tests.                              |
| `JUNIOR_S3_ENDPOINT`                        | Conditional | Base URL of an S3-compatible API, such as `http://localhost:7070`. Required when the provider is `s3`.                                                                      |
| `JUNIOR_S3_BUCKET`                          | Conditional | Private bucket for attachment objects. Required when the provider is `s3`.                                                                                                  |
| `JUNIOR_S3_ACCESS_KEY_ID`                   | Conditional | S3 access key ID. Required when the provider is `s3`.                                                                                                                       |
| `JUNIOR_S3_SECRET_ACCESS_KEY`               | Conditional | S3 secret access key. Required when the provider is `s3`.                                                                                                                   |
| `JUNIOR_S3_REGION`                          | No          | S3 signing region. Defaults to `us-east-1`.                                                                                                                                 |
| `JUNIOR_QUEUE_PROVIDER`                     | No          | Queue that delivers background work: `vercel` or `bullmq`. Defaults to `vercel`. Use `bullmq` only for local development.                                                   |
| `JUNIOR_QUEUE_REDIS_URL`                    | Conditional | Redis for the BullMQ queue, such as `redis://localhost:6382`. Required when the provider is `bullmq`.                                                                       |
| `JUNIOR_QUEUE_WORKER_CONCURRENCY`           | No          | Jobs that the BullMQ worker runs at the same time for each queue topic. A positive integer. Defaults to `4`.                                                                |

For Vercel deployments, create a private Blob store and connect it to the
project before using `sendFiles` or `publishImage`. Prefer an OIDC connection.
It supplies `BLOB_STORE_ID` and uses Vercel's short-lived OIDC credential. Use
`BLOB_READ_WRITE_TOKEN` for local development, CI, non-Vercel hosts, or as a
fallback. See [Deploy to Vercel](/start-here/deploy-to-vercel/#configure-attachment-storage).

Set `JUNIOR_ATTACHMENT_STORAGE_PROVIDER=s3` to store attachments in an
S3-compatible service instead of Vercel Blob. Junior uses path-style URLs, such
as `<endpoint>/<bucket>/<key>`. Keep the bucket private. Junior serves public
artifacts through its own route. Attachments stored with one provider are not
visible after you change to another provider.

`JUNIOR_ATTACHMENT_STORAGE_PROVIDER=memory` keeps objects in process memory.
Junior loses them when the process stops, and each process has its own copy.
Do not use it for a deployed app.

`JUNIOR_QUEUE_PROVIDER=bullmq` delivers background work through BullMQ on
Redis. Local development then needs no Vercel Queues access. The app only
sends jobs. One separate worker process runs them. `pnpm dev` starts that
process, and the worker logs `queue.bullmq.worker.started` with its
concurrency for each queue topic. Because the worker is a separate process,
state must be in Redis, not memory. Install the optional `bullmq` and `redis` packages to use
it. Junior loads them only when this provider is selected, so they never enter a
deployed bundle. Give the queue its own Redis URL. If two dev servers share one
Redis, each one can take the other's jobs.

Junior applies `JUNIOR_SQL_STATEMENT_TIMEOUT_MS` through PostgreSQL `statement_timeout` for both the Neon and node-postgres drivers. `junior upgrade` does not apply this runtime limit because schema migrations can legitimately take longer.

Guardian action review sends the configured Guardian model a bounded review request with
hook-adjusted semantic input (starting from validated tool arguments and
excluding hook-injected environment values), current actor and destination
context, and bounded user, assistant, tool-call, and tool-result evidence using
the Codex Guardian transcript selection rules. Guardian defaults to
`openai/gpt-6-luna`; set `AI_GUARDIAN_MODEL` to override it. Input and output
payloads from this review are excluded from telemetry.

Generate `JUNIOR_SECRET` with Node, then store the generated value in every environment that runs the same app:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use one stable value per deployment. Rotating it invalidates pending internal queue callbacks and sandbox actor context signed with the previous value.

## Encryption keys

Junior encrypts stored provider credentials with AES-256-GCM. The keys are separate from `JUNIOR_SECRET`, so you can rotate them on their own schedule. Each stored value records the id of the key that encrypted it.

Generate a key and give it an id, such as the month you made it:

```bash
node -e "console.log('2026-11:' + require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the result as `JUNIOR_ENCRYPTION_KEYS`. With one key, `JUNIOR_ENCRYPTION_KEY_ID` is optional. Junior does not start when a key is not 32 bytes, an id repeats, or `JUNIOR_ENCRYPTION_KEY_ID` is not in the list.

To rotate a key:

1. Add the new key to `JUNIOR_ENCRYPTION_KEYS`. Keep `JUNIOR_ENCRYPTION_KEY_ID` on the old id, and deploy. All instances can now read values that the new key encrypts.
2. Set `JUNIOR_ENCRYPTION_KEY_ID` to the new id, and deploy. New values use the new key. Junior saves a credential again with the new key when it reads or refreshes it.
3. Keep the old key for at least 30 days.
4. Remove the old key. Credentials that Junior did not use in that period read as missing, and users must connect them again.

## Dashboard auth

If you mount `@sentry/junior-dashboard`, set these browser-auth variables:

| Variable               | Required | Purpose                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes      | Google OAuth client ID.                                               |
| `GOOGLE_CLIENT_SECRET` | Yes      | Google OAuth client secret.                                           |
| `BETTER_AUTH_SECRET`   | No       | Optional override for dashboard cookies. Defaults to `JUNIOR_SECRET`. |

Dashboard auth requires at least one [allowed domain](#allowed-domains). Set these optional policy variables when you prefer environment-managed dashboard authorization:

| Variable                              | Required | Purpose                                                                                 |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `JUNIOR_DASHBOARD_TRUSTED_ORIGINS`    | No       | Comma-separated or JSON array of Better Auth trusted origins.                           |
| `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS` | No       | Set to `true` to replace conversation API responses with local/demo visual-QA fixtures. |

For local/demo dashboard visual QA, set `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true` to replace conversation API responses with sample fixtures.

## Push notifications

Set both keys to turn on Web Push notifications for dashboard replies.
See [Dashboard](/operate/dashboard/#configure-push-notifications).

| Variable                      | Required    | Purpose                                                                                                                                 |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `JUNIOR_WEB_PUSH_PUBLIC_KEY`  | Conditional | VAPID public key. Required for push notifications.                                                                                      |
| `JUNIOR_WEB_PUSH_PRIVATE_KEY` | Conditional | VAPID private key. Required for push notifications.                                                                                     |
| `JUNIOR_WEB_PUSH_SUBJECT`     | No          | `mailto:` or `https:` contact for push services. Defaults to an `https:` `JUNIOR_BASE_URL`. Notifications stay off with an `http:` URL. |

## Build-time snapshot warmup

The scaffolded build runs `junior snapshot create` on every deploy, so:

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

## Brief generation

Brief generation is off by default. Enable it in app configuration when each
Conversation needs a durable Brief:

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  briefs: { enabled: true },
});
```

This option costs one fast-model call per completed Turn. The example app and
`junior chat` enable it.

## Experimental features

Unstable product surfaces opt in through `createApp({ experimental })`, the same
pattern used by frameworks such as Next.js. Features default off, may change
without a stable migration path, and should stay unset in production unless you
are deliberately dogfooding them. There is no environment-variable opt-in.

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  experimental: {
    // Reply to non-mention messages in Slack threads Junior already joined.
    // Off by default. Without this, Junior only replies to explicit @mentions
    // and event notifications in those threads.
    "passive-routing": true,
    // Operator tools such as runOperatorSql. They read and write the app
    // database directly and skip Conversation privacy checks. Enable them only
    // on isolated deployments, such as Previews behind deployment protection.
    "operator-tools": true,
    // Per-user customization text, edited on the dashboard Settings page or
    // with the updateUserCustomization tool. Junior adds it to each Turn of
    // that user as <user-customization>.
    "user-customization": true,
  },
});
```

Child agents are always on: every app gives the model `spawnAgent`,
`messageAgent`, `searchAgents`, `stopAgent`, and `archiveAgent`.
`experimental.subagents` was removed; remove it from your config, because
Junior rejects unknown experimental keys.

A child agent is a Task by default: only its parent gives it work. The model
can start a Thread instead, a child agent that people can open and message
directly. A parent can have at most 8 child agents with open work, Tasks and
Threads alike. The model can archive a finished Thread with `archiveAgent`.

By default, only the root Conversation can start child agents. Set
`limits.maxAgentDepth` to let child agents start their own child agents. For
example, `1` lets a child agent start child agents, and those cannot start more.

Each event automation can start at most 10 runs in a rolling minute. Set
`limits.eventAutomationRunLimit.maxRuns` to change the count. Set
`limits.eventAutomationRunLimit.windowMs` to change the window, in ms. For
example, `eventAutomationRunLimit: { maxRuns: 100, windowMs: 3_600_000 }`
allows 100 runs per hour. When an automation reaches the limit, Junior blocks it, sends
its creator a direct message, and reports a warning issue to Sentry.

Each turn can spend at most $100 of model cost and make at most 1,000 tool
calls, including later execution slices of the turn. Set
`limits.maxTurnCostUsd` (whole USD) or `limits.maxToolCallsPerTurn` to change
these numbers. When a turn reaches a limit, Junior blocks its next tool call
and tells the model to reply with what it finished and what is left. A child
agent sends that reply to its parent as its result. If the model calls more
tools after that, the turn fails with an execution-limit error.

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

`passive-routing` turns on replies to non-mention messages in threads Junior
already joined. Leave it unset in production unless you are testing that path.

## Allowed domains

`createApp({ allowedDomains })` is one list of domains for Slack and the
dashboard. When the option is unset, Junior reads `JUNIOR_ALLOWED_DOMAINS`, a
comma-separated or JSON array of domains. It is optional, but we recommend it.
Junior logs a warning at startup when it is empty.

```ts title="server.ts"
export default await createApp({
  allowedDomains: ["example.com"],
  plugins,
});
```

- **Slack:** Junior starts work from a mention or DM only when the email of the
  author's Slack profile is on an allowed domain. Slack verifies that email.
  Junior drops other messages and does not reply. Passive thread replies, slash
  commands, and Slack actions are not checked yet. Bots have no profile email.
  To let a bot start work, add its Slack user ID to
  `slack.allowedBotUserIds`.
- **Dashboard:** Google sign-in accepts only Google Workspace accounts on an
  allowed domain. Junior checks the verified `hd` claim of the Google ID token,
  not the email. With one domain, Junior also sends it to Google as the `hd`
  hint. With more domains, it sends `hd=*`, so Google shows only Workspace
  accounts. Dashboard auth requires at least one domain.

When the list is empty, every member of the Slack workspace can use Junior.

The old `dashboard.allowedGoogleDomains` option and
`JUNIOR_DASHBOARD_GOOGLE_DOMAINS` variable were removed. Junior fails at
startup when either is set, so a stale config cannot silently allow everyone.

`operator-tools` adds `runOperatorSql` to non-public Conversations. The tool
runs one SQL statement against the app database and returns up to 200 rows.
Each call uses its own database connection, which is closed afterwards, so
session commands such as `BEGIN` or `SET` do not affect the app.
It can write data and it skips every Conversation privacy check, so the Agent
can read private Conversations with it. Never enable it in production. Use it
on an isolated deployment whose database is a disposable copy, and choose that
deployment in app code, for example:

```ts
const app = await createApp({
  experimental: {
    "operator-tools":
      process.env.VERCEL_ENV === "preview" &&
      process.env.JUNIOR_PREVIEW_OPERATOR === "true",
  },
});
```

## Models

Without overrides, Junior runs every agent Turn on Claude Opus 5.5 with high reasoning. Keep this default unless the app needs different behavior.

To override it, pass `modelId` to `createApp()`, or set `AI_MODEL`. Set `AI_REASONING_LEVEL` to change the reasoning level. Pass auxiliary model ids on the same `createApp()` options object. App config overrides the model env settings.

```ts
const app = await createApp({
  modelId: "anthropic/claude-opus-5.5",
  decisionModelId: "typesafe-ai/jev",
  fastModelId: "openai/gpt-6-luna",
  guardianModelId: "openai/gpt-6-luna",
  embeddingModelId: "openai/text-embedding-3-small",
  rerankingModelId: "voyage/rerank-2.5-lite",
  webSearchModelId: "openai/gpt-6-luna",
  imageGenerationModelId: "openai/gpt-image-2",
  visionModelId: "openai/gpt-5.6-sol",
});
```

The memory model belongs to the memory plugin. Set it with `memoryPlugin({ modelId })` in the plugin set.

## Prompt cache warming

A model's prompt cache expires a fixed time after the last read. When a person
replies after that time, the next turn writes the full history to the cache
again. Junior keeps the cache of an idle Conversation warm when a warmup is
likely to cost less than that write.

- Junior warms only models whose cache has a fixed TTL that a read refreshes:
  `anthropic/` and `alibaba/` models (5 minutes) and `openai/` models (30
  minutes). The model's cache write must cost more than a cache read, and the
  cached prefix must be at least 50K tokens. It does not warm models that use a thinking budget, because the
  budget adds output tokens to each warmup.
- When a turn ends, Junior stores the last model request in the `StateAdapter`.
  Junior deletes it when the first model request of the next turn starts, when
  warmups stop, or after 55 minutes.
- A delayed queue message sends the same request with a one-token output limit
  before the cache expires. Junior sends the next warmup only while the chance
  that the person replies soon is high enough to pay for it. Junior compares
  plans of one or more warmups in a row, so it also warms when the person
  usually replies a few TTLs later. The needed chance is the same for each
  warmup. Only replies in the first 55 minutes count, so for a 30-minute cache
  the chance is a low estimate.
- Junior learns that chance from the reply gaps of idle periods. A period with
  no reply in 55 minutes counts as no reply. Junior keeps separate gaps for
  Turns that a person started and Turns that an event or automation started,
  and for the first, second to third, and later Turns of a Conversation. This
  applies to the gaps of each Conversation too. Until Junior has recorded 20
  gaps for a group, it sends no warmups for that group.
- On the first heartbeat with warming on, Junior fills each empty group
  from the stored Turns of the last 30 days. It uses the same rules as the
  gaps that it records after a turn. It reads the newest Conversations first
  for up to 60 seconds, and keeps the gaps that it found in that time. After
  30 days, it does this again for each group that is empty.
- While a tool runs, the running agent warms the cache with the same cost
  model. The chance comes from recorded tool waits: the time from a model
  request that ended with tool calls to the next request. Junior records only
  waits of 2 minutes or more, because shorter waits do not change a decision.
  When the run ends while a tool runs, the wait counts as no return. Until it
  has recorded 20 waits, it sends no tool wait warmups. Warmups stop when
  the next request starts or the run ends.
- A warmup that misses the cache ends warming for its idle period and sends a
  Sentry warning. When 10 of the last 20 warmups of a provider miss or fail,
  Junior stops warming for that provider for 24 hours and sends a Sentry error.
  A failure that the provider says to retry, such as an overload, stops only
  its own idle period and does not count.
- `JUNIOR_CACHE_WARMING_ENABLED=false` turns warming off. Junior stores no
  requests and drops warmups that are already in the queue. The default is
  `true`.
- While warming is on, Junior sends model requests with the short cache
  retention, so `PI_CACHE_RETENTION` does not change it. With
  `JUNIOR_CACHE_WARMING_ENABLED=false`, Pi's retention applies again.

Warmups show in Sentry as `gen_ai.chat` spans with `gen_ai.prompt.name` set to
`junior.cache_warmup`, and as `cache_warming.*` logs. Their cost is added to the
cost of the Conversation. The `app.cache_warming.trigger` log attribute is
`idle` or `tool_wait`.

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

The app setting takes precedence over `SANDBOX_VCPUS`. A Workspace recipe vCPU count takes precedence over both for sandboxes of that Workspace. Snapshot warmup runs before `createApp()`, so `junior snapshot create` still reads `SANDBOX_VCPUS` when its build sandbox also needs explicit sizing.

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
