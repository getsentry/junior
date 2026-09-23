# @sentry/junior-gcp

Read Google Cloud Logging entries with `gcloud logging read` and per-user OAuth.
This package uses Junior's existing OAuth flow and host-side credential proxy.
It adds no Google-specific logic to core and does not use MCP.

The manifest installs Google Cloud CLI 576.0.0 for Linux x86_64 in the Sandbox.
The archive includes Python. The installer checks the pinned SHA-256 before
extraction. Update checks, usage reporting, and interactive prompts are disabled.
Rebuild the Sandbox snapshot after adding or updating this plugin.

## Setup

Install `@sentry/junior-gcp` alongside `@sentry/junior`, then register the package:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-gcp"]);
```

Configure a Google OAuth web application with this authorized redirect URI:

```text
<junior-base-url>/api/oauth/callback/gcp
```

Set `GCP_CLIENT_ID` and `GCP_CLIENT_SECRET` in the host deployment environment.
Use a dedicated OAuth client for this integration. Restrict the consent app to
its intended users. Enable the Cloud Logging API in the relevant Google Cloud
project through the normal operator process.

Each user connects their Google account through Junior. The plugin requests only
`https://www.googleapis.com/auth/logging.read`. It requests offline access and
consent so Google can issue a refresh token. Junior stores and refreshes tokens
on the host. The Sandbox receives only the non-secret placeholder
`CLOUDSDK_AUTH_ACCESS_TOKEN=host_managed_credential`. This CLI property avoids
local login and credential files. The host adds the real bearer token only to
`logging.googleapis.com` requests.

Google IAM still controls which log entries the user can read. OAuth consent
does not grant a project role. Ordinary project logs require
`logging.logEntries.list` (for example, Logs Viewer). Restricted log views and
private logs can require other permissions. Do not grant broad project access
just to enable this plugin.

An optional conversation default can be set on explicit user request:

```bash
jr-rpc config set gcp.project PROJECT_ID
```

## Scope and limits

The bundled `gcp` skill uses `gcloud logging read` with an explicit project,
UTC window, 50-entry limit, and 60-second timeout. It supports project logs and
explicit log views, including GKE and Cloud Run logs. The CLI handles pagination.

The CLI itself is not read-only. The OAuth scope excludes logging writes, and
the skill permits only log reads. The host restriction does not enforce a path
allowlist; Google scope checks and IAM are the access boundary. Do not expand
the scope to `cloud-platform` or `logging.admin`.

There is no shared service account, workload identity federation, project
inventory, live tail, Log Analytics SQL, or infrastructure mutation support.
Regional Logging endpoints are not registered. No credentials, API enablement,
or IAM grants are provisioned by installing this package.

Before rollout, verify consent, a bounded read, token refresh, and a denied
resource with real test accounts. These checks need operator-managed OAuth
configuration and cannot be proved by manifest tests.

## References

- [gcloud logging read](https://docs.cloud.google.com/sdk/gcloud/reference/logging/read)
- [Cloud Logging entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)
- [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
