import { randomUUID } from "node:crypto";
import {
  createLocalSource,
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { PluginTaskQueueMessage } from "@/chat/plugins/task-message";

const ORIGINAL_ENV = { ...process.env };
const conversationId = "local:test:plugin-tasks";
const sessionId = "task-session-1";
const destination = {
  platform: "local",
  conversationId,
} as const;

class PluginTaskQueueTestAdapter {
  #messages: PluginTaskQueueMessage[] = [];

  async send(message: PluginTaskQueueMessage): Promise<void> {
    this.#messages.push(message);
  }

  queuedMessages(): PluginTaskQueueMessage[] {
    return [...this.#messages];
  }
}

async function recordCompletedSession(args: {
  conversationId: string;
  sessionId: string;
}): Promise<void> {
  const { upsertAgentTurnSessionRecord } =
    await import("@/chat/state/turn-session");
  await upsertAgentTurnSessionRecord({
    conversationId: args.conversationId,
    destination: {
      ...destination,
      conversationId: args.conversationId,
    },
    actor: {
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    },
    piMessages: [
      {
        role: "user",
        content: "Run a completed session task.",
      },
      {
        role: "assistant",
        content: "Done.",
      },
    ] as PiMessage[],
    sessionId: args.sessionId,
    sliceId: 1,
    source: createLocalSource(args.conversationId),
    state: "completed",
    surface: "internal",
  });
}

beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
  };
  vi.resetModules();
});

afterEach(async () => {
  const { setPlugins } = await import("@/chat/plugins/agent-hooks");
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  setPlugins([]);
  await disconnectStateAdapter();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe("plugin background tasks", () => {
  it("schedules and runs session.completed tasks from durable session records", async () => {
    const runId = randomUUID();
    const runConversationId = `${conversationId}-${runId}`;
    const runSessionId = `${sessionId}:${runId}`;
    const runDestination = {
      ...destination,
      conversationId: runConversationId,
    };
    const runSource = createLocalSource(runConversationId);
    const queue = new PluginTaskQueueTestAdapter();
    const loadedRuns: PluginRunContext[] = [];
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-demo",
          displayName: "Task Demo",
          description: "Task demo",
        },
        tasks: {
          processSession: {
            async run(ctx) {
              loadedRuns.push(await ctx.run.load());
            },
          },
        },
      }),
    ]);
    await upsertAgentTurnSessionRecord({
      conversationId: runConversationId,
      destination: runDestination,
      piMessages: [
        {
          role: "user",
          content: "Remember that stale prior turn data must not leak.",
        },
        {
          role: "toolResult",
          toolName: "createMemory",
          isError: false,
          content: "saved prior memory",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>\nRelevant memories must not leak.\n</runtime-turn-context>",
            },
            {
              type: "text",
              text: "I prefer pull request summaries with test evidence.",
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "searchDocs",
          isError: false,
          output: "Incident runbooks live in Notion.",
        },
        {
          role: "assistant",
          content: "Understood.",
        },
      ] as PiMessage[],
      sessionId: runSessionId,
      sliceId: 1,
      source: runSource,
      actor: {
        fullName: "Local CLI",
        platform: "local",
        userId: "local-cli",
        userName: "local",
      },
      state: "completed",
      surface: "internal",
      turnStartMessageIndex: 2,
    });
    expect(
      await getAgentTurnSessionRecord(runConversationId, runSessionId),
    ).toBeDefined();

    await scheduleSessionCompletedPluginTasks(
      { conversationId: runConversationId, sessionId: runSessionId },
      { send: (message) => queue.send(message) },
    );
    const messages = queue.queuedMessages();
    expect(messages).toHaveLength(1);

    await processPluginTask(messages[0]!);

    expect(loadedRuns).toEqual([
      expect.objectContaining({
        conversationId: runConversationId,
        destination: runDestination,
        runId: runSessionId,
        transcript: [
          {
            type: "message",
            role: "user",
            text: "I prefer pull request summaries with test evidence.",
          },
          {
            type: "toolResult",
            toolName: "searchDocs",
            isError: false,
            text: "Incident runbooks live in Notion.",
          },
          {
            type: "message",
            role: "assistant",
            text: "Understood.",
          },
        ],
        actor: {
          fullName: "Local CLI",
          platform: "local",
          userId: "local-cli",
          userName: "local",
        },
        source: runSource,
      }),
    ]);
  });

  it("lets task failures bubble to the queue retry boundary", async () => {
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const queue = new PluginTaskQueueTestAdapter();
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-failure-demo",
          displayName: "Task Failure Demo",
          description: "Task failure demo",
        },
        tasks: {
          processSession: {
            run() {
              throw new Error("task failure marker");
            },
          },
        },
      }),
    ]);
    await recordCompletedSession({
      conversationId: "local:test:failure",
      sessionId: "turn-1",
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:failure", sessionId: "turn-1" },
      { send: (message) => queue.send(message) },
    );
    const [message] = queue.queuedMessages();

    await expect(processPluginTask(message!)).rejects.toThrow(
      "task failure marker",
    );
  });

  it("attempts every plugin task send when one enqueue fails", async () => {
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const attempted: PluginTaskQueueMessage[] = [];
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-send-failure-demo",
          displayName: "Task Send Failure Demo",
          description: "Task send failure demo",
        },
        tasks: {
          processSession: {
            run() {},
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "task-send-success-demo",
          displayName: "Task Send Success Demo",
          description: "Task send success demo",
        },
        tasks: {
          processSession: {
            run() {},
          },
        },
      }),
    ]);

    await recordCompletedSession({
      conversationId: "local:test:send-failure",
      sessionId: "turn-1",
    });

    await expect(
      scheduleSessionCompletedPluginTasks(
        { conversationId: "local:test:send-failure", sessionId: "turn-1" },
        {
          async send(message) {
            attempted.push(message);
            if (message.plugin === "task-send-failure-demo") {
              throw new Error("enqueue failure marker");
            }
          },
        },
      ),
    ).rejects.toThrow("enqueue failure marker");

    expect(attempted.map((message) => message.plugin)).toEqual([
      "task-send-failure-demo",
      "task-send-success-demo",
    ]);
  });

  it("rejects task messages for unregistered plugin tasks", async () => {
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const queue = new PluginTaskQueueTestAdapter();
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-registration-demo",
          displayName: "Task Registration Demo",
          description: "Task registration demo",
        },
        tasks: {
          processSession: {
            run() {},
          },
        },
      }),
    ]);
    await recordCompletedSession({
      conversationId: "local:test:missing",
      sessionId: "turn-1",
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:missing", sessionId: "turn-1" },
      { send: (message) => queue.send(message) },
    );
    const [message] = queue.queuedMessages();
    setPlugins([]);

    await expect(processPluginTask(message!)).rejects.toThrow(
      'Plugin task "task-registration-demo.processSession" is not registered',
    );
  });
});
