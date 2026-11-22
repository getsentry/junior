import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { getQueueProvider } from "@/chat/queue/provider";
import type { ModelRequest } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import { findUnreadInputs, type InputMessage } from "@/core/turn/inbox";
import { cancelTurn, claimTurn } from "@/core/turn/state";
import { juniorTurns } from "@/db/schema";
import {
  modelCalls,
  modelOverloaded,
  streamDisconnected,
} from "../fixtures/ai-emulator";
import {
  hasJuniorPostgresTestDatabase,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  createAssistantMessage,
  fakeModelClient,
} from "../fixtures/model-stream";
import {
  ACTOR,
  CONVERSATION_ID,
  LEASE_MS,
  MAX_ATTEMPTS,
  MODEL,
  prepareWith,
  sendCallReply,
  sendTool,
  startTurnEngine,
  storedReply,
  userText,
  type Prepare,
  type Step,
  type TurnEngine,
} from "../fixtures/turn-engine";

// The queue env must be set before chat config loads. turn-ended.test.ts and
// turn-step-queue.test.ts start workers on the same topic, so this file uses
// Redis database 1.
vi.hoisted(() => {
  const redisUrl = new URL(
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382",
  );
  redisUrl.pathname = "/1";
  process.env["JUNIOR_QUEUE_PROVIDER"] = "bullmq";
  process.env["JUNIOR_QUEUE_REDIS_URL"] = redisUrl.href;
  process.env["JUNIOR_QUEUE_WORKER_CONCURRENCY"] = "1";
});

// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

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

/**
 * A step whose model request runs `interrupt`, then waits until the step's
 * signal aborts. The request ends only through the abort.
 */
function prepareInterrupted(interrupt: () => Promise<unknown>): Step {
  const model = fakeModelClient([
    { type: "text", text: "Too late.", waitFor: "abort" },
  ]);
  return {
    prepare: prepareWith([]).prepare,
    client: {
      complete: async (request, signal) => {
        await interrupt();
        return model.complete(request, signal);
      },
    },
  };
}

/** Waits until a lease check that started after `after` waits on a lock. */
async function blockedLeaseCheck(after?: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // Its own session: a transaction would see one snapshot of
    // pg_stat_activity. Text keeps the microseconds that a Date would drop.
    const [check] = await fixture.sql.queryIsolated<{
      pid: number;
      queryStart: string;
    }>(
      `
        select pid, query_start::text as "queryStart"
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike 'select%from "junior_turns"%'
          and query_start > coalesce($1::timestamptz, '-infinity')
      `,
      [after ?? null],
    );
    if (check) {
      return check;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for a lease check");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("advanceTurn", () => {
  it("commits a step that continues the Turn and sends the next step", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = sendCallReply();
    const step = prepareWith([reply]);
    const requests: ModelRequest[] = [];

    await engine.advance({
      ...step,
      client: {
        complete: (request, signal) => {
          requests.push(request);
          return step.client.complete(request, signal);
        },
      },
    });

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
    expect(requests).toMatchObject([
      { model: MODEL, session: CONVERSATION_ID },
    ]);
  });

  it("ends the Turn when the step completes it, and sends nothing", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "All done." });
    await engine.advance(prepareWith([reply]));

    const turn = await engine.readTurn();
    expect(turn).toMatchObject({
      state: "completed",
      stepSeq: 1,
      leaseOwner: null,
    });
    expect(turn.endedAt).toBeInstanceOf(Date);
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(0);
  });

  it("fails the Turn with the model error and writes no history", async () => {
    await engine.addTestInput("How many Turns?");
    // Injected fault: the model provider is overloaded.
    await engine.advance(prepareWith([modelOverloaded()]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: expect.stringContaining("overloaded_error"),
      failureCode: "model_execution_failed",
      failureReason: "capacity",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(0);
  });

  it("fails the Turn and writes no history when the model stream closes mid-reply", async () => {
    await engine.addTestInput("How many Turns?");
    // Injected fault: the stream closes after the first chunk.
    await engine.advance(
      prepareWith([streamDisconnected("All done, and nothing is left.")]),
    );

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "failed",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(modelCalls()).resolves.toEqual([
      expect.objectContaining({ stream: true, fault: "disconnect" }),
    ]);
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(0);
  });

  it.each(["completed", "cancelled"] as const)(
    "does not run a step of a %s Turn",
    async (state) => {
      if (state === "cancelled") {
        await cancelTurn(fixture.sql, turnId);
      } else {
        await fixture.sql
          .db()
          .update(juniorTurns)
          .set({ state, endedAt: sql`now()` })
          .where(eq(juniorTurns.id, turnId));
      }
      const before = await engine.readTurn();
      const step = prepareWith([
        createAssistantMessage({ type: "text", text: "hi" }),
      ]);
      const prepare = vi.fn(step.prepare);

      await engine.advance({ ...step, prepare });

      expect(prepare).not.toHaveBeenCalled();
      await expect(engine.readTurn()).resolves.toEqual(before);
      await expect(engine.loadHistory()).resolves.toEqual([]);
      // Only cancelTurn's own message.
      await expect(engine.deliveredStepMessages()).resolves.toBe(
        state === "cancelled" ? 1 : 0,
      );
    },
  );

  it("stops the step when the Turn is cancelled during it, and writes nothing", async () => {
    await engine.advance(
      prepareInterrupted(() => cancelTurn(fixture.sql, turnId)),
    );

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    // Only cancelTurn's own message.
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
  });

  it("writes nothing when the model request throws its own error after a cancel", async () => {
    const model = fakeModelClient([
      { type: "text", text: "Too late.", waitFor: "abort" },
    ]);

    await engine.advance({
      prepare: prepareWith([]).prepare,
      client: {
        complete: async (request, signal) => {
          await cancelTurn(fixture.sql, turnId);
          await model.complete(request, signal);
          throw new Error("The connection closed");
        },
      },
    });

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "cancelled",
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    // Only cancelTurn's own message.
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
  });

  it("stops the step when another invocation takes over the Turn during it, and writes nothing", async () => {
    // The lease of this invocation has expired, so a redelivery claims it.
    const step = prepareInterrupted(() =>
      claimTurn(fixture.sql, { turnId, owner: "worker-b", leaseMs: LEASE_MS }),
    );

    await engine.advance(step, EXPIRED_LEASE_MS);

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      leaseEpoch: 2,
      stepSeq: 0,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(0);
  });

  it("stops a tool that respects the signal when the Turn is cancelled", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = sendCallReply();
    await engine.advance(prepareWith([reply]));
    const send: ToolDefinition = {
      ...sendTool([]),
      execute: async (_args, { signal }) => {
        await cancelTurn(fixture.sql, turnId);
        // The tool works until its signal aborts.
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return { content: [{ type: "text", text: "sent" }] };
      },
    };

    await engine.advance(prepareWith([], [send]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 1,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    // The step that the first advance committed, and cancelTurn's message.
    await expect(engine.deliveredStepMessages()).resolves.toBe(2);
  });

  // Holding a table lock needs a second database session, which PGlite lacks.
  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "goes on with the step when a lease check fails",
    async () => {
      await engine.addTestInput("How many Turns?");
      const reply = createAssistantMessage({ type: "text", text: "All done." });
      const step = prepareWith([reply]);
      let abortedAfterFailedCheck: boolean | undefined;
      const failingCheck: Step = {
        prepare: step.prepare,
        client: {
          complete: async (request, signal) => {
            // Injected fault: a lease check fails. A table lock holds the
            // check, and the test cancels its query.
            await fixture.sql.transaction(async () => {
              await fixture.sql.execute(
                "LOCK TABLE junior_turns IN ACCESS EXCLUSIVE MODE",
              );
              const failed = await blockedLeaseCheck();
              await fixture.sql.query("select pg_cancel_backend($1)", [
                failed.pid,
              ]);
              // Checks do not overlap, so a later check means the failed one
              // has ended.
              await blockedLeaseCheck(failed.queryStart);
            });
            abortedAfterFailedCheck = signal.aborted;
            return step.client.complete(request, signal);
          },
        },
      };

      await engine.advance(failingCheck);

      expect(abortedAfterFailedCheck).toBe(false);
      await expect(engine.readTurn()).resolves.toMatchObject({
        state: "completed",
        stepSeq: 1,
      });
      await expect(engine.loadHistory()).resolves.toEqual([
        userText("How many Turns?"),
        storedReply(reply),
      ]);
    },
  );

  it("queues the Turn again when the invocation throws, so the retry runs the step at once", async () => {
    await engine.addTestInput("How many Turns?");
    const executed: string[] = [];
    await engine.advance(prepareWith([sendCallReply()]));
    const failure = new Error("The system prompt could not be built");

    await expect(
      engine.advance({ prepare: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const retryStep = prepareWith([], [sendTool(executed)]);
    const retry = vi.fn(retryStep.prepare);
    await engine.advance({ ...retryStep, prepare: retry });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ stepSeq: 1, attempts: 2 }),
      [],
    );
    // The retry is a replay, so it skips the tool that must not run twice.
    expect(executed).toEqual([]);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
    });
  });

  it("fails the Turn when every try of a step throws, and runs it no more", async () => {
    const failure = new Error("The system prompt could not be built");
    const prepare = vi.fn(() => Promise.reject(failure));
    // Each try queues the Turn again, as the queue's redelivery would find it.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(engine.advance({ prepare })).rejects.toBe(failure);
    }

    await engine.advance({ prepare });

    expect(prepare).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: "attempts_exhausted",
      failureCode: "agent_run_failed",
      failureReason: null,
      failureEventId: null,
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(0);
  });

  it("commits a step that succeeds on its last try, and resets the attempts", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    const failure = new Error("The system prompt could not be built");
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(
        engine.advance({ prepare: () => Promise.reject(failure) }),
      ).rejects.toBe(failure);
    }
    const reply = sendCallReply();
    const lastStep = prepareWith([reply]);
    const last = vi.fn(lastStep.prepare);

    await engine.advance({ ...lastStep, prepare: last });

    expect(last).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_ATTEMPTS }),
      [expect.objectContaining({ inputId })],
    );
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
  });

  it.each([
    ["cancelled", () => cancelTurn(fixture.sql, turnId)],
    [
      "taken over",
      () =>
        claimTurn(fixture.sql, {
          turnId,
          owner: "worker-b",
          leaseMs: LEASE_MS,
        }),
    ],
  ])(
    "leaves a Turn that was %s alone when the invocation throws",
    async (_change, interrupt) => {
      let changed: Awaited<ReturnType<TurnEngine["readTurn"]>> | undefined;
      const failure = new Error("The system prompt could not be built");
      const prepare = async () => {
        await interrupt();
        changed = await engine.readTurn();
        throw failure;
      };

      // The lease of this invocation has expired, so a redelivery can claim it.
      await expect(engine.advance({ prepare }, EXPIRED_LEASE_MS)).rejects.toBe(
        failure,
      );

      await expect(engine.readTurn()).resolves.toEqual(changed);
      await expect(engine.loadHistory()).resolves.toEqual([]);
    },
  );

  it("runs a tool that must not run twice on the first attempt of its step", async () => {
    const executed: string[] = [];
    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([sendCallReply()]));

    await engine.advance(prepareWith([], [sendTool(executed)]));

    expect(executed).toEqual(["call-1"]);
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({
        role: "toolResult",
        isError: false,
        content: [{ type: "text", text: "sent" }],
      }),
    ]);
  });

  it("skips that tool when the step runs again after a lost attempt", async () => {
    const executed: string[] = [];
    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([sendCallReply()]));
    // An invocation claims the tool step, then dies before it commits.
    await claimTurn(fixture.sql, {
      turnId,
      owner: "worker-dead",
      leaseMs: EXPIRED_LEASE_MS,
    });

    await engine.advance(prepareWith([], [sendTool(executed)]));

    expect(executed).toEqual([]);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
      leaseEpoch: 3,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "toolResult", isError: true }),
    ]);
  });
  it("runs the next step on a redelivery when the send after a continue commit fails", async () => {
    const executed: string[] = [];
    await engine.addTestInput("How many Turns?");
    const reply = sendCallReply();
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after the commit, before the send.
    vi.spyOn(getQueueProvider(), "send").mockRejectedValueOnce(failure);

    await expect(engine.advance(prepareWith([reply]))).rejects.toBe(failure);

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
    });

    // The queue delivers the same message again.
    await engine.advance(prepareWith([], [sendTool(executed)]));

    // A first attempt, so the tool that must not run twice runs.
    expect(executed).toEqual(["call-1"]);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
    });

    const done = createAssistantMessage({ type: "text", text: "Sent." });
    await engine.advance(prepareWith([done]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
      stepSeq: 3,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      expect.objectContaining({ role: "toolResult", isError: false }),
      storedReply(done),
    ]);
    // Only the tool step's send went out.
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
  });

  it("reads an unread input into the history before the reply", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });

    await engine.advance(prepareWith([reply]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    const events = await createSqlConversationEventStore(
      fixture.sql,
    ).loadCurrentHistory(CONVERSATION_ID);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `inbox:${inputId}`,
      `step:${turnId}:0:0`,
    ]);
    expect(events[0]!.data).toMatchObject({
      type: "user_message",
      provenance: { authority: "instruction", actor: ACTOR },
    });
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([]);
  });

  it("leaves the input unread when the model step fails", async () => {
    const inputId = await engine.addTestInput("How many Turns?");

    // Injected fault: the model provider is overloaded.
    await engine.advance(prepareWith([modelOverloaded()]));

    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId }),
    ]);
  });

  it("continues a completed Turn when an input arrives during the step, and sends the next step", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    const step = prepareWith([reply]);
    let lateInputId: string | undefined;

    await engine.advance({
      prepare: step.prepare,
      client: {
        complete: async (request, signal) => {
          lateInputId = await engine.addTestInput("And how many failed?");
          return step.client.complete(request, signal);
        },
      },
    });

    const turn = await engine.readTurn();
    expect(turn).toMatchObject({ state: "queued", stepSeq: 1 });
    expect(turn.endedAt).toBeNull();
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId: lateInputId }),
    ]);
    await expect(engine.deliveredStepMessages()).resolves.toBe(1);
  });

  it("reads no inputs in a tool step", async () => {
    const executed: string[] = [];
    await engine.addTestInput("How many Turns?");
    const reply = sendCallReply();
    await engine.advance(prepareWith([reply]));
    const inputId = await engine.addTestInput("Also send it to Sam.");
    const toolStep = prepareWith([], [sendTool(executed)]);
    const prepare = vi.fn(toolStep.prepare);

    await engine.advance({ ...toolStep, prepare });

    expect(prepare).toHaveBeenCalledWith(expect.anything(), []);
    expect(executed).toEqual(["call-1"]);
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      expect.objectContaining({ role: "toolResult" }),
    ]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId }),
    ]);
  });

  it.each([
    ["misses an input", (inputs: InputMessage[]) => inputs.slice(1)],
    [
      "adds an input",
      (inputs: InputMessage[]) => [
        ...inputs,
        { ...inputs[0]!, inputId: randomUUID() },
      ],
    ],
  ])("throws when prepare %s, and writes nothing", async (_change, change) => {
    await engine.addTestInput("How many Turns?");
    const step = prepareWith([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
    const prepare: Prepare = async (turn, inputs) => {
      const prepared = await step.prepare(turn, inputs);
      return { ...prepared, inputs: change(prepared.inputs) };
    };

    await expect(engine.advance({ ...step, prepare })).rejects.toThrow(
      "prepare must return each unread input once",
    );

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 0,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toHaveLength(
      1,
    );
  });
});
