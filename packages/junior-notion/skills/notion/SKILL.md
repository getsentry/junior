---
name: notion
description: Search, fetch, create, update, and move Notion pages and data sources. Use when users ask to look up docs, specs, notes, meeting notes, project context, roadmaps, trackers, or internal references stored in Notion, or when they explicitly ask to create or edit Notion content.
---

# Notion Operations

Use this skill for Notion search, fetch, and limited write workflows.

## Workflow

1. Classify the request:

- Read-only lookup or summarization.
- Explicit create, update, or move.

2. Keep tool work mostly silent:

- Send at most one short acknowledgment before Notion tool work.
- Keep intermediate search/fetch reasoning internal.
- Do not narrate each step with "let me...", "I found...", or partial findings while tools are still running.
- Reply with the real answer once you have enough evidence, or explain the actual blocker if you cannot finish.

3. Use the live Notion tool surface:

- Prefer these allowlisted operations when present:
  - search
  - fetch
  - create pages
  - update page
  - move pages
- Discover the current create, update, or move tool before promising a write, and copy only fields justified by its live schema.
- Do not claim write support if the needed operation is unavailable.
- Do not use broader administrative or destructive Notion operations even if they appear in discovery.

4. Search Notion:

- Decide the actual search phrases first. Notion search is title-biased, so search for the likely page or data source title, not the user's full sentence.
- Use 1-3 short explicit search phrases.
- Good: `deployment pipeline`, `launch tracker`, `incident review`
- Bad: `how do we handle deployment pipelines for mobile releases`
- For list/report/calendar requests, search for the canonical container first:
  - page title: `holidays`, `company holidays`
  - data source title: `people calendar`
- Prefer one refinement round at most. If the first search already found a plausible canonical page or data source, fetch it before searching again.

5. Fetch efficiently:

- Search returns ranked page and data-source candidates only. Pick the best candidate, then fetch content using the returned URL or ID.
- If a fetched page clearly points at an inline data source or database, fetch that data source next and work from it.
- If the fetched data source already contains the rows and fields needed to answer, stop there and answer from that result.
- Do not serially fetch many individual row pages when the container page or data source already exposes the needed fields.
- Fetch individual rows only when a small number of important fields are still missing or ambiguous after fetching the canonical page or data source.
- Once you have enough evidence to answer a read request, stop fetching and respond.

6. Write only when the user explicitly asked:

- Resolve the destination or target page first with search and fetch.
- Fetch the current page before updating or moving it.
- Keep the mutation to the exact title, parent, properties, and content the user requested.
- Prefer partial updates over full rewrites.
- After a successful write, return the resulting Notion page URL and a short summary of what changed.
- If the authenticated user lacks access, or the write operation is unavailable, say so clearly and stop.

## Guardrails

- Default to read-only behavior unless the user explicitly asked to create, edit, or move Notion content.
- Do not invent destinations, parents, properties, or large content expansions beyond the request.
- Search results may be pages or data sources. Do not treat data sources as unsupported.
- For scoped requests like "US holidays" or "2026 holidays", apply the user's scope when reading the fetched content and state any assumption you made if the source mixes multiple geos or years.
- If search returns no accessible matches, say that no accessible pages or data sources matched and note that the content may be outside the user's Notion permissions or poorly matched by title.
- If content retrieval fails for the top result, return the best matching Notion URL and explain that the result could not be fetched for summarization.
- Leave database deletion, schema redesign, and other broad administrative operations out of scope.
