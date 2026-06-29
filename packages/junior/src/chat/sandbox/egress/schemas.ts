import { z } from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";
import {
  pluginAuthorizationSchema,
  pluginCredentialHeaderTransformSchema,
  pluginGrantSchema,
  pluginProviderAccountSchema,
} from "@sentry/junior-plugin-api";

const finiteNumberSchema = z.number().refine(Number.isFinite);
const httpStatusSchema = z.number().int().min(100).max(599);
const providerNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const credentialSignalKindSchema = z.enum(["auth_required", "unavailable"]);

export const sandboxEgressGrantSchema = pluginGrantSchema;

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
    account: pluginProviderAccountSchema.optional(),
    authorization: pluginAuthorizationSchema.optional(),
    grant: sandboxEgressGrantSchema,
    provider: providerNameSchema,
    expiresAt: z.string().min(1),
    headerTransforms: z.array(pluginCredentialHeaderTransformSchema).min(1),
  })
  .strict();

export const sandboxEgressAuthRequiredSignalSchema = z
  .object({
    authorization: pluginAuthorizationSchema.optional(),
    grant: sandboxEgressGrantSchema,
    kind: credentialSignalKindSchema.default("auth_required"),
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
    account: pluginProviderAccountSchema.optional(),
    acceptedPermissions: z.string().optional(),
    grant: sandboxEgressGrantSchema,
    message: z.string().min(1),
    provider: providerNameSchema,
    source: z.literal("upstream"),
    sso: z.string().optional(),
    status: httpStatusSchema,
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
