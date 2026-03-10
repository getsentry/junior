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

- **Important**: The Notion search API (`POST /v1/search`) only matches against page **titles**, not page content. Craft your search query accordingly.
- Extract 1–3 short keywords likely to appear in the page title. Do not pass the user's full natural-language question as the query. For example, if the user asks "how do we handle deployment pipelines?", search for `"deployment"` rather than the full sentence.
- **Do not filter by object type** in the initial search — pages and databases both contain useful content, and filtering can hide results. Use a short inline `node` script or `curl` request to `POST https://api.notion.com/v1/search` with the JSON body `{"query": "<keywords>", "page_size": 10}`.
- If the first search returns no results, retry with broader or alternative keywords (synonyms, fewer terms, singular/plural variants, or an empty query to list recent pages). Notion's search index can be inconsistent, so try at least two keyword variations before giving up.
- From the results, pick the best-matching result by title relevance to the user's question. Results may be pages (`"object": "page"`) or databases (`"object": "database"`).
- For pages: fetch markdown from `GET https://api.notion.com/v1/pages/<page_id>/markdown`.
- For databases: fetch entries from `POST https://api.notion.com/v1/databases/<database_id>/query` with `{"page_size": 50}`, then summarize the returned entries.
- Return a concise summary plus the title and Notion URL.

## Guardrails

- Read-only only.
- Do not print credential values.
- The runtime injects `Authorization` and `Notion-Version`; only add request-specific headers like `Content-Type: application/json` when needed.
- If search returns no page matches, say that no accessible pages matched and note the page may not be shared with the integration yet.
- If markdown retrieval fails for the top result, return the best matching page URL and explain that the page could not be fetched for summarization.
