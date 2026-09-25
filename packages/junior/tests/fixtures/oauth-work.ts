import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createConversationWork } from "@/chat/app/conversation-work";
import { getConversationStore } from "@/chat/db";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
} from "./conversation-work";

/** Run callback wakes through production worker composition in route tests. */
export function createOAuthWork(agentRunner: AgentRunner) {
  const queue = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  const work = createConversationWork({
    agentRunner,
    queue,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
  });
  return {
    queue,
    async drain() {
      for (let i = 0; i < 12 && queue.hasQueuedMessages(); i++) {
        await processConversationQueueMessage(queue.takeMessage(), work);
      }
      if (queue.hasQueuedMessages())
        throw new Error("OAuth work did not drain");
    },
  };
}
