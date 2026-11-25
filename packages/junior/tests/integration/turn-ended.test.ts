import { eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { EngineContext } from "@/core/engine-context";
import { fragment, type FragmentMessage, loader } from "@/core/prompt/layout";
import type { ToolDefinition } from "@/core/tool";
import { findUnreadInputs } from "@/core/turn/inbox";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import {
  modelOverloaded,
  replyRule,
  setModelReplies,
} from "../fixtures/ai-emulator";
import type { LocalJuniorSqlFixture } from "../fixtures/sql";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";
import { createAssistantMessage } from "../fixtures/model-stream";
import {
  CONVERSATION_ID,
  LEASE_MS,
  MAX_ATTEMPTS,
  stepWith,
  sendTool,
  startTurnEngine,
  storedReply,
  testInputs,
  promptForEveryTurn,
  testPrompt,
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
  /** Starts this test's harness, whose steps give the model `tools`. */
  async function startHarness(tools: ToolDefinition[] = []) {
    harness = await createTurnHarness({ tools });
    onTestFinished(() => harness.close());
  }

  it("closes an earlier Turn's pending tool calls without running them, and the model sees the results", async () => {
    const executed: string[] = [];
    await startHarness([
      sendTool(executed),
      { ...sendTool(executed), name: "lookup", replay: "safe" as const },
    ]);
    const { engineCtx } = harness;
    const reply = createAssistantMessage({
      type: "toolCalls",
      calls: [
        { name: "send", arguments: {}, id: "call-1" },
        { name: "lookup", arguments: {}, id: "call-2" },
      ],
    });
    const checked = createAssistantMessage({ type: "text", text: "Checked." });
    await setModelReplies([
      reply,
      // Answers only a request that carries the closed calls' results.
      { ...replyRule(checked), match: { hasToolResult: true } },
    ]);
    const first = await harness.send({ text: "How many Turns?" });
    await harness.runStep();
    // The Turn fails with its tool calls pending, and a new Turn starts.
    await engineCtx.executor
      .db()
      .update(juniorTurns)
      .set({ state: "failed", endedAt: sql`now()` })
      .where(eq(juniorTurns.id, first.turnId));
    const next = await harness.send({ text: "Did it send?" });

    await harness.runUntilIdle();

    expect(executed).toEqual([]);
    await expect(harness.turn(next.turnId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      danglingResult(
        "call-1",
        "The previous Turn ended before this call's result was saved. It may or may not have run. Check its effect before you call it again.",
      ),
      danglingResult(
        "call-2",
        "The previous Turn ended before this call returned, so there is no result. Call it again if you still need it.",
      ),
      userText("Did it send?"),
      storedReply(checked),
    ]);
  });
});

// These cases need a fault or a timing that no edge can give: an input that
// arrives while the model request runs, or a prompt loader that fails.
describe("advanceTurn at the end of a Turn, with a test step", () => {
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
    const step = stepWith([modelOverloaded()]);
    let lateId: string | undefined;

    await engine.advance({
      ...step,
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
    await engine.advance(stepWith([modelOverloaded()]), LEASE_MS, next!.id);

    await expect(
      readInputs(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual(inputs);
    await expect(
      fixture.sql.db().select({ id: juniorTurns.id }).from(juniorTurns),
    ).resolves.toHaveLength(2);
  });

  it("keeps a failed Turn's late input on a queued Turn when the process dies before it publishes", async () => {
    await engine.addTestInput("How many Turns?");
    // Injected fault: the model provider is overloaded.
    const step = stepWith([modelOverloaded()]);
    let lateId: string | undefined;

    await expect(
      engine.advance({
        ...step,
        client: {
          complete: async (request, signal) => {
            lateId = await engine.addTestInput("And how many failed?");
            // Injected fault: the process dies after the fail commit, before
            // reconcileTurn publishes anything.
            vi.spyOn(engine.engineCtx.queue, "send").mockRejectedValue(
              new Error("The process died"),
            );
            return step.client.complete(request, signal);
          },
        },
      }),
    ).rejects.toThrow("The process died");

    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    const next = await readOtherTurn(engine.engineCtx, CONVERSATION_ID, turnId);
    expect(next).toMatchObject({ state: "queued" });
    await expect(
      readInputs(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: lateId, turnId: next!.id }),
    );
    expect(engine.sentStepMessages(next!.id)).toBe(0);
  });

  it("drops the inputs when every try of a step throws, and moves none", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    // Injected fault: a loader of the prompt fails each time.
    const memory = loader(
      "memory",
      () => Promise.reject(new Error("The memory store is down")),
      { timeoutMs: 1_000 },
    );
    const prompt = promptForEveryTurn(
      testPrompt([
        testInputs(),
        fragment("memory", {
          loader: memory,
          format: (text): FragmentMessage => ({ role: "user", content: text }),
        }),
      ]),
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(engine.advance({ prompt })).rejects.toThrow(
        'Loader "memory" failed',
      );
    }

    await engine.advance(stepWith([]));

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
});
