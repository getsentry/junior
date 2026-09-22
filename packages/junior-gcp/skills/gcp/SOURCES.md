# Sources and decisions

## Sources

- Google [entries.list reference](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list): authoritative, high confidence. Owns endpoint, resource names, filters, ordering, page tokens, IAM, and `logging.read` scope. Guidance is summarized, not copied.
- Google [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server): authoritative, high confidence. Owns consent, offline access, token endpoint, and redirect setup.
- `packages/junior/src/chat/oauth-flow.ts` and `packages/junior/src/chat/sandbox/egress/policy.ts`: repository authority for OAuth parameters and host-held credentials.
- `packages/junior-datadog/skills/datadog/SKILL.md`: local pattern for bounded telemetry queries and minimal disclosure.
- [junior-prod #317](https://github.com/getsentry/junior-prod/pull/317): related Google IAP work, not a Logging integration.
- [babysitter #56](https://github.com/getsentry/babysitter/pull/56): closed CLI-based log-access proposal. Not reused because Junior already owns per-user OAuth and egress.

## Decisions and coverage

Adopt a workflow-process, inline-guidance skill: one read operation does not need
an SDK, CLI installer, script, or router. Add a new skill because no existing
Junior plugin owns Cloud Logging. Keep setup and rationale out of runtime prose.

Covered: resource resolution, bounded reads, GKE/Cloud Run filters, pagination,
permission denial, rate limits, partial results, and sensitive output. Use the
v2 API and only its global endpoint. Existing provider-neutral runtime owns
OAuth; no runtime contract changes are needed.

Reject broad Cloud Platform scopes and shared service-account access for this
initial feature. Defer other APIs, regional endpoints, and log analytics.

The sources cover the initial read path; further broad research has low value.
Live Google consent, refresh, and IAM denial remain rollout checks. No live
credentials or customer data were used to author this skill.
