import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { eq, sql } from "drizzle-orm";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { getQueueProvider, type QueueWorker } from "@/chat/queue/provider";
import type { ToolDefinition } from "@/core/tool";
import { advanceTurn, type PreparedStep } from "@/core/turn/advance";
import { TURN_STEP_TOPIC, turnStepCallback } from "@/core/turn/queue";
import { cancelTurn, claimTurn } from "@/core/turn/state";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurns,
} from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createJuniorSqlFixture,
  hasJuniorPostgresTestDatabase,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  createAssistantMessage,
  createModelComplete,
} from "../fixtures/model-stream";

// Chat config reads the queue provider when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
// turn-step-queue.test.ts uses the same topic in another worker, so this file
// uses its own Redis database. One job at a time keeps deliveries in send
// order, so the marker below comes last.
vi.hoisted(() => {
  const redisUrl = new URL(
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382",
  );
  redisUrl.pathname = "/1";
  process.env["JUNIOR_QUEUE_PROVIDER"] = "bullmq";
  process.env["JUNIOR_QUEUE_REDIS_URL"] = redisUrl.href;
  process.env["JUNIOR_QUEUE_WORKER_CONCURRENCY"] = "1";
});

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

const carriedPayloadSchema = z.looseObject({
  turnId: z.string(),
  marker: z.literal(true).optional(),
});

let fixture: LocalJuniorSqlFixture;
let turnId: string;
let worker: QueueWorker;
// Step messages of this test's Turn, and the marker that ends a delivery check.
let published: number;
let markerSeen: boolean;

beforeEach(async () => {
  fixture = await createJuniorSqlFixture();
  await fixture.sql.db().insert(juniorIdentities).values({
    createdAt: new Date(),
    id: "identity:actor",
    kind: "user",
    provider: "slack",
    providerSubjectId: "U123",
    providerTenantId: "T123",
    updatedAt: new Date(),
  });
  await fixture.sql
    .db()
    .insert(juniorConversations)
    .values(buildJuniorSqlConversation({ conversationId: CONVERSATION_ID }));
  turnId = randomUUID();
  await fixture.sql.db().insert(juniorTurns).values({
    id: turnId,
    conversationId: CONVERSATION_ID,
    actorIdentityId: "identity:actor",
    state: "queued",
  });

  published = 0;
  markerSeen = false;
  const provider = getQueueProvider();
  if (!provider.startWorker) {
    throw new Error("The BullMQ provider must start workers");
  }
  // The topic is fixed, so the worker counts only messages of this Turn.
  worker = await provider.startWorker([
    {
      ...turnStepCallback(() => Promise.resolve()).consumer,
      handler: async (payload) => {
        const parsed = carriedPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.turnId !== turnId) {
          return;
        }
        if (parsed.data.marker) {
          markerSeen = true;
        } else {
          published += 1;
        }
      },
    },
  ]);
});

afterEach(async () => {
  await worker.close();
  await fixture.close();
});

/** Waits until every step message sent so far is delivered, and counts them. */
async function deliveredStepMessages(): Promise<number> {
  await getQueueProvider().send(TURN_STEP_TOPIC, { turnId, marker: true });
  const deadline = Date.now() + 10_000;
  while (!markerSeen) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for queue delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return published;
}

async function readTurn() {
  const [turn] = await fixture.sql
    .db()
    .select()
    .from(juniorTurns)
    .where(eq(juniorTurns.id, turnId));
  return turn!;
}

async function loadHistory() {
  const events = await createSqlConversationEventStore(
    fixture.sql,
  ).loadCurrentHistory(CONVERSATION_ID);
  return projectConversationEvents(events).messages;
}

/** A step whose model gives the replies in order. */
function prepareWith(
  replies: AssistantMessage[],
  tools: ToolDefinition[] = [],
): { prepare: () => Promise<PreparedStep> } {
  const complete = createModelComplete(
    replies.map((message) => ({ type: "message", message })),
  );
  return {
    prepare: () =>
      Promise.resolve({ systemPrompt: "You are Junior.", tools, complete }),
  };
}

function advance(prepare: () => Promise<PreparedStep>, leaseMs = LEASE_MS) {
  return advanceTurn(
    fixture.sql,
    { turnId },
    { prepare, owner: "worker-a", leaseMs, maxAttempts: MAX_ATTEMPTS },
  );
}

/**
 * A step whose model request runs `interrupt`, then waits until the step's
 * signal aborts. The request ends only through the abort.
 */
function prepareInterrupted(interrupt: () => Promise<unknown>): {
  prepare: () => Promise<PreparedStep>;
} {
  const complete = createModelComplete([
    { type: "text", text: "Too late.", waitFor: "abort" },
  ]);
  return {
    prepare: () =>
      Promise.resolve({
        systemPrompt: "You are Junior.",
        tools: [],
        complete: async (context, signal) => {
          await interrupt();
          return complete(context, signal);
        },
      }),
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

function sendTool(executed: string[]): ToolDefinition {
  return {
    name: "send",
    description: "Sends a message.",
    parameters: { type: "object", properties: {} },
    replay: "never",
    execute: (_args, { callId }) => {
      executed.push(callId);
      return Promise.resolve({ content: [{ type: "text", text: "sent" }] });
    },
  };
}

function sendCallReply(): AssistantMessage {
  return createAssistantMessage({
    type: "toolCalls",
    calls: [{ name: "send", arguments: {}, id: "call-1" }],
  });
}

describe("advanceTurn", () => {
  it("commits a step that continues the Turn and sends the next step", async () => {
    const reply = sendCallReply();
    const { prepare } = prepareWith([reply]);

    await advance(prepare);

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(loadHistory()).resolves.toEqual([reply]);
    await expect(deliveredStepMessages()).resolves.toBe(1);
  });

  it("ends the Turn when the step completes it, and sends nothing", async () => {
    const reply = createAssistantMessage({ type: "text", text: "All done." });
    const { prepare } = prepareWith([reply]);

    await advance(prepare);

    const turn = await readTurn();
    expect(turn).toMatchObject({
      state: "completed",
      stepSeq: 1,
      leaseOwner: null,
    });
    expect(turn.endedAt).toBeInstanceOf(Date);
    await expect(loadHistory()).resolves.toEqual([reply]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("fails the Turn with the model error and writes no history", async () => {
    const { prepare } = prepareWith([
      createAssistantMessage({ type: "error", errorMessage: "overloaded" }),
    ]);

    await advance(prepare);

    await expect(readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: "overloaded",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
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
      const before = await readTurn();
      const prepare = vi.fn(
        prepareWith([createAssistantMessage({ type: "text", text: "hi" })])
          .prepare,
      );

      await advance(prepare);

      expect(prepare).not.toHaveBeenCalled();
      await expect(readTurn()).resolves.toEqual(before);
      await expect(loadHistory()).resolves.toEqual([]);
      await expect(deliveredStepMessages()).resolves.toBe(0);
    },
  );

  it("stops the step when the Turn is cancelled during it, and writes nothing", async () => {
    const { prepare } = prepareInterrupted(() =>
      cancelTurn(fixture.sql, turnId),
    );

    await advance(prepare);

    await expect(readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("writes nothing when the model request throws its own error after a cancel", async () => {
    const complete = createModelComplete([
      { type: "text", text: "Too late.", waitFor: "abort" },
    ]);
    const prepare = () =>
      Promise.resolve({
        systemPrompt: "You are Junior.",
        tools: [],
        complete: async (context: Context, signal: AbortSignal) => {
          await cancelTurn(fixture.sql, turnId);
          await complete(context, signal);
          throw new Error("The connection closed");
        },
      });

    await advance(prepare);

    await expect(readTurn()).resolves.toMatchObject({ state: "cancelled" });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("stops the step when another invocation takes over the Turn during it, and writes nothing", async () => {
    // The lease of this invocation has expired, so a redelivery claims it.
    const { prepare } = prepareInterrupted(() =>
      claimTurn(fixture.sql, { turnId, owner: "worker-b", leaseMs: LEASE_MS }),
    );

    await advance(prepare, EXPIRED_LEASE_MS);

    await expect(readTurn()).resolves.toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      leaseEpoch: 2,
      stepSeq: 0,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("stops a tool that respects the signal when the Turn is cancelled", async () => {
    const reply = sendCallReply();
    await advance(prepareWith([reply]).prepare);
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

    await advance(prepareWith([], [send]).prepare);

    await expect(readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 1,
    });
    await expect(loadHistory()).resolves.toEqual([reply]);
    // Only the step that the first advance committed.
    await expect(deliveredStepMessages()).resolves.toBe(1);
  });

  // Holding a table lock needs a second database session, which PGlite lacks.
  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "goes on with the step when a lease check fails",
    async () => {
      const reply = createAssistantMessage({ type: "text", text: "All done." });
      const { prepare } = prepareWith([reply]);
      let abortedAfterFailedCheck: boolean | undefined;
      const failingCheck = async () => {
        const prepared = await prepare();
        return {
          ...prepared,
          complete: async (context: Context, signal: AbortSignal) => {
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
            return prepared.complete(context, signal);
          },
        };
      };

      await advance(failingCheck);

      expect(abortedAfterFailedCheck).toBe(false);
      await expect(readTurn()).resolves.toMatchObject({
        state: "completed",
        stepSeq: 1,
      });
      await expect(loadHistory()).resolves.toEqual([reply]);
    },
  );

  it("queues the Turn again when the invocation throws, so the retry runs the step at once", async () => {
    const executed: string[] = [];
    await advance(prepareWith([sendCallReply()]).prepare);
    const failure = new Error("The system prompt could not be built");

    await expect(advance(() => Promise.reject(failure))).rejects.toBe(failure);

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const retry = vi.fn(prepareWith([], [sendTool(executed)]).prepare);
    await advance(retry);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ stepSeq: 1, attempts: 2 }),
    );
    // The retry is a replay, so it skips the tool that must not run twice.
    expect(executed).toEqual([]);
    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
    });
  });

  it("fails the Turn when every try of a step throws, and runs it no more", async () => {
    const failure = new Error("The system prompt could not be built");
    const prepare = vi.fn(() => Promise.reject(failure));
    // Each try queues the Turn again, as the queue's redelivery would find it.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(advance(prepare)).rejects.toBe(failure);
    }

    await advance(prepare);

    expect(prepare).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    await expect(readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: "attempts_exhausted",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("commits a step that succeeds on its last try, and resets the attempts", async () => {
    const failure = new Error("The system prompt could not be built");
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(advance(() => Promise.reject(failure))).rejects.toBe(
        failure,
      );
    }
    const reply = sendCallReply();
    const last = vi.fn(prepareWith([reply]).prepare);

    await advance(last);

    expect(last).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_ATTEMPTS }),
    );
    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
    });
    await expect(loadHistory()).resolves.toEqual([reply]);
    await expect(deliveredStepMessages()).resolves.toBe(1);
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
      let changed: Awaited<ReturnType<typeof readTurn>> | undefined;
      const failure = new Error("The system prompt could not be built");
      const prepare = async () => {
        await interrupt();
        changed = await readTurn();
        throw failure;
      };

      // The lease of this invocation has expired, so a redelivery can claim it.
      await expect(advance(prepare, EXPIRED_LEASE_MS)).rejects.toBe(failure);

      await expect(readTurn()).resolves.toEqual(changed);
      await expect(loadHistory()).resolves.toEqual([]);
    },
  );

  it("runs a tool that must not run twice on the first attempt of its step", async () => {
    const executed: string[] = [];
    await advance(prepareWith([sendCallReply()]).prepare);

    await advance(prepareWith([], [sendTool(executed)]).prepare);

    expect(executed).toEqual(["call-1"]);
    await expect(loadHistory()).resolves.toEqual([
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
    await advance(prepareWith([sendCallReply()]).prepare);
    // An invocation claims the tool step, then dies before it commits.
    await claimTurn(fixture.sql, {
      turnId,
      owner: "worker-dead",
      leaseMs: EXPIRED_LEASE_MS,
    });

    await advance(prepareWith([], [sendTool(executed)]).prepare);

    expect(executed).toEqual([]);
    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
      leaseEpoch: 3,
    });
    await expect(loadHistory()).resolves.toEqual([
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "toolResult", isError: true }),
    ]);
  });
});
