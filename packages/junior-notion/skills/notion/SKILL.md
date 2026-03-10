---
name: notion
description: Search Notion pages and data sources and summarize the best match. Use when users ask to look up docs, specs, notes, meeting notes, project context, roadmaps, trackers, or internal references stored in Notion.
requires-capabilities: notion.api
allowed-tools: bash
---

# Notion Operations

Use this skill for `/notion` workflows in the harness.

## Workflow

1. Classify the request:

- `auth`: explain that this plugin uses a shared internal Notion integration, so there is no per-user auth flow. Tell the user the workspace admin must configure `NOTION_TOKEN` and share the relevant pages or data sources with the integration.
- `disconnect`: explain that there is no per-user Notion connection to remove because the plugin uses a shared internal integration.
- otherwise treat the request as a read-only query.

2. Enable credentials:

- Before any Notion API call, run `jr-rpc issue-credential notion.api`.
- If credential issuance fails, explain that Notion is not configured on the host and the admin must set `NOTION_TOKEN`.

3. Search with the checked-in helper:

- Do not improvise `curl` requests or inline `node` snippets for Notion.
- Decide the actual search phrases first. Notion search is title-biased, so search for the likely page or data source title, not the user's full sentence.
- Use 1-3 short explicit search phrases.
- Good: `deployment pipeline`, `launch tracker`, `incident review`
- Bad: `how do we handle deployment pipelines for mobile releases`
- Run search with the loaded `skill_dir` path:
  `node <skill_dir>/scripts/notion-cli.mjs search --query "<best phrase>" --query "<fallback phrase>"`
- If the first phrase misses, rerun with 1-2 alternate title-style phrases.
- Search returns ranked page/data-source candidates only. Pick the best candidate, then fetch content with:
  `node <skill_dir>/scripts/notion-cli.mjs fetch --id "<result id>" --object "page"`
  or
  `node <skill_dir>/scripts/notion-cli.mjs fetch --id "<result id>" --object "data_source"`
- Use the fetch output to summarize page markdown, or summarize the data source schema and returned rows.

## Guardrails

- Read-only only.
- Do not print credential values.
- The runtime injects `Authorization` and `Notion-Version`; the helper handles request-specific headers.
- Search results may be pages or data sources. Do not treat data sources as unsupported.
- If search returns no accessible matches, say that no accessible pages or data sources matched and note the content may not be shared with the integration yet.
- If content retrieval fails for the top result, return the best matching Notion URL and explain that the result could not be fetched for summarization.
