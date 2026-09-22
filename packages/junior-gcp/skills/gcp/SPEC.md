# GCP skill specification

## Intent and scope

Read a bounded sample of Cloud Logging entries under the connected user's IAM
permissions. Cover project and log-view queries, GKE containers, and Cloud Run.
Do not cover other Google APIs, IAM changes, log writes, or infrastructure work.

## Contract

Resolve an explicit resource and UTC window. Use Logging v2 `entries:list` with
small pages and a three-page cap. Report evidence, scope, time, and incomplete
results. Preserve authorization pauses and permission failures. Never expose
credentials or full customer log payloads.

## Layout and evidence

This is a workflow-process skill with inline guidance. One API operation needs
no scripts or optional references. Runtime instructions live in `SKILL.md`;
source decisions live in `SOURCES.md`. Junior's plugin owns OAuth and egress.
The skill is not portable to a host without that credential flow.

## Validation

Run skill format checks, package checks, and the manifest contract test. Review
triggers against “show GKE pod errors”, “query GCP logs”, and “Cloud Run logs”.
Reject “deploy a GKE workload”, “grant IAM access”, and “search Datadog logs”.
Before rollout, test real consent, a bounded read, refresh, and a denied resource.
An empty page with a token and a page cap are manual pagination cases.

## Maintenance

Keep API fields aligned with Google's v2 reference. Update the manifest and
security review before changing scope or hosts. Do not store real tokens or
customer log samples in test evidence.
