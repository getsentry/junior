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
import type { AgentRun } from "@/chat/agent/types";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { deliverAssistantMessagesForTest } from "../fixtures/agent-runner";

const ORIGINAL_ENV = { ...process.env };

function slackSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,
    visibility: "private",
  });
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

function createToolContext(
  request: AgentRun,
  workspace: SandboxWorkspace,
): ToolRuntimeContext {
  if (
    request.source.platform !== "slack" ||
    request.destination.platform !== "slack"
  ) {
    throw new Error("test requires Slack tool context");
  }

  return {
    configuration: request.environment?.configuration,
    conversationId: request.conversationId,
    destination: request.destination,
    egress: {} as ToolRuntimeContext["egress"],
    actor: request.actor?.platform === "slack" ? request.actor : undefined,
    workspace,
    source: request.source,
    surface: request.surface,
    userText: request.instruction.text,
  };
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type PausedTurnModule = typeof import("@/chat/task-execution/paused-turn");
type RequestDeadlineModule = typeof import("@/chat/runtime/request-deadline");
type TurnSessionStoreModule =
  typeof import("@/chat/task-execution/turn-cursor");
type TurnWakeModule = typeof import("@/chat/task-execution/turn-wake");

let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let pausedTurnModule: PausedTurnModule;
let requestDeadlineModule: RequestDeadlineModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let turnWakeModule: TurnWakeModule;
let queue: ConversationWorkQueueTestAdapter;
let agentRunner: AgentRunner;

function continueAgentRun(args: {
  conversationId: string;
  sessionId: string;
  expectedVersion: number;
}): Promise<boolean> {
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
          turnWakeModule.wakePausedTurn(request, { queue }),
      },
    ),
  );
}

describe("paused turn Slack file delivery", () => {
  beforeEach(async () => {
    queue = createConversationWorkQueueTestAdapter();
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

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("posts resumed replies through the shared delivery path", async () => {
    const conversationId = "slack:C123:1712345.0003";
    const sessionId = "turn_msg_3";
    const sessionRecord = await turnSessionStoreModule.upsertTurnRecord({
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

    agentRunner = {
      run: async (request) => {
        const tools = createTools(
          [],
          {},
          createToolContext(
            request,
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
          { files: [{ path: "/tmp/resumed-image.png" }] },
          {} as never,
        );

        await deliverAssistantMessagesForTest(request, [
          { text: "Final resumed answer." },
        ]);
        return completedAgentRun({
          text: "Final resumed answer.",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true,
          },
        });
      },
    };

    await threadStateModule.persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.3",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: { userId: "U123", userName: "alice" },
          },
        ],
        processing: { activeTurnId: sessionId },
        vision: { byFileId: {} },
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
