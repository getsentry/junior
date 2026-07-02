import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

const generateAssistantReplyMock = vi.fn();

const ORIGINAL_ENV = { ...process.env };

function slackSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,
  });
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type AgentContinueRunnerModule =
  typeof import("@/chat/runtime/agent-continue-runner");
type RequestDeadlineModule = typeof import("@/chat/runtime/request-deadline");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");
type AgentContinueServiceModule =
  typeof import("@/chat/services/agent-continue");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let agentContinueRunnerModule: AgentContinueRunnerModule;
let requestDeadlineModule: RequestDeadlineModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let agentContinueServiceModule: AgentContinueServiceModule;
let queue: ConversationWorkQueueTestAdapter;

function continueAgentRun(args: {
  conversationId: string;
  sessionId: string;
  expectedVersion: number;
}): Promise<boolean> {
  return requestDeadlineModule.runWithTurnRequestDeadline(() =>
    agentContinueRunnerModule.continueSlackAgentRunWithLockRetry(
      {
        conversationId: args.conversationId,
        destination: SLACK_DESTINATION,
        expectedVersion: args.expectedVersion,
        sessionId: args.sessionId,
      },
      {
        generateReply: generateAssistantReplyMock,
        scheduleAgentContinue: (request) =>
          agentContinueServiceModule.scheduleAgentContinue(request, {
            queue,
          }),
      },
    ),
  );
}

describe("agent continuation Slack integration", () => {
  beforeEach(async () => {
    queue = createConversationWorkQueueTestAdapter();
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
    agentContinueRunnerModule =
      await import("@/chat/runtime/agent-continue-runner");
    requestDeadlineModule = await import("@/chat/runtime/request-deadline");
    turnSessionStoreModule = await import("@/chat/state/turn-session");
    agentContinueServiceModule = await import("@/chat/services/agent-continue");

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
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1712345.continue-source",
      threadTs: "1712345.0001",
    });
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
        destination: SLACK_DESTINATION,
        source: storedSource,
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
        requester: {
          platform: "slack",
          teamId: SLACK_DESTINATION.teamId,
          userId: "U123",
          userName: "testuser",
          fullName: "Test User",
          email: "testuser@example.com",
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

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "resume this request",
      expect.objectContaining({
        requester: expect.objectContaining({
          email: "testuser@example.com",
          fullName: "Test User",
          userId: "U123",
          userName: "testuser",
        }),
        destination: SLACK_DESTINATION,
        source: storedSource,
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

  it("resumes and delivers when the continuation record is missing stored requester profile data", async () => {
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn_msg_8";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
        destination: SLACK_DESTINATION,
        source: slackSource("1712345.0008"),
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
            id: "msg.8",
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

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0008",
          text: "Final resumed answer",
        }),
      }),
    ]);
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "resume this request",
      expect.objectContaining({
        requester: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
      }),
    );
  });

  it("schedules another continuation for high slice ids", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const sessionId = "turn_msg_2";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 5,
        state: "awaiting_resume",
        destination: SLACK_DESTINATION,
        source: slackSource("1712345.0002"),
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
        requester: {
          platform: "slack",
          teamId: SLACK_DESTINATION.teamId,
          userId: "U123",
          userName: "testuser",
          fullName: "Test User",
          email: "testuser@example.com",
        },
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
      new RetryableTurnError("agent_continue", "timed out again", {
        conversationId,
        sessionId,
        version: sessionRecord.version + 1,
        sliceId: 6,
      }),
    );

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);

    expect(slackApiOutbox.messages()).toEqual([]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${sessionId}:`,
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

  it("terminalizes startup failures before the visible failure path runs", async () => {
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn_msg_7";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
        destination: SLACK_DESTINATION,
        source: slackSource("1712345.0007"),
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
            id: "msg.7",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {},
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

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Paused agent run failed while continuing",
    });
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
        destination: SLACK_DESTINATION,
        source: slackSource("1712345.0006"),
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
        requester: {
          platform: "slack",
          teamId: SLACK_DESTINATION.teamId,
          userId: "U123",
          userName: "testuser",
          fullName: "Test User",
          email: "testuser@example.com",
        },
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
      new RetryableTurnError("agent_continue", "timed out again", {
        conversationId,
        sessionId,
        version: sessionRecord.version + 1,
        sliceId: 3,
      }),
    );

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);

    const postCalls = slackApiOutbox.messages();
    expect(postCalls).toEqual([]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${sessionId}:`,
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
        destination: SLACK_DESTINATION,
        source: slackSource("1712345.0003"),
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
        requester: {
          platform: "slack",
          teamId: SLACK_DESTINATION.teamId,
          userId: "U123",
          userName: "testuser",
          fullName: "Test User",
          email: "testuser@example.com",
        },
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

    const continued = await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(continued).toBe(true);

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
