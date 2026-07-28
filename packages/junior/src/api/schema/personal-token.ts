import { z } from "zod";

export const personalTokenMetadataSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    tokenSuffix: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().nullable(),
  })
  .strict();

export const personalTokenListSchema = z
  .object({ tokens: z.array(personalTokenMetadataSchema) })
  .strict();

export const createPersonalTokenBodySchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

export const createdPersonalTokenSchema = personalTokenMetadataSchema
  .extend({ token: z.string().startsWith("jr_pat_") })
  .strict();

export const personalTokenParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const revokePersonalTokenResponseSchema = z
  .object({ revoked: z.literal(true) })
  .strict();

export type PersonalTokenMetadata = z.infer<typeof personalTokenMetadataSchema>;
