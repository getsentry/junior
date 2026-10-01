import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { ingestEvent } from "@/chat/events/ingest";
import { takeDueTimerWatches } from "@/chat/events/store";

/** Publish a bounded batch of due timers; the mailbox owns agent execution. */
export async function runTimerWatchHeartbeat(args: {
  nowMs: number;
  queue: ConversationWorkQueue;
}): Promise<void> {
  const errors: unknown[] = [];
  for (const watch of await takeDueTimerWatches(args.nowMs)) {
    try {
      await ingestEvent(
        {
          namespace: "junior",
          identifier: watch.identifier,
          eventType: "timer.fired",
          eventKey: `timer:${watch.id}`,
          occurredAtMs: watch.firesAtMs,
          terminal: true,
          trustedSummary: "Timer elapsed.",
        },
        args,
      );
    } catch (error) {
      // Leave the claim for lease expiry. Other due timers can still deliver.
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Timer Watch delivery failed");
}
