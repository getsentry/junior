import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchRecord,
  getDispatchTurnId,
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
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { recordTurnSummary } from "@/chat/task-execution/turn-cursor";
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
        source: { kind: "scheduled_task" },
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

  it.each(["awaiting_resume", "running"] as const)(
    "resumes durable %s work instead of starting another turn",
    async (sessionState) => {
      const dispatch = await createDispatch(`resume-${sessionState}`);
      const conversationId = getDispatchConversationId(dispatch);
      const turnId = getDispatchTurnId(dispatch.id);
      if (sessionState === "awaiting_resume") {
        await markDispatchAwaitingResume(dispatch.id);
      } else {
        await markDispatchRunning(dispatch.id);
      }
      await recordTurnSummary({
        actor: dispatch.actor,
        conversationId,
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        dispatchId: dispatch.id,
        turnId,
        sliceId: 2,
        source: dispatch.source,
        state: sessionState === "awaiting_resume" ? "paused" : "running",
        surface: "api",
      });
      const runTurn = vi.fn();
      const resumeTurn = vi.fn(async () => {
        await recordTurnSummary({
          actor: dispatch.actor,
          conversationId,
          destination: dispatch.destination,
          destinationVisibility: dispatch.destinationVisibility,
          dispatchId: dispatch.id,
          dispatchOutcome: "completed",
          turnId,
          sliceId: 2,
          source: dispatch.source,
          state: "completed",
          surface: "api",
        });
      });
      const worker = createAgentDispatchConversationWorker({
        resumeTurn,
        runTurn,
      });
      const { ack, context } = createContext(dispatch);

      await expect(worker(context, dispatch.id)).resolves.toEqual({
        status: "completed",
      });

      expect(runTurn).not.toHaveBeenCalled();
      expect(resumeTurn).toHaveBeenCalledOnce();
      expect(ack).toHaveBeenCalledOnce();
      await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
        status: "completed",
      });
    },
  );

  it("uses a delivery receipt without starting or resuming a turn", async () => {
    const dispatch = await createDispatch("delivery-receipt-fence");
    await recordTurnSummary({
      actor: dispatch.actor,
      conversationId: getDispatchConversationId(dispatch),
      destination: dispatch.destination,
      destinationVisibility: dispatch.destinationVisibility,
      dispatchId: dispatch.id,
      resultMessageId: "1700000000.000012",
      turnId: getDispatchTurnId(dispatch.id),
      sliceId: 1,
      source: dispatch.source,
      state: "running",
      surface: "api",
    });
    const runTurn = vi.fn();
    const resumeTurn = vi.fn();
    const worker = createAgentDispatchConversationWorker({
      resumeTurn,
      runTurn,
    });
    const { ack, context } = createContext(dispatch);

    await expect(worker(context, dispatch.id)).resolves.toEqual({
      status: "completed",
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(resumeTurn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000012",
      status: "completed",
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
});
