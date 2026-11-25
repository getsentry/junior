/**
 * The background work after a Turn ends: plugin session tasks, event search,
 * and Conversation metadata. A failure is logged, so this work never changes
 * the Turn's outcome.
 */
import { indexEndedTurnEvents } from "@/chat/conversations/event-embedding";
import { CONVERSATION_METADATA_TASK } from "@/chat/conversations/metadata/task";
import type { TurnBehavior } from "@/chat/conversations/kind-behavior";
import { logException } from "@/chat/logging";
import type { PluginTaskQueueMessage } from "@/chat/plugins/task-queue";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";

async function runTask(
  message: PluginTaskQueueMessage,
  conversationId: string,
  turnId: string,
): Promise<void> {
  try {
    await processPluginTask(message);
  } catch (error) {
    logException(error, "conversation.plugin.session_completion_task.failed", {
      conversationId,
      pluginName: message.plugin,
      taskName: message.name,
      turnId,
    });
  }
}

/**
 * Run the work after one ended Turn. A completed Turn with session tasks
 * runs every session task, which includes event search and metadata. Any
 * other Turn indexes its events, and a completed one also updates its
 * metadata when its behavior asks for it, as a Thread's does.
 */
export async function runTurnEndTasks(args: {
  behavior: Pick<TurnBehavior, "conversationMetadata" | "sessionTasks">;
  completed: boolean;
  conversationId: string;
  turnId: string;
}): Promise<void> {
  const { behavior, conversationId, turnId } = args;
  const params = { conversationId, sessionId: turnId };
  if (args.completed && behavior.sessionTasks) {
    try {
      await scheduleSessionCompletedPluginTasks(params, async (message) => {
        await runTask(message, conversationId, turnId);
      });
    } catch (error) {
      logException(
        error,
        "conversation.plugin.session_completion_task.failed",
        {
          conversationId,
          turnId,
        },
      );
    }
    return;
  }
  await indexEndedTurnEvents({ conversationId, turnId });
  if (args.completed && behavior.conversationMetadata) {
    await runTask(
      { ...CONVERSATION_METADATA_TASK, params },
      conversationId,
      turnId,
    );
  }
}
