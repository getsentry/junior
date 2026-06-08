import { z } from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";
import {
  agentPluginAuthorizationSchema,
  agentPluginCredentialHeaderTransformSchema,
  agentPluginGrantSchema,
  agentPluginProviderAccountSchema,
} from "@sentry/junior-plugin-api";

const finiteNumberSchema = z.number().refine(Number.isFinite);
const providerNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const sandboxEgressGrantSchema = agentPluginGrantSchema;

export const sandboxEgressCredentialContextSchema = z
  .object({
    credentials: credentialContextSchema,
    egressId: z.string().min(1),
    expiresAtMs: finiteNumberSchema,
    contextId: z.string().min(1),
  })
  .strict();

export const sandboxEgressCredentialLeaseSchema = z
  .object({
    account: agentPluginProviderAccountSchema.optional(),
    authorization: agentPluginAuthorizationSchema.optional(),
    grant: sandboxEgressGrantSchema,
    provider: providerNameSchema,
    expiresAt: z.string().min(1),
    headerTransforms: z
      .array(agentPluginCredentialHeaderTransformSchema)
      .min(1),
  })
  .strict();

export const sandboxEgressAuthRequiredSignalSchema = z
  .object({
    authorization: agentPluginAuthorizationSchema.optional(),
    grant: sandboxEgressGrantSchema,
    provider: providerNameSchema,
    message: z.string().optional(),
    createdAtMs: finiteNumberSchema,
  })
  .strict()
  .superRefine((signal, ctx) => {
    if (
      signal.authorization &&
      signal.authorization.provider !== signal.provider
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Auth signal authorization provider must match provider",
        path: ["authorization", "provider"],
      });
    }
  });

export const sandboxEgressPermissionDeniedSignalSchema = z
  .object({
    account: agentPluginProviderAccountSchema.optional(),
    acceptedPermissions: z.string().optional(),
    grant: sandboxEgressGrantSchema,
    message: z.string().min(1),
    provider: providerNameSchema,
    source: z.literal("upstream"),
    sso: z.string().optional(),
    status: z.literal(403),
    upstreamHost: z.string().min(1),
    upstreamPath: z.string().min(1),
    createdAtMs: finiteNumberSchema,
  })
  .strict();

export type SandboxEgressCredentialContext = z.output<
  typeof sandboxEgressCredentialContextSchema
>;
export type SandboxEgressGrant = z.output<typeof sandboxEgressGrantSchema>;
export type SandboxEgressCredentialLease = z.output<
  typeof sandboxEgressCredentialLeaseSchema
>;
export type SandboxEgressAuthRequiredSignal = z.output<
  typeof sandboxEgressAuthRequiredSignalSchema
>;
export type SandboxEgressPermissionDeniedSignal = z.output<
  typeof sandboxEgressPermissionDeniedSignalSchema
>;

/** Parse a host-owned sandbox egress auth signal from state or tool results. */
export function parseSandboxEgressAuthRequiredSignal(
  value: unknown,
): SandboxEgressAuthRequiredSignal | undefined {
  const result = sandboxEgressAuthRequiredSignalSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Parse a host-owned sandbox egress permission-denied signal from state or tool results. */
export function parseSandboxEgressPermissionDeniedSignal(
  value: unknown,
): SandboxEgressPermissionDeniedSignal | undefined {
  const result = sandboxEgressPermissionDeniedSignalSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
