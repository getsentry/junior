import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelTurn,
  claimTurn,
  completeTurn,
  failTurn,
  heartbeat,
  reclaimExpired,
} from "@/core/turn/state";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurns,
} from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../../fixtures/sql";

const LEASE_MS = 60_000;
// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

describe("Turn state", () => {
  let fixture: LocalJuniorSqlFixture;
  let turnId: string;

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    const conversation = buildJuniorSqlConversation();
    await fixture.sql.db().insert(juniorConversations).values(conversation);
    await fixture.sql.db().insert(juniorIdentities).values({
      createdAt: new Date(),
      id: "identity:actor",
      kind: "user",
      provider: "slack",
      providerSubjectId: "U123",
      providerTenantId: "T123",
      updatedAt: new Date(),
    });
    // This module does not create Turns, so the test writes a queued one.
    turnId = randomUUID();
    await fixture.sql.db().insert(juniorTurns).values({
      id: turnId,
      conversationId: conversation.conversationId,
      actorIdentityId: "identity:actor",
      state: "queued",
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function readTurn() {
    const [turn] = await fixture.sql
      .db()
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    return turn!;
  }

  function claim(owner = "worker-a", leaseMs = LEASE_MS) {
    return claimTurn(fixture.sql, { turnId, owner, leaseMs });
  }

  it("claims a queued Turn for exactly one of two concurrent workers", async () => {
    const claims = await Promise.all([claim("worker-a"), claim("worker-b")]);

    const winners = claims.filter((claimed) => claimed !== undefined);
    expect(winners).toEqual([
      { turnId, stepSeq: 0, leaseEpoch: 1, attempts: 1 },
    ]);
    const turn = await readTurn();
    // The losing claim wrote nothing, so each counter went up once.
    expect(turn).toMatchObject({
      state: "running",
      stepSeq: 0,
      leaseEpoch: 1,
      attempts: 1,
    });
    expect(["worker-a", "worker-b"]).toContain(turn.leaseOwner);
    expect(turn.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("extends the lease, and rejects a heartbeat with a stale lease_epoch", async () => {
    const claimed = (await claim("worker-a", EXPIRED_LEASE_MS))!;

    await expect(heartbeat(fixture.sql, claimed, LEASE_MS)).resolves.toBe(true);
    await expect(reclaimExpired(fixture.sql)).resolves.toEqual([]);

    const before = await readTurn();
    await expect(
      heartbeat(
        fixture.sql,
        { turnId, leaseEpoch: claimed.leaseEpoch - 1 },
        LEASE_MS * 10,
      ),
    ).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(before);
  });

  it("queues a Turn whose lease expired and fences out the old lease holder", async () => {
    const stale = (await claim("worker-a", EXPIRED_LEASE_MS))!;

    await expect(reclaimExpired(fixture.sql)).resolves.toEqual([turnId]);
    const queued = await readTurn();
    expect(queued).toMatchObject({
      state: "queued",
      leaseEpoch: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(heartbeat(fixture.sql, stale, LEASE_MS)).resolves.toBe(false);
    await expect(completeTurn(fixture.sql, stale)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(queued);

    const reclaimed = await claim("worker-b");
    expect(reclaimed).toEqual({
      turnId,
      stepSeq: 0,
      leaseEpoch: 2,
      attempts: 2,
    });
    await expect(failTurn(fixture.sql, stale, "late")).resolves.toBe(false);
    await expect(readTurn()).resolves.toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      endReason: null,
    });
  });

  it("completes a running Turn, and a terminal Turn takes no other change", async () => {
    const claimed = (await claim())!;

    await expect(completeTurn(fixture.sql, claimed)).resolves.toBe(true);
    const completed = await readTurn();
    expect(completed).toMatchObject({
      state: "completed",
      leaseEpoch: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      endReason: null,
    });
    expect(completed.endedAt).toBeInstanceOf(Date);

    await expect(claim()).resolves.toBeUndefined();
    await expect(heartbeat(fixture.sql, claimed, LEASE_MS)).resolves.toBe(
      false,
    );
    await expect(failTurn(fixture.sql, claimed, "late")).resolves.toBe(false);
    await expect(cancelTurn(fixture.sql, turnId)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(completed);
  });

  it("fails a running Turn with its end reason", async () => {
    const claimed = (await claim())!;

    await expect(
      failTurn(fixture.sql, claimed, "Model request failed"),
    ).resolves.toBe(true);
    const failed = await readTurn();
    expect(failed).toMatchObject({
      state: "failed",
      endReason: "Model request failed",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(failed.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a running Turn and fences out its lease holder", async () => {
    const claimed = (await claim())!;

    await expect(cancelTurn(fixture.sql, turnId)).resolves.toBe(true);
    const cancelled = await readTurn();
    expect(cancelled).toMatchObject({
      state: "cancelled",
      leaseEpoch: 2,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(cancelled.endedAt).toBeInstanceOf(Date);
    await expect(completeTurn(fixture.sql, claimed)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(cancelled);
  });
});
