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

### Create a public Notion integration

Junior uses Notion's OAuth flow, so this plugin needs a public integration rather than an internal workspace token. Start with Notion's [Authorization guide](https://developers.notion.com/guides/get-started/authorization), then create a new integration in the Notion integrations dashboard:

1. Select `New integration`.
2. Choose `Public` as the integration type.
3. Fill in the required metadata for your app.
4. Add this redirect URI:

```text
<base-url>/api/oauth/callback/notion
```

After you save the integration, open the `Configuration` tab and copy the client credentials you will use in Junior:

- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`

If you eventually want to publish the integration broadly, Notion's docs note that public integrations go through a separate review before being listed publicly. You do not need that extra step just to use the plugin in your own Junior deployment.

### Enable the required Notion capability

Open the integration's `Capabilities` tab and enable `Read content`.

Junior's v1 Notion workflow only searches pages and retrieves page markdown, so `Read content` is the only required content capability. Notion documents capability requirements here:

- [Integration capabilities](https://developers.notion.com/reference/capabilities)
- [Retrieve a page as markdown](https://developers.notion.com/reference/retrieve-page-markdown)

### Register the plugin in Junior

Install and register the plugin package:

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

Set the same client credentials in your host environment:

- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`

### Runtime auth flow

1. User runs `/notion auth`.
2. Runtime sends a private authorization link.
3. User selects the pages they want to share with the integration in Notion.
4. OAuth callback stores the token and enables later `/notion` queries.

## Verify

- `/notion auth` completes successfully.
- A real `/notion <query>` request returns a page summary and source URL.
- Removing the stored token triggers re-authorization on the next query.

## Failure modes

- No search matches: the page may not be shared with the integration yet, or Notion search may still be indexing immediately after auth.
- `403` from Notion: the integration is missing `Read content`.
- Callback errors: redirect URL mismatch or invalid base URL.
- Retrieval errors: the top matching page could not be fetched as markdown.

Notion's search docs note that directly shared pages are guaranteed to appear, while newly shared content can take time to index. If a user authorizes the integration and immediately searches, ask them to retry once the page has finished indexing.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
