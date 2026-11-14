import * as z from "zod";

export const serviceAccountSchema = z
  .object({
    provider: z.string(),
    displayName: z.string(),
    userOAuth: z.boolean(),
    tools: z.array(z.string()),
    status: z.enum(["connected", "revoked", "disconnected"]),
    /** Same as `status === "connected"`. Kept for older clients. */
    connected: z.boolean(),
    connectedAt: z.string().optional(),
    connectedBy: z.string().optional(),
    revokedAt: z.string().optional(),
  })
  .strict();

export const serviceAccountListSchema = z
  .object({ serviceAccounts: z.array(serviceAccountSchema) })
  .strict();

export const serviceAccountParamsSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(64),
  })
  .strict();

export const startServiceAccountSignInResponseSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict();

export const disconnectServiceAccountResponseSchema = z
  .object({ disconnected: z.literal(true) })
  .strict();
