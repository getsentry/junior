import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

const GOCD_DOMAIN = "deploy.getsentry.net";
const TOKEN_ENV = "GOCD_ACCESS_TOKEN";
const WIF_AUDIENCE_ENV = "GOCD_IAP_WIF_AUDIENCE";
const SERVICE_ACCOUNT_ENV = "GOCD_IAP_SERVICE_ACCOUNT";
const IAP_CLIENT_ID_ENV = "GOCD_IAP_CLIENT_ID";
const VERCEL_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";

// The GoCD IAP OAuth client. Same audience the deploy.getsentry.net IAP backend
// expects; overridable via GOCD_IAP_CLIENT_ID.
const DEFAULT_IAP_CLIENT_ID =
  "610575311308-9bsjtgqg4jm01mt058rncpopujgk3627.apps.googleusercontent.com";

const STS_ENDPOINT = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS_ENDPOINT = "https://iamcredentials.googleapis.com/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// IAP identity tokens live ~1h; refresh a little early and treat the cached
// value as the lease lifetime so the proxy re-requests before expiry.
const IAP_TOKEN_TTL_MS = 55 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const readEnv = (name) => process.env[name]?.trim() || undefined;

/** Module-scoped IAP token cache. The token is bot-identity-scoped (not per
 * user), so a single cache serves every read request until it nears expiry. */
let cachedIapToken;

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `${url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res.json();
}

/** Exchange the host's Vercel OIDC token for a short-lived GCP access token via
 * Workload Identity Federation. No GCP key is involved — GCP trusts Vercel's
 * OIDC issuer and the token's claims authorize the exchange. */
async function exchangeOidcForGcpAccessToken({ oidcToken, audience }) {
  const body = await postForm(STS_ENDPOINT, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience,
    scope: CLOUD_PLATFORM_SCOPE,
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: oidcToken,
  });
  if (!body.access_token) {
    throw new Error("STS token exchange returned no access_token");
  }
  return body.access_token;
}

/** Mint a Google-signed OIDC identity token for the GoCD IAP audience by
 * impersonating the deploy service account with the federated access token. */
async function mintIapIdToken({ accessToken, serviceAccount, iapClientId }) {
  const url =
    `${IAM_CREDENTIALS_ENDPOINT}/projects/-/serviceAccounts/` +
    `${encodeURIComponent(serviceAccount)}:generateIdToken`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audience: iapClientId, includeEmail: true }),
  });
  if (!res.ok) {
    throw new Error(
      `generateIdToken returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const body = await res.json();
  if (!body.token) {
    throw new Error("generateIdToken returned no token");
  }
  return body.token;
}

async function getIapToken({
  oidcToken,
  audience,
  serviceAccount,
  iapClientId,
}) {
  if (cachedIapToken && cachedIapToken.expiresAtMs > Date.now() + 60_000) {
    return cachedIapToken.token;
  }
  const accessToken = await exchangeOidcForGcpAccessToken({
    oidcToken,
    audience,
  });
  const token = await mintIapIdToken({
    accessToken,
    serviceAccount,
    iapClientId,
  });
  cachedIapToken = { token, expiresAtMs: Date.now() + IAP_TOKEN_TTL_MS };
  return token;
}

const unavailable = (message) => ({ type: "unavailable", message });

/**
 * GoCD plugin: read-only access to Sentry's GoCD deploy pipelines.
 *
 * Egress to deploy.getsentry.net needs two headers — a GoCD bearer token and a
 * Google IAP identity token. The IAP token expires hourly and must be minted
 * via GCP, so this is a custom credential broker rather than a static one. It
 * authenticates to GCP keylessly through Workload Identity Federation, trading
 * the host's Vercel OIDC token for a federated access token and using that to
 * mint the IAP token. The read-only GoCD token is the only stored secret.
 */
export function gocdPlugin(options = {}) {
  const tokenEnv = options.tokenEnv ?? TOKEN_ENV;
  const wifAudienceEnv = options.wifAudienceEnv ?? WIF_AUDIENCE_ENV;
  const serviceAccountEnv = options.serviceAccountEnv ?? SERVICE_ACCOUNT_ENV;
  const iapClientIdEnv = options.iapClientIdEnv ?? IAP_CLIENT_ID_ENV;

  return defineJuniorPlugin({
    packageName: "@sentry/junior-gocd",
    manifest: {
      name: "gocd",
      displayName: "GoCD",
      description:
        "Read-only GoCD deploy pipeline status at Sentry: pipeline and group status, run history, console logs, paused pipelines, and finding which runs include a commit",
      domains: [GOCD_DOMAIN],
      envVars: {
        [tokenEnv]: {},
        [wifAudienceEnv]: {},
        [serviceAccountEnv]: {},
        [iapClientIdEnv]: {},
      },
      runtimeDependencies: [{ type: "system", package: "python3" }],
    },
    hooks: {
      grantForEgress(ctx) {
        // Read-only surface: only safe methods get a credential. Anything else
        // goes out unauthenticated and IAP/GoCD rejects it.
        if (!READ_METHODS.has(ctx.request.method.toUpperCase())) {
          return undefined;
        }
        return {
          access: "read",
          name: "gocd.deploy-status-read",
          reason: "Read-only GoCD deploy status",
        };
      },
      async issueCredential() {
        const pat = readEnv(tokenEnv);
        const audience = readEnv(wifAudienceEnv);
        const serviceAccount = readEnv(serviceAccountEnv);
        const iapClientId = readEnv(iapClientIdEnv) ?? DEFAULT_IAP_CLIENT_ID;
        const oidcToken = readEnv(VERCEL_OIDC_TOKEN_ENV);

        if (!pat) {
          return unavailable(`Missing ${tokenEnv} (read-only GoCD token).`);
        }
        if (!audience || !serviceAccount) {
          return unavailable(
            `Missing ${wifAudienceEnv} or ${serviceAccountEnv} (GCP Workload Identity Federation config).`,
          );
        }
        if (!oidcToken) {
          return unavailable(
            `Missing ${VERCEL_OIDC_TOKEN_ENV}; the host must run with Vercel OIDC enabled to mint an IAP token.`,
          );
        }

        let iapToken;
        try {
          iapToken = await getIapToken({
            oidcToken,
            audience,
            serviceAccount,
            iapClientId,
          });
        } catch (error) {
          return unavailable(`Could not mint GoCD IAP token: ${error.message}`);
        }

        return {
          type: "lease",
          lease: {
            expiresAt: new Date(Date.now() + IAP_TOKEN_TTL_MS).toISOString(),
            headerTransforms: [
              {
                domain: GOCD_DOMAIN,
                headers: {
                  Authorization: `bearer ${pat}`,
                  "Proxy-Authorization": `Bearer ${iapToken}`,
                },
              },
            ],
          },
        };
      },
    },
  });
}
