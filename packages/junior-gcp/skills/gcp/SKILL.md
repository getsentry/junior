---
name: gcp
description: Read Google Cloud Logging entries with per-user access. Use for GCP logs, Logs Explorer queries, GKE container logs, and Cloud Run logs stored in Cloud Logging. Do not use for Cloud resource changes, deployments, IAM administration, or logs stored only in Sentry, Datadog, or Vercel.
---

# Google Cloud Logging

Use the Cloud Logging v2 REST API through `curl`. The plugin owns OAuth and
credential forwarding. Do not install `gcloud`, run a login command, request
service-account keys, or copy tokens into files. `GCP_ACCESS_TOKEN` is a
non-secret placeholder. The host adds the connected user's token only to
`logging.googleapis.com` requests.

## Read log entries

1. Resolve the project or full log-view resource name from the request, linked
   Logs Explorer query, or thread. If absent, read `jr-rpc config get gcp.project`
   as a standalone command. Ask for a project if it is still unknown. Do not
   guess project IDs or search unrelated projects. Change the default only on
   explicit request.
2. Use the requested time range. For a current problem, use the last 15 minutes.
   Get the current UTC time and put both start and end timestamps in the filter.
   Add the known service, container, pod, severity, or trace constraint.
3. Send one request to `POST https://logging.googleapis.com/v2/entries:list`.
   Use `resourceNames`, not the deprecated `projectIds`. Start with `pageSize: 50`
   and `orderBy: "timestamp desc"`. Use JSON serialization for dynamic values.

Example: replace the project and timestamp placeholders before execution.

```bash
curl --silent --show-error --fail-with-body --max-time 60 \
  'https://logging.googleapis.com/v2/entries:list' \
  -H "Authorization: Bearer $GCP_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "resourceNames": ["projects/PROJECT_ID"],
  "filter": "timestamp >= \"START_RFC3339\" AND timestamp < \"END_RFC3339\" AND resource.type = \"k8s_container\" AND severity >= ERROR",
  "orderBy": "timestamp desc",
  "pageSize": 50
}
JSON
```

For a log view, use its full resource name:
`projects/PROJECT_ID/locations/LOCATION/buckets/BUCKET/views/VIEW`.
For GKE, add `resource.labels.namespace_name`, `resource.labels.container_name`,
and a pod-name prefix such as `resource.labels.pod_name =~ "^DEPLOYMENT-"` when
known. For Cloud Run, use `resource.type = "cloud_run_revision"` and
`resource.labels.service_name = "SERVICE"`. Do not assume plain-text errors have
an `ERROR` severity; use a focused text filter when the logging format needs it.

4. If more evidence is needed, pass `nextPageToken` as `pageToken` with all other
   parameters unchanged. Read at most three pages per investigation pass. An
   empty page with a token is not proof that no entries match. If the cap is
   reached, report partial results or narrow the query.
5. Report the project/view, UTC window, filter, and relevant timestamps. Link to
   Logs Explorer with URL-encoded `query` and `project` values:
   `https://console.cloud.google.com/logs/query;query=ENCODED_FILTER?project=ENCODED_PROJECT`.
   Separate log evidence from inferred causes. A page length is not a total
   count. Quote only the minimum useful text; logs can contain customer data.

## Failures and limits

- Let Junior's authorization flow request the user's connection. Do not bypass
  an authorization pause or switch to another identity.
- On `401`, report that the connection needs attention. Do not extract tokens.
- On `403`, report the API's reason and the requested resource. IAM permissions,
  API enablement, and organization policy are operator concerns. Do not change
  IAM, enable APIs, or ask for broader OAuth scopes to work around a denial.
- On `400`, check the filter, resource name, and timestamps; fix only the invalid
  request. On `429` or a transient `5xx`, wait briefly and retry once, then stop.
- Read log entries only. Do not write or delete logs, change sinks or exclusions,
  create metrics, or alter buckets. Do not use other Google APIs or regional
  endpoints with this plugin.
