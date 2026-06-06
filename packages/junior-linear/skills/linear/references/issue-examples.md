# Issue Examples

Calibrate structure and depth by comparing good and bad patterns.

## Bug — simple

Good title: "Webhook delivery drops events over 256KB"

Good body (flat bullets, no headings):

> Events exceeding 256KB are silently dropped by the webhook proxy. The proxy returns 200 but never forwards the payload. Affects ~2% of production events based on recent Sentry data.
>
> - Sentry issue: https://sentry.io/issues/12345
> - Proxy logs show `payload_too_large` but no alert fires
> - Reported by the oncall engineer during weekend incident
>
> Action taken on behalf of Alice.

Bad body (over-structured for a simple bug):

> ## Summary
>
> There is a problem with webhooks.
>
> ## Root Cause
>
> The payload is too large.
>
> ## Expected Behavior
>
> Webhooks should work with large payloads.
>
> ## Impact
>
> Some events are dropped.

## Task — simple

Good title: "Remove deprecated legacyAuth middleware"

Good body:

> `legacyAuth` middleware is unused since SDK v2.1 migration. 7 of 8 patches in `process*.ts` exist solely for scheduling compatibility and can be removed.
>
> - Flagged by Bob during PR #312 review
>
> Action taken on behalf of Bob.

Bad title: "Clean up some auth code"

## Feature — with options

Good title: "Support hot-reload for worker config"

Good body:

> Workers read config at startup. Changes require a full restart, adding 2-3 minutes to incident mitigation.
>
> Options:
>
> - File watch + hot reload — simple, no atomicity guarantee
> - Config service with polling — consistent, adds a dependency
>
> Requested by the platform team after repeated incident delays.
>
> Action taken on behalf of Carol.

## Distinct reporter/requester

Good body:

> The reviewer bot resolved its own warning even though the underlying issue still appeared valid.
>
> Reported by Bojan Oro.
>
> - Original warning still applied after the thread was resolved
> - The related PR remained blocked
> - The bot should not resolve review threads without confirming the condition cleared
>
> Action taken on behalf of David Cramer.

## Anti-patterns

- Adding "Expected behavior" or "Desired outcome" when the thread didn't state one
- Using headed sections (## Summary, ## Impact, ## Root Cause) for a 3-line issue
- Restating the title as the first sentence of the body
- Including fix suggestions when the thread only describes the problem
- Dumping a list of URLs without inline context
- Conflating the reporter with the action requester when they differ
