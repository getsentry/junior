import { z } from "zod";

const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]+$/);
const slackConversationIdSchema = z.string().regex(/^(C|G|D)[A-Z0-9]+$/);
const localConversationIdSchema = z
  .string()
  .regex(/^local:[a-z0-9_-]+:[a-z0-9][a-z0-9_-]*$/);
const exactActorUserIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim() && value.toLowerCase() !== "unknown",
  );

export const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);
const exactNonBlankStringSchema = nonBlankStringSchema.refine(
  (value) => value === value.trim(),
);

/** Runtime platform names supported by plugin public contracts. */
export const platformSchema = z.enum(["slack", "local"]);

/** Runtime source visibility visible to plugins. */
export const sourceTypeSchema = z.enum(["pub", "priv"]);

/** Provider-neutral visibility of a routed destination. */
export const destinationVisibilitySchema = z.enum(["public", "private"]);

const slackAddressSchema = z
  .object({
    platform: z.literal("slack"),
    teamId: slackTeamIdSchema,
    channelId: slackConversationIdSchema,
  })
  .strict();

/** Runtime-owned Slack address for routing future work or side effects. */
export const slackDestinationSchema = slackAddressSchema;

/** Runtime-owned local CLI conversation address. */
export const localDestinationSchema = z
  .object({
    platform: z.literal("local"),
    conversationId: localConversationIdSchema,
  })
  .strict();

/** Runtime-owned provider-neutral address for routing future work or side effects. */
export const destinationSchema = z.discriminatedUnion("platform", [
  slackDestinationSchema,
  localDestinationSchema,
]);

/** Runtime-owned Slack coordinates for the inbound invocation. */
export const slackSourceSchema = slackAddressSchema
  .extend({
    type: sourceTypeSchema,
    messageTs: nonBlankStringSchema.optional(),
    threadTs: nonBlankStringSchema.optional(),
  })
  .strict();

/** Runtime-owned local CLI coordinates for the inbound invocation. */
export const localSourceSchema = z
  .object({
    platform: z.literal("local"),
    type: z.literal("priv"),
    conversationId: localConversationIdSchema,
  })
  .strict();

/** Runtime-owned provider-neutral coordinates for the inbound invocation. */
export const sourceSchema = z.discriminatedUnion("platform", [
  slackSourceSchema,
  localSourceSchema,
]);

/** Stable user credential subject shape accepted from plugins. */
export const pluginCredentialSubjectSchema = z.discriminatedUnion(
  "allowedWhen",
  [
    z
      .object({
        type: z.literal("user"),
        userId: exactActorUserIdSchema,
        allowedWhen: z.literal("private-direct-conversation"),
      })
      .strict(),
    z
      .object({
        type: z.literal("user"),
        userId: exactActorUserIdSchema,
        allowedWhen: z.literal("scheduled-task"),
        taskId: exactNonBlankStringSchema,
      })
      .strict(),
  ],
);

/** Shared exact actor profile fields for platform-scoped actors. */
const actorProfileSchema = {
  email: nonBlankStringSchema.optional(),
  fullName: nonBlankStringSchema.optional(),
  userId: exactActorUserIdSchema,
  userName: nonBlankStringSchema.optional(),
};

export const slackActorSchema = z
  .object({
    ...actorProfileSchema,
    platform: z.literal("slack"),
    teamId: slackTeamIdSchema,
  })
  .strict();

export const localActorSchema = z
  .object({
    ...actorProfileSchema,
    platform: z.literal("local"),
  })
  .strict();

export const systemActorSchema = z
  .object({
    platform: z.literal("system"),
    name: exactActorUserIdSchema,
  })
  .strict();

/** Runtime-provided actor identity visible to plugin hooks. */
export const actorSchema = z.discriminatedUnion("platform", [
  slackActorSchema,
  localActorSchema,
  systemActorSchema,
]);

const dispatchMetadataSchema = z
  .record(z.string(), z.string())
  .superRefine((metadata, ctx) => {
    const entries = Object.entries(metadata);
    if (entries.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dispatch metadata has too many keys",
      });
      return;
    }
    for (const [key, value] of entries) {
      if (!key.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata values must be strings",
          path: [key],
        });
        continue;
      }
      if (key.length > 128) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata key exceeds the maximum length",
          path: [key],
        });
      }
      if (/[\r\n]/.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata keys must be single-line strings",
          path: [key],
        });
      }
      if (/[\r\n]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata values must be single-line strings",
          path: [key],
        });
      }
      if (value.length > 512) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata value exceeds the maximum length",
          path: [key],
        });
      }
    }
  });

/** Plugin dispatch request accepted by Junior core. */
export const dispatchOptionsSchema = z
  .object({
    idempotencyKey: nonBlankStringSchema.pipe(z.string().max(512)),
    credentialSubject: pluginCredentialSubjectSchema.optional(),
    destination: slackDestinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    input: nonBlankStringSchema.pipe(z.string().max(32_000)),
    metadata: dispatchMetadataSchema.optional(),
    source: sourceSchema,
  })
  .strict();
