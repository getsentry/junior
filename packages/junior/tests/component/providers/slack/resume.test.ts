import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  deliverAssistantMessagesForTest,
  createTestTurnExecution,
} from "../../../fixtures/agent-runner";
import { getCapturedSlackApiCalls } from "../../../msw/handlers/slack-api";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;
const TEST_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

function testSlackSource(threadTs: string) {
  return createSlackSource({
    teamId: TEST_SLACK_DESTINATION.teamId,
    channelId: TEST_SLACK_DESTINATION.channelId,
    threadTs,
    visibility: "private",
  });
}

function makeDiagnostics() {
  return {
    assistantMessageCount: 0,
    modelId: "fake-agent-model",
    outcome: "execution_failure" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: false,
  };
}

function successfulAgentRun(text: string) {
  return completedAgentRun({
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-agent-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  });
}

describe("Slack resume result handling", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    vi.resetModules();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (ORIGINAL_STATE_ADAPTER === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = ORIGINAL_STATE_ADAPTER;
    }
  });

  it("posts the safe fallback when failure-state persistence fails", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "slack:T123:C123:1700000000.009";
    const turnId = "turn_1700000000_009";

    await expect(
      resumeSlackTurn({
        messageText: "Resume the failed turn",
        channelId: "C123",
        threadTs: "1700000000.009",
        inputMessageIds: ["msg.9"],
        conversationId,
        turnId,
        run: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.009"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
        executeTurn: createTestTurnExecution({
          run: async () => {
            throw new Error("resume failed");
          },
        }),
        onFailure: async () => {
          throw new Error("failure state unavailable");
        },
      }),
    ).rejects.toThrow("failure state unavailable");

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.009",
          text: expect.stringContaining(
            "I ran into an internal error while processing that.",
          ),
        }),
      }),
    ]);

    const lifecycle = (
      await getConversationEventStore().loadHistory(conversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId,
        inputMessageIds: ["msg.9"],
        surface: "slack",
      }),
      expect.objectContaining({
        type: "turn_failed",
        turnId,
        failureCode: "persistence_failed",
      }),
    ]);
  });

  it("posts an auth pause notice with the conversation footer", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "conversation-auth-pause",
      turnId: "turn-auth-pause",
      channelId: "C123",
      threadTs: "1700000000.008",
      initialText: "",
      run: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.008"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      executeTurn: createTestTurnExecution({
        run: async () => ({
          status: "awaiting_auth" as const,
          providerDisplayName: "Eval Auth",
        }),
      }),
      onAuthPause: async () => undefined,
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.008",
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
          blocks: expect.any(Array),
        }),
      }),
    ]);
    expect(
      JSON.stringify(
        getCapturedSlackApiCalls("chat.postMessage")[0]?.params.blocks,
      ),
    ).toContain("conversation-auth-pause");
  });

  it("replaces an execution-failure result before Slack planning", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");

    await resumeSlackTurn({
      messageText: "Continue the original request",
      conversationId: "slack:C123:1700000000.006",
      turnId: "turn-resume-execution-failure",
      channelId: "C123",
      threadTs: "1700000000.006",
      initialText: "Connected. Continuing...",
      run: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.006"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      executeTurn: createTestTurnExecution({
        run: async () =>
          completedAgentRun({ text: "", diagnostics: makeDiagnostics() }),
      }),
    });

    expect(getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1700000000.006",
        text: expect.stringContaining(
          "I ran into an internal error while processing that.",
        ),
      }),
    );
  });

  it("keeps the delivered reply when the result commit fails", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");
    const onFailure = vi.fn(async () => undefined);

    await expect(
      resumeSlackTurn({
        messageText: "continue this turn",
        conversationId: "slack:C123:1700000000.011",
        turnId: "turn-resume-commit-fail",
        channelId: "C123",
        threadTs: "1700000000.011",
        run: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.011"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
        executeTurn: createTestTurnExecution({
          run: async (run) => {
            await deliverAssistantMessagesForTest(run, [
              { text: "Final resumed answer" },
            ]);
            return successfulAgentRun("Final resumed answer");
          },
        }),
        commitResult: async () => {
          throw new Error("state write failed");
        },
        onFailure,
      }),
    ).rejects.toThrow("state write failed");

    expect(onFailure).not.toHaveBeenCalled();
    expect(
      getCapturedSlackApiCalls("chat.postMessage").map(
        (call) => call.params.text,
      ),
    ).toEqual([expect.stringContaining("Final resumed answer")]);
  });

  it("releases the thread lock before scheduling a suspended continuation", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const onSuspend = vi.fn(async () => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      const lock = await stateAdapter.acquireLock(
        "slack:C123:1700000000.013",
        60_000,
      );
      expect(lock).not.toBeNull();
      if (lock) {
        await stateAdapter.releaseLock(lock);
      }
    });

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:C123:1700000000.013",
      turnId: "turn-resume-lock-release",
      channelId: "C123",
      threadTs: "1700000000.013",
      run: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.013"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      executeTurn: createTestTurnExecution({
        run: async () => ({
          status: "suspended" as const,
          reason: "timeout" as const,
          resumeVersion: 3,
        }),
      }),
      onSuspend,
    });

    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onSuspend).toHaveBeenCalledWith(3);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("runs failure handling when suspended continuation scheduling fails", async () => {
    const { resumeSlackTurn } = await import("@/chat/providers/slack/resume");
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:C123:1700000000.014",
      turnId: "turn-resume-suspend-fail",
      channelId: "C123",
      threadTs: "1700000000.014",
      run: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.014"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      executeTurn: createTestTurnExecution({
        run: async () => ({
          status: "suspended" as const,
          reason: "timeout" as const,
          resumeVersion: 3,
        }),
      }),
      onSuspend: async () => {
        throw new Error("continuation scheduling failed");
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledOnce();
    expect(
      getCapturedSlackApiCalls("chat.postMessage").map(
        (call) => call.params.text,
      ),
    ).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });
});
