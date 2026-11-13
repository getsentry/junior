---
title: Workload Identity Credentials
description: Let a plugin call Google Cloud or Azure protected services with short-lived tokens that Junior mints from its Vercel OIDC token.
type: tutorial
summary: Declare a workload-identity credential in plugin.yaml and set up Google Cloud or Azure to trust only your production Junior deployment.
prerequisites:
  - /extend/build-a-plugin/
  - /concepts/credentials-and-oauth/
related:
  - /concepts/security-and-authority/
  - /cli/check/
---

Use a `workload-identity` credential when a service accepts tokens from Google Cloud or Microsoft Entra ID. Examples are an app behind Identity-Aware Proxy (IAP), a private Cloud Run service, or an API that checks Entra ID tokens.

Junior runs on Vercel. Vercel gives each deployment an OIDC token. Google Cloud and Azure can trust that token through workload identity federation. When sandbox traffic reaches a domain of the plugin, Junior swaps the OIDC token for a short-lived token on the host. Then it adds the token to the request. You do not store a cloud key, and the token never reaches the sandbox or the model.

The plugin needs no code. AWS is not supported, because AWS signs each request instead of using a token header.

## Manifest

This example calls an app behind IAP. The app uses `Authorization` for its own API key, so the IAP token goes in `Proxy-Authorization`. IAP removes that header before the request reaches the app.

```yaml title="plugin.yaml"
name: redash
display-name: Redash
description: Query Redash behind Identity-Aware Proxy

env-vars:
  REDASH_API_KEY:

domains:
  - redash.example.com
api-headers:
  Authorization: Key ${REDASH_API_KEY}

credentials:
  type: workload-identity
  domains:
    - redash.example.com
  header: Proxy-Authorization
  gcp:
    workload-identity-provider: projects/123456789/locations/global/workloadIdentityPools/vercel/providers/junior
    service-account: junior-redash@my-project.iam.gserviceaccount.com
    token: service-account-jwt
    audience: https://redash.example.com/*
```

| Field     | Value                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `domains` | Hosts that get the token.                                                                                         |
| `header`  | `Authorization` (default), `Proxy-Authorization`, or `X-Serverless-Authorization`. Junior sends `Bearer <token>`. |
| `gcp`     | Google Cloud settings. Set `gcp` or `azure`, not both.                                                            |
| `azure`   | Microsoft Entra ID settings.                                                                                      |

Junior always replaces the `header` value that the sandbox sends. Top-level `api-headers` can add other headers for the same domains, but they must not set the `header` name.

Values in `gcp` and `azure` are not secrets. They can use `${NAME}` refs to declared `env-vars`, with or without a default.

### Google Cloud fields

| Field                        | Value                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workload-identity-provider` | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`                         |
| `service-account`            | Email of the service account that Junior impersonates.                                                         |
| `token`                      | `service-account-jwt`, `id-token`, or `access-token`.                                                          |
| `audience`                   | For `service-account-jwt` and `id-token`. For IAP, use `https://<host>/*`. For Cloud Run, use the service URL. |
| `scopes`                     | For `access-token`. A list of Google API scopes.                                                               |

Use `service-account-jwt` for IAP, `id-token` for Cloud Run with `X-Serverless-Authorization` or `Authorization`, and `access-token` for Google APIs. Tokens last one hour. Junior mints a new token about five minutes before the old one expires.

### Azure fields

```yaml title="plugin.yaml"
credentials:
  type: workload-identity
  domains:
    - api.example.com
  azure:
    tenant-id: 00000000-0000-0000-0000-000000000000
    client-id: 11111111-1111-1111-1111-111111111111
    scope: api://my-api/.default
```

`scope` sets the API that the access token is for.

## Set up Google Cloud

1. Create a workload identity pool and an OIDC provider. Set the issuer to `https://oidc.vercel.com/<team-slug>`, even when your Vercel issuer mode is Global. A token with a custom audience always comes from the team issuer. See [Vercel OIDC for Google Cloud](https://vercel.com/docs/oidc/gcp). Select **Default audience**. Junior asks Vercel for a token with that audience.
2. Map `google.subject` to `assertion.sub`.
3. Add an attribute condition that trusts only production:

   ```text title="Attribute condition"
   assertion.sub == "owner:<team-slug>:project:<project-name>:environment:production"
   ```

   Team members can pull development OIDC tokens to their own computers. Without this condition, those tokens can mint the same credentials.

4. Create one service account for each plugin. Give it access to that one upstream only. For IAP, grant it **IAP-secured Web App User** on the protected resource. For Cloud Run, grant it **Cloud Run Invoker** on the service.
5. On the service account, grant the workload identity principal the smallest role for the token kind:

   | `token`               | Role                                         |
   | --------------------- | -------------------------------------------- |
   | `service-account-jwt` | `roles/iam.serviceAccountTokenCreator`       |
   | `id-token`            | `roles/iam.serviceAccountOpenIdTokenCreator` |
   | `access-token`        | `roles/iam.workloadIdentityUser`             |

   The principal is `principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/subject/owner:<team-slug>:project:<project-name>:environment:production`.

The Token Creator role also lets the holder mint access and ID tokens for the service account. This is why each plugin needs its own service account.

Service accounts cannot pass IAP access levels that check the device. Grant the service account its IAP role without a device-based access level condition. Otherwise Junior gets HTTP 403. See [IAP programmatic authentication](https://cloud.google.com/iap/docs/authentication-howto).

## Set up Azure

1. Register an application in Microsoft Entra ID. Copy the application (client) ID and the directory (tenant) ID.
2. Add a federated credential with the scenario **Other**:
   - Issuer: `https://oidc.vercel.com/<team-slug>`
   - Subject: `owner:<team-slug>:project:<project-name>:environment:production`
   - Audience: `api://AzureADTokenExchange`

   Entra ID needs an exact subject match. Do not add credentials for preview or development.

3. Grant the application access to the target API, for example with an app role.

## Verify

Run `junior check` to validate the manifest. Then ask Junior to call the service from the sandbox, for example with `curl https://redash.example.com/api/session`.

If a token exchange fails, the command fails with a message such as `Could not mint the redash workload identity credential: Google IAM Credentials returned HTTP 403.` The message names the failing step: Vercel OIDC, Google STS, Google IAM Credentials, or Microsoft Entra ID. Junior does not ask anyone to connect an account. Fix the trust or role setup for that step.

If the token is minted but the service returns HTTP 401 or 403, the message is `Upstream rejected the redash workload identity credential with HTTP 403.` Check the role that the service account or app has on that service. For a plugin that also sends static `api-headers`, also check those values.

## Next step

Read [Security & Authority](/concepts/security-and-authority/) for how Junior keeps credentials out of the sandbox.
