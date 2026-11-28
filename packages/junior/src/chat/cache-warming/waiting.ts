/**
 * What an idle period waits for besides a person: a timer, a child agent, a
 * question, or another Watch. Junior reads it once, when an idle period
 * starts, not on each warmup.
 */
import { listChildAgents } from "@/chat/child-agents/list";
import { getDb } from "@/chat/db";
import { listWatches, type Watch } from "@/chat/events/store";
import { hasOpenQuestion } from "@/chat/questions/store";
import type { WaitingOn } from "./model";

/**
 * Idle time at which the earliest timer Watch of the Conversation is due,
 * when it is due by `maxDueIdleMs` (`timerFloorMaxDueIdleMs`). A later timer
 * changes nothing, so the idle period warms as without a timer.
 */
export function earliestTimerDueIdleMs(
  watches: Watch[],
  sinceMs: number,
  maxDueIdleMs: number,
): number | undefined {
  const dueIdleMs =
    Math.min(...watches.map((watch) => watch.firesAtMs ?? Infinity)) - sinceMs;
  return dueIdleMs <= maxDueIdleMs ? dueIdleMs : undefined;
}

/**
 * The active Watches of the Conversation, and what else its idle period
 * waits on. Watches include timers and the event Watches that tools such as
 * `createPullRequest` add. A child agent that still runs comes first: its
 * result starts a Turn without a person. When `idleNeedsPendingWork`, as in
 * an Automation run, only a child agent or a Watch can start a later Turn, so
 * an open question does not count.
 */
export async function readPendingWork(
  conversationId: string,
  idleNeedsPendingWork: boolean,
): Promise<{ watches: Watch[]; waitingOn?: WaitingOn }> {
  const [watches, children] = await Promise.all([
    listWatches({ conversationId }),
    listChildAgents(conversationId),
  ]);
  if (children.some((child) => child.status === "running")) {
    return { watches, waitingOn: "child" };
  }
  if (idleNeedsPendingWork) {
    return watches.length > 0 ? { watches, waitingOn: "watch" } : { watches };
  }
  return (await hasOpenQuestion(getDb(), conversationId))
    ? { watches, waitingOn: "review" }
    : { watches };
}
