import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@/core/model/client";
import type { EngineContext } from "@/core/engine-context";
import { findUnreadInputs } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC } from "@/core/turn/queue";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import { modelCalls, modelOverloaded } from "../fixtures/ai-emulator";
import type { LocalJuniorSqlFixture } from "../fixtures/sql";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";
import { createAssistantMessage } from "../fixtures/model-stream";
import {
  CONVERSATION_ID,
  LEASE_MS,
  MAX_ATTEMPTS,
  messageTurnId,
  prepareWith,
  sendTool,
  startTurnEngine,
  storedReply,
  userText,
  type TurnEngine,
} from "../fixtures/turn-engine";

// The end of a Turn through advanceTurn: what a failed Turn drops or hands
// on, and how a new Turn closes an earlier Turn's tool calls.

let harness: TurnHarness;
let engine: TurnEngine;
let fixture: LocalJuniorSqlFixture;
let turnId: string;

afterEach(() => {
  vi.restoreAllMocks();
});

async function readInputs(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
) {
  return executor
    .db()
    .select({
      id: juniorTurnInbox.id,
      turnId: juniorTurnInbox.turnId,
      idempotencyKey: juniorTurnInbox.idempotencyKey,
    })
    .from(juniorTurnInbox)
    .where(eq(juniorTurnInbox.conversationId, conversationId))
    .orderBy(juniorTurnInbox.createdAt);
}

/** The Turn of the Conversation that took the inputs of a Turn. */
async function readOtherTurn(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  ofTurnId: string,
) {
  const turns = await executor
    .db()
    .select({ id: juniorTurns.id, state: juniorTurns.state })
    .from(juniorTurns)
    .where(eq(juniorTurns.conversationId, conversationId));
  return turns.find((turn) => turn.id !== ofTurnId);
}

/** The error result that closes a tool call of an earlier Turn. */
function danglingResult(toolCallId: string, text: string) {
  return expect.objectContaining({
    role: "toolResult",
    toolCallId,
    isError: true,
    content: [{ type: "text", text }],
  });
}

// The real path: an input goes through scheduleInput, and the host's Turn
// step consumer runs each step from the queue.
describe("advanceTurn at the end of a Turn", () => {
  beforeEach(async () => {
    harness = await createTurnHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("hands on a failed Turn's late input on a redelivered message", async () => {
    const { conversationId, engineCtx } = harness;
    const sent = await harness.send({ text: "How many Turns?" });
    // A crash right after the fail commit: reconcileTurn never ran.
    await engineCtx.executor
      .db()
      .update(juniorTurns)
      .set({ state: "failed", endedAt: sql`now()` })
      .where(eq(juniorTurns.id, sent.turnId));

    await harness.runStep();

    await expect(modelCalls()).resolves.toEqual([]);
    const next = await readOtherTurn(engineCtx, conversationId, sent.turnId);
    expect(next).toMatchObject({ state: "queued" });
    await expect(readInputs(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ id: sent.inputId, turnId: next!.id }),
    ]);
    expect(
      harness.queue
        .pending(TURN_STEP_TOPIC)
        .filter((message) => messageTurnId(message.payload) === next!.id),
    ).toHaveLength(1);
  });
});

// These cases need a fault or a timing that no edge can give: an input that
// arrives while the model request runs, a `prepare` that throws, or tools.
describe("advanceTurn at the end of a Turn, with a test prepare", () => {
  beforeEach(async () => {
    engine = await startTurnEngine();
    ({ fixture, turnId } = engine);
  });

  afterEach(async () => {
    await engine.close();
  });

  it("drops the inputs a failed attempt claimed, and moves an input that came after it only once", async () => {
    const claimedId = await engine.addTestInput("How many Turns?");
    // Injected fault: the model provider is overloaded.
    const step = prepareWith([modelOverloaded()]);
    let lateId: string | undefined;

    await engine.advance({
      prepare: step.prepare,
      client: {
        complete: async (request, signal) => {
          lateId = await engine.addTestInput("And how many failed?");
          return step.client.complete(request, signal);
        },
      },
    });

    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    const next = await readOtherTurn(engine.engineCtx, CONVERSATION_ID, turnId);
    expect(next).toMatchObject({ state: "queued" });
    const inputs = [
      { id: claimedId, turnId, idempotencyKey: `slack-event:${claimedId}` },
      { id: lateId, turnId: next!.id, idempotencyKey: `slack-event:${lateId}` },
    ];
    await expect(
      readInputs(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual(inputs);
    expect(engine.sentStepMessages(next!.id)).toBe(1);

    // The new Turn's attempt claims the moved input, so its failure drops it.
    // Injected fault: the model provider is overloaded.
    await engine.advance(prepareWith([modelOverloaded()]), LEASE_MS, next!.id);

    await expect(
      readInputs(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual(inputs);
    await expect(
      fixture.sql.db().select({ id: juniorTurns.id }).from(juniorTurns),
    ).resolves.toHaveLength(2);
  });

  it("drops the inputs when every try of a step throws, and moves none", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    const failure = new Error("The system prompt could not be built");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(
        engine.advance({ prepare: () => Promise.reject(failure) }),
      ).rejects.toBe(failure);
    }

    await engine.advance(prepareWith([]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: "attempts_exhausted",
    });
    await expect(
      readOtherTurn(engine.engineCtx, CONVERSATION_ID, turnId),
    ).resolves.toBeUndefined();
    await expect(findUnreadInputs(engine.engineCtx, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId, attemptedAt: expect.any(Date) }),
    ]);
  });

  it("closes an earlier Turn's pending tool calls without running them, and the model sees the results", async () => {
    const executed: string[] = [];
    const tools = [
      sendTool(executed),
      { ...sendTool(executed), name: "lookup", replay: "safe" as const },
    ];
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({
      type: "toolCalls",
      calls: [
        { name: "send", arguments: {}, id: "call-1" },
        { name: "lookup", arguments: {}, id: "call-2" },
      ],
    });
    await engine.advance(prepareWith([reply]));
    // The Turn fails with its tool calls pending, and a new Turn starts.
    await fixture.sql
      .db()
      .update(juniorTurns)
      .set({ state: "failed", endedAt: sql`now()` })
      .where(eq(juniorTurns.id, turnId));
    const nextId = randomUUID();
    await fixture.sql.db().insert(juniorTurns).values({
      id: nextId,
      conversationId: CONVERSATION_ID,
      actorIdentityId: "identity:actor",
      state: "queued",
      priority: 0,
      source: "slack",
    });

    await engine.advance(prepareWith([], tools), LEASE_MS, nextId);

    expect(executed).toEqual([]);
    const closed = [
      danglingResult(
        "call-1",
        "The previous Turn ended before this call's result was saved. It may or may not have run. Check its effect before you call it again.",
      ),
      danglingResult(
        "call-2",
        "The previous Turn ended before this call returned, so there is no result. Call it again if you still need it.",
      ),
    ];
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      ...closed,
    ]);
    const step = prepareWith(
      [createAssistantMessage({ type: "text", text: "Checked." })],
      tools,
    );
    const requests: ModelRequest[] = [];

    await engine.advance(
      {
        ...step,
        client: {
          complete: (request, signal) => {
            requests.push(request);
            return step.client.complete(request, signal);
          },
        },
      },
      LEASE_MS,
      nextId,
    );

    expect(requests[0]!.context.messages).toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      ...closed,
    ]);
  });
});
