import * as z from "zod";
import { savedUserInputRequestSchema } from "@/chat/inbox-items/user-input-request";

/**
 * One related link that an agent adds to an Inbox item: a link or a
 * Conversation, with a short label and an optional one-line note. A link
 * points outside Junior; a Conversation reference points to work in Junior.
 * The question stores the list, and its card shows it beside the answer
 * choices.
 */
export const inboxItemRelatedLinkSchema = z
  .object({
    conversationId: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(120),
    note: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.url === undefined) !== (entry.conversationId === undefined),
    "A related link has a `url` or a `conversationId`, not both.",
  );

export type InboxItemRelatedLink = z.output<typeof inboxItemRelatedLinkSchema>;

/**
 * The question of an Inbox item with its related links. The links are part
 * of the question, so they are stored with it in `request`.
 */
export const inboxItemRequestSchema = savedUserInputRequestSchema.safeExtend({
  related: z.array(inboxItemRelatedLinkSchema).optional(),
});

export type InboxItemRequest = z.output<typeof inboxItemRequestSchema>;

/**
 * The request of a notice: only the related links that say what it is
 * about, such as a pull request. A notice asks nothing, so it has no
 * question.
 */
export const inboxItemNoticeRequestSchema = z
  .object({ related: z.array(inboxItemRelatedLinkSchema) })
  .strict();

export type InboxItemNoticeRequest = z.output<
  typeof inboxItemNoticeRequestSchema
>;

/**
 * Return the question of an item's request. A notice's request holds only
 * related links, so it has none.
 */
export function inboxItemQuestion(
  request: InboxItemRequest | InboxItemNoticeRequest | null | undefined,
): InboxItemRequest | undefined {
  return request && "question" in request ? request : undefined;
}
