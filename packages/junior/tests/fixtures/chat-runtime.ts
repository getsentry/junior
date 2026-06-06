import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import type { JuniorRuntimeAdapterOverrides } from "@/chat/app/services";
import type { SlackTurnOptions } from "@/chat/runtime/slack-runtime";
import { createTestDestination, FakeSlackAdapter } from "./slack-harness";

/** Create a local Slack runtime that uses fake Slack transport and real runtime wiring. */
export function createTestChatRuntime(
  args: {
    adapters?: JuniorRuntimeAdapterOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const slackAdapter = args.slackAdapter ?? new FakeSlackAdapter();
  const slackRuntime = createSlackRuntime({
    adapters: args.adapters,
    getSlackAdapter: () => slackAdapter as unknown as SlackAdapter,
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
      ) =>
        slackRuntime.handleNewMention(thread, message, turnOptions(thread, hooks)),
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
