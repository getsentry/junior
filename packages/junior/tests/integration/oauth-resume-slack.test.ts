import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
} from "@/chat/slack/output";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import {
  getConversationEventStore,
  getConversationMessageStore,
  getSqlExecutor,
} from "@/chat/db";
import {
  RecoverableSlackDeliveryService,
  type RecoverableSlackDeliveryPort,
} from "@/chat/slack/recoverable-delivery";
import { postRecoverableSlackMessage } from "@/chat/slack/outbound";
import { GET as heartbeat } from "@/handlers/heartbeat";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";

function makeDiagnostics(
  outcome: "success" | "execution_failure" | "provider_error" = "success",
  extras: Record<string, unknown> = {},
) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
    ...extras,
  };
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

    type: "priv",
  });
}

function expectBlocksIncludeConversationId(
  params: Record<string, unknown>,
  conversationId: string,
): void {
  expect(params.blocks).toBeDefined();
  expect(JSON.stringify(params.blocks)).toContain(conversationId);
}

async function runRecoverableSchedulingCase(args: {
  deliveryOutcome: "accepted" | "failed";
  modelOutcome: "success" | "execution_failure";
  suffix: string;
}) {
  const { resumeSlackTurn } = await import("@/chat/runtime/slack-resume");
  const conversationId = `conversation-schedule-${args.suffix}`;
  const turnId = `turn-schedule-${args.suffix}`;
  const messageId = `message-schedule-${args.suffix}`;
  const threadTs = `1700000000.${args.suffix}`;
  await upsertAgentTurnSessionRecord({
    modelId: "test/model",
    conversationId,
    sessionId: turnId,
    sliceId: 2,
    state: "awaiting_resume",
    piMessages: [],
    resumeReason: "auth",
    source: testSlackSource(threadTs),
  });
  await getConversationMessageStore().record(conversationId, [
    {
      messageId,
      role: "user",
      text: "continue this turn",
      createdAtMs: Date.now(),
    },
  ]);
  const post: RecoverableSlackDeliveryPort["post"] =
    args.deliveryOutcome === "accepted"
      ? postRecoverableSlackMessage
      : async () => ({
          outcome: "definitive_failure",
          reason: "api_rejected",
        });
  const schedule = vi.fn(async () => undefined);
  const run = vi.fn(async () =>
    completedAgentRun({
      text: "done",
      diagnostics: makeDiagnostics(args.modelOutcome),
    }),
  );
  await resumeSlackTurn({
    messageText: "continue this turn",
    channelId: "C123",
    threadTs,
    inputMessageIds: [messageId],
    recoverableSlackDelivery: new RecoverableSlackDeliveryService(
      getSqlExecutor(),
      { post, reconcile: vi.fn() },
    ),
    turnLifecycle: new ConversationTurnLifecycleService(
      getConversationEventStore(),
    ),
    replyContext: {
      routing: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource(threadTs),
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: { conversationId, turnId },
      },
    },
    agentRunner: { run },
    scheduleSessionCompletedPluginTasks: schedule,
  });
  return { conversationId, run, schedule, turnId };
}

describe("oauth resume slack integration", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    vi.useRealTimers();
  });

  it("posts resumed status updates through the Slack MSW harness", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    await resumeAuthorizedRequest({
      messageText: "What budget deadline did I mention earlier?",
      channelId: "C123",
      threadTs: "1700000000.001",
      connectedText:
        "Your eval-auth MCP access is now connected. Continuing the original request...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.001"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "The budget deadline you mentioned earlier was Friday.",
            diagnostics: makeDiagnostics("success", {
              durationMs: 842,
              usage: {
                totalTokens: 1234,
              },
            }),
          }),
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
          blocks: [
            {
              type: "markdown",
              text: "The budget deadline you mentioned earlier was Friday.",
            },
            {
              type: "context",
              elements: [
                expect.objectContaining({
                  type: "mrkdwn",
                  text: expect.stringContaining(
                    "*ID:* slack:C123:1700000000.001",
                  ),
                }),
              ],
            },
          ],
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "The budget deadline you mentioned earlier was Friday.",
        }),
      }),
    ]);
  }, 10_000);

  it("recovers a resumed pending delivery on heartbeat without rerunning or reposting", async () => {
    process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "timeout",
      cumulativeDurationMs: 1_000,
      cumulativeUsage: {
        totalTokens: 1_000,
      },
      source: testSlackSource("1700000000.007"),
    });
    await expect(
      getAgentTurnSessionRecord("conversation-1", "turn-1"),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      cumulativeDurationMs: 1_000,
    });
    await getConversationMessageStore().record("conversation-1", [
      {
        messageId: "message-turn-1",
        role: "user",
        text: "continue this turn",
        createdAtMs: Date.now(),
      },
    ]);
    const recoverableSlackDelivery = new RecoverableSlackDeliveryService(
      getSqlExecutor(),
      {
        post: postRecoverableSlackMessage,
        reconcile: vi.fn(),
      },
    );
    const run = vi.fn(async () =>
      completedAgentRun({
        text: "done",
        diagnostics: makeDiagnostics("success", {
          durationMs: 500,
          usage: {
            outputTokens: 7,
          },
        }),
      }),
    );
    const onSuccess = vi.fn(async () => {
      throw new Error("repair crashed");
    });
    const onRecoveredSuccess = vi.fn(async () => undefined);

    const resumeArgs: Parameters<typeof resumeAuthorizedRequest>[0] = {
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.007",
      connectedText: "",
      inputMessageIds: ["message-turn-1"],
      sliceId: 2,
      recoverableSlackDelivery,
      turnLifecycle: new ConversationTurnLifecycleService(
        getConversationEventStore(),
      ),
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.007"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId: "conversation-1",
            turnId: "turn-1",
          },
        },
      },
      agentRunner: { run },
      onSuccess,
      onRecoveredSuccess,
    };

    await resumeAuthorizedRequest(resumeArgs);
    await expect(
      getAgentTurnSessionRecord("conversation-1", "turn-1"),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      cumulativeDurationMs: 1_000,
    });
    const state = getStateAdapter();
    await state.connect();
    const activeRuntimeLock = await acquireActiveLock(state, "conversation-1");
    expect(activeRuntimeLock).not.toBeNull();
    try {
      const blockedWaitUntil = createWaitUntilCollector();
      const blockedResponse = await heartbeat(
        new Request("https://example.invalid/api/internal/heartbeat", {
          headers: { authorization: "Bearer heartbeat-secret" },
        }),
        blockedWaitUntil.fn,
        { recoverableSlackDelivery },
      );
      expect(blockedResponse.status).toBe(202);
      await blockedWaitUntil.flush();

      const blockedLifecycle = (
        await getConversationEventStore().loadHistory("conversation-1")
      ).filter((event) => event.data.type.startsWith("turn_"));
      expect(blockedLifecycle.map((event) => event.data.type)).toEqual([
        "turn_started",
      ]);
    } finally {
      await state.releaseLock(activeRuntimeLock!);
    }

    const recoveryWaitUntil = createWaitUntilCollector();
    const recoveryResponse = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      recoveryWaitUntil.fn,
      { recoverableSlackDelivery },
    );
    expect(recoveryResponse.status).toBe(202);
    await recoveryWaitUntil.flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onRecoveredSuccess).not.toHaveBeenCalled();

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.007",
          text: "done",
          blocks: [
            {
              type: "markdown",
              text: "done",
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "*ID:* conversation-1",
                },
              ],
            },
          ],
        }),
      }),
    ]);
    const lifecycle = (
      await getConversationEventStore().loadHistory("conversation-1")
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data)).toEqual([
      {
        type: "turn_started",
        turnId: "turn-1",
        inputMessageIds: ["message-turn-1"],
        surface: "slack",
      },
      { type: "turn_completed", turnId: "turn-1", outcome: "success" },
    ]);
    await expect(
      getAgentTurnSessionRecord("conversation-1", "turn-1"),
    ).resolves.toMatchObject({
      state: "completed",
      sliceId: 2,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        totalTokens: 1_007,
      },
    });
  });

  it("schedules completed plugins once only for successful recoverable resumes", async () => {
    const success = await runRecoverableSchedulingCase({
      deliveryOutcome: "accepted",
      modelOutcome: "success",
      suffix: "021",
    });
    const modelFailure = await runRecoverableSchedulingCase({
      deliveryOutcome: "accepted",
      modelOutcome: "execution_failure",
      suffix: "022",
    });
    const deliveryFailure = await runRecoverableSchedulingCase({
      deliveryOutcome: "failed",
      modelOutcome: "success",
      suffix: "023",
    });

    expect(success.run).toHaveBeenCalledOnce();
    expect(success.schedule).toHaveBeenCalledOnce();
    expect(success.schedule).toHaveBeenCalledWith({
      conversationId: success.conversationId,
      sessionId: success.turnId,
    });
    expect(modelFailure.run).toHaveBeenCalledOnce();
    expect(modelFailure.schedule).not.toHaveBeenCalled();
    expect(deliveryFailure.run).toHaveBeenCalledOnce();
    expect(deliveryFailure.schedule).not.toHaveBeenCalled();
  });

  it("records one terminal failure when a correlated resume fails", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    const conversationId = "conversation-resume-failure";
    const turnId = "turn-resume-failure";

    await resumeAuthorizedRequest({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.009",
      connectedText: "",
      inputMessageIds: ["message-resume-failure"],
      turnLifecycle: new ConversationTurnLifecycleService(
        getConversationEventStore(),
      ),
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.009"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: { conversationId, turnId },
        },
      },
      agentRunner: {
        run: async () => {
          throw new Error("resume failed");
        },
      },
    });

    const lifecycle = (
      await getConversationEventStore().loadHistory(conversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      turnId,
      failureCode: "agent_run_failed",
      eventId: expect.any(String),
    });
  });

  it("posts resumed auth pause notices with the conversation footer", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");

    await resumeAuthorizedRequest({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.008",
      connectedText: "",
      inputMessageIds: ["message-auth-pause"],
      turnLifecycle: new ConversationTurnLifecycleService(
        getConversationEventStore(),
      ),
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.008"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId: "conversation-auth-pause",
            turnId: "turn-auth-pause",
          },
        },
      },
      agentRunner: {
        run: async () => ({
          status: "awaiting_auth" as const,
          providerDisplayName: "Eval Auth",
        }),
      },
      onAuthPause: async () => undefined,
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.008",
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "conversation-auth-pause",
    );
    const lifecycle = (
      await getConversationEventStore().loadHistory("conversation-auth-pause")
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data.type)).toEqual(["turn_started"]);
  });

  it("chunks long resumed replies into explicit continuation messages", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.002",
      connectedText: "Connected. Continuing...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.002"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: longReply,
            diagnostics: makeDiagnostics(),
          }),
      },
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
  });

  it("marks resumed provider-error partial replies as interrupted", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    const conversationId = "conversation-provider-error";
    const turnId = "turn-provider-error";

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.003",
      connectedText: "Connected. Continuing...",
      inputMessageIds: ["message-provider-error"],
      turnLifecycle: new ConversationTurnLifecycleService(
        getConversationEventStore(),
      ),
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.003"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: { conversationId, turnId },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "Partial output",
            diagnostics: makeDiagnostics("provider_error"),
          }),
      },
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
    const lifecycle = (
      await getConversationEventStore().loadHistory(conversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      turnId,
      failureCode: "model_execution_failed",
      eventId: expect.any(String),
    });
  });

  it("replaces resumed execution-failure replies before Slack planning", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.006",
      connectedText: "Connected. Continuing...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.006"),
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "",
            diagnostics: makeDiagnostics("execution_failure", {
              assistantMessageCount: 0,
              usedPrimaryText: false,
            }),
          }),
      },
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.006",
    });
    expect(postCalls[1]?.params.text).toContain(
      "I ran into an internal error while processing that. Reference: `event_id=",
    );
  });
});
