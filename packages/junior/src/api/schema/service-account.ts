import { z } from "zod";

export const serviceAccountSchema = z
  .object({
    provider: z.string(),
    displayName: z.string(),
    userOAuth: z.boolean(),
    tools: z.array(z.string()),
    connected: z.boolean(),
    connectedAt: z.string().optional(),
    connectedBy: z.string().optional(),
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
