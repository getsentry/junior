import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import {
  cancelTurn,
  claimTurn,
  commitStep,
  completeTurn,
  failTurn,
  holdsLease,
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

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const LEASE_MS = 60_000;
// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

describe("Turn state", () => {
  let fixture: LocalJuniorSqlFixture;
  let turnId: string;

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
    turnId = await insertQueuedTurn(CONVERSATION_ID);
  });

  afterEach(async () => {
    await fixture.close();
  });

  // This module does not create Turns, so the test writes queued ones. A
  // Conversation has at most one active Turn, so each gets its own.
  async function insertQueuedTurn(conversationId: string) {
    const conversation = buildJuniorSqlConversation({ conversationId });
    await fixture.sql.db().insert(juniorConversations).values(conversation);
    const id = randomUUID();
    await fixture.sql.db().insert(juniorTurns).values({
      id,
      conversationId,
      actorIdentityId: "identity:actor",
      state: "queued",
    });
    return id;
  }

  async function readTurn(id = turnId) {
    const [turn] = await fixture.sql
      .db()
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.id, id));
    return turn!;
  }

  async function loadHistory() {
    const events = await createSqlConversationEventStore(
      fixture.sql,
    ).loadCurrentHistory(CONVERSATION_ID);
    return {
      types: events.map((event) => event.data.type),
      messages: projectConversationEvents(events).messages,
    };
  }

  function claim(owner = "worker-a", leaseMs = LEASE_MS) {
    return claimTurn(fixture.sql, { turnId, owner, leaseMs });
  }

  it("claims a queued Turn for exactly one of two concurrent workers", async () => {
    const claims = await Promise.all([claim("worker-a"), claim("worker-b")]);

    const winners = claims.filter((claimed) => claimed !== undefined);
    expect(winners).toEqual([
      {
        turnId,
        conversationId: CONVERSATION_ID,
        stepSeq: 0,
        leaseEpoch: 1,
        attempts: 1,
      },
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

  it("takes over a running Turn whose lease expired, and fences out the old holder", async () => {
    const stale = (await claim("worker-a", EXPIRED_LEASE_MS))!;

    const taken = await claim("worker-b");
    expect(taken).toEqual({
      turnId,
      conversationId: CONVERSATION_ID,
      stepSeq: 0,
      leaseEpoch: 2,
      attempts: 2,
    });
    const running = await readTurn();
    expect(running).toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      leaseEpoch: 2,
      attempts: 2,
    });
    expect(running.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    await expect(holdsLease(fixture.sql, taken!)).resolves.toBe(true);
    await expect(holdsLease(fixture.sql, stale)).resolves.toBe(false);
    await expect(commitStep(fixture.sql, stale, finishedStep())).resolves.toBe(
      false,
    );
    await expect(completeTurn(fixture.sql, stale)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(running);
    await expect(loadHistory()).resolves.toEqual({ types: [], messages: [] });
  });

  it("does not take over a running Turn whose lease is live", async () => {
    await claim("worker-a");
    const running = await readTurn();

    await expect(claim("worker-b")).resolves.toBeUndefined();
    await expect(readTurn()).resolves.toEqual(running);
  });

  it("gives an expired Turn to exactly one of two concurrent workers", async () => {
    await claim("worker-a", EXPIRED_LEASE_MS);

    const claims = await Promise.all([claim("worker-b"), claim("worker-c")]);

    const winners = claims.filter((claimed) => claimed !== undefined);
    expect(winners).toMatchObject([{ leaseEpoch: 2, attempts: 2 }]);
    const turn = await readTurn();
    // The losing takeover wrote nothing, so each counter went up once.
    expect(turn).toMatchObject({ leaseEpoch: 2, attempts: 2 });
    expect(["worker-b", "worker-c"]).toContain(turn.leaseOwner);
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
    await expect(completeTurn(fixture.sql, stale)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(queued);

    const reclaimed = await claim("worker-b");
    expect(reclaimed).toEqual({
      turnId,
      conversationId: CONVERSATION_ID,
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

  it("queues only running Turns whose lease expired", async () => {
    await claim("worker-a", EXPIRED_LEASE_MS);
    const live = await insertQueuedTurn("slack:C123:live");
    await claimTurn(fixture.sql, {
      turnId: live,
      owner: "worker-b",
      leaseMs: LEASE_MS,
    });
    const queued = await insertQueuedTurn("slack:C123:queued");
    const ended = await insertQueuedTurn("slack:C123:ended");
    const endedLease = (await claimTurn(fixture.sql, {
      turnId: ended,
      owner: "worker-c",
      leaseMs: EXPIRED_LEASE_MS,
    }))!;
    await completeTurn(fixture.sql, endedLease);
    const others = [live, queued, ended];
    const before = await Promise.all(others.map((id) => readTurn(id)));

    await expect(reclaimExpired(fixture.sql)).resolves.toEqual([turnId]);
    await expect(
      Promise.all(others.map((id) => readTurn(id))),
    ).resolves.toEqual(before);
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
    await expect(holdsLease(fixture.sql, claimed)).resolves.toBe(false);
    await expect(completeTurn(fixture.sql, claimed)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(cancelled);
  });

  it("cancels a queued Turn so no worker can claim it", async () => {
    await expect(cancelTurn(fixture.sql, turnId)).resolves.toBe(true);
    const cancelled = await readTurn();
    expect(cancelled).toMatchObject({
      state: "cancelled",
      leaseEpoch: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(cancelled.endedAt).toBeInstanceOf(Date);
    await expect(claim()).resolves.toBeUndefined();
    await expect(readTurn()).resolves.toEqual(cancelled);
  });

  it("commits a step: appends its messages and moves the Turn to the next step", async () => {
    // A retried step: the commit resets attempts.
    await claim("worker-a", EXPIRED_LEASE_MS);
    await reclaimExpired(fixture.sql);
    const claimed = (await claim("worker-b"))!;
    expect(claimed).toMatchObject({ leaseEpoch: 2, attempts: 2 });
    const messages = [toolCallReply(), toolResult()];

    await expect(
      commitStep(fixture.sql, claimed, { outcome: "continue", messages }),
    ).resolves.toBe(true);

    await expect(readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      leaseEpoch: 2,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      endedAt: null,
    });
    await expect(loadHistory()).resolves.toEqual({
      types: ["assistant_message", "tool_result"],
      messages,
    });
  });

  it("lets a new claim take the next step at once, and fences out the old lease", async () => {
    const first = (await claim("worker-a"))!;
    await commitStep(fixture.sql, first, {
      outcome: "continue",
      messages: [toolCallReply(), toolResult()],
    });

    await expect(claim("worker-b")).resolves.toEqual({
      turnId,
      conversationId: CONVERSATION_ID,
      stepSeq: 1,
      leaseEpoch: 2,
      attempts: 1,
    });
    const running = await readTurn();
    expect(running).toMatchObject({ state: "running", leaseOwner: "worker-b" });

    await expect(commitStep(fixture.sql, first, finishedStep())).resolves.toBe(
      false,
    );
    await expect(readTurn()).resolves.toEqual(running);
  });

  it("ends the Turn when the committed step completed it", async () => {
    const claimed = (await claim())!;
    const messages = [finalReply()];

    await expect(
      commitStep(fixture.sql, claimed, { outcome: "completed", messages }),
    ).resolves.toBe(true);

    const completed = await readTurn();
    expect(completed).toMatchObject({
      state: "completed",
      stepSeq: 1,
      leaseEpoch: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(completed.endedAt).toBeInstanceOf(Date);
    await expect(loadHistory()).resolves.toEqual({
      types: ["assistant_message"],
      messages,
    });
  });

  it("rejects a second commit of the same step, and appends nothing", async () => {
    const claimed = (await claim())!;
    const messages = [toolCallReply(), toolResult()];
    await commitStep(fixture.sql, claimed, { outcome: "continue", messages });
    const committed = await readTurn();

    await expect(
      commitStep(fixture.sql, claimed, { outcome: "continue", messages }),
    ).resolves.toBe(false);

    expect(committed.stepSeq).toBe(1);
    await expect(readTurn()).resolves.toEqual(committed);
    await expect(loadHistory()).resolves.toEqual({
      types: ["assistant_message", "tool_result"],
      messages,
    });
  });

  it("rejects a commit after reclaim or with a stale lease_epoch, and appends nothing", async () => {
    const stale = (await claim("worker-a", EXPIRED_LEASE_MS))!;
    await reclaimExpired(fixture.sql);
    const queued = await readTurn();

    await expect(commitStep(fixture.sql, stale, finishedStep())).resolves.toBe(
      false,
    );
    await expect(readTurn()).resolves.toEqual(queued);

    await claim("worker-b");
    const running = await readTurn();
    await expect(commitStep(fixture.sql, stale, finishedStep())).resolves.toBe(
      false,
    );
    await expect(readTurn()).resolves.toEqual(running);
    await expect(loadHistory()).resolves.toEqual({ types: [], messages: [] });
  });

  it("rejects a commit after cancel, and appends nothing", async () => {
    const claimed = (await claim())!;
    await cancelTurn(fixture.sql, turnId);
    const cancelled = await readTurn();

    await expect(
      commitStep(fixture.sql, claimed, finishedStep()),
    ).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(cancelled);
    await expect(loadHistory()).resolves.toEqual({ types: [], messages: [] });
  });
});

function reply(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1_718_123_456_000,
  };
}

function toolCallReply() {
  return reply(
    [
      {
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        arguments: { query: "turns" },
      },
    ],
    "toolUse",
  );
}

function toolResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "lookup",
    content: [{ type: "text", text: "3 Turns" }],
    isError: false,
    timestamp: 1_718_123_457_000,
  };
}

function finalReply() {
  return reply([{ type: "text", text: "There are 3 Turns." }], "stop");
}

function finishedStep() {
  return { outcome: "completed" as const, messages: [finalReply()] };
}
