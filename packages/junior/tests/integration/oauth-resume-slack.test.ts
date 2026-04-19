import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeDiagnostics(
  outcome: "success" | "provider_error" = "success",
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
    const { resumeAuthorizedRequest } = await import("@/chat/slack/resume");
    await resumeAuthorizedRequest({
      messageText: "What budget deadline did I mention earlier?",
      channelId: "C123",
      threadTs: "1700000000.001",
      connectedText:
        "Your eval-auth MCP access is now connected. Continuing the original request...",
      failureText:
        "MCP authorization completed, but resuming the request failed. Please retry the original command.",
      replyContext: {
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "The budget deadline you mentioned earlier was Friday.",
          diagnostics: makeDiagnostics("success", {
            durationMs: 842,
            usage: {
              totalTokens: 1234,
            },
          }),
        }) as any,
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
          blocks: expect.arrayContaining([
            {
              type: "section",
              expand: true,
              text: {
                type: "mrkdwn",
                text: "The budget deadline you mentioned earlier was Friday.",
              },
            },
            {
              type: "context",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  type: "mrkdwn",
                  text: expect.stringContaining(
                    "*ID:* slack:C123:1700000000.001",
                  ),
                }),
                expect.objectContaining({
                  type: "mrkdwn",
                  text: "*Tokens:* 1,234",
                }),
                expect.objectContaining({
                  type: "mrkdwn",
                  text: "*Time:* 842ms",
                }),
              ]),
            },
          ]),
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "The budget deadline you mentioned earlier was Friday.",
        }),
      }),
    ]);
  }, 10_000);

  it("chunks long resumed replies into explicit continuation messages", async () => {
    const { resumeAuthorizedRequest } = await import("@/chat/slack/resume");
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.002",
      connectedText: "Connected. Continuing...",
      failureText: "Resume failed.",
      replyContext: {
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: longReply,
          diagnostics: makeDiagnostics(),
        }) as any,
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

  it("marks interrupted resumed replies explicitly", async () => {
    const { resumeAuthorizedRequest } = await import("@/chat/slack/resume");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.003",
      connectedText: "Connected. Continuing...",
      failureText: "Resume failed.",
      replyContext: {
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "Partial output",
          diagnostics: makeDiagnostics("provider_error"),
        }) as any,
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.003",
      text: `Partial output${getSlackInterruptionMarker()}`,
    });
  });

  it("delivers resumed reply files through the shared reply planner", async () => {
    const { resumeAuthorizedRequest } = await import("@/chat/slack/resume");

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.004",
      connectedText: "Connected. Continuing...",
      failureText: "Resume failed.",
      replyContext: {
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "Here is the resumed artifact.",
          files: [
            {
              data: Buffer.from("resume-file"),
              filename: "resume.txt",
            },
          ],
          diagnostics: makeDiagnostics(),
        }) as any,
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
    const { resumeAuthorizedRequest } = await import("@/chat/slack/resume");
    queueSlackApiError("files.completeUploadExternal", {
      error: "upload_failed",
    });

    await resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.005",
      connectedText: "Connected. Continuing...",
      failureText: "Resume failed.",
      replyContext: {
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "Here is the resumed artifact.",
          files: [
            {
              data: Buffer.from("resume-file"),
              filename: "resume.txt",
            },
          ],
          diagnostics: makeDiagnostics(),
        }) as any,
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
