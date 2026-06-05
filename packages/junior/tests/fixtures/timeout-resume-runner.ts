import { vi } from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import type {
  ResumeSlackTurnArgs,
  ResumeSlackTurnRunner,
} from "@/chat/runtime/slack-resume";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";

export type ResumeSlackTurnMock = ReturnType<
  typeof vi.fn<ResumeSlackTurnRunner>
>;

export const TIMEOUT_RESUME_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;

export interface TimeoutResumeScenarioOptions {
  activeTurnId?: string;
  conversationId?: string;
  messageId?: string;
  sessionId?: string;
  sliceId?: number;
}

/** Resets memory state before timeout resume runner tests. */
export async function setupTimeoutResumeRunnerTest() {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  await disconnectStateAdapter();
}

/** Restores timers and memory state after timeout resume runner tests. */
export async function cleanupTimeoutResumeRunnerTest() {
  vi.useRealTimers();
  await disconnectStateAdapter();
  delete process.env.JUNIOR_STATE_ADAPTER;
  vi.restoreAllMocks();
}

/** Creates a typed fake for the Slack resume runtime boundary. */
export function createResumeSlackTurnMock(): ResumeSlackTurnMock {
  return vi.fn<ResumeSlackTurnRunner>();
}

/** Stores the common awaiting timeout resume session and thread state. */
export async function createTimeoutResumeScenario(
  options: TimeoutResumeScenarioOptions = {},
) {
  const conversationId = options.conversationId ?? "slack:C123:1712345.0001";
  const sessionId = options.sessionId ?? "turn_msg_1";
  const sliceId = options.sliceId ?? 2;
  const messageId = options.messageId ?? "msg.1";
  const activeTurnId = options.activeTurnId ?? sessionId;
  const sessionRecord = await upsertAgentTurnSessionRecord({
    conversationId,
    sessionId,
    sliceId,
    state: "awaiting_resume",
    destination: TIMEOUT_RESUME_DESTINATION,
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
  });

  await persistThreadStateById(conversationId, {
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
          id: messageId,
          role: "user",
          text: "resume this request",
          createdAtMs: 1,
          author: {
            userId: "U123",
          },
        },
      ],
      processing: {
        activeTurnId,
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

  return {
    conversationId,
    messageId,
    payload: {
      conversationId,
      destination: TIMEOUT_RESUME_DESTINATION,
      sessionId,
      expectedVersion: sessionRecord.version,
    },
    sessionId,
    sessionRecord,
  };
}

/** Runs the fake resume boundary as the real runner would when it starts. */
export async function prepareResumeArgs(
  args: ResumeSlackTurnArgs,
): Promise<ResumeSlackTurnArgs | false> {
  const prepared = await args.beforeStart?.();
  if (prepared === false) {
    return false;
  }
  return { ...args, ...(prepared ?? {}) };
}
