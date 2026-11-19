import { randomUUID } from "node:crypto";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
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
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

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
): { prepare: () => Promise<PreparedStep>; requests: Context[] } {
  const requests: Context[] = [];
  const prepare = () =>
    Promise.resolve({
      systemPrompt: "You are Junior.",
      tools,
      complete: (context: Context) => {
        requests.push(context);
        const next = replies.shift();
        return next
          ? Promise.resolve(next)
          : Promise.reject(new Error("no model request expected"));
      },
    });
  return { prepare, requests };
}

function advance(prepare: () => Promise<PreparedStep>, leaseMs = LEASE_MS) {
  return advanceTurn(
    fixture.sql,
    { turnId },
    { prepare, owner: "worker-a", leaseMs },
  );
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
  return fauxAssistantMessage([fauxToolCall("send", {}, { id: "call-1" })], {
    stopReason: "toolUse",
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
    const reply = fauxAssistantMessage("All done.");
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
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "overloaded",
      }),
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
      const prepare = vi.fn(prepareWith([fauxAssistantMessage("hi")]).prepare);

      await advance(prepare);

      expect(prepare).not.toHaveBeenCalled();
      await expect(readTurn()).resolves.toEqual(before);
      await expect(loadHistory()).resolves.toEqual([]);
      await expect(deliveredStepMessages()).resolves.toBe(0);
    },
  );

  it("writes nothing when another invocation took over the Turn during the step", async () => {
    const reply = sendCallReply();
    const { prepare } = prepareWith([reply]);
    const takeover = async () => {
      const prepared = await prepare();
      return {
        ...prepared,
        complete: async (context: Context, signal: AbortSignal) => {
          // The lease of this invocation has expired, so a redelivery claims it.
          await claimTurn(fixture.sql, {
            turnId,
            owner: "worker-b",
            leaseMs: LEASE_MS,
          });
          return prepared.complete(context, signal);
        },
      };
    };

    await advance(takeover, EXPIRED_LEASE_MS);

    await expect(readTurn()).resolves.toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      leaseEpoch: 2,
      stepSeq: 0,
    });
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(deliveredStepMessages()).resolves.toBe(0);
  });

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
