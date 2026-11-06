import type { StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import { hasConversationStop } from "./store";

const CONVERSATION_STOP_CHECK_INTERVAL_MS = 500;

/** Poll the run-scoped stop marker only when an adapter observes remote stops. */
export function createConversationStopSignal(args: {
  conversationId: string;
  initiallyStopped: boolean;
  runId: string;
  state?: StateAdapter;
}) {
  const controller = new AbortController();
  let checking = false;
  let failureCaptured = false;
  let listening = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requestStop = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Conversation work stopped"));
    }
  };
  if (args.initiallyStopped) requestStop();

  const check = async (): Promise<void> => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const stopped = await hasConversationStop({
        conversationId: args.conversationId,
        runId: args.runId,
        state: args.state,
      });
      if (stopped) requestStop();
    } catch (error) {
      if (!failureCaptured) {
        failureCaptured = true;
        logException(error, "conversation.work.stop_check.failed");
      }
    } finally {
      checking = false;
    }
  };

  return {
    close(): void {
      if (timer) clearInterval(timer);
    },
    isEnabled(): boolean {
      return listening;
    },
    wasObserved(): boolean {
      return listening && controller.signal.aborted;
    },
    signal(): AbortSignal {
      listening = true;
      if (!timer && !controller.signal.aborted) {
        timer = setInterval(
          () => void check(),
          CONVERSATION_STOP_CHECK_INTERVAL_MS,
        );
        timer.unref?.();
      }
      return controller.signal;
    },
  };
}
