import { afterEach, describe, expect, it } from "vitest";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { FakeSlackAdapter } from "../../fixtures/slack-harness";

describe("Slack behavior: assistant lifecycle", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("sets thread metadata for assistant thread started events", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({ slackAdapter });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C0LIFECYCLE:1700006000.000",
      channelId: "C0LIFECYCLE",
      threadTs: "1700006000.000",
      userId: "U0TEST",
    });

    expect(slackAdapter.titleCalls).toEqual([
      {
        channelId: "C0LIFECYCLE",
        threadTs: "1700006000.000",
        title: "Junior",
      },
    ]);
    expect(slackAdapter.promptCalls).toHaveLength(1);
    expect(slackAdapter.promptCalls[0]?.prompts).toHaveLength(3);
  });

  it("does not reset the thread title on assistant context changes", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({ slackAdapter });

    await slackRuntime.handleAssistantContextChanged({
      threadId: "slack:C0LIFECYCLE:1700006000.000",
      channelId: "C0LIFECYCLE",
      threadTs: "1700006000.000",
      userId: "U0TEST",
      context: {
        channelId: "C0CONTEXT",
      },
    });

    expect(slackAdapter.titleCalls).toEqual([]);
    expect(slackAdapter.promptCalls).toHaveLength(1);
    expect(slackAdapter.promptCalls[0]?.threadTs).toBe("1700006000.000");
  });

  it("persists the assistant context channel without replacing artifacts", async () => {
    await disconnectStateAdapter();

    const threadId = "slack:C0LIFECYCLE:1700006001.000";
    await persistThreadStateById(threadId, {
      artifacts: {
        lastCanvasId: "canvas-1",
        listColumnMap: {
          titleColumnId: "title-column",
        },
      },
    });

    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({ slackAdapter });

    await slackRuntime.handleAssistantContextChanged({
      threadId,
      channelId: "C0LIFECYCLE",
      threadTs: "1700006001.000",
      userId: "U0TEST",
      context: {
        channelId: "slack:C0CONTEXT",
      },
    });

    const artifacts = coerceThreadArtifactsState(
      await getPersistedThreadState(threadId),
    );
    expect(artifacts.assistantContextChannelId).toBe("C0CONTEXT");
    expect(artifacts.lastCanvasId).toBe("canvas-1");
    expect(artifacts.listColumnMap?.titleColumnId).toBe("title-column");
  });
});
