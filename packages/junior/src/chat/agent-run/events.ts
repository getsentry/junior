import type { Agent } from "@earendil-works/pi-agent-core";
import { logWarn, type LogContext } from "@/chat/logging";
import type { AgentRunObservers } from "@/chat/agent-run/request";
import type { SliceCheckpointer } from "@/chat/agent-run/checkpointer";

/** Subscribes to Pi events so streaming observers and safe-boundary writes stay coupled. */
export function subscribeToAgentEvents(args: {
  agent: Agent;
  checkpointer: SliceCheckpointer;
  observers: AgentRunObservers;
  recordParentToolExecutionStart: (event: {
    args: unknown;
    toolCallId: string;
    toolName: string;
  }) => Promise<void>;
  spanContext: LogContext;
}): () => void {
  let hasEmittedText = false;
  let needsSeparator = false;
  return args.agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      return args.recordParentToolExecutionStart(event);
    }
    if (event.type === "turn_end" && event.toolResults.length > 0) {
      return args.checkpointer
        .persistSafeBoundary([...args.agent.state.messages])
        .then(() => undefined);
    }
    if (event.type === "message_start") {
      Promise.resolve(args.observers.onAssistantMessageStart?.()).catch(
        (error) => {
          logWarn(
            "streaming_message_start_error",
            {},
            {
              "exception.message":
                error instanceof Error ? error.message : String(error),
            },
            "Failed to deliver assistant message start to stream coordinator",
          );
        },
      );
      if (hasEmittedText) {
        needsSeparator = true;
      }
      return;
    }
    if (event.type !== "message_update") return;
    if (event.assistantMessageEvent.type !== "text_delta") return;
    const deltaText = event.assistantMessageEvent.delta;
    if (!deltaText) return;

    const text = needsSeparator ? "\n\n" + deltaText : deltaText;
    needsSeparator = false;
    hasEmittedText = true;

    Promise.resolve(args.observers.onTextDelta?.(text)).catch((error) => {
      logWarn(
        "streaming_text_delta_error",
        {},
        {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        },
        "Failed to deliver text delta to stream",
      );
    });
  });
}
