// Main's per-Turn limits on a core Turn: tool calls and model spend. The
// first tool batch past a limit gets main's wrap-up result instead of
// running, so the model replies with its progress. A tool batch after that
// ends the Turn as failed. The counts come from the Turn's own history.
import type { ToolCall } from "@earendil-works/pi-ai";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageSummary,
  logException,
  logWarn,
} from "@/chat/logging";
import {
  TURN_LIMIT_WRAP_UP_MESSAGE,
  TurnBudgetExceededError,
  TurnToolCallLimitExceededError,
} from "@/chat/services/turn-limit";
import { agentTurnCostUsd } from "@/chat/usage";
import type { EngineContext } from "@/core/engine-context";
import { loadTurnAgentHistory } from "@/core/history/read";
import type { ToolResult } from "@/core/tool";
import { TurnFailedError } from "@/core/turn/failure";
import type { TurnFailure } from "@/core/turn/state";

// The wrap-up result carries this in its details, so a later step of the
// Turn knows that the model was told to stop.
const WRAPPED_UP = "wrapped_up";

/**
 * Checks one tool batch of a Turn against main's limits. Undefined when the
 * batch may run. The first time the Turn is over a limit, gives the wrap-up
 * result for each call. After that, throws `TurnFailedError`.
 */
export async function checkTurnLimits(
  ctx: Pick<EngineContext, "executor">,
  turnId: string,
  calls: ToolCall[],
): Promise<Map<string, ToolResult> | undefined> {
  const history = await loadTurnAgentHistory(ctx, turnId);
  const replies = history.filter((message) => message.role === "assistant");
  // The tool calls of the Turn's own model replies, this batch's included:
  // its reply is the Turn's latest. Results that the Turn wrote for an
  // earlier Turn's pending calls are not its calls, so they do not count.
  const toolCallCount = replies
    .flatMap((reply) => reply.content)
    .filter((part) => part.type === "toolCall").length;
  const results = history.filter((message) => message.role === "toolResult");
  const costUsd = agentTurnCostUsd(extractGenAiUsageSummary(...replies)) ?? 0;
  const overBudget = costUsd >= botConfig.maxTurnCostUsd;
  const overToolCalls = toolCallCount > botConfig.maxToolCallsPerTurn;
  const attributes = {
    "app.ai.cost.total_usd": costUsd,
    "app.ai.tool_call_count": toolCallCount,
  };
  if (results.some((result) => isWrapUp(result.details))) {
    // The tool-call total only grows, so a stop under it came from spend.
    const error =
      overToolCalls && !overBudget
        ? new TurnToolCallLimitExceededError(botConfig.maxToolCallsPerTurn)
        : new TurnBudgetExceededError(botConfig.maxTurnCostUsd);
    const failure: TurnFailure = { failureCode: "agent_run_failed" };
    const eventId = logException(error, "agent.turn.limit.exceeded", {
      ...attributes,
      "app.turn.id": turnId,
    });
    if (eventId) {
      failure.eventId = eventId;
    }
    throw new TurnFailedError(error.message, failure);
  }
  if (!overBudget && !overToolCalls) {
    return undefined;
  }
  logWarn("agent.turn.limit.wrapped_up", attributes);
  return new Map(
    calls.map((call) => [
      call.id,
      {
        content: [{ type: "text", text: TURN_LIMIT_WRAP_UP_MESSAGE }],
        details: { turnLimit: WRAPPED_UP },
        isError: true,
      },
    ]),
  );
}

function isWrapUp(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    "turnLimit" in details &&
    details.turnLimit === WRAPPED_UP
  );
}
