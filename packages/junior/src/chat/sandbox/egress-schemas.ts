import { z } from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";

const finiteNumberSchema = z.number().refine(Number.isFinite);
const providerNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const credentialIntentSchema = z.union([z.literal("read"), z.literal("write")]);

const credentialHeaderTransformSchema = z
  .object({
    domain: z.string().min(1),
    headers: z.record(z.string(), z.string()),
  })
  .strict();

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
    provider: providerNameSchema,
    intent: credentialIntentSchema,
    expiresAt: z.string().min(1),
    headerTransforms: z.array(credentialHeaderTransformSchema).min(1),
  })
  .strict();

export const sandboxEgressAuthRequiredSignalSchema = z
  .object({
    provider: providerNameSchema,
    intent: credentialIntentSchema,
    createdAtMs: finiteNumberSchema,
  })
  .strict();

export type SandboxEgressCredentialContext = z.output<
  typeof sandboxEgressCredentialContextSchema
>;
export type SandboxEgressCredentialLease = z.output<
  typeof sandboxEgressCredentialLeaseSchema
>;
export type SandboxEgressAuthRequiredSignal = z.output<
  typeof sandboxEgressAuthRequiredSignalSchema
>;

/** Parse a host-owned sandbox egress auth signal from state or tool results. */
export function parseSandboxEgressAuthRequiredSignal(
  value: unknown,
): SandboxEgressAuthRequiredSignal | undefined {
  const result = sandboxEgressAuthRequiredSignalSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
