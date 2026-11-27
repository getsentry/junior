import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { TURN_LIMIT_WRAP_UP_MESSAGE } from "@/chat/services/turn-limit";
import { contextProvenance } from "@/chat/conversations/provenance";
import { withConversationEventLock } from "@/conversation-events/lock";
import { historyItemFromPiMessage } from "@/core/history/items";
import { appendAgentHistory } from "@/core/history/write";
import { juniorTurns } from "@/db/schema";
import { turnTools } from "@/turn-steps/tools";
import { setModelReplies } from "../fixtures/ai-emulator";
import { useConfig } from "../fixtures/config";
import { createAssistantMessage } from "../fixtures/model-stream";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";
import { storedReply } from "../fixtures/turn-engine";

// Main's per-Turn limits on a core Turn, through the host's tools.

/** Starts a harness whose steps use the host's tools. */
async function startHarness(): Promise<TurnHarness> {
  const harness = await createTurnHarness({ tools: turnTools });
  onTestFinished(() => harness.close());
  return harness;
}

/** A model reply that calls systemTime once, with `id`. */
function timeCall(id: string) {
  return createAssistantMessage({
    type: "toolCalls",
    calls: [{ name: "systemTime", arguments: { timezone: "UTC" }, id }],
  });
}

/** The result that a call past a limit gets in place of running. */
function wrapUpResult(toolCallId: string) {
  return expect.objectContaining({
    role: "toolResult",
    toolCallId,
    isError: true,
    content: [{ type: "text", text: TURN_LIMIT_WRAP_UP_MESSAGE }],
  });
}

describe("core Turn limits", () => {
  it("blocks the first batch past the tool-call limit, and the model can still reply", async () => {
    useConfig({ limits: { maxToolCallsPerTurn: 1 } });
    const harness = await startHarness();
    const reply = createAssistantMessage({
      type: "text",
      text: "Done so far.",
    });
    await setModelReplies([timeCall("call-1"), timeCall("call-2"), reply]);
    const { turnId } = await harness.send({ text: "What time is it?" });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    const history = await harness.history();
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-1",
        isError: false,
      }),
    );
    expect(history).toContainEqual(wrapUpResult("call-2"));
    expect(history.at(-1)).toEqual(storedReply(reply));
  });

  it("does not count the results it writes for an earlier Turn's pending calls", async () => {
    useConfig({ limits: { maxToolCallsPerTurn: 1 } });
    const harness = await startHarness();
    const reply = createAssistantMessage({ type: "text", text: "It is noon." });
    await setModelReplies([
      createAssistantMessage({
        type: "toolCalls",
        calls: [
          { name: "systemTime", arguments: { timezone: "UTC" }, id: "call-1" },
          { name: "systemTime", arguments: { timezone: "UTC" }, id: "call-2" },
        ],
      }),
      timeCall("call-3"),
      reply,
    ]);
    const first = await harness.send({ text: "What time is it?" });
    await harness.runStep();
    // The Turn fails with its two tool calls pending, and a new Turn starts.
    await harness.engineCtx.executor
      .db()
      .update(juniorTurns)
      .set({ state: "failed", endedAt: sql`now()` })
      .where(eq(juniorTurns.id, first.turnId));
    const { turnId } = await harness.send({ text: "And now?" });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    const history = await harness.history();
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-3",
        isError: false,
      }),
    );
    expect(history.at(-1)).toEqual(storedReply(reply));
  });

  it("fails the Turn when the model calls a tool after the wrap-up", async () => {
    useConfig({ limits: { maxToolCallsPerTurn: 1 } });
    const harness = await startHarness();
    await setModelReplies([
      timeCall("call-1"),
      timeCall("call-2"),
      timeCall("call-3"),
    ]);
    const { turnId } = await harness.send({ text: "What time is it?" });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
      endReason: "Agent turn exceeded execution limit (1 tool calls)",
      failureCode: "agent_run_failed",
    });
    const history = await harness.history();
    expect(history).toContainEqual(wrapUpResult("call-2"));
    expect(history).not.toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-3" }),
    );
  });

  it("counts the cost of the failed replies that the Turn dropped against its budget", async () => {
    useConfig({ limits: { maxTurnCostUsd: 1 } });
    const harness = await startHarness();
    await setModelReplies([timeCall("call-1")]);
    const { turnId } = await harness.send({ text: "What time is it?" });
    // Earlier tries of this Turn whose failed replies spent the budget.
    await harness.engineCtx.executor
      .db()
      .update(juniorTurns)
      .set({ discardedCostMicroUsd: 1_000_000 })
      .where(eq(juniorTurns.id, turnId));

    await harness.runStep();
    await harness.runStep();

    expect(await harness.history()).toContainEqual(wrapUpResult("call-1"));
  });

  it("counts the cost of the Turn's model replies against its budget", async () => {
    useConfig({ limits: { maxTurnCostUsd: 1 } });
    const harness = await startHarness();
    await setModelReplies([timeCall("call-1"), timeCall("call-2")]);
    const { turnId } = await harness.send({ text: "What time is it?" });
    // An earlier model reply of this Turn that spent the whole budget. The
    // emulator's replies cost nothing.
    const earlier = createAssistantMessage({ type: "text", text: "Working." });
    const { executor } = harness.engineCtx;
    await executor.transaction(() =>
      withConversationEventLock(executor, harness.conversationId, () =>
        appendAgentHistory(executor, harness.conversationId, turnId, [
          {
            item: historyItemFromPiMessage(
              {
                ...earlier,
                usage: {
                  ...earlier.usage,
                  cost: { ...earlier.usage.cost, total: 1 },
                },
              },
              contextProvenance,
            ),
            idempotencyKey: "earlier-reply",
            createdAtMs: earlier.timestamp,
          },
        ]),
      ),
    );

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
      endReason: "Agent turn exceeded execution limit ($1 budget)",
      failureCode: "agent_run_failed",
    });
    expect(await harness.history()).toContainEqual(wrapUpResult("call-1"));
  });
});
