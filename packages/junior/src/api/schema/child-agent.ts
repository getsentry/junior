import * as z from "zod";
import { CHILD_AGENT_RESULTS } from "@/chat/child-agents/results";
import { AGENT_STATUSES } from "@/chat/conversations/agent-status";
import { conversationChildAgentTotalsSchema } from "./child-agent-totals";
import { conversationTreeStateSchema } from "./conversation-tree-state";
import {
  conversationAuxiliaryCostsSchema,
  conversationUsageSchema,
} from "./conversation";

/**
 * One direct child agent of a Conversation, from its stored agent config.
 *
 * Viewers who cannot see private content get the status, time, and usage, but
 * not the name or title. A visible child always has a title, null when its
 * spawn gave none. Usage covers the child Conversation and all its own child
 * agents, like the detail of that child Conversation. Archived children stay
 * in the report.
 */
export const conversationChildAgentSchema = z
  .object({
    auxiliaryCosts: conversationAuxiliaryCostsSchema.optional(),
    /** When the child was archived for everyone, or null. */
    archivedAt: z.string().datetime().nullable(),
    childAgentTotals: conversationChildAgentTotalsSchema.optional(),
    conversationId: z.string().min(1),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: conversationUsageSchema.optional(),
    kind: z.enum(["thread", "task"]),
    /** How its newest finished Turn that was not stopped ended. */
    lastResult: z.enum(CHILD_AGENT_RESULTS).optional(),
    name: z.string().min(1).optional(),
    redacted: z.literal(true).optional(),
    status: z.enum(AGENT_STATUSES),
    title: z.string().min(1).nullable().optional(),
    /** What the child and its own children wait on, for the viewer. */
    treeState: conversationTreeStateSchema,
    updatedAt: z.string().datetime(),
    /** The child or one of its own children watches for an Event or Timer. */
    watching: z.boolean(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.title === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "child agent title must be set or explicitly redacted",
      });
    }
    if (data.redacted && data.name) {
      context.addIssue({
        code: "custom",
        message: "redacted child agents must not expose a name",
      });
    }
  });

/** Direct child agents of one Conversation, newest activity first. */
export const conversationChildAgentsReportSchema = z
  .object({
    agents: z.array(conversationChildAgentSchema),
    conversationId: z.string().min(1),
  })
  .strict();

export type ConversationChildAgent = z.infer<
  typeof conversationChildAgentSchema
>;
export type ConversationChildAgentsReport = z.infer<
  typeof conversationChildAgentsReportSchema
>;
