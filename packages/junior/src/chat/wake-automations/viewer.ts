import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  canUserReadReviewItem,
  reviewItemReaderForUserInConversation,
  reviewItemVisibleTo,
} from "@/chat/review-items/access";
import { getReviewItem } from "@/chat/review-items/store";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorReviewItems } from "@/db/schema/review-items";
import {
  createWakeAutomation,
  reviewItemInRow,
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
    identityIds: ids,
    nowMs,
    subject: {
      conversationId: root,
      ...(input.subject.reviewItemId
        ? { reviewItemId: input.subject.reviewItemId }
        : undefined),
    },
    triggers: input.triggers,
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
