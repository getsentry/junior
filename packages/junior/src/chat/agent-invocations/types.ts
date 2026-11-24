import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { ChildConversationKind } from "@/chat/conversations/store";
import { credentialContextSchema } from "@/chat/credentials/context";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { agentTypeSchema } from "./agent-types";
import { AGENT_INVOCATION_STATUSES } from "@/chat/agent-invocations/statuses";

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
] as const satisfies readonly ChildConversationKind[];
export type ChildAgentKind = (typeof CHILD_AGENT_KINDS)[number];

/** `messageAgent` target for the parent of a child agent. */
export const PARENT_AGENT_TARGET = "parent";

export const agentBindingSchema = z
  .object({
    childConversationId: exactStringSchema,
    name: agentNameSchema,
    parentConversationId: exactStringSchema,
  })
  .strict();

/** Input of one `startAgent` call that starts a child agent. */
export const spawnChildAgentInputSchema = z
  .object({
    actor: actorSchema,
    agentName: agentNameSchema.optional(),
    credentialContext: credentialContextSchema.optional(),
    idempotencyKey: exactStringSchema,
    input: exactStringSchema,
    kind: z.enum(CHILD_AGENT_KINDS).default("task"),
    parentConversationId: exactStringSchema,
    parentToolCallId: exactStringSchema,
    agentType: agentTypeSchema.optional(),
    fork: z.literal(true).optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
    title: exactStringSchema.optional(),
  })
  .strict();

export type AgentBinding = z.output<typeof agentBindingSchema>;
/** The child agent that sent one reply or message to its parent. */
export type ChildAgentSender = {
  agentName?: string;
  childConversationId: string;
  parentConversationId: string;
  title?: string;
};
type AgentInvocationStatus = (typeof AGENT_INVOCATION_STATUSES)[number];
export type SpawnChildAgentInput = z.input<typeof spawnChildAgentInputSchema>;

/** How a finished task of a child agent ended. A stop is not a result. */
export const CHILD_AGENT_RESULTS = ["completed", "blocked", "failed"] as const;
type ChildAgentResult = (typeof CHILD_AGENT_RESULTS)[number];

/** Current state of one child agent, read from its Turns and mailbox. */
export type ChildAgent = {
  agentName?: string;
  /** Set while the child Conversation is archived. */
  archivedAtMs?: number;
  childConversationId: string;
  /** Why the child is blocked, failed, or stopped. */
  errorMessage?: string;
  kind: ChildAgentKind;
  /** How the newest task that finished without a stop ended. */
  lastResult?: ChildAgentResult;
  status: AgentInvocationStatus;
  /** Latest task that the parent gave the child. */
  task: string;
  /** Short title of that task. */
  title?: string;
  updatedAtMs: number;
};

/** What model-read text names a child agent by. */
export type ChildAgentRef = Pick<
  ChildAgent,
  "agentName" | "childConversationId" | "title"
>;
