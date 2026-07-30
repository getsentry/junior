import { randomUUID } from "node:crypto";
import {
  createLocalSource,
  defineConversationEvent,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const ORIGINAL_ENV = { ...process.env };

function completedMessages(): PiMessage[] {
  return [
    {
      role: "user",
      content: "Run the registered plugin event task.",
      timestamp: 1,
    },
    {
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
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
      },
      stopReason: "stop",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: 2,
    },
  ];
}

async function recordCompletedSession(args: {
  conversationId: string;
  sessionId: string;
}): Promise<void> {
  const { upsertAgentTurnSessionRecord } =
    await import("@/chat/state/turn-session");
  await upsertAgentTurnSessionRecord({
    actor: {
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    },
    conversationId: args.conversationId,
    destination: {
      platform: "local",
      conversationId: args.conversationId,
    },
    modelId: "test/model",
    piMessages: completedMessages(),
    sessionId: args.sessionId,
    sliceId: 1,
    source: createLocalSource(args.conversationId),
    state: "completed",
    surface: "internal",
  });
}

beforeEach(() => {
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

describe("plugin conversation events", () => {
  it("binds task events to the plugin and deduplicates task redelivery", async () => {
    const runId = randomUUID();
    const conversationId = `local:test:plugin-events-${runId}`;
    const sessionId = `plugin-event-session:${runId}`;
    const completedEvent = defineConversationEvent({
      name: "session_processed",
      version: 1,
      schema: z.object({ summary: z.string() }).strict(),
      renderEvent(event) {
        return { title: "Session processed", preview: event.summary };
      },
    });
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { getConversationEventStore } = await import("@/chat/db");
    const { processPluginTask } = await import("@/chat/plugins/task-runner");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-event-demo",
          displayName: "Task Event Demo",
          description: "Task event demo",
        },
        conversationEvents: [completedEvent],
        tasks: {
          processSession: {
            async run(ctx) {
              await ctx.events.emit(
                completedEvent({ summary: "Background task finished." }),
              );
            },
          },
        },
      }),
    ]);
    await recordCompletedSession({ conversationId, sessionId });
    const message = {
      name: "processSession",
      params: { conversationId, sessionId },
      plugin: "task-event-demo",
    };

    await processPluginTask(message);
    await processPluginTask(message);

    const events =
      await getConversationEventStore().loadHistory(conversationId);
    expect(
      events.filter((event) => event.data.type === "plugin_event"),
    ).toEqual([
      expect.objectContaining({
        data: {
          type: "plugin_event",
          namespace: "task-event-demo",
          name: "session_processed",
          version: 1,
          turnId: sessionId,
          content: { summary: "Background task finished." },
        },
      }),
    ]);
  });
});
