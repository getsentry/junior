import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type { AgentRun } from "@/chat/agent/types";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

const ORIGINAL_ENV = { ...process.env };
const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function slackSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,

    visibility: "private",
  });
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type PausedTurnModule = typeof import("@/chat/task-execution/paused-turn");
type RequestDeadlineModule = typeof import("@/chat/runtime/request-deadline");
type TurnSessionStoreModule =
  typeof import("@/chat/task-execution/turn-cursor");
type TurnWakeModule = typeof import("@/chat/task-execution/turn-wake");
type TaskExecutionStoreModule = typeof import("@/chat/task-execution/store");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let pausedTurnModule: PausedTurnModule;
let requestDeadlineModule: RequestDeadlineModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let turnWakeModule: TurnWakeModule;
let taskExecutionStoreModule: TaskExecutionStoreModule;
let queue: ConversationWorkQueueTestAdapter;
let agentRunner: AgentRunner;
let agentRuns: AgentRun[];

function continueAgentRun(args: {
  conversationId: string;
  sessionId: string;
  expectedVersion: number;
}): Promise<boolean> {
  // Direct resume only. Worker-owned timeout lease handback is covered by
  // durable-queue, not reimplemented here.
  return requestDeadlineModule.runWithTurnRequestDeadline(() =>
    pausedTurnModule.runPausedTurn(
      {
        conversationId: args.conversationId,
        destination: SLACK_DESTINATION,
        expectedVersion: args.expectedVersion,
        turnId: args.sessionId,
      },
      {
        agentRunner,
        wakePausedTurn: (request) =>
          turnWakeModule.wakePausedTurn(request, {
            queue,
          }),
      },
    ),
  );
}

describe("paused turn Slack integration", () => {
  beforeEach(async () => {
    queue = createConversationWorkQueueTestAdapter();
    agentRuns = [];
    agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([
        { type: "text", text: "Final resumed answer" },
      ]);
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
    pausedTurnModule = await import("@/chat/task-execution/paused-turn");
    requestDeadlineModule = await import("@/chat/runtime/request-deadline");
    turnSessionStoreModule = await import("@/chat/task-execution/turn-cursor");
    turnWakeModule = await import("@/chat/task-execution/turn-wake");
    taskExecutionStoreModule = await import("@/chat/task-execution/store");

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
    // SQL sessionSource is the resume authority and intentionally drops
    // per-message timestamps; resume routing must match that locator shape.
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1712345.0001",
      visibility: "private",
    });
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
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
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
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
        vision: {
          byFileId: {},
        },
      },
    });
    await threadStateModule
      .getLocationConfigurationService(SLACK_DESTINATION)
      .set({
        key: "demo.org",
        value: "acme",
        source: "test",
      });

    const stateAdapter = stateAdapterModule.getStateAdapter();
    const oldResumeLock = await stateAdapter.acquireLock(
      conversationId,
      90_000,
    );
    expect(oldResumeLock).not.toBeNull();
    let continued: boolean;
    try {
      continued = await continueAgentRun({
        conversationId,
        sessionId,
        expectedVersion: sessionRecord.version,
      });
    } finally {
      if (oldResumeLock) {
        await stateAdapter.releaseLock(oldResumeLock);
      }
    }

    expect(continued).toBe(true);

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
    expect(agentRuns).toHaveLength(1);
    const resumedRun = agentRuns[0]!;
    expect(resumedRun).toMatchObject({
      instruction: {
        text: "resume this request",
        inboundAttachmentCount: 2,
        omittedImageAttachmentCount: 1,
      },
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
      },
      destination: SLACK_DESTINATION,
      location: {
        provider: "slack",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
      source: storedSource,
      toolChannelId: "C123",
      state: expect.objectContaining({
        sandboxRef: undefined,
      }),
    });
    const resumeContext = resumedRun as {
      deadlineAtMs?: number;
      environment?: {
        locationConfiguration?: {
          resolve: (key: string) => Promise<unknown>;
        };
      };
    };
    expect(resumeContext.deadlineAtMs).toEqual(expect.any(Number));
    expect(resumeContext.deadlineAtMs).toBeGreaterThan(Date.now());
    expect(
      await resumeContext.environment?.locationConfiguration?.resolve(
        "demo.org",
      ),
    ).toBe("acme");

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const processing = (
      (persisted.conversation ?? {}) as {
        processing?: { activeTurnId?: string };
      }
    ).processing;
    expect(processing?.activeTurnId).toBeUndefined();
    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({ conversation, conversationId });
    expect(conversation.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer",
    });
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");
    const lifecycle = (
      await getConversationEventStore().loadHistory(conversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: sessionId,
        inputMessageIds: ["msg.1"],
        surface: "slack",
      }),
      expect.objectContaining({
        type: "turn_routed",
        turnId: sessionId,
      }),
      expect.objectContaining({
        type: "turn_completed",
        turnId: sessionId,
        outcome: "success",
      }),
    ]);
    await expect(
      getConversationStore().getDestinationVisibility({
        provider: "slack",
        providerDestinationId: "C123",
        providerTenantId: "T123",
      }),
    ).resolves.toBeUndefined();
  });

  it("restores the Turn Actor when the saved Message has no profile data", async () => {
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn_msg_8";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
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
      actor: {
        email: "alice@example.com",
        fullName: "Alice Example",
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "alice",
      },
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
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
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toMatchObject({
      instruction: { text: "resume this request" },
      actor: {
        email: "alice@example.com",
        fullName: "Alice Example",
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
    });
  });

  it("restores explicit progress from the active turn", async () => {
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn_msg_9";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSource("1712345.0009"),
      turnStartMessageIndex: 3,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "prior turn" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "test/model",
          usage: TEST_USAGE,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "prior-progress-call",
              name: "reportProgress",
              arguments: { message: "Searching old results" },
            },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "prior-progress-call",
          toolName: "reportProgress",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: [{ type: "text", text: "review this" }],
          timestamp: 4,
        },
        {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "test/model",
          usage: TEST_USAGE,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "progress-call-1",
              name: "reportProgress",
              arguments: { message: "Reading current results" },
            },
          ],
          timestamp: 5,
        },
        {
          role: "toolResult",
          toolCallId: "progress-call-1",
          toolName: "reportProgress",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 6,
        },
        {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "test/model",
          usage: TEST_USAGE,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "progress-call-2",
              name: "reportProgress",
              arguments: { message: "Reviewing results" },
            },
          ],
          timestamp: 7,
        },
        {
          role: "toolResult",
          toolCallId: "progress-call-2",
          toolName: "reportProgress",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 8,
        },
        {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "test/model",
          usage: TEST_USAGE,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "invalid-progress-call",
              name: "reportProgress",
              arguments: { message: "   " },
            },
          ],
          timestamp: 9,
        },
        {
          role: "toolResult",
          toolCallId: "invalid-progress-call",
          toolName: "reportProgress",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 10,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
      },
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.9",
            role: "user",
            text: "review this",
            createdAtMs: 1,
            author: { userId: "U123" },
          },
        ],
        processing: { activeTurnId: sessionId },
        vision: { byFileId: {} },
      },
    });

    await continueAgentRun({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    const activeStatuses = slackApiOutbox
      .calls("assistant.threads.setStatus")
      .map((call) => call.params)
      .filter((params) => params.status !== "");
    expect(activeStatuses[0]).toEqual(
      expect.objectContaining({
        loading_messages: ["Reviewing results"],
      }),
    );
  });

  it("terminalizes startup failures before the visible failure path runs", async () => {
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn_msg_7";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
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
      conversation: {
        schemaVersion: 1,
        compactions: [],
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

    // Missing author id is fail-closed without throwing out of beforeStart.
    expect(continued).toBe(false);
    await expect(
      turnSessionStoreModule.getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Unable to rebuild the Slack actor for the paused turn",
    });
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0007",
          text: expect.stringContaining(
            "I ran into an internal error while processing that.",
          ),
        }),
      }),
    ]);
    expect(agentRuns).toEqual([]);
  });

  it("resumes resource-event turns with the rebuilt system actor", async () => {
    const conversationId = "slack:C123:1712345.0012";
    const sessionId = "turn_resource-event-msg_12";
    const storedSource = slackSource("1712345.0012");
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: storedSource,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "subscribed PR checks failed" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "resource-event-msg.12",
            role: "user",
            text: "subscribed PR checks failed",
            createdAtMs: 1,
            author: {
              userId: "UJRNEVENT",
              userName: "junior-event",
              isBot: true,
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
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
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toMatchObject({
      actor: { platform: "system", name: "resource-event" },
      credentialContext: {
        actor: { platform: "system", name: "resource-event" },
      },
      destination: SLACK_DESTINATION,
      source: storedSource,
    });
  });

  it("rebuilds the resume actor from the message author when redis has no actor", async () => {
    // Issue #727: missing redis actor must never throw out of the continue
    // callback. With SQL-only routing, bare author id + destination team is
    // enough to rebuild a Slack resume actor.
    const conversationId = "slack:C123:1712345.0010";
    const sessionId = "turn_msg_10";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSource("1712345.0010"),
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
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.10",
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
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toMatchObject({
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
      },
    });
  });

  it("recovers the resume actor from the durable conversation record", async () => {
    // Issue #727 recovery path: older session records were persisted without
    // a actor; the durable conversation work record still carries the
    // matching identity, so the resume completes instead of failing.
    const conversationId = "slack:C123:1712345.0011";
    const sessionId = "turn_msg_11";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSource("1712345.0011"),
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
    await taskExecutionStoreModule.recordConversationActivity({
      conversationId,
      destination: SLACK_DESTINATION,
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        slackUserId: "U123",
        slackUserName: "testuser",
        fullName: "Test User",
        email: "testuser@example.com",
      },
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.11",
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
          thread_ts: "1712345.0011",
          text: "Final resumed answer",
        }),
      }),
    ]);
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toMatchObject({
      instruction: { text: "resume this request" },
      actor: expect.objectContaining({
        userId: "U123",
        userName: "testuser",
        fullName: "Test User",
        email: "testuser@example.com",
      }),
    });
  });
});
