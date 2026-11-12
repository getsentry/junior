/**
 * What an idle period waits for besides a person: a timer, a child agent, or
 * a Review item. Junior reads it once, when an idle period that it can warm
 * starts, not on each warmup.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { NON_TERMINAL_AGENT_INVOCATION_STATUSES } from "@/chat/agent-invocations/store";
import { listWatches } from "@/chat/events/store";
import type { WaitingOn } from "./model";

/**
 * Idle time at which the earliest timer Watch of the Conversation is due,
 * when it is due by `maxDueIdleMs` (`timerFloorMaxDueIdleMs`). A later timer
 * changes nothing, so the idle period warms as without a timer.
 */
export async function readTimerDueIdleMs(
  conversationId: string,
  sinceMs: number,
  maxDueIdleMs: number,
): Promise<number | undefined> {
  const dueIdleMs =
    Math.min(
      ...(await listWatches({ conversationId })).map(
        (watch) => watch.firesAtMs ?? Infinity,
      ),
    ) - sinceMs;
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
 * Whether the idle period also waits on a child agent that still runs, or
 * on a Review item that the Turn asked. A running child agent comes first:
 * its result starts a Turn without a person.
 */
export async function readWaitingOn(
  conversationId: string,
  messages: Context["messages"],
  final: AssistantMessage,
): Promise<WaitingOn | undefined> {
  const children = await listChildAgents(conversationId);
  if (
    children.some((child) =>
      (NON_TERMINAL_AGENT_INVOCATION_STATUSES as readonly string[]).includes(
        child.status,
      ),
    )
  ) {
    return "child";
  }
  return askedReviewItem(messages, final) ? "review" : undefined;
}
