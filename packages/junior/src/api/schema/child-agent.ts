import * as z from "zod";
import { CHILD_AGENT_RESULTS } from "@/chat/child-agents/results";
import { AGENT_STATUSES } from "@/chat/conversations/agent-status";
import { conversationSummaryReportSchema } from "./conversation";

/**
 * The only fields of a redacted child agent: its state, time, and usage.
 * Every other field can hold private content.
 */
const REDACTED_CHILD_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "agentStatus",
  "archivedAt",
  "auxiliaryCosts",
  "childAgentTotals",
  "conversationId",
  "cumulativeDurationMs",
  "cumulativeUsage",
  "isParticipant",
  "kind",
  "lastMessageAt",
  "lastProgressAt",
  "lastResult",
  "lastSeenAt",
  "latestTurnFailed",
  "parentConversationId",
  "redacted",
  "startedAt",
  "status",
  "surface",
  "treeState",
  "turnActive",
  "watching",
]);

/**
 * One direct child agent of a Conversation: the row that the Conversation
 * feed lists, plus the facts that only a child agent has. Usage covers the
 * child and all its own child agents, like a feed row. Archived children
 * stay in the report.
 *
 * A viewer who cannot see private content gets `redacted` and only the
 * state, time, and usage fields: no title, name, summary, or preview.
 */
export const conversationChildAgentSchema = conversationSummaryReportSchema
  .extend({
    /** What the agent does now, as the `listAgents` tool reports it. */
    agentStatus: z.enum(AGENT_STATUSES),
    /** Set on every child agent that is not redacted. */
    displayTitle: z.string().optional(),
    /** How its newest finished Turn that was not stopped ended. */
    lastResult: z.enum(CHILD_AGENT_RESULTS).optional(),
    name: z.string().min(1).optional(),
    redacted: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if (!data.redacted) {
      if (data.displayTitle === undefined) {
        context.addIssue({
          code: "custom",
          message: "child agent title must be set or explicitly redacted",
        });
      }
      return;
    }
    for (const field of Object.keys(data)) {
      if (!REDACTED_CHILD_AGENT_FIELDS.has(field)) {
        context.addIssue({
          code: "custom",
          message: `redacted child agents must not expose ${field}`,
        });
      }
    }
  });

/** Direct child agents of one Conversation, newest activity first. */
export const conversationChildAgentsReportSchema = z
  .object({
    conversationId: z.string().min(1),
    conversations: z.array(conversationChildAgentSchema),
  })
  .strict();

export type ConversationChildAgent = z.infer<
  typeof conversationChildAgentSchema
>;
export type ConversationChildAgentsReport = z.infer<
  typeof conversationChildAgentsReportSchema
>;
