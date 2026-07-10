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
import type { AgentRunRequest } from "@/chat/agent/request";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const executeAgentRunMock = vi.fn();

const ORIGINAL_ENV = { ...process.env };

function slackSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,

    type: "priv",
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
      stdout: async () => "image/png\n",
      stderr: async () => "",
    }),
  };
}

/** Build a Slack tool context from the resumed request to exercise continuation file sends. */
function createToolContext(
  request: AgentRunRequest,
  sandbox: SandboxWorkspace,
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
    conversationId: request.routing.correlation?.conversationId,
    destination: request.routing.destination,
    egress: {} as ToolRuntimeContext["egress"],
    actor:
      request.routing.actor?.platform === "slack"
        ? request.routing.actor
        : undefined,
    sandbox,
    source: request.routing.source,
    surface: request.routing.surface,
    userText: request.input.messageText,
  };
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type AgentContinueRunnerModule =
  typeof import("@/chat/runtime/agent-continue-runner");
type RequestDeadlineModule = typeof import("@/chat/runtime/request-deadline");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");
type AgentContinueServiceModule =
  typeof import("@/chat/services/agent-continue");
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
    agentContinueRunnerModule.continueSlackAgentRunWithLockRetry(
      {
        conversationId: args.conversationId,
        destination: SLACK_DESTINATION,
        expectedVersion: args.expectedVersion,
        sessionId: args.sessionId,
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
    executeAgentRunMock.mockResolvedValue(
      completedAgentRun({
        text: "Final resumed answer",
        diagnostics: makeDiagnostics(),
      }),
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
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");
    agentContinueRunnerModule =
      await import("@/chat/runtime/agent-continue-runner");
    requestDeadlineModule = await import("@/chat/runtime/request-deadline");
    turnSessionStoreModule = await import("@/chat/state/turn-session");
    agentContinueServiceModule = await import("@/chat/services/agent-continue");
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
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1712345.continue-source",
      threadTs: "1712345.0001",

      type: "priv",
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

    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          messageText: "resume this request",
          inboundAttachmentCount: 2,
          omittedImageAttachmentCount: 1,
        }),
        routing: expect.objectContaining({
          actor: expect.objectContaining({
            email: "testuser@example.com",
            fullName: "Test User",
            userId: "U123",
            userName: "testuser",
          }),
          destination: SLACK_DESTINATION,
          source: storedSource,
          toolChannelId: "C999",
        }),
        state: expect.objectContaining({
          sandbox: expect.objectContaining({
            sandboxId: undefined,
            sandboxDependencyProfileHash: undefined,
          }),
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

  it("resumes and delivers when the continuation record is missing stored actor profile data", async () => {
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
    expect(executeAgentRunMock).not.toHaveBeenCalled();
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

  it("resumes resource-event turns with the stored system actor", async () => {
    const conversationId = "slack:C123:1712345.0012";
    const sessionId = "turn_resource-event-msg_12";
    const storedSource = slackSource("1712345.0012");
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
            content: [{ type: "text", text: "subscribed PR checks failed" }],
            timestamp: 1,
          },
        ],
        resumeReason: "timeout",
        resumedFromSliceId: 1,
        errorMessage: "Agent turn timed out",
        actor: { platform: "system", name: "resource-event" },
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
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({
          credentialContext: {
            actor: { platform: "system", name: "resource-event" },
          },
          destination: SLACK_DESTINATION,
          source: storedSource,
          correlation: expect.not.objectContaining({
            actorId: expect.anything(),
          }),
        }),
      }),
    );
    expect(
      executeAgentRunMock.mock.calls[0]?.[0].routing.actor,
    ).toBeUndefined();
  });

  it("terminally fails with a visible fallback when no stored actor can be recovered", async () => {
    // Issue #727: a missing stored actor must never throw out of the
    // continue callback (a throw NACKs the queue delivery and wedges the
    // conversation forever).
    const conversationId = "slack:C123:1712345.0010";
    const sessionId = "turn_msg_10";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
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
        backfill: {},
        compactions: [],
        piMessages: [],
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

    expect(continued).toBe(false);
    expect(executeAgentRunMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Stored Slack actor missing for continuation",
    });
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0010",
          text: expect.stringContaining(
            "I ran into an internal error while processing that.",
          ),
        }),
      }),
    ]);
  });

  it("recovers the resume actor from the durable conversation record", async () => {
    // Issue #727 recovery path: older session records were persisted without
    // a actor; the durable conversation work record still carries the
    // matching identity, so the resume completes instead of failing.
    const conversationId = "slack:C123:1712345.0011";
    const sessionId = "turn_msg_11";
    const sessionRecord =
      await turnSessionStoreModule.upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: 2,
        state: "awaiting_resume",
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
        backfill: {},
        compactions: [],
        piMessages: [],
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
        destination: SLACK_DESTINATION,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${sessionId}:`,
        ),
      },
    ]);
  });

  it("resumes a lease-expired running session from its latest durable boundary", async () => {
    // Process death between generation and the final post leaves a running
    // record at its last durable safe boundary; queue redelivery must produce
    // exactly one visible reply and only then a delivered/completed session.
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn_msg_8";
    executeAgentRunMock.mockResolvedValueOnce(
      completedAgentRun({
        text: "Final resumed answer",
        piMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Final resumed answer" }],
            timestamp: 2,
          },
        ] as any,
        diagnostics: makeDiagnostics(),
      }),
    );
    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      state: "running",
      destination: SLACK_DESTINATION,
      source: slackSource("1712345.0008"),
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
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

    const resumed = await requestDeadlineModule.runWithTurnRequestDeadline(() =>
      agentContinueRunnerModule.resumeAwaitingSlackContinuation(
        conversationId,
        {
          agentRunner: { run: executeAgentRunMock },
          scheduleAgentContinue: (request) =>
            agentContinueServiceModule.scheduleAgentContinue(request, {
              queue,
            }),
        },
      ),
    );

    expect(resumed).toBe(true);
    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ messageText: "resume this request" }),
        routing: expect.objectContaining({
          destination: SLACK_DESTINATION,
        }),
      }),
    );
    // Exactly one visible reply for the interrupted request.
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0008",
          text: "Final resumed answer",
        }),
      }),
    ]);
    // Completion is committed only after Slack accepted the reply.
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "completed",
    });
  });

  it("terminally fails a stranded running session with no resumable boundary", async () => {
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn_msg_9";
    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      state: "running",
      destination: SLACK_DESTINATION,
      source: slackSource("1712345.0009"),
      // Only uncommitted trailing assistant output survived the crash: there
      // is no continuable user/toolResult boundary to resume from.
      piMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "partial output" }],
          api: "responses",
          provider: "openai",
          model: "gpt-5.3",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
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
            id: "msg.9",
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

    const resumed = await requestDeadlineModule.runWithTurnRequestDeadline(() =>
      agentContinueRunnerModule.resumeAwaitingSlackContinuation(
        conversationId,
        {
          agentRunner: { run: executeAgentRunMock },
        },
      ),
    );

    expect(resumed).toBe(false);
    expect(executeAgentRunMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: expect.stringContaining("no resumable boundary"),
    });
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0009",
          text: expect.stringContaining(
            "I ran into an internal error while processing that.",
          ),
        }),
      }),
    ]);
  });

  it("posts resumed replies through the shared delivery path", async () => {
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
      const sendMessage = tools.sendMessage;
      if (!sendMessage?.execute) {
        throw new Error("sendMessage tool missing from resumed Slack context");
      }
      await sendMessage.execute(
        {
          text: "Sharing the resumed image.",
          files: [{ path: "/tmp/resumed-image.png" }],
        },
        {} as never,
      );

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
      initial_comment: "Sharing the resumed image.",
    });
    expect(slackApiOutbox.calls("files.completeUploadExternal")).toHaveLength(
      1,
    );

    const persisted =
      await threadStateModule.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      messages?: Array<{ role?: string; text?: string }>;
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer.",
    });
  });
});
