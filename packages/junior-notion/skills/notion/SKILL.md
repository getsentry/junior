---
name: notion
description: Search Notion pages and data sources and summarize the best match. Use when users ask to look up docs, specs, notes, meeting notes, project context, roadmaps, trackers, or internal references stored in Notion.
allowed-mcp-tools: notion-search notion-fetch
---

# Notion Operations

Use this skill for `/notion` workflows in the harness.

## Workflow

1. Classify the request:

- `disconnect`: run `jr-rpc delete-token notion` in `bash`, then confirm that the user's Notion connection was removed.
- otherwise treat the request as a read-only query.

2. Keep tool work mostly silent:

- Send at most one short acknowledgment before Notion tool work.
- Keep intermediate search/fetch reasoning internal.
- Do not narrate each step with "let me...", "I found...", or partial findings while tools are still running.
- Reply with the real answer once you have enough evidence, or explain the actual blocker if you cannot finish.

3. Search with MCP:

- `loadSkill` returns `available_tools` for this skill, including the exact `tool_name` values and argument schemas for the Notion tools exposed in this turn.
- Use `useTool` with those exact `tool_name` values.
- Use `searchTools` only if you need to rediscover or filter the active Notion tools later in the turn.
- The first MCP call may trigger a private OAuth link. Do not try to start auth manually. The runtime will pause and resume automatically after the user completes the flow.
- Decide the actual search phrases first. Notion search is title-biased, so search for the likely page or data source title, not the user's full sentence.
- Use 1-3 short explicit search phrases.
- Good: `deployment pipeline`, `launch tracker`, `incident review`
- Bad: `how do we handle deployment pipelines for mobile releases`
- For list/report/calendar requests, search for the canonical container first:
  - page title: `holidays`, `company holidays`
  - data source title: `people calendar`
- Prefer one refinement round at most. If the first search already found a plausible canonical page or data source, fetch it before searching again.

4. Fetch efficiently:

- Search returns ranked page and data-source candidates only. Pick the best candidate, then fetch content with the disclosed Notion fetch tool via `useTool` using the returned URL or ID.
- If a fetched page clearly points at an inline data source or database, fetch that data source next and work from it.
- If the fetched data source already contains the rows and fields needed to answer, stop there and answer from that result.
- Do not serially fetch many individual row pages when the container page or data source already exposes the needed fields.
- Fetch individual rows only when a small number of important fields are still missing or ambiguous after fetching the canonical page or data source.
- Once you have enough evidence to answer, stop fetching and respond.

## Guardrails

- Read-only only.
- Junior intentionally exposes only Notion search and fetch tools for this skill. Do not ask for writes, comments, or page moves.
- Search results may be pages or data sources. Do not treat data sources as unsupported.
- For scoped requests like "US holidays" or "2026 holidays", apply the user's scope when reading the fetched content and state any assumption you made if the source mixes multiple geos or years.
- If search returns no accessible matches, say that no accessible pages or data sources matched and note that the content may be outside the user's Notion permissions or poorly matched by title.
- If content retrieval fails for the top result, return the best matching Notion URL and explain that the result could not be fetched for summarization.
