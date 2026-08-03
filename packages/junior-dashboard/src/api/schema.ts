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
    componentGallery: z.boolean(),
    sentryConversationLinks: z.boolean(),
    systemBudgets: z
      .array(
        z
          .object({
            description: z.string().min(1),
            label: z.string().min(1),
            limit: z.number().positive(),
            name: z.string().min(1),
            outcome: z.enum(["queue", "stop"]),
            stage: z.enum(["conversation_admission", "turn"]),
            unit: z.enum(["count", "milliseconds", "usd"]),
          })
          .strict(),
      )
      .optional(),
    timeZone: z.string(),
  })
  .strict();

export type DashboardIdentity = z.infer<typeof dashboardIdentitySchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
