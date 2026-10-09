import { z } from "zod";

const dashboardSessionUserSchema = z
  .object({
    email: z.string().trim().email(),
    emailVerified: z.boolean().optional(),
    name: z.string().nullable().optional(),
  })
  .strict();

/** Sanitized sign-in session. It never carries Junior roles. */
export const dashboardSessionSchema = z
  .object({ user: dashboardSessionUserSchema })
  .strict();

/** Signed-in viewer returned by `/api/me`. */
export const dashboardIdentitySchema = z
  .object({
    user: dashboardSessionUserSchema
      .extend({
        /** Junior-wide admin role. The server still checks it on every admin route. */
        isAdmin: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const dashboardProfileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
  })
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
    timeZone: z.string().optional(),
    version: z.string().min(1),
  })
  .strict();

export type DashboardSession = z.infer<typeof dashboardSessionSchema>;
export type DashboardIdentity = z.infer<typeof dashboardIdentitySchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
