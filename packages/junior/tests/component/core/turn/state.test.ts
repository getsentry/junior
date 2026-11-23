import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { getQueueProvider } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { findUnreadInputs } from "@/core/turn/inbox";
import {
  cancelTurn,
  claimTurn,
  commitStep,
  failTurn,
  holdsLease,
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
  type LocalJuniorSqlFixture,
} from "../../../fixtures/sql";

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const ACTOR = { platform: "slack", teamId: "T123", userId: "U123" } as const;
const LEASE_MS = 60_000;
// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

describe("Turn state", () => {
  let fixture: LocalJuniorSqlFixture;
  let engineCtx: EngineContext;
  let turnId: string;

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    engineCtx = {
      executor: fixture.sql,
      queue: getQueueProvider(),
      owner: "worker-a",
      leaseMs: LEASE_MS,
    };
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
    // The queue is the external edge: cancelTurn publishes the Turn.
    vi.spyOn(getQueueProvider(), "send").mockResolvedValue({});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    return claimTurn({ ...engineCtx, owner, leaseMs }, turnId);
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
        sentAt: new Date(1_718_123_455_000),
      });
    return inputId;
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

    await expect(holdsLease(engineCtx, taken!)).resolves.toBe(true);
    await expect(holdsLease(engineCtx, stale)).resolves.toBe(false);
    await expect(
      commitStep(engineCtx, stale, finishedStep(), []),
    ).resolves.toBeUndefined();
    await expect(
      failTurn(engineCtx, stale, "late", {
        failureCode: "model_execution_failed",
      }),
    ).resolves.toBe(false);
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

  it("fails a running Turn with its end reason and failure details", async () => {
    const claimed = (await claim())!;

    await expect(
      failTurn(engineCtx, claimed, "Model request failed", {
        failureCode: "model_execution_failed",
        failureReason: "rate_limit",
        eventId: "0123456789abcdef0123456789abcdef",
      }),
    ).resolves.toBe(true);
    const failed = await readTurn();
    expect(failed).toMatchObject({
      state: "failed",
      endReason: "Model request failed",
      failureCode: "model_execution_failed",
      failureReason: "rate_limit",
      failureEventId: "0123456789abcdef0123456789abcdef",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(failed.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a running Turn and fences out its lease holder", async () => {
    const claimed = (await claim())!;

    await expect(cancelTurn(engineCtx, turnId)).resolves.toBe(true);
    const cancelled = await readTurn();
    expect(cancelled).toMatchObject({
      state: "cancelled",
      leaseEpoch: 2,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(cancelled.endedAt).toBeInstanceOf(Date);
    await expect(holdsLease(engineCtx, claimed)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(cancelled);
  });

  it("cancels a queued Turn so no worker can claim it", async () => {
    await expect(cancelTurn(engineCtx, turnId)).resolves.toBe(true);
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
    const claimed = (await claim("worker-b"))!;
    expect(claimed).toMatchObject({ leaseEpoch: 2, attempts: 2 });
    const messages = [toolCallReply(), toolResult()];

    await expect(
      commitStep(engineCtx, claimed, { outcome: "continue", messages }, []),
    ).resolves.toBe("continue");

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
    await commitStep(
      engineCtx,
      first,
      { outcome: "continue", messages: [toolCallReply(), toolResult()] },
      [],
    );

    await expect(claim("worker-b")).resolves.toEqual({
      turnId,
      conversationId: CONVERSATION_ID,
      stepSeq: 1,
      leaseEpoch: 2,
      attempts: 1,
    });
    const running = await readTurn();
    expect(running).toMatchObject({ state: "running", leaseOwner: "worker-b" });

    await expect(
      commitStep(engineCtx, first, finishedStep(), []),
    ).resolves.toBeUndefined();
    await expect(readTurn()).resolves.toEqual(running);
  });

  it("ends the Turn when the committed step completed it, and a terminal Turn takes no other change", async () => {
    const claimed = (await claim())!;
    const messages = [finalReply()];

    await expect(
      commitStep(engineCtx, claimed, { outcome: "completed", messages }, []),
    ).resolves.toBe("completed");

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

    await expect(claim()).resolves.toBeUndefined();
    await expect(
      failTurn(engineCtx, claimed, "late", {
        failureCode: "model_execution_failed",
      }),
    ).resolves.toBe(false);
    await expect(cancelTurn(engineCtx, turnId)).resolves.toBe(false);
    await expect(readTurn()).resolves.toEqual(completed);
  });

  it("rejects a second commit of the same step, and appends nothing", async () => {
    const claimed = (await claim())!;
    const messages = [toolCallReply(), toolResult()];
    await commitStep(engineCtx, claimed, { outcome: "continue", messages }, []);
    const committed = await readTurn();

    await expect(
      commitStep(engineCtx, claimed, { outcome: "continue", messages }, []),
    ).resolves.toBeUndefined();

    expect(committed.stepSeq).toBe(1);
    await expect(readTurn()).resolves.toEqual(committed);
    await expect(loadHistory()).resolves.toEqual({
      types: ["assistant_message", "tool_result"],
      messages,
    });
  });

  it("appends the inputs before the step's messages, and writes each input once", async () => {
    const inputId = await addTestInput("How many Turns?");
    const input = {
      inputId,
      message: question(),
      provenance: instructionProvenanceFor(ACTOR),
    };
    const first = (await claim())!;
    await expect(
      commitStep(
        engineCtx,
        first,
        { outcome: "continue", messages: [toolCallReply(), toolResult()] },
        [input],
      ),
    ).resolves.toBe("continue");
    const second = (await claim())!;

    // The input again, as a step that read it a second time would pass it.
    await expect(
      commitStep(engineCtx, second, finishedStep(), [input]),
    ).resolves.toBe("completed");

    const events = await createSqlConversationEventStore(
      fixture.sql,
    ).loadCurrentHistory(CONVERSATION_ID);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `inbox:${inputId}`,
      `step:${turnId}:0:0`,
      `step:${turnId}:0:1`,
      `step:${turnId}:1:0`,
    ]);
    expect(events[0]!.data).toMatchObject({
      type: "user_message",
      provenance: { authority: "instruction", actor: ACTOR },
    });
    await expect(loadHistory()).resolves.toEqual({
      types: [
        "user_message",
        "assistant_message",
        "tool_result",
        "assistant_message",
      ],
      messages: [question(), toolCallReply(), toolResult(), finalReply()],
    });
    await expect(findUnreadInputs(engineCtx, turnId)).resolves.toEqual([]);
  });

  it("rejects a commit after cancel, and appends nothing", async () => {
    const claimed = (await claim())!;
    await cancelTurn(engineCtx, turnId);
    const cancelled = await readTurn();

    await expect(
      commitStep(engineCtx, claimed, finishedStep(), []),
    ).resolves.toBeUndefined();
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

function question(): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "How many Turns?" }],
    timestamp: 1_718_123_455_000,
  };
}

function finalReply() {
  return reply([{ type: "text", text: "There are 3 Turns." }], "stop");
}

function finishedStep() {
  return { outcome: "completed" as const, messages: [finalReply()] };
}
