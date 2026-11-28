import * as z from "zod";

const conversationRowSchema = z
  .object({
    conversationId: z.string().min(1),
    inboxItemId: z.string().min(1).optional(),
  })
  .strict();
// An item whose owner is not a Conversation, such as an Automation alert,
// has a row of its own.
const itemRowSchema = z.object({ inboxItemId: z.string().min(1) }).strict();

/**
 * The Inbox row of a snooze: one Conversation, one item in it, or one item
 * on its own.
 */
export const inboxSnoozeSubjectSchema = z.union([
  conversationRowSchema,
  itemRowSchema,
]);

/**
 * An Event that ends a snooze: `wake` shows the item again, and `resolve`
 * dismisses it, or marks a To-do item's To-do done. The Event is on the page at `resourceUrl`, such as another
 * pull request, or on each item's subject when it is unset.
 */
export const inboxSnoozeTriggerSchema = z
  .object({
    eventType: z.string().min(1),
    outcome: z.enum(["wake", "resolve"]),
    resourceUrl: z.string().url().max(2000).optional(),
  })
  .strict();

/**
 * An Event resource that a snooze can wait on, such as a pull request, and
 * the Event types of its resource type.
 */
export const inboxSnoozeResourceSchema = z
  .object({
    events: z.array(z.string().min(1)).min(1),
    namespace: z.string().min(1),
    /** How each Event reads after the resource's name, such as "is merged". */
    phrases: z.record(z.string().min(1), z.string().min(1)),
    resourceType: z.string().min(1),
  })
  .strict();

/** `GET /api/inbox/snoozes/resource` query: the page that a person names. */
export const inboxSnoozeResourceQuerySchema = z
  .object({ url: z.string().url().max(2000) })
  .strict();

/**
 * Most triggers in one snooze. It bounds the trigger rows that one request
 * writes for each item, and fits every Event of one page: a GitHub pull
 * request has 13.
 */
export const INBOX_SNOOZE_MAX_TRIGGERS = 30;

const snoozeUntil = {
  triggers: z
    .array(inboxSnoozeTriggerSchema)
    .min(1)
    .max(INBOX_SNOOZE_MAX_TRIGGERS)
    .optional(),
  /**
   * No time and no Event: the snooze lasts until the item closes, so it
   * waits until someone else handles it, or the viewer wakes it.
   */
  untilClosed: z.literal(true).optional(),
  wakeAt: z.string().datetime().optional(),
};

/**
 * `POST /api/inbox/snoozes` body: hide the row's open items from the viewer
 * until `wakeAt` or one of `triggers` fires, whichever is first, or with
 * `untilClosed`, until each item closes. A later item in the row shows by
 * itself.
 */
export const inboxSnoozeCreateSchema = z
  .union([
    conversationRowSchema.extend(snoozeUntil).strict(),
    itemRowSchema.extend(snoozeUntil).strict(),
  ])
  .refine(
    (body) =>
      (body.untilClosed === true) !==
      (body.wakeAt !== undefined || body.triggers !== undefined),
    { message: "Set wakeAt, triggers, or both, or set untilClosed alone." },
  );

/** The items that a snooze hid from the viewer, one snooze each. */
export const inboxSnoozeSchema = z
  .object({ inboxItemIds: z.array(z.string().min(1)).min(1) })
  .strict();

/**
 * Why the viewer's snooze of an item woke: its time came, or an Event on
 * `resource`, such as `getsentry/junior#12`. `phrase` says how the Event
 * reads after the resource's name, where its source says.
 */
export const inboxSnoozeWakeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }).strict(),
  z
    .object({
      eventType: z.string().min(1),
      kind: z.literal("event"),
      phrase: z.string().min(1).optional(),
      resource: z.string().min(1),
    })
    .strict(),
]);

/**
 * The viewer's snooze of an open item, and what ends it: `wakeAt` or one
 * of `events`, whichever is first, or with `untilClosed`, the item's close.
 * An Event on `resource`, such as `getsentry/junior#12`, reads as `phrase`
 * after its name, where its source says. A `resolve` Event closes the
 * item.
 */
export const inboxViewerSnoozeSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            eventType: z.string().min(1),
            outcome: z.enum(["wake", "resolve"]),
            phrase: z.string().min(1).optional(),
            resource: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    snoozedAt: z.string().datetime(),
    untilClosed: z.literal(true).optional(),
    /**
     * A timed snooze made before its wake time was stored: it has a time,
     * but no `wakeAt`. No new snooze sets it.
     */
    untilSetTime: z.literal(true).optional(),
    wakeAt: z.string().datetime().optional(),
  })
  .strict();

/**
 * `DELETE /api/inbox/snoozes/wakes` body: the viewer opened these items, so
 * they no longer show why their snoozes woke.
 */
export const inboxSnoozeWakesClearSchema = z
  .object({ inboxItemIds: z.array(z.string().min(1)).min(1).max(100) })
  .strict();

export type InboxSnoozeCreateBody = z.input<typeof inboxSnoozeCreateSchema>;
export type InboxSnoozeSubjectBody = z.input<typeof inboxSnoozeSubjectSchema>;
export type InboxSnoozeTrigger = z.output<typeof inboxSnoozeTriggerSchema>;
export type InboxSnoozeResource = z.output<typeof inboxSnoozeResourceSchema>;
export type InboxSnoozeWake = z.output<typeof inboxSnoozeWakeSchema>;
export type InboxViewerSnooze = z.output<typeof inboxViewerSnoozeSchema>;
