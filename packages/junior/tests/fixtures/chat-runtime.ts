import type { Message, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import type { JuniorRuntimeAdapterOverrides } from "@/chat/app/services";
import type { SlackTurnOptions } from "@/chat/runtime/slack-runtime";
import { createTestDestination, FakeSlackAdapter } from "./slack-harness";

type TestSlackTurnOptions = Omit<SlackTurnOptions, "destination"> & {
  destination?: SlackTurnOptions["destination"];
};

function withDefaultDestination(
  thread: Thread,
  hooks: TestSlackTurnOptions = {},
): SlackTurnOptions {
  return {
    ...hooks,
    destination: hooks.destination ?? createTestDestination(thread),
  };
}

/** Create a local Slack runtime that uses fake Slack transport and real runtime wiring. */
export function createTestChatRuntime(
  args: {
    adapters?: JuniorRuntimeAdapterOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const slackAdapter = args.slackAdapter ?? new FakeSlackAdapter();
  const runtime = createSlackRuntime({
    adapters: args.adapters,
    getSlackAdapter: () => slackAdapter as unknown as SlackAdapter,
  });

  return {
    slackAdapter,
    slackRuntime: {
      ...runtime,
      handleNewMention(
        thread: Thread,
        message: Message,
        hooks?: TestSlackTurnOptions,
      ) {
        return runtime.handleNewMention(
          thread,
          message,
          withDefaultDestination(thread, hooks),
        );
      },
      handleSubscribedMessage(
        thread: Thread,
        message: Message,
        hooks?: TestSlackTurnOptions,
      ) {
        return runtime.handleSubscribedMessage(
          thread,
          message,
          withDefaultDestination(thread, hooks),
        );
      },
    },
  };
}
