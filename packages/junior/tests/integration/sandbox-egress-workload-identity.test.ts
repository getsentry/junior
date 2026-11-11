import path from "node:path";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import {
  consumeSandboxEgressAuthRequiredSignal,
  createSandboxEgressCredentialToken,
} from "@/chat/sandbox/egress/session";
import {
  proxyVercelSandboxEgressRequest,
  toVercelNetworkPolicy,
} from "@/chat/sandbox/egress/vercel";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import {
  AZURE_ACCESS_TOKEN,
  failWorkloadIdentityStep,
  GCP_ACCESS_TOKEN,
  GCP_SIGNED_JWT,
  GCP_STS_ACCESS_TOKEN,
  jwtClaims,
  VERCEL_DEPLOYMENT_OIDC_TOKEN,
  workloadIdentityRequests,
} from "../msw/handlers/workload-identity";

const ORIGINAL_ENV = { ...process.env };
const FIXTURE_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/workload-identity",
);
const BASE_URL = "https://junior.example.com";
const EGRESS_ID = "sbx_workload_identity";
const IAP_HOST = "iap-app.example.test";
const CLOUD_RUN_HOST = "cloud-run.example.test";
const GOOGLE_API_HOST = "google-api.example.test";
const AZURE_HOST = "azure-app.example.test";
const WORKLOAD_IDENTITY_PROVIDER =
  "projects/123456/locations/global/workloadIdentityPools/vercel/providers/junior";

/**
 * Start the app with Cloud Run, Google API, and Azure plugins from inline
 * manifests. The IAP plugin comes from the `plugin.yaml` fixture.
 */
async function startApp() {
  const gcp = {
    workloadIdentityProvider: WORKLOAD_IDENTITY_PROVIDER,
    serviceAccount: "runner@example-project.iam.gserviceaccount.com",
  };
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "cloud-run",
          displayName: "Cloud Run",
          description: "Cloud Run fixture",
          credentials: {
            type: "workload-identity",
            domains: [CLOUD_RUN_HOST],
            header: "X-Serverless-Authorization",
            gcp: {
              ...gcp,
              token: "id-token",
              audience: `https://${CLOUD_RUN_HOST}`,
            },
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "google-api",
          displayName: "Google API",
          description: "Google API fixture",
          credentials: {
            type: "workload-identity",
            domains: [GOOGLE_API_HOST],
            gcp: {
              ...gcp,
              token: "access-token",
              scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
            },
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "azure-app",
          displayName: "Azure App",
          description: "Azure fixture",
          credentials: {
            type: "workload-identity",
            domains: [AZURE_HOST],
            azure: {
              tenantId: "contoso.onmicrosoft.com",
              clientId: "11111111-1111-1111-1111-111111111111",
              scope: "api://azure-app/.default",
            },
          },
        },
      }),
    ]),
    waitUntil(task) {
      if (typeof task === "function") {
        void task();
      }
    },
  });
}

describe("sandbox egress workload identity credentials", () => {
  let pluginApp: PluginAppFixture | undefined;
  const upstreamHeaders: Headers[] = [];
  const upstreamFetch = vi.fn(
    async (_url: URL | string, init?: RequestInit) => {
      upstreamHeaders.push(new Headers(init?.headers));
      return new Response("ok");
    },
  );

  /** Send one request from the sandbox through the real egress proxy. */
  async function sendFromSandbox(
    host: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const credentialToken = createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: "U123" } },
      egressId: EGRESS_ID,
      ttlMs: 2 * 60 * 60 * 1000,
    });
    const policy = toVercelNetworkPolicy(
      buildSandboxEgressNetworkPolicy({ credentialToken }),
    ) as { allow: Record<string, Array<{ forwardURL: string }>> };
    const forwardURL = policy.allow[host]?.[0]?.forwardURL;
    if (!forwardURL) {
      throw new Error(`Missing forwardURL for ${host}`);
    }
    return await proxyVercelSandboxEgressRequest(
      new Request(`${forwardURL}/api/queries`, {
        headers: {
          "vercel-forwarded-host": host,
          "vercel-forwarded-path": "/api/queries",
          "vercel-forwarded-scheme": "https",
          "vercel-sandbox-oidc-token": "signed-vercel-token",
          ...headers,
        },
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );
  }

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: BASE_URL,
      JUNIOR_SECRET: "integration-secret",
      JUNIOR_STATE_ADAPTER: "memory",
      IAP_APP_API_KEY: "redash-api-key",
      VERCEL_OIDC_TOKEN: VERCEL_DEPLOYMENT_OIDC_TOKEN,
    };
    upstreamHeaders.length = 0;
    upstreamFetch.mockClear();
    pluginApp = await createPluginAppFixture([FIXTURE_PLUGIN_ROOT]);
    await disconnectStateAdapter();
    await getStateAdapter().connect();
    await startApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("sends an IAP service account JWT in Proxy-Authorization next to static API headers, and mints again when the lease expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const response = await sendFromSandbox(IAP_HOST, {
      authorization: "Key sandbox-value",
      "proxy-authorization": "Bearer sandbox-value",
    });

    expect(response.status).toBe(200);
    expect(Object.fromEntries(upstreamHeaders[0] ?? [])).toMatchObject({
      authorization: "Key redash-api-key",
      "proxy-authorization": `Bearer ${GCP_SIGNED_JWT}`,
    });
    const [sts, signJwt] = workloadIdentityRequests();
    expect(sts?.body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${WORKLOAD_IDENTITY_PROVIDER}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(jwtClaims(String(sts?.body.subject_token)).aud).toBe(
      `https://iam.googleapis.com/${WORKLOAD_IDENTITY_PROVIDER}`,
    );
    expect(signJwt?.url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/iap-app%40example-project.iam.gserviceaccount.com:signJwt",
    );
    expect(signJwt?.authorization).toBe(`Bearer ${GCP_STS_ACCESS_TOKEN}`);
    const claims = JSON.parse(String(signJwt?.body.payload)) as Record<
      string,
      number | string
    >;
    expect(claims).toMatchObject({
      iss: "iap-app@example-project.iam.gserviceaccount.com",
      sub: "iap-app@example-project.iam.gserviceaccount.com",
      aud: `https://${IAP_HOST}/*`,
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);

    // The lease is shared until 5 minutes before the token expires.
    vi.setSystemTime(Date.now() + 54 * 60 * 1000);
    expect((await sendFromSandbox(IAP_HOST)).status).toBe(200);
    expect(workloadIdentityRequests()).toHaveLength(2);

    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect((await sendFromSandbox(IAP_HOST)).status).toBe(200);
    expect(workloadIdentityRequests()).toHaveLength(4);
    expect(upstreamHeaders[2]?.get("proxy-authorization")).toBe(
      `Bearer ${GCP_SIGNED_JWT}`,
    );
  });

  it("sends Cloud Run ID tokens, Google access tokens, and Azure access tokens in the configured header", async () => {
    for (const host of [CLOUD_RUN_HOST, GOOGLE_API_HOST, AZURE_HOST]) {
      expect((await sendFromSandbox(host)).status).toBe(200);
    }

    const [cloudRun, googleApi, azure] = upstreamHeaders;
    const idToken = cloudRun?.get("x-serverless-authorization") ?? "";
    expect(jwtClaims(idToken.replace(/^Bearer /, "")).aud).toBe(
      `https://${CLOUD_RUN_HOST}`,
    );
    expect(cloudRun?.get("authorization")).toBeNull();
    expect(googleApi?.get("authorization")).toBe(`Bearer ${GCP_ACCESS_TOKEN}`);
    expect(azure?.get("authorization")).toBe(`Bearer ${AZURE_ACCESS_TOKEN}`);

    const requests = workloadIdentityRequests();
    expect(
      requests
        .filter((request) => request.step === "gcp-iam-credentials")
        .map((request) => [request.url.split(":").at(-1), request.body]),
    ).toEqual([
      [
        "generateIdToken",
        { audience: `https://${CLOUD_RUN_HOST}`, includeEmail: true },
      ],
      [
        "generateAccessToken",
        { scope: ["https://www.googleapis.com/auth/bigquery.readonly"] },
      ],
    ]);
    const entra = requests.find((request) => request.step === "azure-entra");
    expect(entra?.url).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
    expect(entra?.body).toMatchObject({
      grant_type: "client_credentials",
      client_id: "11111111-1111-1111-1111-111111111111",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      scope: "api://azure-app/.default",
    });
    expect(jwtClaims(String(entra?.body.client_assertion)).aud).toBe(
      "api://AzureADTokenExchange",
    );
  });

  it("reports a mint failure as unavailable with the failing step, without an auth flow", async () => {
    // Injected fault: IAM Credentials denies the service account.
    failWorkloadIdentityStep("gcp-iam-credentials", 403);

    const response = await sendFromSandbox(IAP_HOST);

    expect(response.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
    const signal = await consumeSandboxEgressAuthRequiredSignal(EGRESS_ID);
    expect(signal).toMatchObject({
      kind: "unavailable",
      provider: "iap-app",
      message:
        "Could not mint the iap-app workload identity credential: Google IAM Credentials returned HTTP 403.",
    });
    expect(signal?.authorization).toBeUndefined();
  });
});
