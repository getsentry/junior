import { randomUUID } from "node:crypto";
import {
  createLocalSource,
  createSlackSource,
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { PluginTaskQueueMessage } from "@/chat/plugins/task-message";
import type { ConversationMessage } from "@/chat/state/conversation";

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

/**
 * Seed the durable visible transcript through the SQL-backed message store, the
 * authority the task runner now hydrates its public-Slack context from. The
 * legacy `conversation.messages` thread-state field is no longer persisted.
 */
async function seedVisibleMessages(
  conversationId: string,
  messages: ConversationMessage[],
): Promise<void> {
  const { coerceThreadConversationState } =
    await import("@/chat/state/conversation");
  const { persistConversationMessages } =
    await import("@/chat/conversations/visible-messages");
  const conversation = coerceThreadConversationState({});
  conversation.messages.push(...messages);
  await persistConversationMessages({ conversation, conversationId });
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
  vi.useRealTimers();
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
        // Exposed from the full-run provenance: the single instruction author.
        actors: [
          {
            fullName: "Local CLI",
            platform: "local",
            userId: "local-cli",
            userName: "local",
          },
        ],
        transcript: [
          {
            type: "message",
            role: "user",
            text: "I prefer pull request summaries with test evidence.",
            provenance: {
              authority: "instruction",
              actor: {
                fullName: "Local CLI",
                platform: "local",
                userId: "local-cli",
                userName: "local",
              },
            },
            isRunActor: true,
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

  it("exposes only the instruction content when a user turn embeds another user's thread-transcript block", async () => {
    const runId = randomUUID();
    const runConversationId = `${conversationId}-embedded-${runId}`;
    const runSessionId = `${sessionId}:embedded:${runId}`;
    const runSource = createLocalSource(runConversationId);
    const queue = new PluginTaskQueueTestAdapter();
    const loadedRuns: PluginRunContext[] = [];
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-embedded-demo",
          displayName: "Task Embedded Demo",
          description: "Task embedded demo",
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

    // The live runtime embeds prior-thread context (here Bob's verbatim
    // message) in the same user-turn text that carries the current
    // instruction. The projection must never surface that embedded text on an
    // instruction-authority entry.
    const embeddedUserText = [
      "<thread-transcript>",
      '  <message index="1" role="user" author="bob" actor_id="U_BOB">',
      "  I prefer really short, emoji-heavy summaries when these get written up.",
      "  </message>",
      "</thread-transcript>",
      "",
      '<current-instruction author_id="local-cli">',
      "What are the takeaways so far?",
      "</current-instruction>",
    ].join("\n");

    await upsertAgentTurnSessionRecord({
      conversationId: runConversationId,
      destination: { ...destination, conversationId: runConversationId },
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: embeddedUserText }],
        },
        { role: "assistant", content: "Here are the takeaways." },
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
      turnStartMessageIndex: 0,
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: runConversationId, sessionId: runSessionId },
      { send: (message) => queue.send(message) },
    );
    await processPluginTask(queue.queuedMessages()[0]!);

    const transcript = loadedRuns[0]!.transcript;
    const instructionEntries = transcript.filter(
      (entry) =>
        entry.type === "message" &&
        entry.role === "user" &&
        entry.provenance?.authority === "instruction",
    );
    expect(instructionEntries).toEqual([
      {
        type: "message",
        role: "user",
        text: "What are the takeaways so far?",
        provenance: {
          authority: "instruction",
          actor: {
            fullName: "Local CLI",
            platform: "local",
            userId: "local-cli",
            userName: "local",
          },
        },
        isRunActor: true,
      },
    ]);
    // Bob's embedded preference must not appear in ANY instruction-authority
    // entry, so a passive consumer cannot cite Alice's instruction while
    // reading Bob's text out of the same block.
    for (const entry of instructionEntries) {
      expect(entry.type === "message" && entry.text).not.toMatch(/emoji/i);
      expect(entry.type === "message" && entry.text).not.toMatch(
        /thread-transcript/,
      );
    }
  });

  it("projects prior public Slack thread messages as context-authority transcript entries", async () => {
    const teamId = "T123";
    const channelId = "C123";
    const slackConversationId = "slack:C123:1700000000.000000";
    const slackSessionId = "slack-session-context";
    const alice = {
      platform: "slack",
      teamId,
      userId: "U_ALICE",
      userName: "alice",
    } as const;
    const source = createSlackSource({
      teamId,
      channelId,
      type: "pub",
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000000",
    });
    const loadedRuns: PluginRunContext[] = [];
    const queue = new PluginTaskQueueTestAdapter();
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-context-demo",
          displayName: "Task Context Demo",
          description: "Task context demo",
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

    await seedVisibleMessages(slackConversationId, [
      {
        id: "m-bob",
        role: "user",
        text: "Bob's prior note: incident runbooks live in Notion.",
        createdAtMs: 1,
        author: { userId: "U_BOB", userName: "bob" },
      },
      {
        id: "m-alice",
        role: "user",
        text: "Deploy the release now.",
        createdAtMs: 2,
        author: { userId: "U_ALICE", userName: "alice" },
      },
    ]);

    await upsertAgentTurnSessionRecord({
      conversationId: slackConversationId,
      destination: { platform: "slack", teamId, channelId },
      piMessages: [
        { role: "user", content: "Deploy the release now." },
        { role: "assistant", content: "On it." },
      ] as PiMessage[],
      sessionId: slackSessionId,
      sliceId: 1,
      source,
      actor: alice,
      state: "completed",
      surface: "slack",
      turnStartMessageIndex: 0,
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: slackConversationId, sessionId: slackSessionId },
      { send: (message) => queue.send(message) },
    );
    await processPluginTask(queue.queuedMessages()[0]!);

    const transcript = loadedRuns[0]!.transcript;
    expect(transcript).toContainEqual({
      type: "message",
      role: "user",
      text: "Bob's prior note: incident runbooks live in Notion.",
      provenance: {
        authority: "context",
        actor: { platform: "slack", teamId, userId: "U_BOB", userName: "bob" },
      },
      isRunActor: false,
    });
    // The active run-actor instruction appears once; the context projection is
    // deduplicated against messages already present in the run transcript.
    expect(
      transcript.filter(
        (entry) =>
          entry.type === "message" && entry.text === "Deploy the release now.",
      ),
    ).toEqual([
      {
        type: "message",
        role: "user",
        text: "Deploy the release now.",
        provenance: { authority: "instruction", actor: alice },
        isRunActor: true,
      },
    ]);
  });

  it("bounds public Slack context transcript entries to the completed run window", async () => {
    const teamId = "T123";
    const channelId = "C123";
    const completionMs = 1_700_000_001_000;
    const slackConversationId = "slack:C123:1700000000.000200";
    const slackSessionId = "slack-session-context-window";
    const alice = {
      platform: "slack",
      teamId,
      userId: "U_ALICE",
      userName: "alice",
    } as const;
    const source = createSlackSource({
      teamId,
      channelId,
      type: "pub",
      messageTs: "1700000000.950000",
      threadTs: "1700000000.000200",
    });
    const loadedRuns: PluginRunContext[] = [];
    const queue = new PluginTaskQueueTestAdapter();
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-context-window-demo",
          displayName: "Task Context Window Demo",
          description: "Task context window demo",
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

    vi.useFakeTimers({ now: completionMs });
    await upsertAgentTurnSessionRecord({
      conversationId: slackConversationId,
      destination: { platform: "slack", teamId, channelId },
      piMessages: [
        { role: "user", content: "Summarize the thread context." },
        { role: "assistant", content: "On it." },
      ] as PiMessage[],
      sessionId: slackSessionId,
      sliceId: 1,
      source,
      actor: alice,
      state: "completed",
      surface: "slack",
      turnStartMessageIndex: 0,
    });
    expect(
      await getAgentTurnSessionRecord(slackConversationId, slackSessionId),
    ).toMatchObject({ updatedAtMs: completionMs });

    vi.setSystemTime(completionMs + 10_000);
    await seedVisibleMessages(slackConversationId, [
      {
        id: "m-before-completion",
        role: "user",
        text: "Before completion: staging smoke tests passed.",
        createdAtMs: completionMs - 500,
        meta: { slackTs: "1700000000.900000" },
        author: { userId: "U_BOB", userName: "bob" },
      },
      {
        id: "m-after-completion",
        role: "user",
        text: "After completion: cite this only in the next run.",
        createdAtMs: completionMs - 500,
        meta: { slackTs: "1700000001.100000" },
        author: { userId: "U_CAROL", userName: "carol" },
      },
    ]);

    await scheduleSessionCompletedPluginTasks(
      { conversationId: slackConversationId, sessionId: slackSessionId },
      { send: (message) => queue.send(message) },
    );
    await processPluginTask(queue.queuedMessages()[0]!);

    const transcript = loadedRuns[0]!.transcript;
    expect(transcript).toContainEqual({
      type: "message",
      role: "user",
      text: "Before completion: staging smoke tests passed.",
      provenance: {
        authority: "context",
        actor: { platform: "slack", teamId, userId: "U_BOB", userName: "bob" },
      },
      isRunActor: false,
    });
    expect(
      transcript.some(
        (entry) =>
          entry.type === "message" &&
          entry.text === "After completion: cite this only in the next run.",
      ),
    ).toBe(false);
  });

  it("loads actor-less legacy completed session records without run authority", async () => {
    const runId = randomUUID();
    const runConversationId = `${conversationId}-actorless-${runId}`;
    const runSessionId = `${sessionId}:actorless:${runId}`;
    const runSource = createLocalSource(runConversationId);
    const loadedRuns: PluginRunContext[] = [];
    const queue = new PluginTaskQueueTestAdapter();
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-actorless-demo",
          displayName: "Task Actorless Demo",
          description: "Task actorless demo",
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
      destination: { ...destination, conversationId: runConversationId },
      piMessages: [
        { role: "user", content: "Run a legacy system task." },
        { role: "assistant", content: "Done." },
      ] as PiMessage[],
      sessionId: runSessionId,
      sliceId: 1,
      source: runSource,
      state: "completed",
      surface: "internal",
      turnStartMessageIndex: 0,
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: runConversationId, sessionId: runSessionId },
      { send: (message) => queue.send(message) },
    );
    await processPluginTask(queue.queuedMessages()[0]!);

    expect(loadedRuns).toHaveLength(1);
    expect(loadedRuns[0]).not.toHaveProperty("actor");
    expect(loadedRuns[0]).toMatchObject({
      actors: [],
      conversationId: runConversationId,
      runId: runSessionId,
      transcript: [
        {
          type: "message",
          role: "user",
          text: "Run a legacy system task.",
          provenance: { authority: "context" },
          isRunActor: false,
        },
        {
          type: "message",
          role: "assistant",
          text: "Done.",
        },
      ],
    });
  });

  it("adds no context transcript entries for private Slack sources", async () => {
    const teamId = "T123";
    const channelId = "D123";
    const slackConversationId = "slack:D123:1700000000.000000";
    const slackSessionId = "slack-session-private";
    const alice = {
      platform: "slack",
      teamId,
      userId: "U_ALICE",
      userName: "alice",
    } as const;
    const source = createSlackSource({
      teamId,
      channelId,
      type: "priv",
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000000",
    });
    const loadedRuns: PluginRunContext[] = [];
    const queue = new PluginTaskQueueTestAdapter();
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { persistThreadStateById } =
      await import("@/chat/runtime/thread-state");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "task-private-demo",
          displayName: "Task Private Demo",
          description: "Task private demo",
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

    await persistThreadStateById(slackConversationId, {
      conversation: coerceThreadConversationState({
        conversation: {
          messages: [
            {
              id: "m-bob",
              role: "user",
              text: "Bob's private note stays out of the transcript.",
              createdAtMs: 1,
              author: { userId: "U_BOB", userName: "bob" },
            },
          ],
        },
      }),
    });

    await upsertAgentTurnSessionRecord({
      conversationId: slackConversationId,
      destination: { platform: "slack", teamId, channelId },
      piMessages: [
        { role: "user", content: "Handle this direct message." },
        { role: "assistant", content: "Sure." },
      ] as PiMessage[],
      sessionId: slackSessionId,
      sliceId: 1,
      source,
      actor: alice,
      state: "completed",
      surface: "slack",
      turnStartMessageIndex: 0,
    });

    await scheduleSessionCompletedPluginTasks(
      { conversationId: slackConversationId, sessionId: slackSessionId },
      { send: (message) => queue.send(message) },
    );
    await processPluginTask(queue.queuedMessages()[0]!);

    const transcript = loadedRuns[0]!.transcript;
    expect(
      transcript.some(
        (entry) =>
          entry.type === "message" && entry.provenance?.authority === "context",
      ),
    ).toBe(false);
    expect(
      transcript.some(
        (entry) =>
          entry.type === "message" &&
          entry.text === "Bob's private note stays out of the transcript.",
      ),
    ).toBe(false);
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
