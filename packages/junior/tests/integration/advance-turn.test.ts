import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { eq, sql } from "drizzle-orm";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { getQueueProvider, type QueueWorker } from "@/chat/queue/provider";
import type {
  ModelClient,
  ModelRequest,
  ModelSettings,
} from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import { advanceTurn } from "@/core/turn/advance";
import {
  findUnreadInputs,
  type InputMessage,
  type UnreadInput,
} from "@/core/turn/inbox";
import { TURN_STEP_TOPIC, turnStepCallback } from "@/core/turn/queue";
import { cancelTurn, claimTurn } from "@/core/turn/state";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurnInbox,
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
  fakeModelClient,
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
const ACTOR = { platform: "slack", teamId: "T123", userId: "U123" } as const;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;
const MODEL: ModelSettings = {
  id: "test-model",
  reasoning: "none",
  privacy: "private",
};

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
    priority: 0,
    source: "slack",
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
  vi.restoreAllMocks();
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

type Prepare = Parameters<typeof advanceTurn>[2]["prepare"];

/** How a test prepares a step, and the model client that the step uses. */
type Step = { prepare: Prepare; client?: ModelClient };

/** Formats an input as an instruction of the test Actor with its text. */
function inputMessage(input: UnreadInput): InputMessage {
  return {
    inputId: input.inputId,
    message: {
      role: "user",
      content: [{ type: "text", text: String(input.payload["text"]) }],
      timestamp: input.sentAt.getTime(),
    },
    provenance: instructionProvenanceFor(ACTOR),
  };
}

async function addTestInput(text: string) {
  const inputId = randomUUID();
  await fixture.sql
    .db()
    .insert(juniorTurnInbox)
    .values({
      id: inputId,
      conversationId: CONVERSATION_ID,
      turnId,
      actorIdentityId: "identity:actor",
      payload: { text },
      idempotencyKey: `slack-event:${inputId}`,
      sentAt: new Date(),
    });
  return inputId;
}

function userText(text: string) {
  return expect.objectContaining({
    role: "user",
    content: [{ type: "text", text }],
  });
}

/** A step whose model gives the replies in order. */
function prepareWith(
  replies: AssistantMessage[],
  tools: ToolDefinition[] = [],
): Required<Step> {
  return {
    prepare: (_turn, inputs) =>
      Promise.resolve({
        systemPrompt: "You are Junior.",
        tools,
        model: MODEL,
        inputs: inputs.map(inputMessage),
      }),
    client: fakeModelClient(
      replies.map((message) => ({ type: "message", message })),
    ),
  };
}

function advance(step: Step, leaseMs = LEASE_MS) {
  return advanceTurn(
    fixture.sql,
    { turnId },
    {
      client: step.client ?? fakeModelClient([]),
      prepare: step.prepare,
      owner: "worker-a",
      leaseMs,
      maxAttempts: MAX_ATTEMPTS,
    },
  );
}

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
    const step = prepareWith([reply]);
    const requests: ModelRequest[] = [];

    await advance({
      ...step,
      client: {
        complete: (request, signal) => {
          requests.push(request);
          return step.client.complete(request, signal);
        },
      },
    });

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(loadHistory()).resolves.toEqual([reply]);
    await expect(deliveredStepMessages()).resolves.toBe(1);
    expect(requests).toMatchObject([
      { model: MODEL, session: CONVERSATION_ID },
    ]);
  });

  it("ends the Turn when the step completes it, and sends nothing", async () => {
    const reply = createAssistantMessage({ type: "text", text: "All done." });
    await advance(prepareWith([reply]));

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
    await advance(
      prepareWith([
        createAssistantMessage({ type: "error", errorMessage: "overloaded" }),
      ]),
    );

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
      const step = prepareWith([
        createAssistantMessage({ type: "text", text: "hi" }),
      ]);
      const prepare = vi.fn(step.prepare);

      await advance({ ...step, prepare });

      expect(prepare).not.toHaveBeenCalled();
      await expect(readTurn()).resolves.toEqual(before);
      await expect(loadHistory()).resolves.toEqual([]);
      await expect(deliveredStepMessages()).resolves.toBe(0);
    },
  );

  it("stops the step when the Turn is cancelled during it, and writes nothing", async () => {
    await advance(prepareInterrupted(() => cancelTurn(fixture.sql, turnId)));

    await expect(readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("writes nothing when the model request throws its own error after a cancel", async () => {
    const model = fakeModelClient([
      { type: "text", text: "Too late.", waitFor: "abort" },
    ]);

    await advance({
      prepare: prepareWith([]).prepare,
      client: {
        complete: async (request, signal) => {
          await cancelTurn(fixture.sql, turnId);
          await model.complete(request, signal);
          throw new Error("The connection closed");
        },
      },
    });

    await expect(readTurn()).resolves.toMatchObject({ state: "cancelled" });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

  it("stops the step when another invocation takes over the Turn during it, and writes nothing", async () => {
    // The lease of this invocation has expired, so a redelivery claims it.
    const step = prepareInterrupted(() =>
      claimTurn(fixture.sql, { turnId, owner: "worker-b", leaseMs: LEASE_MS }),
    );

    await advance(step, EXPIRED_LEASE_MS);

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
    await advance(prepareWith([reply]));
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

    await advance(prepareWith([], [send]));

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
    await advance(prepareWith([sendCallReply()]));
    const failure = new Error("The system prompt could not be built");

    await expect(
      advance({ prepare: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const retryStep = prepareWith([], [sendTool(executed)]);
    const retry = vi.fn(retryStep.prepare);
    await advance({ ...retryStep, prepare: retry });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ stepSeq: 1, attempts: 2 }),
      [],
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
      await expect(advance({ prepare })).rejects.toBe(failure);
    }

    await advance({ prepare });

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
      await expect(
        advance({ prepare: () => Promise.reject(failure) }),
      ).rejects.toBe(failure);
    }
    const reply = sendCallReply();
    const lastStep = prepareWith([reply]);
    const last = vi.fn(lastStep.prepare);

    await advance({ ...lastStep, prepare: last });

    expect(last).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_ATTEMPTS }),
      [],
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
      await expect(advance({ prepare }, EXPIRED_LEASE_MS)).rejects.toBe(
        failure,
      );

      await expect(readTurn()).resolves.toEqual(changed);
      await expect(loadHistory()).resolves.toEqual([]);
    },
  );

  it("runs a tool that must not run twice on the first attempt of its step", async () => {
    const executed: string[] = [];
    await advance(prepareWith([sendCallReply()]));

    await advance(prepareWith([], [sendTool(executed)]));

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
    await advance(prepareWith([sendCallReply()]));
    // An invocation claims the tool step, then dies before it commits.
    await claimTurn(fixture.sql, {
      turnId,
      owner: "worker-dead",
      leaseMs: EXPIRED_LEASE_MS,
    });

    await advance(prepareWith([], [sendTool(executed)]));

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
  it("runs the next step on a redelivery when the send after a continue commit fails", async () => {
    const executed: string[] = [];
    const reply = sendCallReply();
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after the commit, before the send.
    vi.spyOn(getQueueProvider(), "send").mockRejectedValueOnce(failure);

    await expect(advance(prepareWith([reply]))).rejects.toBe(failure);

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
    });

    // The queue delivers the same message again.
    await advance(prepareWith([], [sendTool(executed)]));

    // A first attempt, so the tool that must not run twice runs.
    expect(executed).toEqual(["call-1"]);
    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
    });

    const done = createAssistantMessage({ type: "text", text: "Sent." });
    await advance(prepareWith([done]));

    await expect(readTurn()).resolves.toMatchObject({
      state: "completed",
      stepSeq: 3,
    });
    await expect(loadHistory()).resolves.toEqual([
      reply,
      expect.objectContaining({ role: "toolResult", isError: false }),
      done,
    ]);
    // Only the tool step's send went out.
    await expect(deliveredStepMessages()).resolves.toBe(1);
  });

  it("reads an unread input into the history before the reply", async () => {
    const inputId = await addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });

    await advance(prepareWith([reply]));

    await expect(readTurn()).resolves.toMatchObject({ state: "completed" });
    await expect(loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      reply,
    ]);
    const events = await createSqlConversationEventStore(
      fixture.sql,
    ).loadCurrentHistory(CONVERSATION_ID);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `inbox:${inputId}`,
      undefined,
    ]);
    expect(events[0]!.data).toMatchObject({
      type: "user_message",
      provenance: { authority: "instruction", actor: ACTOR },
    });
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([]);
  });

  it("leaves the input unread when the model step fails", async () => {
    const inputId = await addTestInput("How many Turns?");

    await advance(
      prepareWith([
        createAssistantMessage({ type: "error", errorMessage: "overloaded" }),
      ]),
    );

    await expect(readTurn()).resolves.toMatchObject({ state: "failed" });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId }),
    ]);
  });

  it("continues a completed Turn when an input arrives during the step, and sends the next step", async () => {
    await addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    const step = prepareWith([reply]);
    let lateInputId: string | undefined;

    await advance({
      prepare: step.prepare,
      client: {
        complete: async (request, signal) => {
          lateInputId = await addTestInput("And how many failed?");
          return step.client.complete(request, signal);
        },
      },
    });

    const turn = await readTurn();
    expect(turn).toMatchObject({ state: "queued", stepSeq: 1 });
    expect(turn.endedAt).toBeNull();
    await expect(loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      reply,
    ]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId: lateInputId }),
    ]);
    await expect(deliveredStepMessages()).resolves.toBe(1);
  });

  it("reads no inputs in a tool step", async () => {
    const executed: string[] = [];
    const reply = sendCallReply();
    await advance(prepareWith([reply]));
    const inputId = await addTestInput("Also send it to Sam.");
    const toolStep = prepareWith([], [sendTool(executed)]);
    const prepare = vi.fn(toolStep.prepare);

    await advance({ ...toolStep, prepare });

    expect(prepare).toHaveBeenCalledWith(expect.anything(), []);
    expect(executed).toEqual(["call-1"]);
    await expect(loadHistory()).resolves.toEqual([
      reply,
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
    await addTestInput("How many Turns?");
    const step = prepareWith([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
    const prepare: Prepare = async (turn, inputs) => {
      const prepared = await step.prepare(turn, inputs);
      return { ...prepared, inputs: change(prepared.inputs) };
    };

    await expect(advance({ ...step, prepare })).rejects.toThrow(
      "prepare must return each unread input once",
    );

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 0,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(findUnreadInputs(fixture.sql, turnId)).resolves.toHaveLength(
      1,
    );
  });
});
