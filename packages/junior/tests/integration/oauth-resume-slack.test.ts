import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
} from "@/chat/slack/output";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

function modelReply(text: string) {
  return createModelAgentRunner(createModelStream([{ type: "text", text }]));
}

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

function expectBlocksIncludeConversationId(
  params: Record<string, unknown>,
  conversationId: string,
): void {
  expect(params.blocks).toBeDefined();
  expect(JSON.stringify(params.blocks)).toContain(conversationId);
}

describe("oauth resume slack integration", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    vi.resetModules();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("posts resumed status updates through the Slack MSW harness", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    await resumeSlackTurn({
      messageText: "What budget deadline did I mention earlier?",
      conversationId: "slack:C123:1700000000.001",
      turnId: "turn-resume-status",
      channelId: "C123",
      threadTs: "1700000000.001",
      initialText:
        "Your eval-auth MCP access is now connected. Continuing the original request...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.001"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: modelReply(
        "The budget deadline you mentioned earlier was Friday.",
      ),
      commitResult: async () => {
        expect(
          getCapturedSlackApiCalls("assistant.threads.setStatus").at(-1)
            ?.params,
        ).toEqual(expect.objectContaining({ status: "" }));
      },
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.001",
          status: expect.any(String),
          loading_messages: expect.arrayContaining([expect.any(String)]),
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.001",
          status: "",
        }),
      }),
    ]);

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "Your eval-auth MCP access is now connected. Continuing the original request...",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "The budget deadline you mentioned earlier was Friday.",
        }),
      }),
    ]);
  }, 10_000);

  it("validates credentials before starting Slack resume UX", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const agentRunner = neverRunAgentRunner();

    await resumeSlackTurn({
      messageText: "Continue the original request",
      conversationId: "slack:C123:1700000000.011",
      turnId: "turn-invalid-resume-actor",
      channelId: "C123",
      threadTs: "1700000000.011",
      initialText: "Connected. Continuing...",
      initialStatus: { text: "Continuing request" },
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U456" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.011"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner,
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([]);
    expect(
      getCapturedSlackApiCalls("chat.postMessage").map(
        (call) => call.params.text,
      ),
    ).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that. Reference: `event_id=",
      ),
    ]);
  });

  it("posts a failure reply when resumed generation times out", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const runEvents: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const realAgentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "text",
          text: "This reply should not finish.",
          waitFor: new Promise<never>(() => undefined),
        },
      ]),
    );
    const onFailure = vi.fn(async () => {
      runEvents.push("failure handled");
    });

    await resumeSlackTurn({
      messageText: "What budget deadline did I mention earlier?",
      conversationId: "slack:C123:1700000000.010",
      turnId: "turn-resume-timeout",
      channelId: "C123",
      threadTs: "1700000000.010",
      initialText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.010"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: {
        run: async (run) => {
          observedSignal = run.signal;
          run.signal?.addEventListener(
            "abort",
            () => runEvents.push("agent aborted"),
            { once: true },
          );
          try {
            return await realAgentRunner.run(run);
          } finally {
            runEvents.push("agent settled");
          }
        },
      },
      replyTimeoutMs: 10,
      onFailure,
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toEqual(
      new Error("executeAgentRun timed out after 10ms"),
    );
    expect(runEvents).toEqual([
      "agent aborted",
      "agent settled",
      "failure handled",
    ]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(
      getCapturedSlackApiCalls("chat.postMessage").map(
        (call) => call.params.text,
      ),
    ).toEqual([
      "Connected. Continuing...",
      expect.stringContaining(
        "I ran into an internal error while processing that. Reference: `event_id=",
      ),
    ]);
  });

  it("persists a resumed assistant message without canonical user history", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const { getPersistedThreadState } =
      await import("@/chat/runtime/thread-state");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { hydrateConversationMessages } =
      await import("@/chat/conversations/messages");
    const threadTs = "1700000000.007";
    const conversationId = "agent-dispatch:resume-binding";
    const turnId = "turn-resume-without-user-history";

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs,
      conversationId,
      turnId,
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        dispatch: { id: "resume-binding" },
        source: testSlackSource(threadTs),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: modelReply("Done."),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls.map((call) => call.params.text)).toEqual(["Done."]);
    expectBlocksIncludeConversationId(postCalls[0]!.params, conversationId);
    const { getConversationStore } = await import("@/chat/db");
    await expect(
      getConversationStore().getConversationIdByProviderConversation({
        provider: "slack",
        providerDestinationId: "C123",
        providerTenantId: "T123",
        providerConversationId: threadTs,
      }),
    ).resolves.toBe(conversationId);
    const conversation = coerceThreadConversationState(
      await getPersistedThreadState(`slack:C123:${threadTs}`),
    );
    await hydrateConversationMessages({ conversation, conversationId });
    expect(
      conversation.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
    ).toEqual(["Done."]);
  });

  it("chunks long resumed replies into explicit continuation messages", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");

    await resumeSlackTurn({
      messageText: "Continue the original request",
      conversationId: "slack:C123:1700000000.002",
      turnId: "turn-resume-long-reply",
      channelId: "C123",
      threadTs: "1700000000.002",
      initialText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.002"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: modelReply(longReply),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(5);
    expect(postCalls[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.002",
      text: "Connected. Continuing...",
    });
    expect(postCalls[1]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[2]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[3]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[4]?.params.text).not.toContain(
      getSlackContinuationMarker(),
    );
    expect(postCalls[4]?.params.text).toContain("line 80");
    // Continuations keep body blocks only; the conversation footer is final-chunk only.
    for (const call of postCalls.slice(1, 4)) {
      expect(JSON.stringify(call.params.blocks ?? [])).not.toContain(
        "slack:C123:1700000000.002",
      );
    }
    expectBlocksIncludeConversationId(
      postCalls[4]!.params,
      "slack:C123:1700000000.002",
    );
  });

  it("marks resumed provider-error partial replies as interrupted", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");

    await resumeSlackTurn({
      messageText: "Continue the original request",
      conversationId: "slack:C123:1700000000.003",
      turnId: "turn-resume-provider-error",
      channelId: "C123",
      threadTs: "1700000000.003",
      initialText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.003"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: createModelAgentRunner(
        createModelStream([
          {
            type: "message",
            message: fauxAssistantMessage("Partial output", {
              stopReason: "error",
              errorMessage: "The model stream stopped.",
            }),
          },
        ]),
      ),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.003",
    });
    expect(postCalls[1]?.params.text).toContain("Partial output");
    expect(postCalls[1]?.params.text).toContain(
      getSlackInterruptionMarker().trim(),
    );
    expect(postCalls[1]?.params.text).not.toContain("event_id=");
  });

  it("keeps the delivered resume reply when post-delivery commit fails", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const onFailure = vi.fn(async () => undefined);

    await expect(
      resumeSlackTurn({
        messageText: "continue this turn",
        conversationId: "slack:C123:1700000000.011",
        turnId: "turn-resume-commit-fail",
        channelId: "C123",
        threadTs: "1700000000.011",
        replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.011"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
        agentRunner: modelReply("Final resumed answer"),
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

  it("schedules plugin tasks after a successful resumed turn", async () => {
    const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:C123:1700000000.012",
      turnId: "turn-resume-plugin-tasks",
      channelId: "C123",
      threadTs: "1700000000.012",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.012"),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      agentRunner: modelReply("Final resumed answer"),
      scheduleSessionCompletedPluginTasks,
    });

    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: "slack:C123:1700000000.012",
      sessionId: "turn-resume-plugin-tasks",
    });
  });
});
