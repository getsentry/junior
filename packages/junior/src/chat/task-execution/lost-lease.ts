import type { Destination } from "@sentry/junior-plugin-api";
import { logException } from "@/chat/logging";
import { nudgeIdempotencyKey } from "./queue";
import {
  ensureConversationWake,
  getConversationWorkState,
  recordConversationRetry,
  releaseConversationWork,
  requestAnotherSlice,
} from "./store";
import type { ProcessConversationWorkOptions } from "./worker";

/**
 * Count a slice that lost its Conversation Lease as a failed attempt, then
 * hand the work to a new slice, or stop it when retries are exhausted.
 */
export async function requestLostLeaseRecovery(args: {
  conversationId: string;
  destination?: Destination;
  leaseToken: string;
  nowMs: number;
  options: ProcessConversationWorkOptions;
}): Promise<void> {
  const before = await getConversationWorkState({
    conversationId: args.conversationId,
    state: args.options.state,
  });
  const retry = await recordConversationRetry({
    beforeWorkStops: args.options.beforeWorkStops,
    conversationId: args.conversationId,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (retry === "lost_lease") {
    return;
  }
  if (retry === "stopped") {
    logException(
      new Error("Conversation work stopped after repeated failed attempts"),
      "conversation.work.retry.exhausted",
      {
        "app.run.id": before?.execution.runId ?? "unknown",
        "app.worker.last_progress_at_ms":
          before?.execution.lastProgressAtMs ?? before?.createdAtMs ?? 0,
        "app.worker.retry_count": (before?.execution.retryCount ?? 0) + 1,
      },
    );
    return;
  }
  const sliceRequested = await requestAnotherSlice({
    conversationId: args.conversationId,
    destination: args.destination,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!sliceRequested) {
    return;
  }
  const released = await releaseConversationWork({
    conversationId: args.conversationId,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!released) {
    return;
  }
  await ensureConversationWake({
    conversationId: args.conversationId,
    conversationStore: args.options.conversationStore,
    idempotencyKey: nudgeIdempotencyKey(
      "lost_lease",
      args.conversationId,
      args.nowMs,
    ),
    nowMs: args.nowMs,
    queue: args.options.queue,
    replaceExistingWake: true,
    state: args.options.state,
  });
}
