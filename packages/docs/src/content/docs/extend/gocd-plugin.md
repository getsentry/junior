---
title: GoCD Plugin
description: Configure read-only GoCD pipeline and job access.
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

Apps behind an access proxy can pass credential hooks to `gocdPlugin({ hooks })`. The hooks must add the headers required by that proxy and GoCD.

## Capabilities

Junior can find visible pipelines and inspect pipeline history, one pipeline run, pipeline status, one stage run, or job history. All tools are read-only.

This plugin does not support resource subscriptions.

## Verify

Ask Junior: `Show recent runs for <pipeline>.` Confirm that the reply includes run, stage, and job results.

## Failure modes

- **Base URL missing:** Set `GOCD_URL` or pass `baseUrl` to `gocdPlugin()`.
- **GoCD returns `401` or `403`:** Check the token and its read access.
- **Pipeline not found:** Check the pipeline name or set `gocd.pipeline`.
- **Access proxy rejects the request:** Add credential hooks for the proxy.

## Next step

Review [Security Hardening](/operate/security-hardening/).
