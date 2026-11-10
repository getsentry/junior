import {
  actorSchema,
  destinationSchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { ConversationKind } from "@/chat/conversations/store";
import { credentialContextSchema } from "@/chat/credentials/context";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { agentTypeSchema } from "./agent-types";
import {
  AGENT_INVOCATION_MAILBOX_STATUSES,
  AGENT_INVOCATION_STATUSES,
} from "@/chat/agent-invocations/statuses";

const exactStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

export const agentNameSchema = exactStringSchema.max(64);

/**
 * Kind of a new child Conversation. A Thread is a child that people can
 * message; a Task is one that only its parent messages.
 */
export const CHILD_AGENT_KINDS = [
  "thread",
  "task",
] as const satisfies readonly Exclude<ConversationKind, "root">[];
export type ChildAgentKind = (typeof CHILD_AGENT_KINDS)[number];

/**
 * Longest text of one `messageAgent` message, so a loop cannot fill a mailbox
 * quickly. A report that does not come from that tool has the same cap.
 */
export const MESSAGE_AGENT_TEXT_MAX_LENGTH = 8_000;

/** `messageAgent` target for the parent of a child agent. */
export const PARENT_AGENT_TARGET = "parent";

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

/**
 * One entry in the report log of an agent invocation. A `report` is a text
 * that the child sent to its parent. Its `key` is the `messageAgent` tool
 * call id, so a retry of that call does not save it twice. A `steered_task`
 * marks a parent task that steered the running Run, so later reports answer
 * that task.
 */
const agentInvocationReportEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      key: exactStringSchema,
      kind: z.literal("report"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      invocationId: exactStringSchema,
      kind: z.literal("steered_task"),
    })
    .strict(),
]);
export type AgentInvocationReportEntry = z.output<
  typeof agentInvocationReportEntrySchema
>;

const agentInvocationBaseSchema = z
  .object({
    actor: actorSchema,
    agentName: agentNameSchema.optional(),
    childConversationId: exactStringSchema,
    createdAtMs: z.number().finite(),
    credentialContext: credentialContextSchema.optional(),
    destination: destinationSchema,
    input: exactStringSchema,
    inputLabel: exactStringSchema.optional(),
    invocationId: exactStringSchema,
    mailboxStatus: agentInvocationMailboxStatusSchema,
    parentConversationId: exactStringSchema,
    parentToolCallId: exactStringSchema.optional(),
    agentType: agentTypeSchema.optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
    reportLog: z.array(agentInvocationReportEntrySchema).optional(),
    source: sourceSchema,
    title: exactStringSchema.optional(),
    updatedAtMs: z.number().finite(),
  })
  .strict();

export const agentInvocationSchema = z.discriminatedUnion("status", [
  agentInvocationBaseSchema.extend({
    status: z.enum(["pending", "running", "paused"]),
  }),
  agentInvocationBaseSchema.extend({
    result: z.string(),
    status: z.literal("completed"),
    terminalAtMs: z.number().finite(),
  }),
  agentInvocationBaseSchema.extend({
    errorMessage: z.string(),
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
    kind: z.enum(CHILD_AGENT_KINDS).default("task"),
    parentConversationId: exactStringSchema,
    parentToolCallId: exactStringSchema.optional(),
    agentType: agentTypeSchema.optional(),
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
  /** Set while the child Conversation is archived. */
  archivedAtMs?: number;
  childConversationId: string;
  /** Error of the latest agent invocation when the child is blocked, failed, or stopped. */
  errorMessage?: string;
  kind: ChildAgentKind;
  /** Result of the newest agent invocation that finished without a stop. */
  lastResult?: ChildAgentResult;
  status: AgentInvocationStatus;
  /** Input of the latest agent invocation that the parent started. */
  task: string;
  /** Short title of that task. */
  title?: string;
  updatedAtMs: number;
};
