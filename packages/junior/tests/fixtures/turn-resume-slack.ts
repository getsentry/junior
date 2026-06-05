import { vi } from "vitest";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "./conversation-work";
import {
  createTurnResumeTestClient,
  type TurnResumeTestClient,
} from "./turn-resume";
import type { WaitUntilCollector } from "./wait-until";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { successfulAssistantReply } from "./assistant-reply";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

export { SLACK_DESTINATION };

const ORIGINAL_ENV = { ...process.env };

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type TurnResumeHandlerModule = typeof import("@/handlers/turn-resume");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");
type TimeoutResumeServiceModule =
  typeof import("@/chat/services/timeout-resume");

export interface TimeoutResumeThreadOptions {
  artifacts?: Record<string, unknown>;
  author?: {
    userId: string;
    userName?: string;
  };
  conversationId: string;
  messageId: string;
  messageMeta?: Record<string, unknown>;
  sessionId: string;
  sliceId?: number;
}

/** Starts the Slack timeout-resume integration fixture. */
export async function createTurnResumeSlackFixture() {
  const queue: ConversationWorkQueueTestAdapter =
    createConversationWorkQueueTestAdapter();
  const turnResumeClient: TurnResumeTestClient = createTurnResumeTestClient({
    juniorSecret: "resume-secret",
  });
  const waitUntil: WaitUntilCollector = turnResumeClient.waitUntil();
  const generateAssistantReplyMock = vi.fn<ResumeReplyGenerator>();
  generateAssistantReplyMock.mockResolvedValue(
    successfulAssistantReply("Final resumed answer"),
  );
  resetSlackApiMockState();
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
    JUNIOR_BASE_URL: "https://junior.example.com",
    JUNIOR_SECRET: "resume-secret",
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token",
  };

  vi.resetModules();
  const stateAdapter: StateAdapterModule = await import("@/chat/state/adapter");
  const threadState: ThreadStateModule =
    await import("@/chat/runtime/thread-state");
  const turnResumeHandler: TurnResumeHandlerModule =
    await import("@/handlers/turn-resume");
  const turnSessionStore: TurnSessionStoreModule =
    await import("@/chat/state/turn-session");
  const timeoutResumeService: TimeoutResumeServiceModule =
    await import("@/chat/services/timeout-resume");

  await stateAdapter.disconnectStateAdapter();
  await stateAdapter.getStateAdapter().connect();

  return {
    generateAssistantReplyMock,
    queue,
    stateAdapter,
    threadState,
    turnSessionStore,
    waitUntil,

    /** Posts a signed timeout-resume request through the real handler. */
    async postResumeRequest(args: {
      conversationId: string;
      sessionId: string;
      expectedVersion: number;
    }): Promise<Response> {
      return await turnResumeHandler.POST(
        turnResumeClient.request({
          ...args,
          destination: SLACK_DESTINATION,
        }),
        waitUntil.fn,
        {
          generateReply: generateAssistantReplyMock,
          scheduleTurnTimeoutResume: (request) =>
            timeoutResumeService.scheduleTurnTimeoutResume(request, {
              queue,
            }),
        },
      );
    },

    /** Stores a timeout-resume turn session and matching Slack thread state. */
    async createTimeoutResumeThread(options: TimeoutResumeThreadOptions) {
      const sliceId = options.sliceId ?? 2;
      const sessionRecord = await turnSessionStore.upsertAgentTurnSessionRecord(
        {
          conversationId: options.conversationId,
          sessionId: options.sessionId,
          sliceId,
          state: "awaiting_resume",
          destination: SLACK_DESTINATION,
          piMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1,
            },
          ],
          resumeReason: "timeout",
          resumedFromSliceId: sliceId - 1,
          errorMessage: "Agent turn timed out",
        },
      );

      await threadState.persistThreadStateById(options.conversationId, {
        artifacts: options.artifacts ?? {
          listColumnMap: {},
        },
        conversation: {
          schemaVersion: 1,
          backfill: {},
          compactions: [],
          piMessages: [],
          messages: [
            {
              id: options.messageId,
              role: "user",
              text: "resume this request",
              createdAtMs: 1,
              author: options.author ?? {
                userId: "U123",
              },
              ...(options.messageMeta ? { meta: options.messageMeta } : {}),
            },
          ],
          processing: {
            activeTurnId: options.sessionId,
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

      return sessionRecord;
    },

    /** Disconnects memory state and restores the test environment. */
    async cleanup() {
      await stateAdapter.disconnectStateAdapter();
      process.env = { ...ORIGINAL_ENV };
      vi.restoreAllMocks();
    },
  };
}
