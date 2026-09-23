# Sources and decisions

## Sources

- Google [gcloud logging read reference](https://docs.cloud.google.com/sdk/gcloud/reference/logging/read): authoritative, high confidence. Owns filters, explicit projects and log views, ordering, and the unlimited default. Guidance is summarized, not copied.
- Google [CLI authentication guide](https://docs.cloud.google.com/sdk/docs/authorizing) and [properties guide](https://docs.cloud.google.com/sdk/docs/properties): authoritative, high confidence. Own token-based authentication without credential storage and environment configuration.
- Google [entries.list reference](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list): authoritative, high confidence. Owns API resource names, pagination, IAM, and `logging.read` scope.
- Google [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server): authoritative, high confidence. Owns consent, offline access, token endpoint, and redirect setup.
- `packages/junior/src/chat/oauth-flow.ts` and `packages/junior/src/chat/sandbox/egress/policy.ts`: repository authority for OAuth parameters and host-held credentials.
- `packages/junior-datadog/plugin.yaml` and its `skills/datadog/SKILL.md`: local patterns for checksum-verified CLI installation, bounded telemetry queries, and minimal disclosure.
- [junior-prod #317](https://github.com/getsentry/junior-prod/pull/317): related Google IAP work, not a Logging integration.
- [babysitter #56](https://github.com/getsentry/babysitter/pull/56): closed CLI-based log-access proposal. Reuse its Google Cloud CLI 576.0.0 archive and SHA-256. The downloaded archive passed checksum validation and reported that version.
- Google Cloud CLI 576.0.0 source: `googlecloudsdk/core/credentials/store.py`, `surface/logging/read.py`, and `api_lib/logging/common.py` confirm placeholder-token support, resource targeting, and pagination. A local synthetic API check passed project and view reads, an empty first page with a next-page token, and a permission denial. No real credentials were used.

## Decisions and coverage

Adopt a workflow-process, inline-guidance skill. One read command does not need
a wrapper or router. Replace the REST/curl instructions with `gcloud logging
read` at the user's request. Let the CLI handle API pagination. Replace the
manual page cap with a result limit, command timeout, and three-sample cap.
Keep setup and rationale out of runtime prose.

Reuse Junior's per-user OAuth and egress. Pass only the non-secret placeholder
through `CLOUDSDK_AUTH_ACCESS_TOKEN`; do not run CLI login. The plugin installs
the CLI during Sandbox setup, not during an investigation. These runtime
features are required; the instructions are not a standalone gcloud setup guide.

Covered: resource resolution, bounded reads, GKE/Cloud Run filters, pagination,
permission denial, rate limits, partial results, and sensitive output. Use the
v2 API through the CLI's global endpoint. The CLI is not a read-only binary;
the narrow OAuth scope and user IAM enforce access. No core changes are needed.

Reject MCP, broad Cloud Platform scopes, and shared service-account access for
this initial feature. Defer other APIs, regional endpoints, and log analytics.

The pinned CLI source, command docs, and local checks cover the initial read
path; further broad research has low value. Live Google consent, host egress,
refresh, and IAM denial remain rollout checks. No live credentials or customer
data were used to author this skill.
