import { z } from "zod";
import { parseActorUserId } from "@/chat/actor";

const exactActorIdSchema = z
  .string()
  .refine((value) => parseActorUserId(value) === value);
const exactNonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

const slackDirectCredentialSubjectBindingSchema = z
  .object({
    type: z.literal("slack-direct-conversation"),
    teamId: z.string().min(1),
    channelId: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

const scheduledTaskCredentialSubjectBindingSchema = z
  .object({
    type: z.literal("scheduled-task"),
    plugin: z.string().min(1),
    taskId: exactNonBlankStringSchema,
    signature: z.string().min(1),
  })
  .strict();

const credentialSubjectBindingSchema = z.discriminatedUnion("type", [
  slackDirectCredentialSubjectBindingSchema,
  scheduledTaskCredentialSubjectBindingSchema,
]);

const credentialUserActorSchema = z
  .object({
    type: z.literal("user"),
    userId: exactActorIdSchema,
  })
  .strict();

const credentialSystemActorSchema = z
  .object({
    platform: z.literal("system"),
    name: exactActorIdSchema,
  })
  .strict();

export const credentialSubjectSchema = z.discriminatedUnion("allowedWhen", [
  z
    .object({
      type: z.literal("user"),
      userId: exactActorIdSchema,
      allowedWhen: z.literal("private-direct-conversation"),
      binding: slackDirectCredentialSubjectBindingSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("user"),
      userId: exactActorIdSchema,
      allowedWhen: z.literal("scheduled-task"),
      taskId: exactNonBlankStringSchema,
      binding: scheduledTaskCredentialSubjectBindingSchema,
    })
    .strict()
    .refine((subject) => subject.binding.taskId === subject.taskId, {
      message: "Scheduled task credential subject requires task binding",
      path: ["binding"],
    }),
]);

export const credentialContextSchema = z.union([
  z
    .object({
      actor: credentialUserActorSchema,
    })
    .strict(),
  z
    .object({
      actor: credentialSystemActorSchema,
      subject: credentialSubjectSchema.optional(),
    })
    .strict(),
]);

export type CredentialSubjectBinding = z.output<
  typeof credentialSubjectBindingSchema
>;
export type CredentialSystemActor = z.output<
  typeof credentialSystemActorSchema
>;
export type CredentialSubject = z.output<typeof credentialSubjectSchema>;
export type CredentialContext = z.output<typeof credentialContextSchema>;

/** Return the user whose OAuth token may satisfy this credential request. */
export function credentialUserSubjectId(
  context: CredentialContext,
): string | undefined {
  if ("type" in context.actor) {
    return context.actor.userId;
  }
  return "subject" in context ? context.subject?.userId : undefined;
}

/** Parse an untrusted credential context payload from sandbox egress state. */
export function parseCredentialContext(
  value: unknown,
): CredentialContext | undefined {
  const result = credentialContextSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
