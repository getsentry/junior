---
name: gcp
description: Read Google Cloud Logging entries with gcloud and per-user access. Use for GCP logs, Logs Explorer queries, GKE container logs, and Cloud Run logs stored in Cloud Logging. Do not use for Cloud resource changes, deployments, IAM administration, or logs stored only in Sentry, Datadog, or Vercel.
---

# Google Cloud Logging

Use `gcloud logging read`. The plugin installs the pinned CLI and owns OAuth
and credential forwarding. Do not install or update the CLI, run login or init,
request service-account keys, or copy tokens into files.
`CLOUDSDK_AUTH_ACCESS_TOKEN` is a non-secret placeholder. The host adds the
connected user's token only to `logging.googleapis.com` requests.

## Read log entries

1. Resolve the project or full log-view resource name from the request, linked
   Logs Explorer query, or thread. If absent, read `jr-rpc config get gcp.project`
   as a standalone command. Ask for a project if it is still unknown. Do not
   guess project IDs or search unrelated projects. Change the default only on
   explicit request; do not use `gcloud config set`.
2. Use the requested time range. For a current problem, use the last 15 minutes.
   Get the current UTC time and put both start and end timestamps in the filter.
   Add the known service, container, pod, severity, or trace constraint.
3. Run `gcloud logging read` with an explicit `--project`, `--limit=50`,
   `--order=desc`, and `--format=json`. Bound each call with `timeout 60s`.
   Quote filters and resource names as shell arguments. Never omit `--limit`;
   the CLI default is unlimited.

Example: replace the project and timestamp placeholders before execution.

```bash
timeout 60s gcloud logging read \
  'timestamp >= "START_RFC3339" AND timestamp < "END_RFC3339" AND resource.type = "k8s_container" AND severity >= ERROR' \
  --project='PROJECT_ID' --limit=50 --order=desc --format=json
```

For a log view, also pass its full resource name:
`--resource-names='projects/PROJECT_ID/locations/LOCATION/buckets/BUCKET/views/VIEW'`.
Use the view's project for `--project`. Do not override the API endpoint.
For GKE, add `resource.labels.namespace_name`, `resource.labels.container_name`,
and a pod-name prefix such as `resource.labels.pod_name =~ "^DEPLOYMENT-"` when
known. For Cloud Run, use `resource.type = "cloud_run_revision"` and
`resource.labels.service_name = "SERVICE"`. Do not assume plain-text errors have
an `ERROR` severity; use a focused text filter when the logging format needs it.

4. If the limit is reached, narrow the query. Read at most three samples of
   50 entries per investigation pass. The CLI handles API pagination; do not
   implement page-token loops or raise the limit for a bulk export. If a call
   times out, report incomplete results and narrow the scope before retrying.
5. Report the project/view, UTC window, filter, and relevant timestamps. Link to
   Logs Explorer with URL-encoded `query` and `project` values:
   `https://console.cloud.google.com/logs/query;query=ENCODED_FILTER?project=ENCODED_PROJECT`.
   Separate log evidence from inferred causes. A sample size is not a total
   count. Quote only the minimum useful text; logs can contain customer data.

## Failures and limits

- Let Junior's authorization flow request the user's connection. Do not bypass
  an authorization pause or switch to another identity.
- If `gcloud` is missing, report a plugin runtime setup failure. Do not install it.
- On `401` or `UNAUTHENTICATED`, report that the connection needs attention.
  Do not extract tokens or follow a CLI suggestion to run `gcloud auth login`.
- On `403` or `PERMISSION_DENIED`, report the API's reason and requested resource.
  IAM permissions, API enablement, and organization policy are operator concerns.
  Do not change IAM, enable APIs, or ask for broader scopes to bypass a denial.
- On `400` or `INVALID_ARGUMENT`, check the filter, resource name, and timestamps;
  fix only the invalid request. On `429` or a transient `5xx`, wait briefly and
  retry once, then stop. The CLI can also retry within the command timeout.
- Read log entries only. Do not write or delete logs, change sinks or exclusions,
  create metrics, or alter buckets. Do not use other Google APIs, regional
  endpoints, impersonation, or alternate credentials with this plugin.
