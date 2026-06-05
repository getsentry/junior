import type { SlackAdapter } from "@chat-adapter/slack";
import {
  createSlackRuntime,
  type CreateSlackRuntimeOptions,
} from "@/chat/app/factory";
import type { SlackTurnOptions } from "@/chat/runtime/slack-runtime";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createTestDestination, FakeSlackAdapter } from "./slack-harness";

export function createTestChatRuntime(
  args: {
    now?: CreateSlackRuntimeOptions["now"];
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const slackAdapter = args.slackAdapter ?? new FakeSlackAdapter();
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => slackAdapter as unknown as SlackAdapter,
    now: args.now,
    services: args.services,
  });
  const turnOptions = (
    thread: Parameters<typeof slackRuntime.handleNewMention>[0],
    hooks: Partial<SlackTurnOptions> | undefined,
  ): SlackTurnOptions => ({
    destination: createTestDestination(thread),
    ...hooks,
  });

  return {
    slackAdapter,
    slackRuntime: {
      ...slackRuntime,
      handleNewMention: (
        thread: Parameters<typeof slackRuntime.handleNewMention>[0],
        message: Parameters<typeof slackRuntime.handleNewMention>[1],
        hooks?: Partial<SlackTurnOptions>,
      ) => slackRuntime.handleNewMention(thread, message, turnOptions(thread, hooks)),
      handleSubscribedMessage: (
        thread: Parameters<typeof slackRuntime.handleSubscribedMessage>[0],
        message: Parameters<typeof slackRuntime.handleSubscribedMessage>[1],
        hooks?: Partial<SlackTurnOptions>,
      ) =>
        slackRuntime.handleSubscribedMessage(
          thread,
          message,
          turnOptions(thread, hooks),
        ),
    },
  };
}
