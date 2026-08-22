import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import { getAuthPausedApiTurnId } from "@/chat/api-turns/routing";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  getConversation,
  requestConversationWork,
  stopConversationWork,
  type StopConversationWorkResult,
} from "@/chat/task-execution/store";

/** Stop the current API Turn and wake an idle durable resume when needed. */
export async function stopApiConversationTurn(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
  const nowMs = args.nowMs ?? Date.now();
  const stop = async (): Promise<StopConversationWorkResult> =>
    await stopConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      nowMs,
      state: args.state,
    });
  let result = await stop();

  if (
    result.status === "no_work" &&
    (await getAuthPausedApiTurnId(args.conversationId))
  ) {
    const conversation = await getConversation({
      conversationId: args.conversationId,
      state: args.state,
    });
    await requestConversationWork({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      destination: conversation?.destination,
      nowMs,
      state: args.state,
    });
    result = await stop();
  }

  if (result.status === "requested") {
    await ensureConversationWake({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      idempotencyKey: `api-stop:${args.conversationId}:${result.runId}`,
      nowMs,
      queue: args.queue,
      replaceExistingWake: true,
      state: args.state,
    });
  }
  return result;
}
