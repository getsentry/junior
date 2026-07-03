import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
} from "@/chat/slack/output";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
  queueSlackApiError,
} from "../msw/handlers/slack-api";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

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
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
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

  it("uses correlation IDs for resumed reply footers", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
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

    await resumeAuthorizedRequest({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.007",
      connectedText: "",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.007"),
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId: "conversation-1",
            turnId: "turn-1",
          },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "done",
            diagnostics: makeDiagnostics("success", {
              durationMs: 500,
              usage: {
                outputTokens: 7,
              },
            }),
          }),
      },
    });

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
  });

  it("posts resumed auth pause notices with the conversation footer", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");

    await resumeAuthorizedRequest({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.008",
      connectedText: "",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.008"),
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
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
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
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

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.003",
      connectedText: "Connected. Continuing...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.003"),
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
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
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
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

  it("delivers resumed reply files through the shared reply planner", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.004",
      connectedText: "Connected. Continuing...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.004"),
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "Here is the resumed artifact.",
            files: [
              {
                data: Buffer.from("resume-file"),
                filename: "resume.txt",
              },
            ],
            diagnostics: makeDiagnostics(),
          }),
      },
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.004",
      text: "Connected. Continuing...",
    });
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.004",
      text: "Here is the resumed artifact.",
    });
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.004",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });

  it("keeps the resumed reply visible when file upload followups fail", async () => {
    const { resumeAuthorizedRequest } =
      await import("@/chat/runtime/slack-resume");
    queueSlackApiError("files.completeUploadExternal", {
      error: "upload_failed",
    });

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.005",
      connectedText: "Connected. Continuing...",
      replyContext: {
        routing: {
          credentialContext: {
            actor: { type: "user", userId: "U123" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.005"),
          requester: { platform: "slack", teamId: "T123", userId: "U123" },
        },
      },
      agentRunner: {
        run: async () =>
          completedAgentRun({
            text: "Here is the resumed artifact.",
            files: [
              {
                data: Buffer.from("resume-file"),
                filename: "resume.txt",
              },
            ],
            diagnostics: makeDiagnostics(),
          }),
      },
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.005",
          text: "Connected. Continuing...",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.005",
          text: "Here is the resumed artifact.",
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(1);
  });
});
