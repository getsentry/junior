import * as z from "zod";

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

/** Longest auto-archive grace period a user can pick: one week. */
export const AUTO_ARCHIVE_MAX_GRACE_HOURS = 7 * 24;

/** Signed-in viewer returned by `/api/me`. */
export const dashboardIdentitySchema = z
  .object({
    /** Auto-archive the viewer's conversations when their work is done. */
    autoArchiveDefault: z.boolean().optional(),
    /** Hours done work and the conversation stay quiet before auto-archive. */
    autoArchiveGraceHours: z.number().int().positive().optional(),
    user: dashboardSessionUserSchema
      .extend({
        /** Junior API path of the viewer's Slack photo, then Google photo. */
        avatarUrl: z.string().optional(),
        /** Junior-wide admin role. The server still checks it on every admin route. */
        isAdmin: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const dashboardProfileUpdateSchema = z
  .object({
    autoArchiveDefault: z.boolean().optional(),
    autoArchiveGraceHours: z
      .number()
      .int()
      .min(1)
      .max(AUTO_ARCHIVE_MAX_GRACE_HOURS)
      .optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Change at least one setting.",
  );

export const dashboardConfigSchema = z
  .object({
    allowedDomainCount: z.number(),
    authRequired: z.boolean(),
    authPath: z.string(),
    basePath: z.string(),
    sentryConversationLinks: z.boolean(),
    version: z.string().min(1),
  })
  .strict();

/** Core data the page shell embeds, so the client skips its first API reads. */
export const dashboardBootstrapSchema = z
  .object({ config: dashboardConfigSchema, me: dashboardIdentitySchema })
  .strict();

export type DashboardSession = z.infer<typeof dashboardSessionSchema>;
export type DashboardIdentity = z.infer<typeof dashboardIdentitySchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
export type DashboardBootstrap = z.infer<typeof dashboardBootstrapSchema>;
