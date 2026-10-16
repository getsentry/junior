import {
  actorSchema,
  destinationSchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { modelProfileSchema } from "@/chat/model-profile";
import {
  AGENT_INVOCATION_MAILBOX_STATUSES,
  AGENT_INVOCATION_PARENT_MAILBOX_STATUSES,
  AGENT_INVOCATION_STATUSES,
} from "@/db/schema/agent-invocations";

const exactStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

export const agentNameSchema = exactStringSchema.max(64);

/** `messageAgent` target for the parent of a child agent. */
export const PARENT_AGENT_TARGET = "parent";

const agentInvocationMailboxStatusSchema = z.enum(
  AGENT_INVOCATION_MAILBOX_STATUSES,
);

const agentInvocationParentMailboxStatusSchema = z.enum(
  AGENT_INVOCATION_PARENT_MAILBOX_STATUSES,
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
    parentToolCallId: exactStringSchema.optional(),
    modelProfile: modelProfileSchema.optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
    source: sourceSchema,
    /**
     * Actor of the child's latest task that is not the event system Actor.
     * Guardian reads root approval for this Actor, not for `actor`.
     */
    taskActor: actorSchema.optional(),
    title: exactStringSchema.optional(),
    updatedAtMs: z.number().finite(),
  })
  .strict();

export const agentInvocationSchema = z.discriminatedUnion("status", [
  agentInvocationBaseSchema.extend({
    status: z.enum(["pending", "running", "paused"]),
  }),
  agentInvocationBaseSchema.extend({
    parentMailboxStatus: agentInvocationParentMailboxStatusSchema,
    result: z.string(),
    status: z.literal("completed"),
    terminalAtMs: z.number().finite(),
  }),
  agentInvocationBaseSchema.extend({
    errorMessage: z.string(),
    parentMailboxStatus: agentInvocationParentMailboxStatusSchema,
    status: z.enum(["blocked", "failed", "stopped"]),
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
    /** Task Actor of the parent Run when the parent is a child agent. */
    parentTaskActor: actorSchema.optional(),
    parentToolCallId: exactStringSchema.optional(),
    modelProfile: modelProfileSchema.optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
    title: exactStringSchema.optional(),
  })
  .strict();

export type AgentBinding = z.output<typeof agentBindingSchema>;
export type AgentInvocation = z.output<typeof agentInvocationSchema>;
export type AgentInvocationStatus = (typeof AGENT_INVOCATION_STATUSES)[number];
export type TerminalAgentInvocation = Extract<
  AgentInvocation,
  { status: "blocked" | "completed" | "failed" | "stopped" }
>;
export type CreateAgentInvocationInput = z.input<
  typeof createAgentInvocationSchema
>;

/** How a finished task of a child agent ended. A stop is not a result. */
export const CHILD_AGENT_RESULTS = ["completed", "blocked", "failed"] as const;
export type ChildAgentResult = (typeof CHILD_AGENT_RESULTS)[number];

/** Current state of one child agent, read from its agent invocations. */
export type ChildAgent = {
  agentName?: string;
  childConversationId: string;
  /** Error of the latest agent invocation when the child is blocked, failed, or stopped. */
  errorMessage?: string;
  /** Result of the newest agent invocation that finished without a stop. */
  lastResult?: ChildAgentResult;
  status: AgentInvocationStatus;
  /** Input of the latest agent invocation that the parent started. */
  task: string;
  /** Short title of that task. */
  title?: string;
  updatedAtMs: number;
};
