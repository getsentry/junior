# GCP skill specification

## Intent and scope

Read a bounded sample of Cloud Logging entries under the connected user's IAM
permissions. Cover project and log-view queries, GKE containers, and Cloud Run.
Do not cover other Google APIs, IAM changes, log writes, or infrastructure work.

## Contract

Resolve an explicit resource and UTC window. Use `gcloud logging read` with a
50-entry limit, 60-second timeout, and at most three samples per pass. Report
evidence, scope, time, and incomplete results. Preserve authorization pauses and
permission failures. Never expose credentials or full customer log payloads.

## Layout and evidence

This is a workflow-process skill with inline guidance. One CLI operation needs
no wrapper scripts or optional references. Runtime instructions live in
`SKILL.md`; source decisions live in `SOURCES.md`. Junior's plugin owns the pinned
CLI install, OAuth, and egress. The skill is not portable to a host without that
credential flow.

## Validation

Run skill format checks, package checks, and the manifest contract test. Review
triggers against “show GKE pod errors”, “query GCP logs”, and “Cloud Run logs”.
Reject “deploy a GKE workload”, “grant IAM access”, and “search Datadog logs”.
Check the installer checksum and CLI version. Use a local synthetic API to
check placeholder auth, project/view targets, pagination, and permission errors.
Before rollout, test real consent, a bounded read, refresh, and a denied resource.

## Maintenance

Keep command flags aligned with the pinned CLI and Google's command reference.
Update the archive version and checksum together. Update the manifest and
security review before changing scope or hosts. Do not store real tokens or
customer log samples in test evidence.
