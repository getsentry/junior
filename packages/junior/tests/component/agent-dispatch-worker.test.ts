import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchRecord,
  getDispatchTurnId,
  transitionDispatch,
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
        source: { kind: "scheduled_automation" },
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
        await transitionDispatch(dispatch.id, { status: "awaiting_resume" });
      } else {
        await transitionDispatch(dispatch.id, { status: "running" });
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

  it.each([
    // A receipt saved before receipts stored their outcome.
    { dispatchOutcome: undefined, status: "completed" },
    { dispatchOutcome: "failed", status: "failed" },
  ] as const)(
    "uses a $status delivery receipt without starting or resuming a turn",
    async ({ dispatchOutcome, status }) => {
      const dispatch = await createDispatch(`delivery-receipt-${status}`);
      await recordTurnSummary({
        actor: dispatch.actor,
        conversationId: getDispatchConversationId(dispatch),
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        dispatchId: dispatch.id,
        ...(dispatchOutcome ? { dispatchOutcome } : undefined),
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
        status,
      });
    },
  );

  it.each(["blocked", "completed", "failed"] as const)(
    "preserves a terminal %s projection against stale transitions",
    async (terminalStatus) => {
      const dispatch = await createDispatch(`terminal-${terminalStatus}`);
      if (terminalStatus === "blocked") {
        await transitionDispatch(dispatch.id, {
          errorMessage: "Authorization required",
          status: "blocked",
        });
      } else if (terminalStatus === "completed") {
        await transitionDispatch(dispatch.id, {
          resultMessageTs: "1700000000.000010",
          status: "completed",
        });
      } else {
        await transitionDispatch(dispatch.id, {
          errorMessage: "Provider failed",
          status: "failed",
        });
      }
      const terminalRecord = await getDispatchRecord(dispatch.id);

      await transitionDispatch(dispatch.id, { status: "running" });
      await transitionDispatch(dispatch.id, { status: "awaiting_resume" });
      await transitionDispatch(dispatch.id, {
        errorMessage: "Stale blocked projection",
        status: "blocked",
      });
      await transitionDispatch(dispatch.id, {
        resultMessageTs: "1700000000.000011",
        status: "completed",
      });
      await transitionDispatch(dispatch.id, {
        errorMessage: "Stale failed projection",
        status: "failed",
      });

      await expect(getDispatchRecord(dispatch.id)).resolves.toEqual(
        terminalRecord,
      );
    },
  );
});
