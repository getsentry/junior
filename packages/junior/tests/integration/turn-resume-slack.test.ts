import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitUntilFn } from "@/handlers/types";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

const { generateAssistantReplyMock } = vi.hoisted(() => ({
  generateAssistantReplyMock: vi.fn(),
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: generateAssistantReplyMock,
}));

const ORIGINAL_ENV = { ...process.env };

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type TurnResumeHandlerModule = typeof import("@/handlers/turn-resume");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session-store");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let turnResumeHandlerModule: TurnResumeHandlerModule;
let turnSessionStoreModule: TurnSessionStoreModule;

const waitUntilCallbacks: Array<() => Promise<unknown> | void> = [];

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

async function buildSignedTurnResumeRequest(args: {
  conversationId: string;
  sessionId: string;
  expectedCheckpointVersion: number;
}): Promise<Request> {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn(
    async () => new Response("Accepted", { status: 202 }),
  );
  global.fetch = fetchMock as typeof fetch;

  try {
    const { scheduleTurnTimeoutResume } =
      await import("@/chat/services/timeout-resume");
    await scheduleTurnTimeoutResume(args);
  } finally {
    global.fetch = originalFetch;
  }

  const firstCall = fetchMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("Expected scheduleTurnTimeoutResume to issue one fetch");
  }
  const [url, init] = firstCall as unknown as [string, RequestInit];
  return new Request(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
}

describe("turn resume slack integration", () => {
  beforeEach(async () => {
    waitUntilCallbacks.length = 0;
    generateAssistantReplyMock.mockReset();
    generateAssistantReplyMock.mockResolvedValue({
      text: "Final resumed answer",
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_INTERNAL_RESUME_SECRET: "resume-secret",
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token",
    };

    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");
    turnResumeHandlerModule = await import("@/handlers/turn-resume");
    turnSessionStoreModule = await import("@/chat/state/turn-session-store");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("posts the resumed reply through the Slack MSW harness and persists completion", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const checkpoint =
      await turnSessionStoreModule.upsertAgentTurnSessionCheckpoint({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
        piMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
        ],
        loadedSkillNames: ["demo-skill"],
        resumeReason: "timeout",
        resumedFromSliceId: 1,
        errorMessage: "Agent turn timed out",
      });

    await threadStateModule.persistThreadStateById(conversationId, {
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        messages: [
          {
            id: "msg.1",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
              userName: "alice",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1,
        },
        vision: {
          byFileId: {},
        },
      },
    });
    await threadStateModule.getChannelConfigurationServiceById("C123").set({
      key: "demo.org",
      value: "acme",
      source: "test",
    });

    const response = await turnResumeHandlerModule.POST(
      await buildSignedTurnResumeRequest({
        conversationId,
        sessionId,
        expectedCheckpointVersion: checkpoint.checkpointVersion,
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    expect(waitUntilCallbacks).toHaveLength(1);

    await waitUntilCallbacks[0]?.();

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1712345.0001",
            status: expect.any(String),
            loading_messages: expect.arrayContaining([expect.any(String)]),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1712345.0001",
            status: "",
          }),
        }),
      ]),
    );
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0001",
          text: "Final resumed answer",
        }),
      }),
    ]);

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      messages?: Array<{ role?: string; text?: string }>;
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer",
    });
  });

  it("posts the failure message when timeout resume depth is exhausted", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const sessionId = "turn_msg_2";
    const checkpoint =
      await turnSessionStoreModule.upsertAgentTurnSessionCheckpoint({
        conversationId,
        sessionId,
        sliceId: 5,
        state: "awaiting_resume",
        piMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
        ],
        loadedSkillNames: ["demo-skill"],
        resumeReason: "timeout",
        resumedFromSliceId: 4,
        errorMessage: "Agent turn timed out",
      });

    await threadStateModule.persistThreadStateById(conversationId, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        messages: [
          {
            id: "msg.2",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { RetryableTurnError } = await import("@/chat/runtime/turn");
    generateAssistantReplyMock.mockRejectedValueOnce(
      new RetryableTurnError("turn_timeout_resume", "timed out again", {
        conversationId,
        sessionId,
        checkpointVersion: checkpoint.checkpointVersion + 1,
        sliceId: 6,
      }),
    );

    const response = await turnResumeHandlerModule.POST(
      await buildSignedTurnResumeRequest({
        conversationId,
        sessionId,
        expectedCheckpointVersion: checkpoint.checkpointVersion,
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    expect(waitUntilCallbacks).toHaveLength(1);

    await waitUntilCallbacks[0]?.();

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0002",
          text: "I hit an error while resuming that request. Please try the command again.",
        }),
      }),
    ]);

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
  });
});
