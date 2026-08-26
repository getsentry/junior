import {
  createSlackRuntime,
  type CreateSlackRuntimeOptions,
} from "@/chat/app/factory";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { ScheduleSessionCompletedPluginTasksOptions } from "@/chat/plugins/task-runner";
import { createPausedTurns } from "@/chat/task-execution/turn-wake";
import type { StateAdapter } from "chat";
import { FakeSlackAdapter } from "./slack-harness";

export function createTestChatRuntime(
  args: {
    conversationStore?: ConversationStore;
    now?: CreateSlackRuntimeOptions["now"];
    queue?: ConversationWorkQueue;
    sendPluginTask?: ScheduleSessionCompletedPluginTasksOptions["send"];
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
    state?: StateAdapter;
  } = {},
) {
  const slackAdapter = args.slackAdapter ?? new FakeSlackAdapter();

  return {
    slackAdapter,
    slackRuntime: createSlackRuntime({
      getSlackAdapter: () => slackAdapter,
      now: args.now,
      pausedTurns: createPausedTurns({
        conversationStore: args.conversationStore,
        queue: args.queue,
        state: args.state,
      }),
      sendPluginTask: args.sendPluginTask,
      services: args.services,
    }),
  };
}
