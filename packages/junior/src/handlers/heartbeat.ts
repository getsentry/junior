import type { IdentityDispatcher } from "@/chat/agent-dispatch/identity";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import type { AppEventPublisher } from "@/chat/plugins/agent-hooks";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import type { SendPluginTask } from "@/chat/plugins/task-runner";
import { verifySchedulerRequest } from "@/handlers/scheduler-auth";
import type { WaitUntilFn } from "@/handlers/types";

export interface HeartbeatHandlerOptions {
  conversationWorkQueue?: ConversationWorkQueue;
  dispatchForIdentity: IdentityDispatcher;
  events: AppEventPublisher;
  sendPluginTask: SendPluginTask;
  showInboxItem?: ShowInboxItem;
  /** Sends the queue message again for core Turns that no message reaches. */
  sweepTurns?: () => Promise<void>;
}

/** Handle the authenticated internal heartbeat. */
export async function GET(
  request: Request,
  waitUntil: WaitUntilFn,
  options: HeartbeatHandlerOptions,
): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nowMs = Date.now();
  waitUntil(() =>
    runHeartbeat({
      conversationWorkQueue: options.conversationWorkQueue,
      dispatchForIdentity: options.dispatchForIdentity,
      events: options.events,
      nowMs,
      sendPluginTask: options.sendPluginTask,
      showInboxItem: options.showInboxItem,
    }).catch((error) => {
      logException(error, "heartbeat.run.failed", {
        "app.heartbeat.now_ms": nowMs,
      });
    }),
  );

  const { sweepTurns } = options;
  if (sweepTurns) {
    waitUntil(() =>
      sweepTurns().catch((error) => {
        logException(error, "turn.sweep.failed");
      }),
    );
  }

  return new Response("Accepted", { status: 202 });
}
