import {
  actorSchema,
  destinationSchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import {
  AGENT_INVOCATION_MAILBOX_STATUSES,
  AGENT_INVOCATION_STATUSES,
} from "@/db/schema/agent-invocations";

const exactStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

export const agentNameSchema = exactStringSchema.max(64);

const agentInvocationMailboxStatusSchema = z.enum(
  AGENT_INVOCATION_MAILBOX_STATUSES,
);

export const agentBindingSchema = z
  .object({
    childConversationId: exactStringSchema,
    name: agentNameSchema,
    parentConversationId: exactStringSchema,
  })
  .strict();

const agentInvocationBaseSchema = z
  .object({
    actor: actorSchema,
    agentName: agentNameSchema.optional(),
    childConversationId: exactStringSchema,
    createdAtMs: z.number().finite(),
    credentialContext: credentialContextSchema.optional(),
    destination: destinationSchema,
    input: exactStringSchema,
    invocationId: exactStringSchema,
    mailboxStatus: agentInvocationMailboxStatusSchema,
    parentConversationId: exactStringSchema,
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
    source: sourceSchema,
    updatedAtMs: z.number().finite(),
  })
  .strict();

export const agentInvocationSchema = z.discriminatedUnion("status", [
  agentInvocationBaseSchema.extend({
    status: z.enum(["pending", "running", "awaiting_resume"]),
  }),
  agentInvocationBaseSchema.extend({
    result: z.string(),
    status: z.literal("completed"),
    terminalAtMs: z.number().finite(),
  }),
  agentInvocationBaseSchema.extend({
    errorMessage: z.string(),
    status: z.enum(["blocked", "failed"]),
    terminalAtMs: z.number().finite(),
  }),
]);

export const createAgentInvocationSchema = z
  .object({
    actor: actorSchema,
    agentName: agentNameSchema.optional(),
    credentialContext: credentialContextSchema.optional(),
    destination: destinationSchema,
    idempotencyKey: exactStringSchema,
    input: exactStringSchema,
    parentConversationId: exactStringSchema,
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
  })
  .strict();

export type AgentBinding = z.output<typeof agentBindingSchema>;
export type AgentInvocation = z.output<typeof agentInvocationSchema>;
export type AgentInvocationStatus = (typeof AGENT_INVOCATION_STATUSES)[number];
export type CreateAgentInvocationInput = z.input<
  typeof createAgentInvocationSchema
>;
