---
name: sum
description: Summarize the current Slack thread into a concise brief with actions. Use when users invoke /sum.
---

# Thread Summary

Generate a summary for explicit `/sum` requests.

## Workflow

1. Treat the current thread context as the primary source of truth.
2. Identify URLs from the thread context and current message.
3. Select only URLs that are relevant to the summary. Fetch at most 5 URLs with `webFetch`.
   - Skip duplicates.
   - If a fetch fails, continue and do not retry repeatedly.
4. Build the response in this exact order:
   - `Summary`
   - `Action items`
   - `Open questions` (only if present)
   - `Sources used`

## Output Rules

- `Summary`: 5-8 bullets focused on decisions, status, and risks.
- `Action items`: bullet list using this shape:
  - `Owner: <name|unassigned> | Action: <task> | Due: <date|none>`
- `Open questions`: include only unresolved blockers/questions.
- `Sources used`:
  - If URLs were fetched, list thread context plus each fetched URL.
  - If none were fetched, write `Thread context only`.

## Guardrails

- Never invent facts.
- Clearly separate thread-derived statements from URL-derived statements when it matters.
- If details are missing, say `uncertain` instead of guessing.
- Keep output concise and directly actionable.
