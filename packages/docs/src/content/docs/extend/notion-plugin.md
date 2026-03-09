---
title: Notion Plugin
description: Configure Notion OAuth for read-only page search workflows.
type: tutorial
summary: Set up the Notion plugin with per-user OAuth and verify `/notion` page search and summarization.
prerequisites:
  - /extend/plugins-overview/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Notion plugin enables per-user OAuth so Slack users can search shared Notion pages and summarize page content through `/notion`.

## Setup

### Configure OAuth application

Set redirect URL to:

```text
<base-url>/api/oauth/callback/notion
```

Set host env vars:

- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`

Register the package:

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

### Runtime auth flow

1. User runs `/notion auth`.
2. Runtime sends a private authorization link.
3. OAuth callback stores the token and enables later `/notion` queries.

## Verify

- `/notion auth` completes successfully.
- A real `/notion <query>` request returns a page summary and source URL.
- Removing the stored token triggers re-authorization on the next query.

## Failure modes

- No search matches: the page may not be shared with the integration yet.
- Callback errors: redirect URL mismatch or invalid base URL.
- Retrieval errors: the top matching page could not be fetched as markdown.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
