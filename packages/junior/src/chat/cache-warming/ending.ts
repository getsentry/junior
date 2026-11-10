import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import { FINISH_AUTOMATION_RUN_TOOL_NAME } from "@/chat/automation-result";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { ADD_REVIEW_ITEM_TOOL_NAME } from "@/chat/tools/review-items";
import { MESSAGE_AGENT_TOOL_NAME } from "@/chat/tools/runtime/message-agent";
import { SPAWN_AGENT_TOOL_NAME } from "@/chat/tools/runtime/spawn-agent";
import { WATCH_TIMER_TOOL_NAME } from "@/chat/tools/watch-timer";

/**
 * How a Turn ended, from the core tools that it called, strongest first. A
 * label is the strongest one that the Turn called:
 *
 * - `automation_done`: the Automation run finished, so nothing follows it.
 * - `awaiting_agent`: a child agent's result starts a Turn by itself.
 * - `timer`: the timer starts a Turn by itself.
 * - `question`: a person must answer a Review item.
 * - `no_reply`: Junior posted nothing, so nobody has a reply to answer.
 * - `plain`: none of these.
 *
 * Labels that end or start the next Turn without a person come before labels
 * that wait for one. This is a structural signal: it reads which tool the
 * agent called, not what any text means.
 *
 * `noReply` and `finishAutomationRun` stop the run after their batch, and an
 * idle period starts only after a final reply. So these two labels come only
 * from a Turn where another tool in the same batch kept the run going.
 */
const TURN_ENDINGS = [
  "automation_done",
  "awaiting_agent",
  "timer",
  "question",
  "no_reply",
  "plain",
] as const;

export type TurnEnding = (typeof TURN_ENDINGS)[number];

const ENDING_BY_TOOL: Record<string, TurnEnding> = {
  [FINISH_AUTOMATION_RUN_TOOL_NAME]: "automation_done",
  [SPAWN_AGENT_TOOL_NAME]: "awaiting_agent",
  [MESSAGE_AGENT_TOOL_NAME]: "awaiting_agent",
  [WATCH_TIMER_TOOL_NAME]: "timer",
  [ADD_REVIEW_ITEM_TOOL_NAME]: "question",
  [NO_REPLY_TOOL_NAME]: "no_reply",
};

/**
 * Label how the Turn ended from the tool calls after its last user message.
 * Calls inside `codemode` or `executeTool` do not count. A message that
 * steers the Turn while it runs is a user message too, so only the calls
 * after it count.
 */
export function turnEnding(
  messages: Context["messages"],
  final: AssistantMessage,
): TurnEnding {
  let best = TURN_ENDINGS.length - 1;
  for (const message of [final, ...[...messages].reverse()]) {
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      const ending = part.type === "toolCall" && ENDING_BY_TOOL[part.name];
      if (ending) best = Math.min(best, TURN_ENDINGS.indexOf(ending));
    }
  }
  return TURN_ENDINGS[best]!;
}
