import { z } from "zod";

export const dashboardIdentitySchema = z
  .object({
    user: z
      .object({
        email: z.string().trim().email(),
        emailVerified: z.boolean().optional(),
        name: z.string().nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const personalTokenMetadataSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tokenSuffix: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();

export const personalTokenListSchema = z
  .object({ tokens: z.array(personalTokenMetadataSchema) })
  .strict();

export const createPersonalTokenBodySchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

export const createdPersonalTokenSchema = personalTokenMetadataSchema
  .extend({ token: z.string() })
  .strict();

export const dashboardConfigSchema = z
  .object({
    allowedEmailCount: z.number(),
    allowedGoogleDomainCount: z.number(),
    authRequired: z.boolean(),
    authPath: z.string(),
    basePath: z.string(),
    componentGallery: z.boolean(),
    sentryConversationLinks: z.boolean(),
    timeZone: z.string(),
  })
  .strict();

export type DashboardIdentity = z.infer<typeof dashboardIdentitySchema>;
export type PersonalTokenMetadata = z.infer<typeof personalTokenMetadataSchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
