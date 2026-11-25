import { eq } from "drizzle-orm";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { getQueueProvider } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { findUnreadInputs, markInputsAttempted } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  endFailedTurn,
  reconcileTurn,
  scheduleInput,
} from "@/core/turn/schedule";
import {
  claimTurn,
  commitStep,
  failTurn,
  releaseTurn,
  stopTurns,
} from "@/core/turn/state";
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
const LOCAL_SOURCE = {
  kind: "local",
  visibility: "private",
  conversationId: CONVERSATION_ID,
} as const;
const WEB_SOURCE = {
  kind: "web",
  visibility: "private",
  conversationId: CONVERSATION_ID,
} as const;
const CONTINUE = { outcome: "continue" as const, messages: [] };
const LEASE_MS = 60_000;

const stepMessageSchema = z.looseObject({ turnId: z.string() });

/** A step message that the queue took, and what a worker could see then. */
type Publish = { turnId: string; committed: boolean };

// The observer reads on its own connection, so it sees only committed rows,
// as a worker that takes the message does. Postgres fixtures share one
// database per test worker; PGlite fixtures do not.
describe.skipIf(!hasJuniorPostgresTestDatabase())("scheduleInput", () => {
  let fixture: LocalJuniorSqlFixture;
  let engineCtx: EngineContext;
  let observer: LocalJuniorSqlFixture;
  let publishes: Publish[];

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    engineCtx = {
      executor: fixture.sql,
      queue: getQueueProvider(),
      owner: "worker-a",
      leaseMs: LEASE_MS,
    };
    observer = await createJuniorSqlFixture();
    await fixture.sql
      .db()
      .insert(juniorIdentities)
      .values(
        ["actor", "other"].map((name) => ({
          createdAt: new Date(),
          id: `identity:${name}`,
          kind: "user" as const,
          provider: "local",
          providerSubjectId: name,
          providerTenantId: "",
          updatedAt: new Date(),
        })),
      );
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
        .select({ state: juniorTurns.state })
        .from(juniorTurns)
        .where(eq(juniorTurns.id, turnId)),
      observer.sql
        .db()
        .select({ id: juniorTurnInbox.id })
        .from(juniorTurnInbox)
        .where(eq(juniorTurnInbox.turnId, turnId)),
    ]);
    // A publish follows the input that went to the Turn, or a stop, which
    // takes the inputs out of the inbox.
    return (
      turns.length === 1 &&
      (inputs.length > 0 || turns[0]!.state === "cancelled")
    );
  }

  function input(idempotencyKey: string): Parameters<typeof scheduleInput>[1] {
    return {
      conversationId: CONVERSATION_ID,
      actorIdentityId: "identity:actor",
      payload: { text: `Message ${idempotencyKey}` },
      idempotencyKey,
      message: { messageId: idempotencyKey, text: `Message ${idempotencyKey}` },
      sentAt: new Date("2026-11-21T08:00:00.000Z"),
      source: LOCAL_SOURCE,
      destination: null,
      delivery: "interrupt",
    };
  }

  // Schedules an input that the test expects in a Turn.
  async function place(args: Parameters<typeof scheduleInput>[1]) {
    const result = await scheduleInput(engineCtx, args);
    if (result.turnId === undefined) {
      throw new Error(`Input ${args.idempotencyKey} went to no Turn`);
    }
    return result;
  }

  function schedule(idempotencyKey: string) {
    return place(input(idempotencyKey));
  }

  async function claim(turnId: string) {
    return (await claimTurn(engineCtx, turnId))!;
  }

  async function readTurns() {
    return fixture.sql
      .db()
      .select({
        id: juniorTurns.id,
        state: juniorTurns.state,
        priority: juniorTurns.priority,
        actorIdentityId: juniorTurns.actorIdentityId,
      })
      .from(juniorTurns);
  }

  async function readEnd(turnId: string) {
    const [turn] = await fixture.sql
      .db()
      .select({
        state: juniorTurns.state,
        endReason: juniorTurns.endReason,
        priority: juniorTurns.priority,
      })
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    return turn;
  }

  function interruptFrom(actorIdentityId: string, idempotencyKey: string) {
    return place({
      ...input(idempotencyKey),
      actorIdentityId,
    });
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

  // The transcript Messages of the inputs that left the inbox.
  async function readMessages() {
    const events = await createSqlConversationEventStore(
      fixture.sql,
    ).loadCurrentHistory(CONVERSATION_ID);
    return events.flatMap(({ data }) =>
      data.type === "message"
        ? [{ messageId: data.messageId, meta: data.meta }]
        : [],
    );
  }

  it("starts a Turn with the first input and publishes it after the commit", async () => {
    const scheduled = await schedule("event-1");

    expect(scheduled).toEqual({ turnId: expect.any(String), created: true });
    await expect(readTurns()).resolves.toEqual([
      {
        id: scheduled.turnId,
        state: "queued",
        priority: 1,
        actorIdentityId: "identity:actor",
      },
    ]);
    await expect(readInputs()).resolves.toEqual([
      { turnId: scheduled.turnId, idempotencyKey: "event-1" },
    ]);
    await expect(
      fixture.sql
        .db()
        .select({ sourceKind: juniorTurns.sourceKind })
        .from(juniorTurns),
    ).resolves.toEqual([{ sourceKind: "local" }]);
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

  it("joins an interrupt from the same Actor and Source to the started Turn", async () => {
    const first = await schedule("event-1");
    await claim(first.turnId);

    await expect(schedule("event-2")).resolves.toEqual({
      turnId: first.turnId,
      created: false,
    });
    expect(publishes).toHaveLength(1);
  });

  it("puts a deferred input in a new Turn while the Turn runs, and joins the next one to it", async () => {
    const first = await schedule("event-1");
    await claim(first.turnId);
    publishes = [];

    const deferred = await place({
      ...input("event-2"),
      delivery: "defer",
    });
    await expect(
      place({ ...input("event-3"), delivery: "defer" }),
    ).resolves.toEqual({ turnId: deferred.turnId, created: false });

    expect(deferred).toEqual({ turnId: expect.any(String), created: true });
    expect(deferred.turnId).not.toBe(first.turnId);
    expect(publishes).toEqual([]);
  });

  it("queues an input from another Actor or Source in its own Turn, so A1 B1 A2 makes A2 wait", async () => {
    const a1 = await schedule("event-1");
    const b1 = await place({
      ...input("event-2"),
      actorIdentityId: "identity:other",
    });
    const a2 = await schedule("event-3");
    const web = await place({
      ...input("event-4"),
      source: WEB_SOURCE,
    });

    expect(new Set([a1, b1, a2, web].map((turn) => turn.turnId)).size).toBe(4);
    expect(publishes).toEqual([{ turnId: a1.turnId, committed: true }]);
  });

  it("claims only the next Turn, and publishes the next one when a Turn ends", async () => {
    const first = await schedule("event-1");
    const second = await place({
      ...input("event-2"),
      actorIdentityId: "identity:other",
    });

    await expect(claimTurn(engineCtx, second.turnId)).resolves.toBeUndefined();
    const running = await claim(first.turnId);
    await expect(claimTurn(engineCtx, second.turnId)).resolves.toBeUndefined();

    await failTurn(engineCtx, running, "overloaded", {
      failureCode: "model_execution_failed",
    });
    publishes = [];
    await reconcileTurn(engineCtx, first.turnId);

    expect(publishes).toEqual([{ turnId: second.turnId, committed: true }]);
    await expect(claimTurn(engineCtx, second.turnId)).resolves.toMatchObject({
      turnId: second.turnId,
    });
  });

  it("supersedes a running Turn for an interrupt from another Actor, and ends it when its step commits", async () => {
    const alice = await schedule("event-1");
    const running = await claim(alice.turnId);
    publishes = [];

    const deferred = await place({
      ...input("event-2"),
      actorIdentityId: "identity:other",
      delivery: "defer",
    });
    const bob = await interruptFrom("identity:other", "event-3");

    expect(publishes).toEqual([{ turnId: bob.turnId, committed: true }]);
    await expect(readEnd(bob.turnId)).resolves.toMatchObject({ priority: 0 });
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toBeUndefined();
    await expect(commitStep(engineCtx, running, CONTINUE, [])).resolves.toBe(
      "superseded",
    );
    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    await expect(readEnd(deferred.turnId)).resolves.toMatchObject({
      state: "queued",
    });
    await expect(readMessages()).resolves.toEqual([
      {
        messageId: "event-1",
        meta: { replied: false, skippedReason: "superseded" },
      },
    ]);
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toMatchObject({
      turnId: bob.turnId,
    });
  });

  it("ends a superseded Turn at once when it waits between steps", async () => {
    const alice = await schedule("event-1");
    await commitStep(engineCtx, await claim(alice.turnId), CONTINUE, []);
    publishes = [];

    const bob = await interruptFrom("identity:other", "event-2");

    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    expect(publishes).toEqual([{ turnId: bob.turnId, committed: true }]);
    await expect(readMessages()).resolves.toEqual([
      {
        messageId: "event-1",
        meta: { replied: false, skippedReason: "superseded" },
      },
    ]);
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toMatchObject({
      turnId: bob.turnId,
    });
  });

  it("ends a superseded Turn whose step fails", async () => {
    const alice = await schedule("event-1");
    const running = await claim(alice.turnId);
    await interruptFrom("identity:other", "event-2");

    await expect(releaseTurn(engineCtx, running)).resolves.toBe(true);

    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    await expect(readMessages()).resolves.toEqual([
      {
        messageId: "event-1",
        meta: { replied: false, skippedReason: "superseded" },
      },
    ]);
  });

  it("sends later inputs past a superseded Turn", async () => {
    const alice = await schedule("event-1");
    await claim(alice.turnId);
    const bob = await interruptFrom("identity:other", "event-2");

    const bobAgain = await interruptFrom("identity:other", "event-3");
    const aliceAgain = await interruptFrom("identity:actor", "event-4");

    expect([alice.turnId, bob.turnId]).not.toContain(aliceAgain.turnId);
    expect(bobAgain.turnId).toBe(bob.turnId);
  });

  it("lets a superseding Turn be superseded in turn", async () => {
    const alice = await schedule("event-1");
    const runningAlice = await claim(alice.turnId);
    const bob = await interruptFrom("identity:other", "event-2");
    await commitStep(engineCtx, runningAlice, CONTINUE, []);
    const runningBob = await claim(bob.turnId);

    const aliceAgain = await interruptFrom("identity:actor", "event-3");

    await expect(readEnd(bob.turnId)).resolves.toMatchObject({ priority: 1 });
    await expect(commitStep(engineCtx, runningBob, CONTINUE, [])).resolves.toBe(
      "superseded",
    );
    await expect(
      claimTurn(engineCtx, aliceAgain.turnId),
    ).resolves.toMatchObject({ turnId: aliceAgain.turnId });
  });

  it("waits for the Conversation lock before it claims a Turn", async () => {
    const turn = await schedule("event-1");
    let claimed: Awaited<ReturnType<typeof claimTurn>> | "pending" = "pending";
    let claiming: Promise<void> | undefined;

    // The observer holds the lock the way scheduleInput does while it places
    // an input, so the claim cannot start the Turn in between.
    await observer.sql.transaction(() =>
      withConversationEventLock(observer.sql, CONVERSATION_ID, async () => {
        claiming = claimTurn(engineCtx, turn.turnId).then((result) => {
          claimed = result;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(claimed).toBe("pending");
      }),
    );
    await claiming;

    expect(claimed).toMatchObject({ turnId: turn.turnId });
  });

  it("writes nothing for a duplicate input, and publishes its Turn again only while it is queued", async () => {
    const first = await schedule("event-1");
    const duplicate = { turnId: first.turnId, created: false };

    await expect(schedule("event-1")).resolves.toEqual(duplicate);
    expect(publishes).toHaveLength(2);

    await claimTurn(engineCtx, first.turnId);
    await expect(schedule("event-1")).resolves.toEqual(duplicate);

    await stopTurns(engineCtx, CONVERSATION_ID);
    // The stop's own message.
    expect(publishes).toHaveLength(3);
    // The stop took the input out of the inbox, so the history has it.
    await expect(scheduleInput(engineCtx, input("event-1"))).resolves.toEqual({
      turnId: undefined,
      created: false,
    });

    expect(publishes).toHaveLength(3);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([]);
    await expect(readMessages()).resolves.toEqual([
      {
        messageId: "event-1",
        meta: { replied: false, skippedReason: "stopped" },
      },
    ]);
  });

  it("writes nothing for an input that a step already read", async () => {
    const first = await schedule("event-1");
    const running = await claim(first.turnId);
    const [unread] = await findUnreadInputs(engineCtx, first.turnId);
    await expect(
      commitStep(engineCtx, running, { outcome: "completed", messages: [] }, [
        {
          source: "input",
          inputId: unread!.inputId,
          message: {
            role: "user",
            content: [{ type: "text", text: "Message event-1" }],
            timestamp: 1_718_123_455_000,
          },
          provenance: instructionProvenanceFor(undefined),
        },
      ]),
    ).resolves.toBe("completed");

    await expect(scheduleInput(engineCtx, input("event-1"))).resolves.toEqual({
      turnId: undefined,
      created: false,
    });

    expect(publishes).toHaveLength(1);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([]);
    await expect(readMessages()).resolves.toEqual([
      { messageId: "event-1", meta: undefined },
    ]);
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

  it("moves a failed Turn's unclaimed inputs to a new Turn in the fail commit, and reconcileTurn publishes it", async () => {
    const failed = await schedule("event-1");
    const claimed = await claim(failed.turnId);
    await schedule("event-2");
    const fail = () =>
      endFailedTurn(engineCtx, claimed, "overloaded", {
        failureCode: "model_execution_failed",
      });

    await expect(fail()).resolves.toBe(true);

    const next = (await readTurns()).find((turn) => turn.id !== failed.turnId);
    expect(next).toEqual({
      id: expect.any(String),
      state: "queued",
      priority: 1,
      actorIdentityId: "identity:actor",
    });
    const moved = [
      { turnId: next!.id, idempotencyKey: "event-1" },
      { turnId: next!.id, idempotencyKey: "event-2" },
    ];
    await expect(readInputs()).resolves.toEqual(moved);
    publishes = [];

    await reconcileTurn(engineCtx, failed.turnId);
    expect(publishes).toEqual([{ turnId: next!.id, committed: true }]);

    // The lease is gone, so a second fail changes nothing.
    await expect(fail()).resolves.toBe(false);
    await expect(readTurns()).resolves.toHaveLength(2);
    await expect(readInputs()).resolves.toEqual(moved);
  });

  it("moves a failed Turn's unclaimed inputs to the open Turn when one exists", async () => {
    const failed = await schedule("event-1");
    const claimed = await claim(failed.turnId);
    await schedule("event-2");
    const open = await place({
      ...input("event-3"),
      delivery: "defer",
    });

    await endFailedTurn(engineCtx, claimed, "overloaded", {
      failureCode: "model_execution_failed",
    });

    await expect(readTurns()).resolves.toHaveLength(2);
    await expect(readInputs()).resolves.toEqual([
      { turnId: open.turnId, idempotencyKey: "event-1" },
      { turnId: open.turnId, idempotencyKey: "event-2" },
      { turnId: open.turnId, idempotencyKey: "event-3" },
    ]);
  });

  it("moves nothing for a completed Turn", async () => {
    const completed = await schedule("event-1");
    await fixture.sql
      .db()
      .update(juniorTurns)
      .set({ state: "completed", endedAt: new Date() })
      .where(eq(juniorTurns.id, completed.turnId));

    await reconcileTurn(engineCtx, completed.turnId);

    await expect(readInputs()).resolves.toEqual([
      { turnId: completed.turnId, idempotencyKey: "event-1" },
    ]);
    expect(publishes).toHaveLength(1);
  });

  it("publishes a cancelled Turn, whose input leaves the inbox as a skipped Message", async () => {
    const cancelled = await schedule("event-1");

    await stopTurns(engineCtx, CONVERSATION_ID);
    await reconcileTurn(engineCtx, cancelled.turnId);

    expect(publishes).toEqual([
      { turnId: cancelled.turnId, committed: true },
      { turnId: cancelled.turnId, committed: true },
    ]);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([]);
    await expect(readMessages()).resolves.toEqual([
      {
        messageId: "event-1",
        meta: { replied: false, skippedReason: "stopped" },
      },
    ]);
  });

  it("stops the running Turn and the Turn queued behind it, so no Turn starts", async () => {
    const running = await schedule("event-1");
    await claim(running.turnId);
    const queued = await place({
      ...input("event-2"),
      actorIdentityId: "identity:other",
      delivery: "defer",
    });
    publishes = [];

    const stopped = await stopTurns(engineCtx, CONVERSATION_ID);
    // The step consumer runs reconcileTurn for the stop's message.
    const [published] = publishes;
    await reconcileTurn(engineCtx, published!.turnId);

    expect([...stopped].sort()).toEqual([running.turnId, queued.turnId].sort());
    await expect(readEnd(running.turnId)).resolves.toMatchObject({
      state: "cancelled",
    });
    await expect(readEnd(queued.turnId)).resolves.toMatchObject({
      state: "cancelled",
    });
    // Only the stop's own message: reconcileTurn found no Turn to start.
    expect(publishes).toEqual([published]);
  });

  it("keeps the first attempt time of an input", async () => {
    await schedule("event-1");
    const [input] = await fixture.sql
      .db()
      .select({ id: juniorTurnInbox.id })
      .from(juniorTurnInbox);
    const readAttemptedAt = async () =>
      (
        await fixture.sql
          .db()
          .select({ attemptedAt: juniorTurnInbox.attemptedAt })
          .from(juniorTurnInbox)
      )[0]!.attemptedAt;

    await markInputsAttempted(engineCtx, [input!.id]);
    const first = await readAttemptedAt();
    // A later attempt has a later now().
    await new Promise((resolve) => setTimeout(resolve, 10));
    await markInputsAttempted(engineCtx, [input!.id]);

    expect(first).toBeInstanceOf(Date);
    await expect(readAttemptedAt()).resolves.toEqual(first);
  });
});
