# junior-gocd setup

This plugin gives Junior read-only access to Sentry's GoCD deploy pipelines at
`deploy.getsentry.net`. GoCD sits behind Google IAP, so every request needs two
headers: a GoCD bearer token and a short-lived IAP identity token. The credential
broker mints the IAP token keylessly via GCP Workload Identity Federation (no
service-account key at rest), trading the host's `VERCEL_OIDC_TOKEN` for a
federated access token and using that to mint the IAP token.

## What the broker needs at runtime

| Env var                    | Secret? | Purpose                                                                                                                         |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GOCD_ACCESS_TOKEN`        | yes     | Read-only GoCD API token (a view-only bot PAT)                                                                                  |
| `GOCD_IAP_WIF_AUDIENCE`    | no      | WIF provider resource: `//iam.googleapis.com/projects/<NUM>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>` |
| `GOCD_IAP_SERVICE_ACCOUNT` | no      | SA email to impersonate, e.g. `junior-gocd-iap@<project>.iam.gserviceaccount.com`                                               |
| `GOCD_IAP_CLIENT_ID`       | no      | GoCD IAP OAuth client id (defaults to the `deploy.getsentry.net` client)                                                        |
| `VERCEL_OIDC_TOKEN`        | runtime | Provided by Vercel when OIDC federation is enabled on the project                                                               |

`VERCEL_OIDC_TOKEN` is ambient (the host already uses it for the AI gateway), so
the only secret to provision is `GOCD_ACCESS_TOKEN`.

## GCP infra to provision (DevInfra-owned)

1. **Dedicated service account** `junior-gocd-iap@<project>` with
   `roles/iap.httpsResourceAccessor` on the GoCD IAP backend.
2. **Workload Identity pool + provider** trusting Vercel's OIDC issuer
   (`https://oidc.vercel.com/<team>`), with an attribute condition scoping it to
   Junior's Vercel project/team so only Junior can use it.
3. **Impersonation binding**: grant the federated principal
   (`principalSet://iam.googleapis.com/.../workloadIdentityPools/<POOL>/attribute.../<junior project>`)
   `roles/iam.serviceAccountTokenCreator` on the SA, so it can call
   `generateIdToken`.
4. **Read-only GoCD bot PAT**: create a GoCD user with the view-only role and
   mint a personal access token; put it in Junior's Vercel env as
   `GOCD_ACCESS_TOKEN`.

This mirrors the existing GitHub-Actions → GCP WIF setup in `devinfra-mcp`
(`infra_changelog.md`); Vercel is just a different OIDC issuer feeding the same
machinery. The IAP client id reuses the existing `deploy.getsentry.net` backend,
so no IAP-side change is needed beyond the SA grant.

## Prerequisite to confirm

OIDC federation must be enabled on Junior's Vercel project (the host already
reads `VERCEL_OIDC_TOKEN` for the AI gateway, so this is likely already on — but
confirm the issuer/audience claims map to the WIF provider config above).
