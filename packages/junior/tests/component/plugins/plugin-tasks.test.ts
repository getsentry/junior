import { randomUUID } from "node:crypto";
import {
  createLocalSource,
  defineJuniorPlugin,
  type PluginSessionContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { PluginTaskQueue } from "@/chat/plugins/task-queue";

const ORIGINAL_ENV = { ...process.env };
const conversationId = "local:test:plugin-tasks";
const sessionId = "task-session-1";
const destination = {
  platform: "local",
  conversationId,
} as const;

class PluginTaskQueueTestAdapter implements PluginTaskQueue {
  #messages: Parameters<PluginTaskQueue["send"]>[0][] = [];

  async send(message: Parameters<PluginTaskQueue["send"]>[0]): Promise<void> {
    this.#messages.push(message);
  }

  queuedTaskIds(): string[] {
    return this.#messages.map((message) => message.id);
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
    const loadedSessions: PluginSessionContext[] = [];
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
              expect(ctx.params).toEqual({
                conversationId: runConversationId,
                sessionId: runSessionId,
              });
              loadedSessions.push(await ctx.session.load());
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
          role: "assistant",
          content: "Understood.",
        },
      ] as PiMessage[],
      sessionId: runSessionId,
      sliceId: 1,
      source: runSource,
      state: "completed",
      surface: "internal",
      turnStartMessageIndex: 2,
    });
    expect(
      await getAgentTurnSessionRecord(runConversationId, runSessionId),
    ).toBeDefined();

    const records = await scheduleSessionCompletedPluginTasks(
      { conversationId: runConversationId, sessionId: runSessionId },
      { queue },
    );
    expect(records).toHaveLength(1);
    expect(queue.queuedTaskIds()).toEqual([records[0]!.id]);

    await processPluginTask(records[0]!.message);

    expect(loadedSessions).toEqual([
      expect.objectContaining({
        conversationId: runConversationId,
        destination: runDestination,
        messages: [
          {
            role: "user",
            text: "I prefer pull request summaries with test evidence.",
          },
          {
            role: "assistant",
            text: "Understood.",
          },
        ],
        sessionId: runSessionId,
        source: runSource,
        toolCalls: [],
      }),
    ]);
    expect(loadedSessions[0]).not.toHaveProperty("requester");
  });

  it("uses stable ids for duplicate scheduling", async () => {
    const queue = new PluginTaskQueueTestAdapter();
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-id-demo",
          displayName: "Task Id Demo",
          description: "Task id demo",
        },
        tasks: {
          processSession: {
            run() {},
          },
        },
      }),
    ]);
    await recordCompletedSession({
      conversationId: "local:test:duplicate",
      sessionId: "turn-1",
    });

    const first = await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:duplicate", sessionId: "turn-1" },
      { queue },
    );
    const second = await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:duplicate", sessionId: "turn-1" },
      { queue },
    );

    expect(first[0]!.id).toBe(second[0]!.id);
    expect(queue.queuedTaskIds()).toEqual([first[0]!.id, second[0]!.id]);
  });

  it("rejects tampered signed task queue messages", async () => {
    process.env.JUNIOR_SECRET = "plugin-task-test-secret";
    const {
      createPluginTaskQueueMessage,
      signPluginTaskQueueMessage,
      verifyPluginTaskQueueMessage,
    } = await import("@/chat/plugins/task-queue-signing");
    const message = createPluginTaskQueueMessage({
      name: "processSession",
      params: {
        conversationId: "local:test:signed",
        sessionId: "turn-1",
      },
      plugin: "task-signing-demo",
      trigger: "session.completed",
    });
    const signed = signPluginTaskQueueMessage(message, 1000);

    expect(verifyPluginTaskQueueMessage(signed, 1000)).toEqual({
      status: "verified",
      message,
    });
    expect(
      verifyPluginTaskQueueMessage(
        {
          ...signed,
          signature: "tampered",
        },
        1000,
      ),
    ).toEqual({
      status: "rejected",
      reason: "signature_mismatch",
    });
  });

  it("lets task failures bubble to the queue retry boundary", async () => {
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
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

    const records = await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:failure", sessionId: "turn-1" },
      { enqueue: false },
    );

    await expect(processPluginTask(records[0]!.message)).rejects.toThrow(
      "task failure marker",
    );
  });

  it("rejects task messages for unregistered plugin tasks", async () => {
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
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

    const records = await scheduleSessionCompletedPluginTasks(
      { conversationId: "local:test:missing", sessionId: "turn-1" },
      { enqueue: false },
    );
    setPlugins([]);

    await expect(processPluginTask(records[0]!.message)).rejects.toThrow(
      'Plugin task "task-registration-demo.processSession" is not registered',
    );
  });
});
