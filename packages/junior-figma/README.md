# @sentry/junior-figma

`@sentry/junior-figma` adds read-only Figma lookups to Junior through the Figma REST API. Use it to read frames, layout, spacing, colors, typography, copy, components, and comments, and to render frames as images. Junior can then use exact design details when it changes or reviews UI code.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-figma
```

## Configure

Add the package name to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-figma"]);
```

Set a Figma token in the Junior deployment environment:

```bash
FIGMA_ACCESS_TOKEN=...
```

Use a REST API [plan access token](https://developers.figma.com/docs/rest-api/plan-access-tokens/). An organization admin creates it at `https://www.figma.com/developers/tokens`. Give it only read scopes: `file_content:read`, `file_metadata:read`, `file_comments:read`, `library_content:read`, and, on Enterprise plans, `file_variables:read`.

## Auth model

- The plugin uses one deployment-level Figma token. Users do not connect individual Figma accounts.
- The real token stays on the host. Junior adds `X-Figma-Token: <token>` to sandbox requests to `api.figma.com`.
- The token scopes are the read-only boundary. The bundled skill also uses only `GET` requests.
- Everyone who can use Junior can read the files that the token can read. Limit the token to selected files, folders, or teams if this is a concern.

## Why REST and not MCP

Figma's hosted MCP server accepts only clients in the Figma MCP catalog. Until Junior is approved, the plugin uses the REST API.

Full setup guide: https://junior.sentry.dev/extend/figma-plugin/
