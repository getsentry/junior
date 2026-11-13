import { getVercelOidcToken } from "@vercel/oidc";
import * as z from "zod";
import { CredentialMintError } from "@/chat/credentials/broker";
import { withSpan } from "@/chat/logging";
import type { WorkloadIdentityCredentials } from "@/chat/plugins/types";

// Module overview: trade the deployment's Vercel OIDC token for a short-lived
// cloud credential on the host.
//
// Core owns this exchange because the endpoints are fixed federation protocol
// details, like an OAuth token endpoint. Plugins supply the trust config
// (provider, service account or app, audience, scope) in `plugin.yaml`.
// Tokens stay on the host: callers turn them into egress header transforms.

const REQUEST_TIMEOUT_MS = 20_000;
const GCP_STS_URL = "https://sts.googleapis.com/v1/token";
const GCP_IAM_CREDENTIALS_URL =
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const GCP_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
const AZURE_VERCEL_AUDIENCE = "api://AzureADTokenExchange";
// Identity-Aware Proxy rejects service account JWTs that live longer than 1h.
const SERVICE_ACCOUNT_JWT_LIFETIME_S = 3600;

type MintStep =
  | "Vercel OIDC"
  | "Google STS"
  | "Google IAM Credentials"
  | "Microsoft Entra ID";

/** A short-lived token and the time it stops working. */
export interface WorkloadIdentityToken {
  expiresAtMs: number;
  token: string;
}

class MintStepError extends Error {
  readonly status?: number;
  readonly step: MintStep;

  constructor(
    step: MintStep,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MintStepError";
    this.step = step;
    this.status = options.status;
  }
}

const stsResponseSchema = z.object({ access_token: z.string().min(1) });
const signJwtResponseSchema = z.object({ signedJwt: z.string().min(1) });
const idTokenResponseSchema = z.object({ token: z.string().min(1) });
const accessTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  expireTime: z.iso.datetime({ offset: true }),
});
const entraResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});
const jwtExpirySchema = z.object({ exp: z.number().int().positive() });

async function vercelOidcToken(audience: string): Promise<string> {
  try {
    return await getVercelOidcToken({ audience });
  } catch (error) {
    throw new MintStepError("Vercel OIDC", "Vercel OIDC token is unavailable", {
      cause: error,
    });
  }
}

async function postForJson<T>(
  step: MintStep,
  url: string,
  init: { body: string; headers: Record<string, string> },
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MintStepError(step, `${step} request failed`, { cause: error });
  }
  if (!response.ok) {
    // Release the error body without waiting on the upstream stream.
    void response.body?.cancel().catch(() => undefined);
    throw new MintStepError(step, `${step} returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new MintStepError(step, `${step} returned an invalid response`);
  }
  return parsed.data;
}

function form(values: Record<string, string>) {
  return {
    body: new URLSearchParams(values).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

function bearerJson(token: string, value: unknown) {
  return {
    body: JSON.stringify(value),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
}

function jwtExpiresAtMs(step: MintStep, token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const claims = jwtExpirySchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return claims.exp * 1000;
  } catch (error) {
    throw new MintStepError(step, `${step} returned an invalid token`, {
      cause: error,
    });
  }
}

async function mintGcp(
  gcp: NonNullable<WorkloadIdentityCredentials["gcp"]>,
): Promise<WorkloadIdentityToken> {
  // Vercel's GCP guide uses the provider's default audience for the subject
  // token, and the `//` resource name as the STS audience.
  const subjectToken = await vercelOidcToken(
    `https://iam.googleapis.com/${gcp.workloadIdentityProvider}`,
  );
  const sts = await postForJson(
    "Google STS",
    GCP_STS_URL,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${gcp.workloadIdentityProvider}`,
      scope: GCP_CLOUD_PLATFORM_SCOPE,
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }),
    stsResponseSchema,
  );
  const serviceAccountUrl = `${GCP_IAM_CREDENTIALS_URL}/${encodeURIComponent(gcp.serviceAccount)}`;
  const step = "Google IAM Credentials";

  if (gcp.token === "service-account-jwt") {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + SERVICE_ACCOUNT_JWT_LIFETIME_S;
    const signed = await postForJson(
      step,
      `${serviceAccountUrl}:signJwt`,
      bearerJson(sts.access_token, {
        payload: JSON.stringify({
          iss: gcp.serviceAccount,
          sub: gcp.serviceAccount,
          aud: gcp.audience,
          iat: issuedAt,
          exp: expiresAt,
        }),
      }),
      signJwtResponseSchema,
    );
    return { token: signed.signedJwt, expiresAtMs: expiresAt * 1000 };
  }
  if (gcp.token === "id-token") {
    const minted = await postForJson(
      step,
      `${serviceAccountUrl}:generateIdToken`,
      bearerJson(sts.access_token, {
        audience: gcp.audience,
        includeEmail: true,
      }),
      idTokenResponseSchema,
    );
    return {
      token: minted.token,
      expiresAtMs: jwtExpiresAtMs(step, minted.token),
    };
  }
  const minted = await postForJson(
    step,
    `${serviceAccountUrl}:generateAccessToken`,
    bearerJson(sts.access_token, { scope: gcp.scopes }),
    accessTokenResponseSchema,
  );
  return {
    token: minted.accessToken,
    expiresAtMs: Date.parse(minted.expireTime),
  };
}

async function mintAzure(
  azure: NonNullable<WorkloadIdentityCredentials["azure"]>,
): Promise<WorkloadIdentityToken> {
  const assertion = await vercelOidcToken(AZURE_VERCEL_AUDIENCE);
  const minted = await postForJson(
    "Microsoft Entra ID",
    `https://login.microsoftonline.com/${encodeURIComponent(azure.tenantId)}/oauth2/v2.0/token`,
    form({
      grant_type: "client_credentials",
      client_id: azure.clientId,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: azure.scope,
    }),
    entraResponseSchema,
  );
  return {
    token: minted.access_token,
    expiresAtMs: Date.now() + minted.expires_in * 1000,
  };
}

/**
 * Mint one workload identity token for a plugin on the host.
 *
 * Expected exchange failures become `CredentialMintError`, whose message names
 * the failing step and HTTP status. Each mint records one span.
 */
export async function mintWorkloadIdentityToken(
  provider: string,
  credentials: WorkloadIdentityCredentials,
): Promise<WorkloadIdentityToken> {
  return await withSpan(
    "credential.workload_identity.mint",
    "credential.workload_identity.mint",
    {},
    async (setSpanAttributes) => {
      try {
        const minted = credentials.gcp
          ? await mintGcp(credentials.gcp)
          : await mintAzure(credentials.azure);
        setSpanAttributes({ "app.workload_identity.outcome": "completed" });
        return minted;
      } catch (error) {
        if (!(error instanceof MintStepError)) {
          throw error;
        }
        setSpanAttributes({
          "app.workload_identity.outcome": "failed",
          "app.workload_identity.step": error.step,
          "error.type": error.status ? `http_${error.status}` : error.name,
          ...(error.status
            ? { "http.response.status_code": error.status }
            : undefined),
        });
        throw new CredentialMintError(
          provider,
          `Could not mint the ${provider} workload identity credential: ${error.message}.`,
          { cause: error },
        );
      }
    },
    {
      "app.credential.provider": provider,
      "app.workload_identity.issuer": credentials.gcp ? "gcp" : "azure",
      "app.workload_identity.token_kind":
        credentials.gcp?.token ?? "access-token",
    },
  );
}
