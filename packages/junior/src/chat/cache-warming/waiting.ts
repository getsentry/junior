/**
 * What an idle period waits for besides a person: a timer, a child agent, a
 * Review item, or another Watch. Junior reads it once, when an idle period
 * starts, not on each warmup.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { NON_TERMINAL_AGENT_INVOCATION_STATUSES } from "@/chat/agent-invocations/store";
import { listWatches, type Watch } from "@/chat/events/store";
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

// Whether the Turn called `addReviewItem` after its last user message. A
// message that steers the Turn is a user message too, so only the calls
// after it count. Calls inside `codemode` or `executeTool` do not count.
function askedReviewItem(
  messages: Context["messages"],
  final: AssistantMessage,
): boolean {
  for (const message of [final, ...[...messages].reverse()]) {
    if (message.role === "user") return false;
    if (
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "toolCall" && part.name === "addReviewItem",
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The active Watches of the Conversation, and what else its idle period
 * waits on. Watches include timers and the event Watches that tools such as
 * `createPullRequest` add. A child agent that still runs comes first: its
 * result starts a Turn without a person. In an Automation run, only a child
 * agent or a Watch can start a later Turn, so a Review item does not count.
 */
export async function readPendingWork(
  conversationId: string,
  messages: Context["messages"],
  final: AssistantMessage,
  automation: boolean,
): Promise<{ watches: Watch[]; waitingOn?: WaitingOn }> {
  const [watches, children] = await Promise.all([
    listWatches({ conversationId }),
    listChildAgents(conversationId),
  ]);
  if (
    children.some((child) =>
      (NON_TERMINAL_AGENT_INVOCATION_STATUSES as readonly string[]).includes(
        child.status,
      ),
    )
  ) {
    return { watches, waitingOn: "child" };
  }
  if (automation) {
    return watches.length > 0 ? { watches, waitingOn: "watch" } : { watches };
  }
  return askedReviewItem(messages, final)
    ? { watches, waitingOn: "review" }
    : { watches };
}
