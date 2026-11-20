---
title: Figma Plugin
description: Configure read-only Figma lookups for frames, layout, styles, rendered images, and comments.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Figma plugin lets Slack users share a Figma link and ask Junior to use the design. Junior reads exact layout, spacing, color, typography, and copy details, and renders frames as images. Junior calls the Figma REST API from the sandbox.

The plugin is read-only. It uses one deployment-level token, and the bundled skill uses only `GET` requests.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-figma
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-figma"]);
```

## Config

Set deployment variables in the Junior environment, then redeploy.

### Environment variables

<details class="plugin-config">
<summary><code>FIGMA_ACCESS_TOKEN</code></summary>

Figma REST API token for read-only requests.

- **Define:** Set `FIGMA_ACCESS_TOKEN` in the deployment environment
- **Required:** Yes
- **Environment override:** `FIGMA_ACCESS_TOKEN`

Use a REST API [plan access token](https://developers.figma.com/docs/rest-api/plan-access-tokens/). Plan access tokens need a Figma Organization or Enterprise plan. An organization admin creates the token at `https://www.figma.com/developers/tokens`.

Give the token only read scopes:

- `file_content:read`
- `file_metadata:read`
- `file_comments:read`
- `library_content:read`
- `file_variables:read` (Enterprise plans only)

You can limit the token to selected files, folders, teams, or workspaces. Tokens expire after at most one year.

</details>

## Auth model

- The plugin uses one deployment-level Figma token, not per-user OAuth.
- Junior keeps the real `FIGMA_ACCESS_TOKEN` value on the host.
- Sandbox requests to `api.figma.com` receive a host-managed `X-Figma-Token` header.
- The sandbox never receives the token in env, files, or command arguments.
- Everyone who can use Junior can read the files that the token can read. Per-user Figma permissions do not apply.

Figma's hosted MCP server accepts only approved clients. For this reason, the plugin uses the REST API.

## What users can do

- Share a frame link and ask Junior to match it in code.
- Ask for exact spacing, sizes, colors, typography, or copy in a frame.
- Ask Junior to compare an implementation with a frame.
- Render a frame as an image.
- Read comments on a file.

## Verify

1. Set `FIGMA_ACCESS_TOKEN` and redeploy.
2. Share a Figma frame link with Junior in a channel and ask: `What spacing and colors does this frame use?`
3. Confirm that the reply names the frame and lists values from the design.

## Failure modes

- `FIGMA_ACCESS_TOKEN` missing: Junior cannot add the credential. Set the env var and redeploy.
- `403 Forbidden`: the token is invalid or expired, or it cannot read the file.
- `404 Not Found`: the file or node does not exist, or the token cannot see it.
- `429 Too Many Requests`: Figma is throttling. File, node, and image endpoints have strict [rate limits](https://developers.figma.com/docs/rest-api/rate-limits/).
- Variables requests fail: the variables API needs a Figma Enterprise plan. Junior uses style names and raw values instead.
- Edit requests (comments, variables, file changes): the plugin is read-only, and the skill declines these.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
