import * as z from "zod";
import {
  objectTypeSchema,
  ownedObjectAnnotationSchema,
} from "@sentry/junior-plugin-api";
import {
  inboxItemNoticeRequestSchema,
  inboxItemRequestSchema,
} from "@/chat/inbox-items/request";
import { actorIdentitySchema } from "./conversation";
import {
  inboxSnoozeResourceSchema,
  inboxSnoozeWakeSchema,
} from "./inbox-snooze";

const answerSchema = z
  .object({
    other: z.string().max(4000).optional(),
    requestId: z.string().min(1),
    values: z.record(z.string(), z.array(z.string().max(4000)).max(20)),
  })
  .strict();

const personSchema = z
  .object({
    /** Junior API path of the profile photo. */
    avatarUrl: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    email: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

/** One Inbox item as the viewer sees it. */
export const inboxItemSchema = z
  .object({
    /**
     * Names the Conversation that owns the item when it is not
     * `rootConversationId`, such as a child agent's Thread title.
     */
    addedByLabel: z.string().min(1).optional(),
    /** Turn that added the item. Unset for a plugin item. */
    addedByTurnId: z.string().min(1).optional(),
    answer: answerSchema.optional(),
    /** True for an item for Everyone, also one with no assignees. */
    assignedToEveryone: z.boolean(),
    assignees: z.array(personSchema),
    automationId: z.string().min(1).optional(),
    body: z.string(),
    /** True when the viewer can take, submit, dismiss, or mark it done. */
    canAct: z.boolean(),
    /**
     * True when the viewer can answer the open question. A public question
     * takes an answer from anyone who can see it, also when `canAct` is
     * false.
     */
    canAnswer: z.boolean(),
    /** True when the viewer can act and is not already the only assignee. */
    canTake: z.boolean(),
    closeReason: z.string().min(1).optional(),
    closedAt: z.string().datetime().optional(),
    /** Unset for an open item, or when an agent closed it. */
    closedBy: personSchema.optional(),
    conversationIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    /**
     * Set when the viewer snoozed the open item, and the snooze has not
     * woken. It stays open for the other people it is for.
     */
    snoozedByViewer: z.literal(true).optional(),
    id: z.string().min(1),
    kind: z.enum(["notice", "action"]),
    /** People that the title, body, and question mention. */
    mentions: z.array(actorIdentitySchema).optional(),
    /**
     * What the item belongs to: the Conversation of the agent or plugin
     * that added it, or the Automation of an Automation alert. Its kind
     * decides the item's visibility and where the Inbox stacks it.
     */
    owner: z
      .object({
        id: z.string().min(1),
        kind: z.enum(["conversation", "automation"]),
      })
      .strict(),
    /**
     * Other open work that the viewer can see on the same subject or linked
     * work. Only an open item has it.
     */
    related: z
      .object({
        /** Linked Conversations other than the one that added the item. */
        conversationIds: z.array(z.string().min(1)),
        /**
         * Open items with the same subject id or URL, or linked to one of
         * those Conversations, newest first.
         */
        items: z.array(
          z
            .object({ id: z.string().min(1), title: z.string().min(1) })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    /**
     * The question and its related links. A notice has only the related
     * links, which say what it is about.
     */
    request: z
      .union([inboxItemRequestSchema, inboxItemNoticeRequestSchema])
      .optional(),
    /**
     * The top of the owner Conversation's tree that the viewer can see. The
     * Inbox stacks items by it. Unset when the owner is not a Conversation,
     * or when the viewer cannot see it, such as a person on the item by a
     * role on the subject; then the payload names no Conversation or Turn.
     */
    rootConversationId: z.string().min(1).optional(),
    status: z.enum(["open", "done", "dismissed"]),
    /**
     * What the item is about. `kind` says what the item asks, such as
     * `github:pull_request_review`. The rest comes from the subject when
     * Junior reads the item, never from a copy in the item.
     */
    subject: z
      .object({
        id: z.string().min(1),
        kind: z.string().min(1),
        /** The name of a plugin kind's ask, such as `Review requested`. */
        label: z.string().min(1).optional(),
        /**
         * The viewer's card of `url`, such as a pull request with its title
         * and state. Unset when no link type claims `url`, the viewer
         * cannot see it, or its provider read failed.
         */
        object: ownedObjectAnnotationSchema.optional(),
        /**
         * The object type of the link type that claims `url`, such as
         * `code_change` for a pull request. Unset when none claims it.
         */
        objectType: objectTypeSchema.optional(),
        /**
         * The Event resource that `url` names, such as a pull request, with
         * the Event types that can wake or resolve a snooze of the item.
         * Unset when no Event source claims it.
         */
        resource: inboxSnoozeResourceSchema.optional(),
        /** The web link of `id`, when `id` is one. */
        url: z.string().min(1).optional(),
      })
      .strict(),
    title: z.string().min(1),
    /**
     * The id of the To-do that the item shows, for a To-do assigned to the
     * viewer. Its owner Conversation holds the To-do. The item takes Done
     * instead of an answer or Dismiss.
     */
    todoId: z.number().int().positive().optional(),
    updatedAt: z.string().datetime(),
    visibility: z.enum(["public", "private"]),
    /**
     * Why the viewer's snooze of the open item woke. Only that viewer sees
     * it, until they open or act on the item.
     */
    wake: inboxSnoozeWakeSchema.optional(),
  })
  .strict();

export type InboxItemPayload = z.output<typeof inboxItemSchema>;
export type { InboxItemChangeRecord } from "@/chat/inbox-items/change-record";

/**
 * Inbox list filters. The list has the open items that the viewer can
 * see, one page at a time. A search or `include=archived` also finds done and
 * dismissed items, after the open ones. `status` lists closed items instead,
 * with the same visibility.
 */
export const inboxItemListQuerySchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    /** `nextCursor` of the page before. */
    cursor: z.string().min(1).max(1_000).optional(),
    /**
     * `viewer` drops the items that are assigned only to other people. The
     * list keeps items assigned to the viewer, to Everyone, or to no one.
     */
    for: z.enum(["viewer"]).optional(),
    /** `automation` lists only Automation alerts. */
    owner: z.enum(["automation"]).optional(),
    /**
     * `true` lists only the open items in Inbox rows that the viewer
     * snoozed, the Snoozed view. Without it, `for=viewer` hides them.
     */
    snoozed: z.enum(["true"]).optional(),
    /** The number of open items on one page. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Also list the newest done and dismissed items, with the first page. */
    include: z.enum(["archived"]).optional(),
    q: z.string().trim().max(200).optional(),
    /**
     * `waiting` lists the open items that wait on the viewer first, then the
     * rest, newest first within each group. By default open items page
     * oldest first. A closed list ignores it.
     */
    sort: z.enum(["waiting"]).optional(),
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
 * One page of the Inbox list. Open items come first, oldest first.
 * The first page of a search, or of a list that includes archived items,
 * also has the newest archived matches.
 */
export const inboxItemListSchema = z
  .object({
    items: z.array(inboxItemSchema),
    /** Set when more archived items match than the list shows. */
    moreArchived: z.boolean().optional(),
    /** Set when more open items follow. Pass it as `cursor` to read them. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

/** `GET /api/inbox-items/count` query. */
export const inboxItemCountQuerySchema = z
  .object({
    /**
     * Extra counts, comma separated. `automations` counts the viewer's
     * Automations that need attention, and `snoozed` their snoozed rows.
     */
    include: z
      .string()
      .default("")
      .transform((value) => [...new Set(value.split(",").filter(Boolean))])
      .pipe(z.array(z.enum(["automations", "snoozed"]))),
  })
  .strict();

/**
 * The counts behind the Inbox badge, which shows `needsViewer`, and behind
 * the Inbox entries. An Automation alert is an Inbox item, so
 * `needsViewer` counts it.
 */
export const inboxItemCountSchema = z
  .object({
    /**
     * The viewer's own Automations that need attention, as the Automations
     * entry counts them (`scope=attention&owner=me`). Only with
     * `include=automations`.
     */
    automations: z.number().int().nonnegative().optional(),
    /** The `needsViewer` items whose subject is a code change. */
    codeChanges: z.number().int().nonnegative(),
    /** The `needsViewer` items that ask with a form. */
    decisions: z.number().int().nonnegative(),
    /**
     * Open action items assigned to the viewer as a User
     * (`inboxItemNeedsUser`). Notices and items for Everyone do not count.
     */
    needsViewer: z.number().int().nonnegative(),
    /**
     * The Inbox rows that the viewer snoozed and that still have an open
     * item for them, as Snoozed lists them. 0 without `include=snoozed`.
     */
    snoozed: z.number().int().nonnegative(),
    /** The `needsViewer` items that show a To-do (`todoId`). */
    todos: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Conversations linked to an open action item assigned to the viewer. `title`
 * is the newest such item; `count` is how many there are; `waitingSince` is
 * when the oldest was added.
 */
export const inboxItemWaitingConversationsSchema = z
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

export const inboxItemParamsSchema = z
  .object({ id: z.string().min(1) })
  .strict();

/** One person action on an Inbox item. */
export const inboxItemActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("take") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  /** Mark the To-do of a To-do item done. */
  z.object({ action: z.literal("done") }).strict(),
  z
    .object({
      action: z.literal("submit"),
      answer: answerSchema.omit({ requestId: true }),
    })
    .strict(),
]);

export type InboxItemActionBody = z.output<typeof inboxItemActionSchema>;
