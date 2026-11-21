/**
 * The cache warming recorder of one agent run. It sees each model request of
 * the run, records the finished calls, and starts the idle period when the
 * Turn ends. `warmup.ts` owns the idle period and its warmups.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
// oxlint-disable-next-line no-restricted-imports -- The agent loop stream. Its Turn records the cost.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getChatConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";
import type { ToolDefinitionsKey } from "@/chat/tool-support/registry";
import { CACHE_RETENTION, type ModelRequest } from "./request";
import { createToolWaitWarmer } from "./tool-wait";
import {
  ANSWER_TOOL_ENDINGS,
  recordModelCall,
  stopIdleWarmups,
  type CacheWarmingTurn,
  type TurnEnding,
} from "./warmup";

/** Records the model calls of one agent run and schedules cache warmups. */
export interface CacheWarmingRecorder {
  /**
   * Wrap the stream function so the recorder sees each model request. The
   * wrapper also sets the cache retention that warming assumes while warming
   * is on.
   */
  wrap(base?: AgentRequestStreamFn): AgentRequestStreamFn;
  /** Record the finished assistant message of the last model request. */
  record(message: AssistantMessage): Promise<void>;
  /** Mark that the tools of the last request returned. */
  toolsReturned(): void;
  /**
   * Mark that an answer tool call of the last request ended the run. After
   * `reply`, `noReply` or `reportBlocked`, `stop` starts the idle period from
   * that request, as a final response would.
   */
  answerToolEnded(toolName: string): void;
  /** Stop the warmups of this run. Call it when the run ends. */
  stop(): Promise<void>;
}

/**
 * Create a recorder for one agent run. A failure to record only loses cache
 * warming, so it is logged and does not stop the run.
 */
export function createCacheWarmingRecorder(
  conversationId: string,
  turn: CacheWarmingTurn,
  definitionsKey: ToolDefinitionsKey,
): CacheWarmingRecorder {
  let lastRequest: ModelRequest | undefined;
  // The last finished call, for an idle period that an answer tool starts.
  let lastCall:
    | { request: ModelRequest; message: AssistantMessage }
    | undefined;
  let answerToolEnding: TurnEnding | undefined;
  // After the first call of the run ends the idle period, the next mid-turn
  // calls have nothing to record. This keeps them free of state reads.
  let idleEnded = false;
  let warmupsStopped: Promise<void> | undefined;
  const toolWait = createToolWaitWarmer(conversationId);
  return {
    wrap:
      (base = streamSimple) =>
      (model, context, options) => {
        if (!warmupsStopped && getChatConfig().cacheWarmingEnabled) {
          warmupsStopped = stopIdleWarmups(conversationId);
        }
        // The tools returned, so this request reads the cache.
        toolWait.stop();
        // With warming off, Pi's own retention applies.
        const cacheRetention =
          options?.cacheRetention ??
          (getChatConfig().cacheWarmingEnabled ? CACHE_RETENTION : undefined);
        lastRequest = {
          model,
          // Copy the list, so later changes to the run do not change it.
          context: { ...context, messages: [...context.messages] },
          ...(options?.reasoning
            ? { reasoning: options.reasoning }
            : undefined),
          ...(cacheRetention ? { cacheRetention } : undefined),
          startedAtMs: Date.now(),
        };
        return base(
          model,
          context,
          cacheRetention ? { ...options, cacheRetention } : options,
        );
      },
    record: async (message) => {
      const request = lastRequest;
      lastRequest = undefined;
      await warmupsStopped;
      if (!getChatConfig().cacheWarmingEnabled || !request) {
        return;
      }
      try {
        await toolWait.record(request, message);
      } catch (error) {
        logWarn("cache_warming.tool_wait.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return;
      }
      lastCall = { request, message };
      if (idleEnded && message.stopReason !== "stop") {
        return;
      }
      idleEnded = message.stopReason !== "stop";
      try {
        await recordModelCall(
          conversationId,
          turn,
          definitionsKey,
          request,
          message,
          message.stopReason === "stop" ? "reply" : undefined,
        );
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
    toolsReturned: toolWait.toolsReturned,
    answerToolEnded: (toolName) => {
      answerToolEnding = ANSWER_TOOL_ENDINGS[toolName];
    },
    stop: async () => {
      try {
        await toolWait.end(answerToolEnding !== undefined);
      } catch (error) {
        logWarn("cache_warming.tool_wait.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      // The answer tool call stopped the run, so no final response came. Its
      // request holds the prefix that the next Turn reads.
      if (!answerToolEnding || !lastCall) return;
      try {
        await recordModelCall(
          conversationId,
          turn,
          definitionsKey,
          lastCall.request,
          lastCall.message,
          answerToolEnding,
        );
      } catch (error) {
        logWarn("cache_warming.model_call.record_failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
