import * as z from "zod";
import type { PluginWorkloadIdentityHeader } from "@sentry/junior-plugin-api";
import type { WorkloadIdentityCredentials } from "./types";

// Values in these blocks go into token endpoint URLs and request bodies.
// Patterns keep path segments from carrying `/`, `?`, or `#`.
const WORKLOAD_IDENTITY_PROVIDER_RE =
  /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const GCP_SERVICE_ACCOUNT_RE = /^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/;
const AZURE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const WORKLOAD_IDENTITY_HEADERS = [
  "Authorization",
  "Proxy-Authorization",
  "X-Serverless-Authorization",
] as const satisfies readonly PluginWorkloadIdentityHeader[];

const text = z
  .string({ error: "must be a string" })
  .trim()
  .min(1, { error: "must be a non-empty string" });

const gcpBase = {
  "workload-identity-provider": text.regex(WORKLOAD_IDENTITY_PROVIDER_RE, {
    error:
      "must be projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
  }),
  "service-account": text.regex(GCP_SERVICE_ACCOUNT_RE, {
    error: "must be a service account email",
  }),
};

const gcpSourceSchema = z.discriminatedUnion(
  "token",
  [
    z
      .object({
        ...gcpBase,
        token: z.enum(["service-account-jwt", "id-token"]),
        audience: text,
      })
      .strict(),
    z
      .object({
        ...gcpBase,
        token: z.literal("access-token"),
        scopes: z.array(text).min(1, { error: "must not be empty" }),
      })
      .strict(),
  ],
  {
    error: 'token must be "service-account-jwt", "id-token", or "access-token"',
  },
);

const azureSourceSchema = z
  .object({
    "tenant-id": text.regex(AZURE_ID_RE, {
      error: "must be a tenant id or domain",
    }),
    "client-id": text.regex(AZURE_ID_RE, { error: "must be a client id" }),
    scope: text,
  })
  .strict();

/**
 * Strict `credentials` source for `type: workload-identity`. Strict keys make
 * an unsupported issuer such as `aws` fail instead of being ignored.
 */
export const workloadIdentitySourceSchema = z
  .object({
    type: z.literal("workload-identity"),
    domains: z.unknown(),
    header: z
      .enum(WORKLOAD_IDENTITY_HEADERS, {
        error: `must be one of ${WORKLOAD_IDENTITY_HEADERS.join(", ")}`,
      })
      .optional(),
    gcp: gcpSourceSchema.optional(),
    azure: azureSourceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.gcp) === Boolean(value.azure)) {
      ctx.addIssue({
        code: "custom",
        message: "must set exactly one of gcp or azure",
      });
    }
  });

type WorkloadIdentitySource = z.output<typeof workloadIdentitySourceSchema>;

function expandStrings(
  value: unknown,
  path: string,
  expand: (value: string, path: string) => string,
): unknown {
  if (typeof value === "string") {
    return expand(value, path);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      expandStrings(entry, `${path}.${index}`, expand),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        expandStrings(entry, `${path}.${key}`, expand),
      ]),
    );
  }
  return value;
}

/** Fill `${NAME}` refs in the non-secret `gcp` and `azure` blocks before validation. */
export function expandWorkloadIdentityEnvRefs(
  data: Record<string, unknown>,
  expand: (value: string, path: string) => string,
): Record<string, unknown> {
  return {
    ...data,
    ...(data["gcp"] !== undefined
      ? { gcp: expandStrings(data["gcp"], "gcp", expand) }
      : undefined),
    ...(data["azure"] !== undefined
      ? { azure: expandStrings(data["azure"], "azure", expand) }
      : undefined),
  };
}

// Google access tokens are accepted only by Google APIs.
const GOOGLE_API_DOMAIN = "googleapis.com";

function isGoogleApiDomain(domain: string): boolean {
  return (
    domain === GOOGLE_API_DOMAIN || domain.endsWith(`.${GOOGLE_API_DOMAIN}`)
  );
}

function audienceHost(audience: string): string | undefined {
  if (!URL.canParse(audience)) {
    return undefined;
  }
  const url = new URL(audience);
  return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
}

/**
 * Reject a credential whose minted token could reach a host that the token is
 * not for.
 *
 * All plugins federate as the same Vercel principal, so a manifest can name
 * any service account that principal can impersonate. Egress sends the token
 * only to the plugin's own `domains`, and no two plugins can own one domain.
 * So a JWT or ID token must name one of those domains as its audience, and a
 * Google access token can go only to Google APIs.
 */
export function assertWorkloadIdentityTokenTarget(
  credentials: WorkloadIdentityCredentials,
  prefix: string,
): void {
  const gcp = credentials.gcp;
  if (!gcp) {
    return;
  }
  if (gcp.token === "access-token") {
    const other = credentials.domains.find(
      (domain) => !isGoogleApiDomain(domain),
    );
    if (other) {
      throw new Error(
        `${prefix}.domains entry "${other}" is not a Google API host (*.${GOOGLE_API_DOMAIN}), so it cannot get a gcp access-token`,
      );
    }
    return;
  }
  const host = audienceHost(gcp.audience);
  if (!host || !credentials.domains.includes(host)) {
    throw new Error(
      `${prefix}.gcp.audience must be an https URL whose host is in credentials.domains`,
    );
  }
}

/**
 * Key for the identity that a credential mints tokens for. Two plugins cannot
 * share one, so one plugin cannot mint another plugin's token.
 */
export function workloadIdentityKey(
  credentials: WorkloadIdentityCredentials,
): string {
  if (credentials.azure) {
    const { clientId, tenantId } = credentials.azure;
    return `azure app ${tenantId.toLowerCase()}/${clientId.toLowerCase()}`;
  }
  return `gcp service account ${credentials.gcp.serviceAccount.toLowerCase()}`;
}

/** Return the request header that carries the minted token. */
export function workloadIdentityHeader(
  credentials: WorkloadIdentityCredentials,
): PluginWorkloadIdentityHeader {
  return credentials.header ?? "Authorization";
}

/** Convert a parsed workload identity source into its runtime credentials. */
export function workloadIdentityCredentials(
  source: WorkloadIdentitySource,
  domains: string[],
): WorkloadIdentityCredentials {
  const header = source.header ? { header: source.header } : undefined;
  if (source.gcp) {
    const gcp = source.gcp;
    const base = {
      serviceAccount: gcp["service-account"],
      workloadIdentityProvider: gcp["workload-identity-provider"],
    };
    return {
      type: "workload-identity",
      domains,
      ...header,
      gcp:
        gcp.token === "access-token"
          ? { ...base, token: gcp.token, scopes: gcp.scopes }
          : { ...base, token: gcp.token, audience: gcp.audience },
    };
  }
  const azure = source.azure;
  if (!azure) {
    // The schema refinement requires exactly one of `gcp` or `azure`.
    throw new Error("workload identity credentials must set gcp or azure");
  }
  return {
    type: "workload-identity",
    domains,
    ...header,
    azure: {
      tenantId: azure["tenant-id"],
      clientId: azure["client-id"],
      scope: azure.scope,
    },
  };
}
