---
title: GoCD Plugin
description: Configure GoCD reads and signed stage-failure events.
type: tutorial
summary: Let Junior find pipelines and inspect recent pipeline, stage, and job results.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

Use the GoCD plugin to find pipelines and inspect recent runs, stages, and jobs. The plugin does not expose pipeline config, environment variables, source details, user identities, or console output.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-gocd
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { gocdPlugin } from "@sentry/junior-gocd";

export const plugins = defineJuniorPlugins([gocdPlugin()]);
```

## Config

Set `GOCD_URL` and `GOCD_ACCESS_TOKEN` in the Junior environment, then redeploy.

### Conversation defaults

<details class="plugin-config">
<summary><code>gocd.pipeline</code></summary>

Default pipeline when a request does not name one.

- **Define:** `jr-rpc config set gocd.pipeline <pipeline>`
- **Install-wide default:** `configDefaults["gocd.pipeline"]`
- **Required:** No
- **Environment override:** None

</details>

### Plugin options

<details class="plugin-config">
<summary><code>baseUrl</code></summary>

GoCD server URL. Use this instead of `GOCD_URL` when the app defines plugin config in code.

- **Define:** `gocdPlugin({ baseUrl: "https://gocd.example.com" })`
- **Default:** `GOCD_URL`
- **Required:** Yes
- **Environment variable:** `GOCD_URL`

</details>

### Environment variables

<details class="plugin-config">
<summary><code>GOCD_URL</code></summary>

HTTPS URL for the GoCD server.

- **Define:** Set `GOCD_URL` in the deployment environment
- **Required:** Yes unless `baseUrl` is set
- **Environment override:** `GOCD_URL`

</details>

<details class="plugin-config">
<summary><code>GOCD_ACCESS_TOKEN</code></summary>

Read-only GoCD API token.

- **Define:** Set `GOCD_ACCESS_TOKEN` in the deployment environment
- **Required:** Yes for token auth
- **Environment override:** `GOCD_ACCESS_TOKEN`

</details>

<details class="plugin-config">
<summary><code>GOCD_WEBHOOK_SECRET</code></summary>

Host-only signing secret shared with the trusted deployment notifier. It grants no Sentry API access.

- **Define:** Set `GOCD_WEBHOOK_SECRET` on the Junior host and notifier
- **Required:** Only for stage-failure events
- **Environment override:** `GOCD_WEBHOOK_SECRET`

</details>

Apps behind an access proxy can pass credential hooks to `gocdPlugin({ hooks })`. The hooks must add the headers required by that proxy and GoCD.

## Capabilities

Junior can find visible pipelines and inspect pipeline history, one pipeline run, pipeline status, one stage run, or job history. All tools are read-only.

With a configured webhook secret, the plugin supports pipeline watches and event automations for `stage.failed`. A watch only notifies a Conversation. Use an event automation for creator-bound investigation.

## Deployment triage with creator credentials

Keep Sentry on user OAuth. Create an event automation as the person whose connected account should run the investigation. Junior binds that person's credentials to this automation's runs, not to every Conversation. Bot-authored Slack mentions cannot borrow a thread participant's credentials or start interactive OAuth.

The trigger is:

```json
{
  "namespace": "gocd",
  "resourceType": "pipeline",
  "identifier": "https://gocd.example.com/go/pipelines/deploy-backend",
  "label": "Backend deployment",
  "events": ["stage.failed"],
  "match": { "stage": "deploy-canary" }
}
```

The identifier includes the configured GoCD origin and the exact, case-sensitive pipeline name. Omit `match` to include all failed stages. Leave credential mode at its creator default. Store a read-only triage instruction, with explicit GoCD and Sentry targets and no rollback or unpause action. Select a message outcome if the result should be posted.

The existing runtime supplies the creator's connected credentials; it does not narrow the underlying OAuth scopes or limit delegation to Sentry. Action review and the stored task instruction still apply. Other users and plain bot mentions keep their own credential context. Executable edits by another user clear creator mode. Only the creator can enable it again. A missing or revoked connection requires the creator to reconnect; the unattended run cannot start interactive OAuth.

Event automations require single-workspace Slack mode and deliver to a channel or DM, not the original Sentaur thread. This change does not create an automation, alter production credentials, or enable a sender.

### Signed notification adapter

This is a **Junior adapter contract**, not a native GoCD webhook format. An operator-controlled deployment notifier must read a confirmed failed stage from GoCD and send this payload to `POST /api/webhooks/gocd`:

```json
{
  "pipeline": "deploy-backend",
  "pipelineCounter": 42,
  "stage": "deploy-canary",
  "stageCounter": 1,
  "result": "Failed"
}
```

Use positive integer counters and names containing only letters, digits, underscores, or hyphens (1–255 characters). Do not include an actor, credentials, task instructions, destination, or a caller-selected URL. Junior rejects extra fields and builds run links from its configured GoCD server. The signed sender is responsible for the truth of the failure; signature verification is not an independent GoCD API check.

1. Set `GOCD_WEBHOOK_SECRET` to the same strong random secret on the Junior host and the trusted notifier. This secret authenticates events only. It is not a shared Sentry connection and cannot select whose credentials to use. Never expose it to the Sandbox, model, or pipeline code that is not trusted to trigger these automations.
2. Set `x-junior-gocd-timestamp` to the current Unix time in seconds.
3. Set `x-junior-gocd-signature` to lowercase hex HMAC-SHA256 of `<timestamp>.<exact request body>`, using that secret.
4. Send over HTTPS with `Content-Type: application/json`. The body is limited to 4 KiB; the signature timestamp must be within five minutes of Junior's clock.
5. Retry delivery errors with the same stage coordinates and a fresh timestamp and signature. Core deduplicates event automation dispatch by the exact GoCD server, pipeline run, stage, and stage attempt. A retry must not invent a new stage counter.

The event timestamp records the notification time. Inspect the linked GoCD run for execution timing. Rotate the secret on both hosts to revoke sender access. Without the secret, the event catalog is disabled and the route returns `503`; read tools are unchanged. Stop the old mention-based triage trigger when enabling event delivery to avoid two investigations.

**Rollout prerequisite:** implement this adapter in the deployment notifier, provision its signing secret, connect the owner's Sentry account, and create the automation after installing the package. This plugin alone does not connect Sentaur to Junior.

## Verify

Ask Junior: `Show recent runs for <pipeline>.` Confirm that the reply includes run, stage, and job results.

## Failure modes

- **Base URL missing:** Set `GOCD_URL` or pass `baseUrl` to `gocdPlugin()`.
- **GoCD returns `401` or `403`:** Check the token and its read access.
- **Pipeline not found:** Check the pipeline name or set `gocd.pipeline`.
- **Access proxy rejects the request:** Add credential hooks for the proxy.

## Next step

Review [Security Hardening](/operate/security-hardening/).
