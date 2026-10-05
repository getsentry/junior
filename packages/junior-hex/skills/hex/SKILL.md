---
name: hex
type: atomic
description: >
  Internal data access primitive. Executes a Hex query and returns structured
  results. Called by core skills — not intended for direct use. Invoke when you
  need to run a Hex query on behalf of a core skill that has provided a query
  and pattern. Do not use for Sentry product telemetry, Sentry feature-usage
  questions, or explicit requests to use Sentry telemetry when the Sentry skill
  is available.
---

# Query Hex (Atomic)

Single responsibility: execute a Hex query via MCP, poll for completion, and return results matched against the caller-provided pattern. Hex Threads take a few minutes to run — this skill owns the full create → poll → extract cycle.

## Input

Receive all three from the calling core skill:

- **query** — the complete, self-contained prompt to send to Hex (see Prompt Construction below)
- **pattern** — what the target data looks like (field names, expected shape — provided by caller; do not assume)
- **context** — any identifying context for the query (e.g. account name, entity ID, time range)

## Prompt Construction (Critical — Read Before Creating a Thread)

Hex's Threads Agent decides which tables to query and what SQL to run based entirely on your prompt. A vague prompt causes broad table exploration and significantly slower responses. A precise prompt can shave several minutes off query time.

### Rules

1. **Batch everything into one prompt.** Include every metric and data point the caller needs in a single `create_thread` call. Do NOT use `continue_thread` to fetch additional fields — each call re-triggers the full agent pipeline and adds multiple minutes of latency. Treat `continue_thread` as a last resort only when a genuinely requested data point is absent from the initial response.

2. **Anchor on a specific entity identifier.** Always include the primary key or identifier for the entity being queried (e.g. account ID, org slug, user ID, opportunity ID). Never rely on Hex to infer the entity from a name or description alone.

3. **Use exact field and table terminology.** Vague terms force Hex to guess. Use the canonical column names, table names, and metric names from the caller's data model. If the caller provides known column names, include them in the prompt.

4. **Specify the time window explicitly.** Always state the period: `"for the last 28 days"`, `"from [start date] to today"`, `"monthly for the last 6 months"`.

5. **Request structured output.** End every prompt with: `"Return results in a structured list or table."`

6. **Pass raw SQL when available.** When the caller provides a specific SQL query, pass it directly to `create_thread` — the agent will execute it as-is, which is faster than natural language exploration.

### Example: Natural Language Query

> "For account ID '12345': return (1) total revenue for the last 90 days, (2) number of active users this month, and (3) any plan or subscription changes in the last 30 days. Return results in a structured list."

### Example: Raw SQL Query

> "Run this SQL: SELECT id, name, revenue, created_at FROM \`my-project.dataset.orders\` WHERE account_id = '12345' AND created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) ORDER BY created_at DESC"

## Steps

1. **Create a Hex thread.**
   Call `create_thread` with the fully constructed prompt.
   Stop on an authorization error. Retry one transient network or server error.
   If the retry fails, return `status: "error"` with a short failure reason.
   Never include the raw provider error in a user-facing reply.

2. **Wait for completion.**
   Call `waitForHexThread` with the Thread ID from `create_thread`. The tool calls Hex up to five times without another model call. If it returns `pending`, call it once more for a total of at most ten polls. Stop on `error` or `authorization_pending`. If it returns `unknown`, inspect its Hex response. Do not treat an unknown status as a completed query. If it is still `pending` after two calls, return:

   ```json
   {
     "status": "timeout",
     "value": null,
     "source": "Hex",
     "raw": "Hex query did not complete after 10 polling attempts."
   }
   ```

3. **Extract the result.**
   Once `waitForHexThread` returns `complete`, read the response content. Reason against the returned data using the caller-provided **pattern** to locate and extract the target value(s).

4. **Use `continue_thread` only as a last resort.**
   If a genuinely requested data point is completely absent from the response (not just unlabeled or formatted differently), use `continue_thread` once to ask for it specifically, but only if a wait call remains. Wait for the continued Thread with the remaining call, then re-extract when it is complete. If no wait call remains, return `not_found`. Do not use `continue_thread` to request data the caller did not include in the original query.

5. **Return structured output.**
   Return one of:
   - **Match found:**
     ```json
     {
       "status": "found",
       "value": "<extracted value(s) matching the pattern>",
       "source": "Hex",
       "raw": "<full thread response for debugging>"
     }
     ```
   - **No match:**
     ```json
     {
       "status": "not_found",
       "value": null,
       "source": "Hex",
       "raw": "<full thread response for debugging>"
     }
     ```

## Constraints

- Do not hardcode data formats or field names — patterns come from the caller.
- Do not poll beyond the 10-attempt cap defined here.
- Do not return partial results as successes — if the pattern match fails, return `not_found`.
- Do not invoke other skills or data sources — this is a single-source primitive.
- Do not fabricate data. If Hex returns an empty or ambiguous result, return `not_found` with the raw output so the caller can inspect it.
- Do not use `continue_thread` as a standard follow-up mechanism — it is expensive and should be used at most once per query, only when a requested data point is genuinely absent from the initial response.

## Guardrails

### Auth and error handling

- **If `create_thread` returns an auth error** (401/403 or OAuth failure), stop immediately and return `status: "error"` — do not retry auth failures.
- **If `create_thread` returns a transient error** (network timeout, 5xx), retry once. If the retry also fails, return an error status.
- **Never expose raw Hex API error messages to end users.** Summarize the failure mode (auth, timeout, not found) without leaking internal details.

### Query safety

- **Do not execute write operations.** Hex threads are read-only analytics queries. If a prompt implies mutation (INSERT, UPDATE, DELETE), refuse and return an error.
- **Do not pass raw user input directly as the Hex prompt.** Always template input into the structured format defined by the caller's query.

### Rate limits

- **Cap Hex Thread polling at two `waitForHexThread` calls per thread.** Do not poll beyond this — return `status: "timeout"`.
- **Do not chain this skill recursively.** One invocation handles one query.
