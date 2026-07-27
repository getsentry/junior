import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  createOrGetDispatch,
  getDispatchRecord,
  getDispatchStorageKey,
  markDispatchAwaitingResume,
  markDispatchBlocked,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchRunning,
} from "@/chat/agent-dispatch/store";
import {
  buildAgentDispatchInboundMessage,
  createAgentDispatchConversationWorker,
} from "@/chat/agent-dispatch/work";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const destination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

async function createDispatch(idempotencyKey: string) {
  return (
    await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination,
        destinationVisibility: "private",
        idempotencyKey,
        input: "Post the scheduled digest.",
        source: createSlackSource({
          ...destination,
          type: "priv",
        }),
      },
      plugin: "scheduler",
    })
  ).record;
}

function createContext(
  dispatch: Awaited<ReturnType<typeof createDispatch>>,
  overrides: Partial<ConversationWorkerContext> = {},
) {
  const ack = vi.fn(async () => {});
  const message = buildAgentDispatchInboundMessage(dispatch);
  const context: ConversationWorkerContext = {
    attempt: {
      ack,
      conversationId: message.conversationId,
      destination,
      drain: vi.fn(async () => []),
      isFinalAttempt: false,
      messages: [message],
    },
    checkIn: vi.fn(async () => true),
    conversationId: message.conversationId,
    destination,
    shouldYield: () => false,
    ...overrides,
  };
  return { ack, context };
}

describe("agent dispatch worker contract", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "conversation",
      overrides: { conversationId: "agent-dispatch:other" },
    },
    {
      label: "destination",
      overrides: {
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C999",
        },
      },
    },
  ])("rejects a mismatched $label lease", async ({ overrides }) => {
    const dispatch = await createDispatch(
      `authority-${overrides.conversationId ?? "destination"}`,
    );
    const runTurn = vi.fn();
    const worker = createAgentDispatchConversationWorker({
      resumeTurn: vi.fn(),
      runTurn,
    });
    const { context } = createContext(dispatch, overrides);

    await expect(worker(context, dispatch.id)).rejects.toThrow(
      /belongs to|destination does not match/,
    );
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("retries when the runtime returns without a durable outcome", async () => {
    const dispatch = await createDispatch("missing-outcome");
    const runTurn = vi.fn(async () => ({}));
    const worker = createAgentDispatchConversationWorker({
      resumeTurn: vi.fn(),
      runTurn,
    });
    const { ack, context } = createContext(dispatch);

    await expect(worker(context, dispatch.id)).rejects.toThrow(
      "returned without a durable outcome",
    );
    expect(ack).not.toHaveBeenCalled();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "running",
    });
  });

  it.each(["blocked", "completed", "failed"] as const)(
    "preserves a terminal %s projection against stale transitions",
    async (terminalStatus) => {
      const dispatch = await createDispatch(`terminal-${terminalStatus}`);
      if (terminalStatus === "blocked") {
        await markDispatchBlocked(dispatch.id, "Authorization required");
      } else if (terminalStatus === "completed") {
        await markDispatchCompleted(dispatch.id, "1700000000.000010");
      } else {
        await markDispatchFailed(dispatch.id, "Provider failed");
      }
      const terminalRecord = await getDispatchRecord(dispatch.id);

      await markDispatchRunning(dispatch.id);
      await markDispatchAwaitingResume(dispatch.id);
      await markDispatchBlocked(dispatch.id, "Stale blocked projection");
      await markDispatchCompleted(dispatch.id, "1700000000.000011");
      await markDispatchFailed(dispatch.id, "Stale failed projection");

      await expect(getDispatchRecord(dispatch.id)).resolves.toEqual(
        terminalRecord,
      );
    },
  );

  it("does not execute when a terminal projection wins the running claim", async () => {
    const dispatch = await createDispatch("terminal-claim-race");
    const state = getStateAdapter();
    await state.connect();
    const storageKey = getDispatchStorageKey(dispatch.id);
    const originalGet = state.get.bind(state);
    let dispatchReads = 0;
    state.get = (async (key: string) => {
      const value = await originalGet(key);
      if (
        key === storageKey &&
        dispatchReads++ === 0 &&
        value &&
        typeof value === "object"
      ) {
        await state.set(
          storageKey,
          { ...(value as Record<string, unknown>), status: "completed" },
          JUNIOR_THREAD_STATE_TTL_MS,
        );
      }
      return value;
    }) as typeof state.get;
    const runTurn = vi.fn();
    const resumeTurn = vi.fn();
    const worker = createAgentDispatchConversationWorker({
      resumeTurn,
      runTurn,
    });
    const { ack, context } = createContext(dispatch);

    try {
      await expect(worker(context, dispatch.id)).resolves.toEqual({
        status: "completed",
      });
    } finally {
      state.get = originalGet;
    }

    expect(runTurn).not.toHaveBeenCalled();
    expect(resumeTurn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "completed",
    });
  });
});
