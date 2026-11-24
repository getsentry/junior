/**
 * Own the MCP view of one Inbox item, shared by the inbox item tools.
 *
 * MCP Inbox items stay read-only. An answer sends a message to the linked
 * Conversations, which can start a Turn. A dismiss starts no Turn.
 */
import * as z from "zod";
import { getDashboardInboxItemLink } from "@/chat/dashboard-link";
import { canActOnInboxItem } from "@/chat/inbox-items/access";
import type { InboxItem } from "@/chat/inbox-items/store";
import type { InboxSubjectView } from "@/api/inbox-items/resolve-subjects";
import { subjectKey } from "@/chat/inbox-items/subject-links";

/** MCP view of one Inbox item. Answers happen in Slack or the dashboard. */
export const mcpInboxItemSchema = z
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

/**
 * Map an Inbox item to its MCP view for one user. A subject shows only when
 * it is a web link. Its title comes from the user's card of the link
 * (`resolveInboxItemSubjects`).
 */
export function mcpInboxItem(
  item: InboxItem,
  userId: string,
  views: ReadonlyMap<string, InboxSubjectView>,
): z.output<typeof mcpInboxItemSchema> {
  const url = getDashboardInboxItemLink(item.id);
  const view = views.get(subjectKey(item.subject));
  const subjectUrl = view?.url;
  const subjectTitle = view?.object?.title;
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
    canAct: canActOnInboxItem(item, userId),
    conversationIds: item.conversationIds,
    ...(subjectUrl
      ? {
          subject: {
            id: item.subject.id,
            ...(subjectTitle ? { title: subjectTitle } : undefined),
            url: subjectUrl,
          },
        }
      : undefined),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    ...(url ? { url } : undefined),
  };
}
