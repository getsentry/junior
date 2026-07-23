import type { SlackAdapter } from "@chat-adapter/slack";
import {
  createSlackRuntime,
  type CreateSlackRuntimeOptions,
} from "@/chat/app/factory";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { FakeSlackAdapter } from "./slack-harness";
import { postSlackAssistantReplyToThread } from "@/chat/slack/reply";

export function createTestChatRuntime(
  args: {
    now?: CreateSlackRuntimeOptions["now"];
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const slackAdapter = args.slackAdapter ?? new FakeSlackAdapter();

  return {
    slackAdapter,
    slackRuntime: createSlackRuntime({
      deliverAssistantReply: postSlackAssistantReplyToThread,
      getSlackAdapter: () => slackAdapter as unknown as SlackAdapter,
      now: args.now,
      services: args.services,
    }),
  };
}
