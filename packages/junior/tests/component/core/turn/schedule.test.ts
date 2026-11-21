import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQueueProvider } from "@/chat/queue/provider";
import { TURN_STEP_TOPIC } from "@/core/turn/queue";
import { scheduleInput } from "@/core/turn/schedule";
import { cancelTurn, claimTurn, type Turn } from "@/core/turn/state";
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
} from "../../../fixtures/sql";

const CONVERSATION_ID = "local:conversation-1";
const LEASE_MS = 60_000;

// The v1 rule: one Actor, so an input joins the open Turn or starts one.
function joinOrCreate(openTurn: Turn | undefined) {
  return openTurn ? { join: openTurn.turnId } : { create: { priority: 0 } };
}

const stepMessageSchema = z.looseObject({ turnId: z.string() });

/** A step message that the queue took, and what a worker could see then. */
type Publish = { turnId: string; committed: boolean };

// The observer reads on its own connection, so it sees only committed rows,
// as a worker that takes the message does. Postgres fixtures share one
// database per test worker; PGlite fixtures do not.
describe.skipIf(!hasJuniorPostgresTestDatabase())("scheduleInput", () => {
  let fixture: LocalJuniorSqlFixture;
  let observer: LocalJuniorSqlFixture;
  let publishes: Publish[];

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    observer = await createJuniorSqlFixture();
    await fixture.sql.db().insert(juniorIdentities).values({
      createdAt: new Date(),
      id: "identity:actor",
      kind: "user",
      provider: "local",
      providerSubjectId: "user-1",
      providerTenantId: "",
      updatedAt: new Date(),
    });
    await fixture.sql
      .db()
      .insert(juniorConversations)
      .values(buildJuniorSqlConversation({ conversationId: CONVERSATION_ID }));
    publishes = [];
    // The queue is the external edge, so the test takes its sends.
    vi.spyOn(getQueueProvider(), "send").mockImplementation(
      async (topic, payload) => {
        if (topic === TURN_STEP_TOPIC) {
          const { turnId } = stepMessageSchema.parse(payload);
          publishes.push({ turnId, committed: await isCommitted(turnId) });
        }
        return {};
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await observer.close();
    await fixture.close();
  });

  async function isCommitted(turnId: string): Promise<boolean> {
    const [turns, inputs] = await Promise.all([
      observer.sql
        .db()
        .select({ id: juniorTurns.id })
        .from(juniorTurns)
        .where(eq(juniorTurns.id, turnId)),
      observer.sql
        .db()
        .select({ id: juniorTurnInbox.id })
        .from(juniorTurnInbox)
        .where(eq(juniorTurnInbox.turnId, turnId)),
    ]);
    return turns.length === 1 && inputs.length > 0;
  }

  function input(idempotencyKey: string): Parameters<typeof scheduleInput>[1] {
    return {
      conversationId: CONVERSATION_ID,
      kind: "message",
      actorIdentityId: "identity:actor",
      payload: { text: `Message ${idempotencyKey}` },
      idempotencyKey,
      sentAt: new Date("2026-11-21T08:00:00.000Z"),
      source: "local",
    };
  }

  function schedule(idempotencyKey: string) {
    return scheduleInput(fixture.sql, input(idempotencyKey), {
      assignTurn: joinOrCreate,
    });
  }

  async function readTurns() {
    return fixture.sql
      .db()
      .select({
        id: juniorTurns.id,
        state: juniorTurns.state,
        priority: juniorTurns.priority,
        source: juniorTurns.source,
        actorIdentityId: juniorTurns.actorIdentityId,
      })
      .from(juniorTurns);
  }

  async function readInputs() {
    return fixture.sql
      .db()
      .select({
        turnId: juniorTurnInbox.turnId,
        idempotencyKey: juniorTurnInbox.idempotencyKey,
      })
      .from(juniorTurnInbox)
      .orderBy(juniorTurnInbox.createdAt);
  }

  it("starts a Turn with the first input and publishes it after the commit", async () => {
    const scheduled = await schedule("event-1");

    expect(scheduled).toEqual({ turnId: expect.any(String), created: true });
    await expect(readTurns()).resolves.toEqual([
      {
        id: scheduled.turnId,
        state: "queued",
        priority: 0,
        source: "local",
        actorIdentityId: "identity:actor",
      },
    ]);
    await expect(readInputs()).resolves.toEqual([
      { turnId: scheduled.turnId, idempotencyKey: "event-1" },
    ]);
    expect(publishes).toEqual([{ turnId: scheduled.turnId, committed: true }]);
  });

  it("adds a second input to the open Turn without a publish", async () => {
    const first = await schedule("event-1");

    await expect(schedule("event-2")).resolves.toEqual({
      turnId: first.turnId,
      created: false,
    });
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([
      { turnId: first.turnId, idempotencyKey: "event-1" },
      { turnId: first.turnId, idempotencyKey: "event-2" },
    ]);
    expect(publishes).toHaveLength(1);
  });

  it("writes nothing for a duplicate input, and publishes its Turn again only while it is queued", async () => {
    const first = await schedule("event-1");
    const duplicate = { turnId: first.turnId, created: false };

    await expect(schedule("event-1")).resolves.toEqual(duplicate);
    expect(publishes).toHaveLength(2);

    await claimTurn(fixture.sql, {
      turnId: first.turnId,
      owner: "worker-a",
      leaseMs: LEASE_MS,
    });
    await expect(schedule("event-1")).resolves.toEqual(duplicate);

    await cancelTurn(fixture.sql, first.turnId);
    await expect(schedule("event-1")).resolves.toEqual(duplicate);

    expect(publishes).toHaveLength(2);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toHaveLength(1);
  });

  it("rejects a join of a Turn that is not the open Turn, and writes nothing", async () => {
    const first = await schedule("event-1");

    await expect(
      scheduleInput(fixture.sql, input("event-2"), {
        assignTurn: () => ({ join: randomUUID() }),
      }),
    ).rejects.toThrow(`but the open Turn is ${first.turnId}`);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([
      { turnId: first.turnId, idempotencyKey: "event-1" },
    ]);
    expect(publishes).toHaveLength(1);
  });

  it("keeps the Turn and its input when the publish fails, and the retry publishes it", async () => {
    // Injected fault: the queue rejects the send after the commit.
    vi.mocked(getQueueProvider().send).mockRejectedValueOnce(
      new Error("Queue unavailable"),
    );

    await expect(schedule("event-1")).rejects.toThrow("Queue unavailable");
    const [turn] = await readTurns();
    expect(turn).toMatchObject({ state: "queued" });
    await expect(readInputs()).resolves.toEqual([
      { turnId: turn!.id, idempotencyKey: "event-1" },
    ]);

    // The source retries the same input.
    await expect(schedule("event-1")).resolves.toEqual({
      turnId: turn!.id,
      created: false,
    });
    expect(publishes).toEqual([{ turnId: turn!.id, committed: true }]);
  });
});
