import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  createTurnResumeTestClient,
  type TurnResumeTestClient,
} from "../fixtures/turn-resume";
import type { WaitUntilCollector } from "../fixtures/wait-until";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

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
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");
type TimeoutResumeServiceModule =
  typeof import("@/chat/services/timeout-resume");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let turnResumeHandlerModule: TurnResumeHandlerModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let timeoutResumeServiceModule: TimeoutResumeServiceModule;
let queue: ConversationWorkQueueTestAdapter;
let turnResumeClient: TurnResumeTestClient;
let waitUntil: WaitUntilCollector;

function postResumeRequest(args: {
  conversationId: string;
  sessionId: string;
  expectedVersion: number;
}): Promise<Response> {
  return turnResumeHandlerModule.POST(
    turnResumeClient.request(args),
    waitUntil.fn,
    {
      scheduleTurnTimeoutResume: (request) =>
        timeoutResumeServiceModule.scheduleTurnTimeoutResume(request, {
          queue,
        }),
    },
  );
}

describe("turn resume slack integration", () => {
  beforeEach(async () => {
    queue = createConversationWorkQueueTestAdapter();
    turnResumeClient = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });
    waitUntil = turnResumeClient.waitUntil();
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
      JUNIOR_SECRET: "resume-secret",
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token",
    };

    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");
    turnResumeHandlerModule = await import("@/handlers/turn-resume");
    turnSessionStoreModule = await import("@/chat/state/turn-session");
    timeoutResumeServiceModule = await import("@/chat/services/timeout-resume");

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
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
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
        piMessages: [],
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
            meta: {
              attachmentCount: 2,
              imageAttachmentCount: 1,
              imagesHydrated: false,
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

    const response = await postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(waitUntil.pendingCount()).toBe(1);

    await waitUntil.flush();

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "resume this request",
      expect.objectContaining({
        requester: expect.objectContaining({
          email: "testuser@example.com",
          fullName: "Test User",
          userId: "U123",
          userName: "testuser",
        }),
        toolChannelId: "C999",
        inboundAttachmentCount: 2,
        omittedImageAttachmentCount: 1,
        sandbox: expect.objectContaining({
          sandboxId: undefined,
          sandboxDependencyProfileHash: undefined,
        }),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      channelConfiguration?: {
        resolve: (key: string) => Promise<unknown>;
      };
      turnDeadlineAtMs?: number;
    };
    expect(resumeContext.turnDeadlineAtMs).toEqual(expect.any(Number));
    expect(resumeContext.turnDeadlineAtMs).toBeGreaterThan(Date.now());
    expect(await resumeContext.channelConfiguration?.resolve("demo.org")).toBe(
      "acme",
    );

    expect(slackApiOutbox.calls("assistant.threads.setStatus")).toEqual(
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
    expect(slackApiOutbox.messages()).toEqual([
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

  it("schedules another continuation for high timeout resume slice ids", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const sessionId = "turn_msg_2";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
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
        piMessages: [],
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
        version: sessionRecord.version + 1,
        sliceId: 6,
      }),
    );

    const response = await postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(waitUntil.pendingCount()).toBe(1);

    await waitUntil.flush();

    expect(slackApiOutbox.messages()).toEqual([]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        idempotencyKey: expect.stringContaining(
          `timeout:${conversationId}:${sessionId}:`,
        ),
      },
    ]);

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBe(sessionId);
  });

  it("schedules a durable continuation without posting a notice when a resumed slice times out again", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
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
        resumeReason: "timeout",
        resumedFromSliceId: 1,
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
        piMessages: [],
        messages: [
          {
            id: "msg.6",
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
        version: sessionRecord.version + 1,
        sliceId: 3,
      }),
    );

    const response = await postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(waitUntil.pendingCount()).toBe(1);

    await waitUntil.flush();

    const postCalls = slackApiOutbox.messages();
    expect(postCalls).toEqual([]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        idempotencyKey: expect.stringContaining(
          `timeout:${conversationId}:${sessionId}:`,
        ),
      },
    ]);
  });

  it("uploads resumed reply files through the shared delivery path", async () => {
    const conversationId = "slack:C123:1712345.0003";
    const sessionId = "turn_msg_3";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
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
        resumeReason: "timeout",
        resumedFromSliceId: 1,
        errorMessage: "Agent turn timed out",
      });

    generateAssistantReplyMock.mockResolvedValueOnce({
      text: "Final resumed answer with artifact",
      files: [
        {
          data: Buffer.from("resume-file"),
          filename: "resume.txt",
        },
      ],
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
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
        piMessages: [],
        messages: [
          {
            id: "msg.3",
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

    const response = await postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(waitUntil.pendingCount()).toBe(1);

    await waitUntil.flush();

    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0003",
          text: "Final resumed answer with artifact",
        }),
      }),
    ]);
    expect(slackApiOutbox.calls("files.getUploadURLExternal")).toHaveLength(1);
    expect(slackApiOutbox.calls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1712345.0003",
        }),
      }),
    ]);
    expect(slackApiOutbox.fileUploads()).toHaveLength(1);

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      messages?: Array<{ role?: string; text?: string }>;
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer with artifact",
    });
  });
});
