import { z } from "zod";
import { AGENT_INVOCATION_STATUSES } from "@/db/schema/agent-invocations";
import { conversationChildAgentTotalsSchema } from "./child-agent-totals";
import {
  conversationAuxiliaryCostsSchema,
  conversationUsageSchema,
} from "./conversation";

/**
 * One direct child agent of a Conversation, from agent invocation records.
 *
 * Viewers who cannot see private content get the status, time, and usage, but
 * not the name, task, title, or error. Usage covers the child Conversation and
 * all its own child agents, like the detail of that child Conversation.
 */
export const conversationChildAgentSchema = z
  .object({
    auxiliaryCosts: conversationAuxiliaryCostsSchema.optional(),
    childAgentTotals: conversationChildAgentTotalsSchema.optional(),
    conversationId: z.string().min(1),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: conversationUsageSchema.optional(),
    error: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    redacted: z.literal(true).optional(),
    status: z.enum(AGENT_INVOCATION_STATUSES),
    task: z.string().optional(),
    title: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.task === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "child agent task must be text or explicitly redacted",
      });
    }
    if (data.redacted && (data.name || data.title || data.error)) {
      context.addIssue({
        code: "custom",
        message:
          "redacted child agents must not expose a name, title, or error",
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
