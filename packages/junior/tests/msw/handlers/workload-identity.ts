import { http, HttpResponse } from "msw";

// Fake token endpoints for workload identity federation: the Vercel OIDC
// audience exchange, Google STS, Google IAM Credentials, and Microsoft Entra
// ID. Tests read captured requests and can make one step fail.

export type WorkloadIdentityMockStep =
  | "gcp-sts"
  | "gcp-iam-credentials"
  | "azure-entra";

export interface WorkloadIdentityMockRequest {
  authorization: string | null;
  body: Record<string, unknown>;
  step: WorkloadIdentityMockStep;
  url: string;
}

// Far-future expiry keeps the subject token stable, so the in-process cache in
// `@vercel/oidc` cannot change what later tests see.
const SUBJECT_TOKEN_EXPIRY_S = 4_102_444_800;
const VERCEL_OIDC_SUBJECT = "owner:acme:project:junior:environment:production";

export const GCP_STS_ACCESS_TOKEN = "gcp-sts-access-token";
export const GCP_SIGNED_JWT = "gcp-signed-jwt";
export const GCP_ACCESS_TOKEN = "gcp-access-token";
export const AZURE_ACCESS_TOKEN = "azure-access-token";

const requests: WorkloadIdentityMockRequest[] = [];
const failures = new Map<WorkloadIdentityMockStep, number>();

/** Build an unsigned JWT with the given claims. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

/** Return the claims of a JWT without checking its signature. */
export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

/** A deployment OIDC token for `VERCEL_OIDC_TOKEN`. */
export const VERCEL_DEPLOYMENT_OIDC_TOKEN = unsignedJwt({
  aud: "https://vercel.com/acme",
  exp: SUBJECT_TOKEN_EXPIRY_S,
  sub: VERCEL_OIDC_SUBJECT,
});

/** Clear captured requests and injected failures between tests. */
export function resetWorkloadIdentityMockState(): void {
  requests.length = 0;
  failures.clear();
}

/** Make every request to one token endpoint fail with an HTTP status. */
export function failWorkloadIdentityStep(
  step: WorkloadIdentityMockStep,
  status: number,
): void {
  failures.set(step, status);
}

/** Return the requests that reached the fake token endpoints. */
export function workloadIdentityRequests(): WorkloadIdentityMockRequest[] {
  return requests.map((request) => ({ ...request }));
}

async function capture(
  step: WorkloadIdentityMockStep,
  request: Request,
): Promise<Response | undefined> {
  const text = await request.text();
  const body = request.headers
    .get("content-type")
    ?.includes("application/x-www-form-urlencoded")
    ? Object.fromEntries(new URLSearchParams(text))
    : (JSON.parse(text) as Record<string, unknown>);
  requests.push({
    step,
    url: request.url,
    authorization: request.headers.get("authorization"),
    body,
  });
  const status = failures.get(step);
  return status
    ? HttpResponse.json({ error: "injected_failure" }, { status })
    : undefined;
}

function expiresInSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

export const workloadIdentityHandlers = [
  http.post("https://oidc.vercel.com/~token", async ({ request }) => {
    const body = (await request.json()) as { aud?: string };
    return HttpResponse.json({
      token: unsignedJwt({
        aud: body.aud,
        exp: SUBJECT_TOKEN_EXPIRY_S,
        sub: VERCEL_OIDC_SUBJECT,
      }),
      expiry: SUBJECT_TOKEN_EXPIRY_S,
    });
  }),
  http.post("https://sts.googleapis.com/v1/token", async ({ request }) => {
    return (
      (await capture("gcp-sts", request)) ??
      HttpResponse.json({
        access_token: GCP_STS_ACCESS_TOKEN,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
      })
    );
  }),
  http.post(
    /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[^/]+:(signJwt|generateIdToken|generateAccessToken)$/,
    async ({ request }) => {
      const failure = await capture("gcp-iam-credentials", request);
      if (failure) return failure;
      const method = new URL(request.url).pathname.split(":").at(-1);
      const body = requests.at(-1)?.body ?? {};
      if (method === "signJwt") {
        return HttpResponse.json({ keyId: "key-1", signedJwt: GCP_SIGNED_JWT });
      }
      if (method === "generateIdToken") {
        return HttpResponse.json({
          token: unsignedJwt({
            aud: body.audience,
            exp: expiresInSeconds(3600),
          }),
        });
      }
      return HttpResponse.json({
        accessToken: GCP_ACCESS_TOKEN,
        expireTime: new Date(expiresInSeconds(3600) * 1000).toISOString(),
      });
    },
  ),
  http.post(
    "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
    async ({ request }) =>
      (await capture("azure-entra", request)) ??
      HttpResponse.json({
        token_type: "Bearer",
        expires_in: 3599,
        access_token: AZURE_ACCESS_TOKEN,
      }),
  ),
];
