import { z } from "zod";

export const connectionSchema = z
  .object({
    provider: z.string(),
    displayName: z.string(),
    description: z.string(),
    account: z
      .object({ label: z.string(), url: z.string().optional() })
      .strict()
      .optional(),
    connected: z.boolean(),
  })
  .strict();

export const connectionListSchema = z
  .object({ connections: z.array(connectionSchema) })
  .strict();

export const connectionParamsSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(64),
  })
  .strict();

export const startConnectionResponseSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict();

export const disconnectConnectionResponseSchema = z
  .object({ disconnected: z.literal(true) })
  .strict();
