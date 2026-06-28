# Troubleshooting and Workarounds

## Auth failures

**Symptom:** MCP returns 401 or "unauthorized" errors.

- Stop and tell the user the session is not authorized for the Cloudflare MCP.
- The Cloudflare MCP uses OAuth. If the user has not authorized yet, they will see an auth prompt — follow Junior's OAuth resume flow.
- Do not attempt to bypass auth. Do not guess at token scopes.

**Symptom:** API calls return 403 "Permission denied" or "Insufficient permissions".

- The authorized account lacks the required permission for this resource.
- Tell the user which operation failed and which Cloudflare permission scope is needed (see `safety-and-permissions.md`).
- Suggest creating a more scoped token from `dash.cloudflare.com/profile/api-tokens`.

## Multiple accounts

**Symptom:** account discovery returns more than one account.

- Do not guess which account to use.
- Show the user the list (name + ID) and ask them to specify.
- Once identified, suggest they configure `cloudflare.account.id` for this channel.

## Zone name ambiguity

**Symptom:** zone lookup by domain returns multiple zones (e.g. test + production zones).

- Show all matching zones with their IDs and statuses.
- Ask the user to confirm the intended zone.
- Note: some accounts have zone aliases; the `status: active` zone is usually the production zone.

## MCP tool failures

**Symptom:** `execute` returns an unexpected error or empty result.

- Use `search` to re-confirm the operation shape before retrying.
- Check whether the operation requires `account_id` vs `zone_id` — this is a common mistake.
- Use `docs` to verify current product behavior if the spec seems stale.
- If the MCP server itself returns 5xx, note this and retry once. If it persists, report the error.

**Symptom:** `search` returns no results for an expected operation.

- Try a broader search term (e.g. `workers` instead of `workers/scripts/deployments`).
- The spec may use different names than Cloudflare's product docs; use `docs` to clarify terminology.

## Analytics data delays

Cloudflare analytics pipelines typically have a 1–2 minute delay. For "right now" questions, note this delay and use tail logs for live data instead of analytics queries.

## Log retention and plan limits

- Workers tail logs are live only — they do not provide historical log retrieval.
- Logpush provides historical logs but requires configuration (destination bucket or external service). If the user has not configured Logpush, tail is the only real-time option.
- Workers analytics retention varies by plan. Enterprise customers may have longer retention.
- If a query returns fewer results than expected, check whether plan limits or retention windows are truncating the data.

## Rate limits

**Symptom:** API returns 429 Too Many Requests.

- Wait a few seconds and retry the query once.
- If still throttled, report the rate limit and stop.
- Do not loop or retry aggressively — Cloudflare enforces per-second and per-minute limits.

## Operation changed or not found

**Symptom:** An expected Cloudflare operation returns 404.

- Use `search` against the current spec. Do not hand-guess a corrected path.
- Use `docs` to look up the current API surface for the product area.
- Cloudflare frequently changes API surfaces; the spec in `search` is authoritative.

## Workers Builds vs Pages

Cloudflare has two CI systems:

- **Workers Builds** — for Worker scripts deployed via `wrangler`
- **Pages** — for static sites and Pages Functions

If the user asks about "builds" and it's unclear which system, ask whether they are deploying a Worker or a Pages project.

## GraphQL Analytics API

Some deep analytics (request counts by colo, detailed error breakdown, Web Analytics) are only available through Cloudflare's GraphQL Analytics API at `https://api.cloudflare.com/client/v4/graphql`. Use the `docs` tool to find the relevant GraphQL datasets. Note that GraphQL queries are POST requests with a JSON body containing the query string.
