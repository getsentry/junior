/**
 * Own the MCP view of one Review item, shared by the review item tools.
 *
 * MCP Review items stay read-only. An answer or dismissal sends a message to
 * the linked Conversations, which can start a Turn.
 */
import * as z from "zod";
import { getDashboardReviewItemLink } from "@/chat/dashboard-link";
import { canActOnReviewItem } from "@/chat/review-items/access";
import type { ReviewItem } from "@/chat/review-items/store";

/** MCP view of one Review item. Answers happen in Slack or the dashboard. */
export const mcpReviewItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["notice", "action"]),
    status: z.enum(["open", "done", "dismissed"]),
    title: z.string(),
    body: z.string(),
    question: z.string().optional(),
    assignees: z
      .array(z.string())
      .describe("Names or emails. Empty when anyone can act."),
    canAct: z.boolean().describe("True when you can answer or dismiss it."),
    conversationIds: z.array(z.string()),
    subject: z
      .object({
        id: z.string(),
        title: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    url: z.string().optional().describe("Dashboard link to answer it."),
  })
  .strict();

/** Map a Review item to its MCP view for one user. */
export function mcpReviewItem(
  item: ReviewItem,
  userId: string,
): z.output<typeof mcpReviewItemSchema> {
  const url = getDashboardReviewItemLink(item.id);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    body: item.body,
    ...(item.request ? { question: item.request.question } : undefined),
    assignees: item.assignedToEveryone
      ? []
      : item.assignees.map((person) => person.displayName ?? person.email),
    canAct: canActOnReviewItem(item, userId),
    conversationIds: item.conversationIds,
    ...(item.subject
      ? {
          subject: {
            id: item.subject.id,
            ...(item.subject.title ? { title: item.subject.title } : undefined),
            ...(item.subject.url ? { url: item.subject.url } : undefined),
          },
        }
      : undefined),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    ...(url ? { url } : undefined),
  };
}
