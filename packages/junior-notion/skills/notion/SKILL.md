---
name: notion
description: Search Notion pages and summarize page content via /notion. Use when users ask to look up docs, specs, notes, or project context stored in Notion.
requires-capabilities: notion.api.read
allowed-tools: bash
---

# Notion Operations

Use this skill for `/notion` workflows in the harness.

## Workflow

1. Classify the request:

- `auth`: explain that this plugin uses a shared internal Notion integration, so there is no per-user auth flow. Tell the user the workspace admin must configure `NOTION_TOKEN` and share the relevant pages with the integration.
- `disconnect`: explain that there is no per-user Notion connection to remove because the plugin uses a shared internal integration.
- otherwise treat the request as a read-only query.

2. Enable credentials:

- Before any Notion API call, run `jr-rpc issue-credential notion.api.read`.
- If credential issuance fails, explain that Notion is not configured on the host and the admin must set `NOTION_TOKEN`.

3. Search and summarize:

- Use a short inline `node` script or `curl` request to `POST https://api.notion.com/v1/search` with a JSON body containing the user query.
- Filter the results to `object === "page"` and use the top page result for v1.
- Fetch markdown for that page from `GET https://api.notion.com/v1/pages/<page_id>/markdown`.
- Return a concise summary plus the page title and Notion URL.

## Guardrails

- Read-only only.
- Do not print credential values.
- The runtime injects `Authorization` and `Notion-Version`; only add request-specific headers like `Content-Type: application/json` when needed.
- If search returns no page matches, say that no accessible pages matched and note the page may not be shared with the integration yet.
- If markdown retrieval fails for the top result, return the best matching page URL and explain that the page could not be fetched for summarization.
