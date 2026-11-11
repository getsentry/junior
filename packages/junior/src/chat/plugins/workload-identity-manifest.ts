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
    ...(data.gcp !== undefined
      ? { gcp: expandStrings(data.gcp, "gcp", expand) }
      : undefined),
    ...(data.azure !== undefined
      ? { azure: expandStrings(data.azure, "azure", expand) }
      : undefined),
  };
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
  // The schema refinement guarantees `azure` when `gcp` is absent.
  const azure = source.azure as NonNullable<WorkloadIdentitySource["azure"]>;
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
