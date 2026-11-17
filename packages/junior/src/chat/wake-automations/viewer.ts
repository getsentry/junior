import type { User } from "@sentry/junior-plugin-api";
import { and, count, desc, eq, exists, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  canUserReadReviewItem,
  reviewItemForUser,
  reviewItemReaderForUser,
  reviewItemReaderForUserInConversation,
  reviewItemVisibleTo,
} from "@/chat/review-items/access";
import { getReviewItem } from "@/chat/review-items/store";
import { SLACK_EVENT_NAMESPACE } from "@/chat/slack/channel-message-events";
import { juniorAutomations } from "@/db/schema/automations";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorReviewItems } from "@/db/schema/review-items";
import {
  createWakeAutomation,
  parseWakeAutomationRow,
  reviewItemInRow,
  reviewItemInWakeRow,
  snoozeOfUserAsleep,
  unsnoozeWakeAutomation,
} from "./store";
import {
  wakeEventTrigger,
  wakeTimerTrigger,
  type WakeAutomation,
  type WakeTrigger,
} from "./types";

/** A snooze request that the viewer may not make, such as a bad trigger. */
export class WakeAutomationInputError extends Error {}

/** The viewer cannot see the Inbox row, or it does not exist. */
export class WakeSubjectNotFoundError extends Error {}

function identityIds(user: User): string[] {
  return user.identities.flatMap((identity) =>
    identity.id ? [identity.id] : [],
  );
}

async function rootConversationId(
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row ? (row.rootConversationId ?? row.conversationId) : undefined;
}

/**
 * Return the root Conversation of the row when the viewer can see an open
 * Review item in it. A missing row and a hidden row look the same.
 */
async function visibleRowRoot(
  user: User,
  subject: { conversationId: string; reviewItemId?: string },
): Promise<string> {
  const root = await rootConversationId(subject.conversationId);
  if (!root) throw new WakeSubjectNotFoundError("Inbox row was not found.");
  if (subject.reviewItemId) {
    const item = await getReviewItem(getDb(), subject.reviewItemId);
    const roots = item
      ? await Promise.all(item.conversationIds.map(rootConversationId))
      : [];
    if (
      item?.status === "open" &&
      roots.includes(root) &&
      (await canUserReadReviewItem(item, user))
    ) {
      return root;
    }
    throw new WakeSubjectNotFoundError("Inbox row was not found.");
  }
  const reader = await reviewItemReaderForUserInConversation(user, root);
  const [visible] = await getDb()
    .select({ id: juniorReviewItems.id })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reader),
        reviewItemInRow(root),
      ),
    )
    .limit(1);
  if (!visible) throw new WakeSubjectNotFoundError("Inbox row was not found.");
  return root;
}

function requireUsableTriggers(triggers: WakeTrigger[], nowMs: number): void {
  const timer = wakeTimerTrigger(triggers);
  if (timer && Date.parse(timer.firesAt) <= nowMs) {
    throw new WakeAutomationInputError("The timer must fire in the future.");
  }
  const event = wakeEventTrigger(triggers);
  if (!event) return;
  // A Slack channel-message Event runs only in its own channel. A snooze has
  // no channel, and its wake would show activity in a channel that the
  // creator may not be in.
  if (event.namespace === SLACK_EVENT_NAMESPACE) {
    throw new WakeAutomationInputError(
      "A snooze cannot wake on Slack channel messages.",
    );
  }
  const problems = registeredEventTriggerProblems(
    automationEventCatalog(getEventCatalog()),
    event,
  );
  if (problems.length > 0) {
    throw new WakeAutomationInputError(
      problems.map((problem) => problem.message).join(" "),
    );
  }
}

/**
 * Snooze one Inbox row for the viewer. It replaces the viewer's earlier
 * snooze on the row.
 */
export async function createViewerSnooze(
  user: User,
  input: {
    subject: { conversationId: string; reviewItemId?: string };
    triggers: WakeTrigger[];
  },
  nowMs = Date.now(),
): Promise<WakeAutomation> {
  const ids = identityIds(user);
  // A signed-in User always has an Identity; ownership uses it.
  if (ids.length === 0) {
    throw new WakeSubjectNotFoundError("Inbox row was not found.");
  }
  requireUsableTriggers(input.triggers, nowMs);
  const root = await visibleRowRoot(user, input.subject);
  return createWakeAutomation(getDb(), {
    creatorIdentityId: [...ids].sort()[0]!,
    nowMs,
    subject: {
      conversationId: root,
      ...(input.subject.reviewItemId
        ? { reviewItemId: input.subject.reviewItemId }
        : undefined),
    },
    triggers: input.triggers,
    userId: user.id,
  });
}

/** Undo one of the viewer's snoozes. Return false when it is not theirs. */
export async function unsnoozeViewerSnooze(
  user: User,
  id: string,
): Promise<boolean> {
  return unsnoozeWakeAutomation(getDb(), {
    id,
    identityIds: identityIds(user),
  });
}

/**
 * SQL: the viewer's snoozes that have not woken and that still hide an open
 * Review item the viewer's Inbox lists. A snooze on a row the viewer can no
 * longer see does not show.
 */
function viewerSnoozesAsleep(user: User, nowMs: number): SQL {
  const db = getDb();
  return and(
    snoozeOfUserAsleep(user.id, nowMs),
    exists(
      db
        .select({ id: juniorReviewItems.id })
        .from(juniorReviewItems)
        .where(
          and(
            eq(juniorReviewItems.status, "open"),
            reviewItemVisibleTo(reviewItemReaderForUser(user)),
            reviewItemForUser(user.id),
            reviewItemInWakeRow(),
          ),
        ),
    ),
  )!;
}

/** Count the Inbox rows that the viewer snoozed, as Snoozed lists them. */
export async function countViewerSnoozes(
  user: User,
  nowMs = Date.now(),
): Promise<number> {
  const [row] = await getDb()
    .select({ count: count() })
    .from(juniorAutomations)
    .where(viewerSnoozesAsleep(user, nowMs));
  return row?.count ?? 0;
}

/**
 * List the viewer's snoozes that hide a row now, newest first. The title is
 * the snoozed item's, or the Conversation's.
 */
export async function listViewerSnoozes(
  user: User,
  nowMs = Date.now(),
): Promise<Array<WakeAutomation & { title?: string }>> {
  const itemTitle = sql<
    string | null
  >`(select ${juniorReviewItems.title} from ${juniorReviewItems} where ${juniorReviewItems.id} = ${juniorAutomations.subjectReviewItemId})`;
  const rows = await getDb()
    .select({
      automation: juniorAutomations,
      title: sql<
        string | null
      >`coalesce(${itemTitle}, nullif(trim(${juniorConversations.title}), ''))`,
    })
    .from(juniorAutomations)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomations.subjectConversationId,
      ),
    )
    .where(viewerSnoozesAsleep(user, nowMs))
    .orderBy(desc(juniorAutomations.createdAtMs), desc(juniorAutomations.id));
  return rows.flatMap((row) => {
    const wake = parseWakeAutomationRow(row.automation);
    if (!wake) return [];
    return [{ ...wake, ...(row.title ? { title: row.title } : undefined) }];
  });
}
