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

export const dashboardConfigSchema = z
  .object({
    allowedEmailCount: z.number(),
    allowedGoogleDomainCount: z.number(),
    authRequired: z.boolean(),
    authPath: z.string(),
    basePath: z.string(),
    sentryConversationLinks: z.boolean(),
    timeZone: z.string(),
  })
  .strict();

export type DashboardIdentity = z.infer<typeof dashboardIdentitySchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
