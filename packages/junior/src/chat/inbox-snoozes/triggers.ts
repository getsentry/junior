import {
  eventMatches,
  type Event,
  type EventData,
} from "@sentry/junior-plugin-api";
import { and, inArray, like } from "drizzle-orm";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import { updateTimerIndex, type TimerIndex } from "@/chat/events/timer-index";
import { getSqlExecutor } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import {
  inboxItemTodo,
  TODO_INBOX_ITEM_KEY_PREFIX,
} from "@/chat/inbox-items/access";
import { dismissOpenInboxItems } from "@/chat/inbox-items/store";
import { pushInboxSnoozeWakes } from "@/chat/notifications/inbox-item-push";
import { getStateAdapter } from "@/chat/state/adapter";
import { setTodoStatusByUser } from "@/chat/todos/store";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItems } from "@/db/schema/inbox-items";
import type { InboxSnoozeWakeReason } from "@/db/schema/inbox-snoozes";
import {
  listFiringInboxSnoozeTriggers,
  settleInboxSnoozes,
  SNOOZE_TIMER_EVENT_TYPE,
} from "./store";

/**
 * Pending snooze timers. A snooze wakes in one cheap update, so one claim
 * takes many.
 */
const INBOX_SNOOZE_TIMER_INDEX: TimerIndex = {
  batchSize: 500,
  key: "junior:inbox-snoozes:due",
};

type SnoozeEvent = Pick<Event, "eventType" | "namespace"> & {
  data?: EventData | undefined;
  identifiers: readonly string[];
};

/** The To-do of each resolved item that shows one, for its snoozer. */
async function resolvedTodos(
  db: JuniorDatabase,
  resolved: readonly { inboxItemId: string; userId: string }[],
): Promise<
  { conversationId: string; id: number; inboxItemId: string; userId: string }[]
> {
  if (resolved.length === 0) return [];
  const items = await db
    .select({ dedupeKey: juniorInboxItems.dedupeKey, id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(
        inArray(
          juniorInboxItems.id,
          resolved.map((row) => row.inboxItemId),
        ),
        like(juniorInboxItems.dedupeKey, `${TODO_INBOX_ITEM_KEY_PREFIX}%`),
      ),
    );
  const todoOf = new Map(items.map((item) => [item.id, inboxItemTodo(item)]));
  return resolved.flatMap((row) => {
    const todo = todoOf.get(row.inboxItemId);
    return todo ? [{ ...todo, ...row }] : [];
  });
}

/**
 * Fire the snooze triggers that one Event matches. A `resolve` trigger
 * cancels the snooze and closes the item: it dismisses it, or marks the
 * To-do of a To-do item done for the person who snoozed it, so the agent
 * sees the change in its next `<todo-delta>`. A `wake` trigger ends the
 * snooze, which records `reason`. When one Event fires both on a snooze,
 * `resolve` wins. A snooze that already ended ignores the Event. Each
 * woken snooze pushes to its User. Returns the number of items woken.
 */
async function fireTriggers(
  db: JuniorDatabase,
  event: SnoozeEvent,
  reason: InboxSnoozeWakeReason,
  nowMs: number,
): Promise<number> {
  const triggers = (
    await listFiringInboxSnoozeTriggers(db, {
      eventTypes: [event.eventType],
      identifiers: event.identifiers,
      namespace: event.namespace,
    })
  ).filter((trigger) => eventMatches(trigger.match ?? undefined, event.data));
  const resolving = new Map(
    triggers
      .filter((trigger) => trigger.outcome === "resolve")
      .map((trigger) => [trigger.snoozeId, trigger]),
  );
  const waking = new Set(
    triggers
      .filter((trigger) => !resolving.has(trigger.snoozeId))
      .map((trigger) => trigger.snoozeId),
  );
  if (resolving.size === 0 && waking.size === 0) {
    return 0;
  }
  // A To-do changes under its own lock, so it cannot join the snooze
  // transaction. It changes first: if it fails, the snooze stays, so a
  // redelivered Event fires it again. A repeat finds the To-do closed and
  // changes nothing. Its change closes its item (`syncTodoInboxItems`).
  const todos = await resolvedTodos(db, [...resolving.values()]);
  await mapBounded(todos, (todo) =>
    setTodoStatusByUser(getSqlExecutor(), {
      assignedOnly: true,
      conversationId: todo.conversationId,
      id: todo.id,
      nowMs,
      status: "done",
      userId: todo.userId,
    }),
  );
  const todoItemIds = new Set(todos.map((todo) => todo.inboxItemId));
  const woken = await db.transaction(async (tx) => {
    const resolved = await settleInboxSnoozes(tx, {
      snoozeIds: [...resolving.keys()],
      state: "cancelled",
    });
    await dismissOpenInboxItems(tx, {
      ids: resolved
        .map((row) => row.inboxItemId)
        .filter((id) => !todoItemIds.has(id)),
      nowMs,
      reason: "A snooze trigger resolved it.",
    });
    return await settleInboxSnoozes(tx, {
      reason,
      snoozeIds: [...waking],
      state: "woken",
    });
  });
  // Only the caller whose update woke a snooze gets it back, so each wake
  // pushes once. A resolved item closed, so it pushes nothing.
  await pushInboxSnoozeWakes(woken);
  return woken.length;
}

/** Fire the snooze triggers that one published Event matches. */
export async function fireInboxSnoozeTriggers(
  db: JuniorDatabase,
  event: Event,
  nowMs = Date.now(),
): Promise<void> {
  await fireTriggers(
    db,
    {
      data: event.data,
      eventType: event.eventType,
      identifiers: [event.identifier],
      namespace: event.namespace,
    },
    {
      eventType: event.eventType,
      identifier: event.identifier,
      kind: "event",
      namespace: event.namespace,
    },
    nowMs,
  );
}

/**
 * Return whether any of these Events fires a snooze trigger. A plugin
 * batch has one namespace, so this is one read.
 */
export async function hasInboxSnoozeMatch(
  db: JuniorDatabase,
  events: readonly Event[],
): Promise<boolean> {
  const namespaces = [...new Set(events.map((event) => event.namespace))];
  const matched = await mapBounded(namespaces, async (namespace) => {
    const group = events.filter((event) => event.namespace === namespace);
    const triggers = await listFiringInboxSnoozeTriggers(db, {
      eventTypes: [...new Set(group.map((event) => event.eventType))],
      identifiers: [...new Set(group.map((event) => event.identifier))],
      namespace,
    });
    return group.some((event) =>
      triggers.some(
        (trigger) =>
          trigger.eventType === event.eventType &&
          trigger.identifier === event.identifier &&
          eventMatches(trigger.match ?? undefined, event.data),
      ),
    );
  });
  return matched.some(Boolean);
}

/** Return the Event data keys that snooze triggers on these resources match. */
export async function collectInboxSnoozeMatchKeys(
  db: JuniorDatabase,
  input: { eventTypes: string[]; identifiers: string[]; namespace: string },
): Promise<string[]> {
  const triggers = await listFiringInboxSnoozeTriggers(db, input);
  return [
    ...new Set(triggers.flatMap((trigger) => Object.keys(trigger.match ?? {}))),
  ];
}

/**
 * Schedule the timer of a snooze. Its `timer.fired` Event wakes the
 * snoozes whose triggers name `timerId`. A claimed timer is removed even
 * when no snooze names it yet, so a caller that schedules before the
 * snoozes commit wakes them itself if the fire time passed meanwhile.
 */
export async function scheduleInboxSnoozeTimer(
  timerId: string,
  firesAtMs: number,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await updateTimerIndex(state, INBOX_SNOOZE_TIMER_INDEX, {
    atMs: firesAtMs,
    id: timerId,
    kind: "add",
  });
}

/**
 * Fire the snooze timers that are due, as `timer.fired` Events. A failed
 * pass leaves its claims to expire, so the next heartbeat retries them.
 * Returns the number of items woken.
 */
export async function runInboxSnoozeTimers(
  db: JuniorDatabase,
  nowMs: number,
): Promise<number> {
  const state = getStateAdapter();
  await state.connect();
  const timerIds = await updateTimerIndex(state, INBOX_SNOOZE_TIMER_INDEX, {
    kind: "claim",
    nowMs,
  });
  if (timerIds.length === 0) return 0;
  const woken = await fireTriggers(
    db,
    {
      eventType: SNOOZE_TIMER_EVENT_TYPE,
      identifiers: timerIds,
      namespace: CORE_EVENT_NAMESPACE,
    },
    { kind: "time" },
    nowMs,
  );
  await mapBounded(timerIds, (id) =>
    updateTimerIndex(state, INBOX_SNOOZE_TIMER_INDEX, { id, kind: "remove" }),
  );
  return woken;
}
