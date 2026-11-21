import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@/core/model/client";
import { findUnreadInputs } from "@/core/turn/inbox";
import { juniorTurnInbox, juniorTurns } from "@/db/schema";
import type { LocalJuniorSqlFixture } from "../fixtures/sql";
import { createAssistantMessage } from "../fixtures/model-stream";
import {
  CONVERSATION_ID,
  LEASE_MS,
  MAX_ATTEMPTS,
  prepareWith,
  sendTool,
  startTurnEngine,
  type TurnEngine,
} from "../fixtures/turn-engine";

// The end of a Turn through advanceTurn: what a failed Turn drops or hands
// on, and how a new Turn closes an earlier Turn's tool calls. The queue env
// must be set before chat config loads. advance-turn.test.ts and
// turn-step-queue.test.ts start workers on the same topic, so this file uses
// Redis database 2.
vi.hoisted(() => {
  const redisUrl = new URL(
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382",
  );
  redisUrl.pathname = "/2";
  process.env["JUNIOR_QUEUE_PROVIDER"] = "bullmq";
  process.env["JUNIOR_QUEUE_REDIS_URL"] = redisUrl.href;
  process.env["JUNIOR_QUEUE_WORKER_CONCURRENCY"] = "1";
});

let engine: TurnEngine;
let fixture: LocalJuniorSqlFixture;
let turnId: string;

beforeEach(async () => {
  engine = await startTurnEngine();
  ({ fixture, turnId } = engine);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
});

async function readInputs() {
  return fixture.sql
    .db()
    .select({
      id: juniorTurnInbox.id,
      turnId: juniorTurnInbox.turnId,
      idempotencyKey: juniorTurnInbox.idempotencyKey,
    })
    .from(juniorTurnInbox)
    .orderBy(juniorTurnInbox.createdAt);
}

/** The Turn that took the inputs of the test's Turn. */
async function readOtherTurn() {
  const turns = await fixture.sql
    .db()
    .select({ id: juniorTurns.id, state: juniorTurns.state })
    .from(juniorTurns)
    .where(eq(juniorTurns.conversationId, CONVERSATION_ID));
  return turns.find((turn) => turn.id !== turnId);
}

function modelError(): AssistantMessage {
  return createAssistantMessage({ type: "error", errorMessage: "overloaded" });
}

/** The error result that closes a tool call of an earlier Turn. */
function abandonedResult(toolCallId: string, text: string) {
  return expect.objectContaining({
    role: "toolResult",
    toolCallId,
    isError: true,
    content: [{ type: "text", text }],
  });
}

describe("advanceTurn at the end of a Turn", () => {
  it("drops the inputs a failed attempt claimed, and moves an input that came after it only once", async () => {
    const claimedId = await engine.addTestInput("How many Turns?");
    const step = prepareWith([modelError()]);
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
    const next = await readOtherTurn();
    expect(next).toMatchObject({ state: "queued" });
    const inputs = [
      { id: claimedId, turnId, idempotencyKey: `slack-event:${claimedId}` },
      { id: lateId, turnId: next!.id, idempotencyKey: `slack-event:${lateId}` },
    ];
    await expect(readInputs()).resolves.toEqual(inputs);
    await expect(engine.deliveredStepMessages(next!.id)).resolves.toBe(1);

    // The new Turn's attempt claims the moved input, so its failure drops it.
    await engine.advance(prepareWith([modelError()]), LEASE_MS, next!.id);

    await expect(readInputs()).resolves.toEqual(inputs);
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
    await expect(readOtherTurn()).resolves.toBeUndefined();
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId, attemptedAt: expect.any(Date) }),
    ]);
  });

  it("closes an earlier Turn's pending tool calls without running them, and the model sees the results", async () => {
    const executed: string[] = [];
    const tools = [
      sendTool(executed),
      { ...sendTool(executed), name: "lookup", replay: "safe" as const },
    ];
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
      abandonedResult(
        "call-1",
        "The previous Turn ended before this call's result was saved. It may or may not have run. Check its effect before you call it again.",
      ),
      abandonedResult(
        "call-2",
        "The previous Turn ended before this call returned, so there is no result. Call it again if you still need it.",
      ),
    ];
    await expect(engine.loadHistory()).resolves.toEqual([reply, ...closed]);
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

    expect(requests[0]!.context.messages).toEqual([reply, ...closed]);
  });

  it("finishes the end work of a failed Turn on a redelivered message", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    // A crash right after the fail commit: the end work never ran.
    await fixture.sql
      .db()
      .update(juniorTurns)
      .set({ state: "failed", endedAt: sql`now()` })
      .where(eq(juniorTurns.id, turnId));
    const step = prepareWith([]);
    const prepare = vi.fn(step.prepare);

    await engine.advance({ ...step, prepare });

    expect(prepare).not.toHaveBeenCalled();
    const next = await readOtherTurn();
    expect(next).toMatchObject({ state: "queued" });
    await expect(readInputs()).resolves.toEqual([
      expect.objectContaining({ id: inputId, turnId: next!.id }),
    ]);
    await expect(engine.deliveredStepMessages(next!.id)).resolves.toBe(1);
  });
});
