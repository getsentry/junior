import * as z from "zod";
import { userInputRequestSchema } from "@/chat/tools/runtime/user-input-request";

const answerSchema = z
  .object({
    other: z.string().max(4000).optional(),
    requestId: z.string().min(1),
    values: z.record(z.string(), z.array(z.string().max(4000)).max(20)),
  })
  .strict();

const personSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    email: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

/** One Review item as the viewer sees it. */
export const reviewItemSchema = z
  .object({
    addedByConversationId: z.string().min(1),
    /** Turn that added the item. Unset for a plugin item. */
    addedByTurnId: z.string().min(1).optional(),
    answer: answerSchema.optional(),
    assignedToEveryone: z.boolean(),
    assignees: z.array(personSchema),
    automationId: z.string().min(1).optional(),
    body: z.string(),
    /** True when the viewer can take, submit, or dismiss it. */
    canAct: z.boolean(),
    /** True when the viewer can act and is not already the only assignee. */
    canTake: z.boolean(),
    closeReason: z.string().min(1).optional(),
    closedAt: z.string().datetime().optional(),
    /** Unset for an open item, or when an agent closed it. */
    closedBy: personSchema.optional(),
    conversationIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
    kind: z.enum(["notice", "action"]),
    request: userInputRequestSchema.optional(),
    status: z.enum(["open", "done", "dismissed"]),
    subject: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    title: z.string().min(1),
    updatedAt: z.string().datetime(),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export type ReviewItemPayload = z.output<typeof reviewItemSchema>;
export type { ReviewItemChangeRecord } from "@/chat/review-items/change-record";

/**
 * Review desk list filters. The list has the open items that the viewer can
 * see, one page at a time. A search or `include=archived` also finds done and
 * dismissed items, after the open ones. `status` lists closed items instead,
 * with the same visibility.
 */
export const reviewItemListQuerySchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    /** `nextCursor` of the page before. */
    cursor: z.string().min(1).max(1_000).optional(),
    /**
     * `viewer` drops the items that are assigned only to other people. The
     * list keeps items assigned to the viewer, to Everyone, or to no one.
     */
    for: z.enum(["viewer"]).optional(),
    /** The number of open items on one page. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Also list the newest done and dismissed items, with the first page. */
    include: z.enum(["archived"]).optional(),
    q: z.string().trim().max(200).optional(),
    /**
     * `open` (the default), or closed statuses, comma separated, such as
     * `done,dismissed`. Closed items page newest closed first.
     */
    status: z
      .string()
      .default("open")
      .transform((value) => [...new Set(value.split(","))])
      .pipe(
        z
          .array(z.enum(["open", "done", "dismissed"]))
          .refine(
            (statuses) => !statuses.includes("open") || statuses.length === 1,
            "List open items on their own.",
          ),
      ),
  })
  .strict();

/**
 * One page of the review desk list. Open items come first, oldest first.
 * The first page of a search, or of a list that includes archived items,
 * also has the newest archived matches.
 */
export const reviewItemListSchema = z
  .object({
    items: z.array(reviewItemSchema),
    /** Set when more archived items match than the list shows. */
    moreArchived: z.boolean().optional(),
    /** Set when more open items follow. Pass it as `cursor` to read them. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

/** The count of Review items for the nav. */
export const reviewItemCountSchema = z
  .object({
    /**
     * Open action items assigned to the viewer as a User
     * (`reviewItemNeedsUser`). Notices and items for Everyone do not count.
     */
    needsViewer: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Conversations linked to an open action item assigned to the viewer. `title`
 * is the newest such item; `count` is how many there are; `waitingSince` is
 * when the oldest was added.
 */
export const reviewItemWaitingConversationsSchema = z
  .object({
    conversations: z.array(
      z
        .object({
          conversationId: z.string().min(1),
          /** Open items that need the viewer, newest first. */
          items: z
            .array(
              z
                .object({
                  /** The plugin that added the item, such as `github`. */
                  plugin: z.string().min(1).optional(),
                  title: z.string().min(1),
                })
                .strict(),
            )
            .min(1),
          /** When the oldest of those items was added: when the wait began. */
          waitingSince: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const reviewItemParamsSchema = z
  .object({ id: z.string().min(1) })
  .strict();

/** One person action on a Review item. */
export const reviewItemActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("take") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z
    .object({
      action: z.literal("submit"),
      answer: answerSchema.omit({ requestId: true }),
    })
    .strict(),
]);

export type ReviewItemActionBody = z.output<typeof reviewItemActionSchema>;
