import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type { AgentRunRequest } from "@/chat/agent/request";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { deliverAssistantMessagesForTest } from "../fixtures/agent-runner";

const executeAgentRunMock = vi.fn();

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

function makeDiagnostics() {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
  };
}

function createSandbox(files: Record<string, Buffer>): SandboxWorkspace {
  return {
    readFileToBuffer: async ({ path }) => files[path] ?? null,
    runCommand: async () => ({
      exitCode: 0,
      stdout: "image/png\n",
      stderr: "",
    }),
    writeFiles: async () => undefined,
  };
}

/** Build a Slack tool context from the resumed request to exercise continuation file sends. */
function createToolContext(
  request: AgentRunRequest,
  workspace: SandboxWorkspace,
): ToolRuntimeContext {
  if (
    request.routing.source.platform !== "slack" ||
    request.routing.destination.platform !== "slack"
  ) {
    throw new Error("test requires Slack tool context");
  }

  return {
    artifactState: request.state?.artifactState,
    configuration: request.policy?.configuration,
    conversationId: request.conversationId,
    destination: request.routing.destination,
    egress: {} as ToolRuntimeContext["egress"],
    actor:
      request.routing.actor?.platform === "slack"
        ? request.routing.actor
        : undefined,
    workspace,
    source: request.routing.source,
    surface: request.routing.surface,
    userText: request.input.messageText,
  };
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type AgentContinueRunnerModule =
  typeof import("@/chat/task-execution/continue-run");
type RequestDeadlineModule = typeof import("@/chat/runtime/request-deadline");
type TurnSessionStoreModule =
  typeof import("@/chat/task-execution/turn-cursor");
type AgentContinueServiceModule =
  typeof import("@/chat/task-execution/continue");
type TaskExecutionStoreModule = typeof import("@/chat/task-execution/store");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let agentContinueRunnerModule: AgentContinueRunnerModule;
let requestDeadlineModule: RequestDeadlineModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let agentContinueServiceModule: AgentContinueServiceModule;
let taskExecutionStoreModule: TaskExecutionStoreModule;
let queue: ConversationWorkQueueTestAdapter;

function continueAgentRun(args: {
  conversationId: string;
  sessionId: string;
  expectedVersion: number;
}): Promise<boolean> {
  return requestDeadlineModule.runWithTurnRequestDeadline(() =>
    agentContinueRunnerModule.continueSlackAgentRun(
      {
        conversationId: args.conversationId,
        destination: SLACK_DESTINATION,
        expectedVersion: args.expectedVersion,
        turnId: args.sessionId,
      },
      {
        agentRunner: { run: executeAgentRunMock },
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
    executeAgentRunMock.mockReset();
    executeAgentRunMock.mockImplementation(async (request) => {
      await deliverAssistantMessagesForTest(request, [
        { text: "Final resumed answer" },
      ]);
      return completedAgentRun({
        text: "Final resumed answer",
        diagnostics: makeDiagnostics(),
      });
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
      await import("@/chat/task-execution/continue-run");
    requestDeadlineModule = await import("@/chat/runtime/request-deadline");
    turnSessionStoreModule = await import("@/chat/task-execution/turn-cursor");
    agentContinueServiceModule = await import("@/chat/task-execution/continue");
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
      modelId: "test/model",
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
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
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

    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          messageText: "resume this request",
          inboundAttachmentCount: 2,
          omittedImageAttachmentCount: 1,
        }),
        routing: expect.objectContaining({
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
          destination: SLACK_DESTINATION,
          source: storedSource,
          toolChannelId: "C999",
        }),
        state: expect.objectContaining({
          sandboxRef: undefined,
        }),
      }),
    );
    const resumeContext = executeAgentRunMock.mock.calls[0]?.[0] as {
      policy?: {
        channelConfiguration?: {
          resolve: (key: string) => Promise<unknown>;
        };
        turnDeadlineAtMs?: number;
      };
    };
    expect(resumeContext.policy?.turnDeadlineAtMs).toEqual(expect.any(Number));
    expect(resumeContext.policy?.turnDeadlineAtMs).toBeGreaterThan(Date.now());
    expect(
      await resumeContext.policy?.channelConfiguration?.resolve("demo.org"),
    ).toBe("acme");

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
    const { getConversationEventStore } = await import("@/chat/db");
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
        type: "turn_completed",
        turnId: sessionId,
        outcome: "success",
      }),
    ]);
  });

  it("resumes and delivers when the continuation record is missing stored actor profile data", async () => {
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn_msg_8";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
      },
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      artifacts: {
        listColumnMap: {},
      },
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
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ messageText: "resume this request" }),
        routing: expect.objectContaining({
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
        }),
      }),
    );
  });

  it("restores explicit progress from the active turn", async () => {
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn_msg_9";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
      artifacts: { listColumnMap: {} },
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

  it("schedules another continuation for high slice ids", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const sessionId = "turn_msg_2";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
      conversationId,
      turnId: sessionId,
      sliceId: 5,
      state: "paused",
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
      actor: {
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
        vision: {
          byFileId: {},
        },
      },
    });

    executeAgentRunMock.mockResolvedValueOnce({
      status: "suspended",
      resumeVersion: sessionRecord.version + 1,
    });

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
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
      artifacts: {
        listColumnMap: {},
      },
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
    expect(executeAgentRunMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Unable to rebuild Slack actor for continuation",
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
  });

  it("resumes resource-event turns with the rebuilt system actor", async () => {
    const conversationId = "slack:C123:1712345.0012";
    const sessionId = "turn_resource-event-msg_12";
    const storedSource = slackSource("1712345.0012");
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
      artifacts: {
        listColumnMap: {},
      },
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
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({
          actor: { platform: "system", name: "resource-event" },
          credentialContext: {
            actor: { platform: "system", name: "resource-event" },
          },
          destination: SLACK_DESTINATION,
          source: storedSource,
        }),
      }),
    );
  });

  it("rebuilds the resume actor from the message author when redis has no actor", async () => {
    // Issue #727: missing redis actor must never throw out of the continue
    // callback. With SQL-only routing, bare author id + destination team is
    // enough to rebuild a Slack resume actor.
    const conversationId = "slack:C123:1712345.0010";
    const sessionId = "turn_msg_10";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
      artifacts: {
        listColumnMap: {},
      },
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
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
        }),
      }),
    );
  });

  it("recovers the resume actor from the durable conversation record", async () => {
    // Issue #727 recovery path: older session records were persisted without
    // a actor; the durable conversation work record still carries the
    // matching identity, so the resume completes instead of failing.
    const conversationId = "slack:C123:1712345.0011";
    const sessionId = "turn_msg_11";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
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
      artifacts: {
        listColumnMap: {},
      },
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
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ messageText: "resume this request" }),
        routing: expect.objectContaining({
          actor: expect.objectContaining({
            userId: "U123",
            userName: "testuser",
            fullName: "Test User",
            email: "testuser@example.com",
          }),
        }),
      }),
    );
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0011",
          text: "Final resumed answer",
        }),
      }),
    ]);
  });

  it("schedules a durable continuation without posting a notice when a resumed slice times out again", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
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
      actor: {
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
        compactions: [],
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
        vision: {
          byFileId: {},
        },
      },
    });

    executeAgentRunMock.mockResolvedValueOnce({
      status: "suspended",
      resumeVersion: sessionRecord.version + 1,
    });

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
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${sessionId}:`,
        ),
      },
    ]);
  });

  it("posts resumed replies through the shared delivery path", async () => {
    const conversationId = "slack:C123:1712345.0003";
    const sessionId = "turn_msg_3";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
      modelId: "test/model",
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
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
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "testuser",
        fullName: "Test User",
        email: "testuser@example.com",
      },
    });

    executeAgentRunMock.mockImplementationOnce(async (request) => {
      const tools = createTools(
        [],
        {},
        createToolContext(
          request as AgentRunRequest,
          createSandbox({
            "/tmp/resumed-image.png": Buffer.from("resumed image"),
          }),
        ),
      );
      const sendFiles = tools.sendFiles;
      if (!sendFiles?.execute) {
        throw new Error("sendFiles tool missing from resumed Slack context");
      }
      await sendFiles.execute(
        {
          files: [{ path: "/tmp/resumed-image.png" }],
        },
        {} as never,
      );

      await deliverAssistantMessagesForTest(request, [
        { text: "Final resumed answer." },
      ]);
      return completedAgentRun({
        text: "Final resumed answer.",
        diagnostics: makeDiagnostics(),
      });
    });

    await threadStateModule.persistThreadStateById(conversationId, {
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        compactions: [],
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
          text: "Final resumed answer.",
        }),
      }),
    ]);
    expect(slackApiOutbox.calls("files.getUploadURLExternal")).toHaveLength(1);
    expect(slackApiOutbox.fileUploads()).toHaveLength(1);
    expect(
      slackApiOutbox.calls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1712345.0003",
    });
    expect(slackApiOutbox.calls("files.completeUploadExternal")).toHaveLength(
      1,
    );

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
      text: "Final resumed answer.",
    });
  });
});
