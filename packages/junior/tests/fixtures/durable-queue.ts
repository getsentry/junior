/**
 * Checks and lease faults for `tests/integration/durable-queue.test.ts`: the
 * durable state that its Slack harness leaves behind (terminal Turns, a later
 * Turn, another person's Turn, saved assistant history) and expired leases.
 */
import type { StateAdapter } from "chat";
import { expect } from "vitest";
import { readConversationAuthors } from "@/api/conversations/participants";
import { getConversationEventStore, getDb } from "@/chat/db";
import { loadProjection } from "@/chat/conversations/projection";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
import {
  CONVERSATION_ID,
  SLACK_BOT_USER_ID,
  SLACK_DESTINATION,
} from "./conversation-work";

/** The parts of the durable-queue Slack harness that these checks read. */
export interface DurableQueueHarness {
  state: StateAdapter;
  wakes: Parameters<typeof recoverConversationWork>[0]["queue"] & {
    hasQueuedMessages(): boolean;
  };
  replies(): string[];
  next(): Promise<unknown>;
  send(input: {
    text?: string;
    threadTs?: string;
    ts?: string;
  }): Promise<unknown>;
}

/** Assert the durable state left by a turn that cannot run again. */
export async function expectTerminalTurn(
  q: DurableQueueHarness,
  expected: {
    turnId: string;
    state: "completed" | "failed";
    replies: string[] | number;
    error?: string;
  },
): Promise<void> {
  const record = await getTurnRecord(CONVERSATION_ID, expected.turnId);
  expect(record).toMatchObject({
    state: expected.state,
    turnId: expected.turnId,
  });
  expect(record?.errorMessage ?? "").toContain(expected.error ?? "");
  await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: expected.state,
        turnId: expected.turnId,
      }),
    ]),
  );

  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
  expect(conversation.processing.activeTurnId).toBeUndefined();
  expect(conversation.processing.pendingAuth).toBeUndefined();
  await expect(
    getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: q.state,
    }),
  ).resolves.toMatchObject({ needsRun: false, messages: [] });
  expect(q.wakes.hasQueuedMessages()).toBe(false);

  const replies = q.replies();
  const replyCount =
    typeof expected.replies === "number"
      ? expected.replies
      : expected.replies.length;
  const expectedReplies =
    typeof expected.replies === "number" ? replies : expected.replies;
  expect(replies).toHaveLength(replyCount);
  expect(replies).toEqual(expectedReplies);
}

/** Prove that a terminal turn does not block a later user request. */
export async function expectNextTurn(
  q: DurableQueueHarness,
  ts: string,
): Promise<void> {
  const priorTurns = new Set(
    (await listTurnSummaries(CONVERSATION_ID)).map((turn) => turn.turnId),
  );
  const priorReplies = q.replies();
  await q.send({
    text: `<@${SLACK_BOT_USER_ID}> check the next deploy`,
    threadTs: "1712345.0001",
    ts,
  });
  await expect(q.next()).resolves.toEqual({ status: "completed" });

  const nextTurn = (await listTurnSummaries(CONVERSATION_ID)).find(
    (turn) => !priorTurns.has(turn.turnId),
  );
  if (!nextTurn) throw new Error("Expected a new turn");
  expect(nextTurn).toMatchObject({ state: "completed" });
  await expectTerminalTurn(q, {
    turnId: nextTurn.turnId,
    state: "completed",
    replies: [...priorReplies, "Deploy checked."],
  });
}

/** Assert that SQL history keeps an assistant message with `text`. */
export async function expectAssistantInSql(text: string): Promise<void> {
  await expect(
    loadProjection({ conversationId: CONVERSATION_ID }),
  ).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text,
          }),
        ]),
      }),
    ]),
  );
}

/**
 * Assert that another person's mention (`U0OTHER`, ts `1712345.0002`) ended
 * `endedTurnId` and ran as its own Turn with that person's credentials.
 */
export async function expectAnotherPersonsTurn(
  q: DurableQueueHarness,
  expected: { endedTurnId: string; otherText: string },
): Promise<void> {
  // The first Turn ends without the other person's message, and the other
  // person's Turn runs as them. No other Turn exists or stays open.
  const ended = await getTurnRecord(CONVERSATION_ID, expected.endedTurnId);
  expect(ended?.actor).toMatchObject({ userId: "U123" });
  expect(JSON.stringify(ended?.piMessages)).not.toContain(expected.otherText);
  const otherTurnId = "turn_1712345_0002";
  const summaries = await listTurnSummaries(CONVERSATION_ID);
  expect(
    summaries.map((summary) => [summary.turnId, summary.state]).sort(),
  ).toEqual([
    [expected.endedTurnId, "abandoned"],
    [otherTurnId, "completed"],
  ]);
  await expect(
    getTurnRecord(CONVERSATION_ID, otherTurnId),
  ).resolves.toMatchObject({
    actor: expect.objectContaining({ userId: "U0OTHER" }),
  });
  await expect(
    new ConversationTurnLifecycleService(
      getConversationEventStore(),
    ).loadInputMessageIds(CONVERSATION_ID, otherTurnId),
  ).resolves.toEqual([expect.stringContaining("1712345.0002")]);
  const { participants } = await readConversationAuthors(
    getDb(),
    CONVERSATION_ID,
  );
  expect(participants).toContainEqual(
    expect.objectContaining({ slackUserId: "U0OTHER" }),
  );
  expect(q.replies()).toEqual(["Deploy checked."]);
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  expect(conversation.processing.activeTurnId).toBeUndefined();
  await expect(
    getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: q.state,
    }),
  ).resolves.toMatchObject({ needsRun: false, messages: [] });
}

/** Expire the lease of a worker that died before the Run started. */
export async function expireDeadWorkerLease(
  q: DurableQueueHarness,
): Promise<void> {
  await requestConversationWork({
    conversationId: CONVERSATION_ID,
    destination: SLACK_DESTINATION,
    nowMs: 1_000,
    state: q.state,
  });
  await startConversationWork({
    conversationId: CONVERSATION_ID,
    nowMs: 1_000,
    state: q.state,
  });
  await expect(
    recoverConversationWork({
      nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
      queue: q.wakes,
      state: q.state,
    }),
  ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
}

/** Expire the lease of a worker that still runs, `afterMs` from now. */
export async function expireLiveWorkerLease(
  q: DurableQueueHarness,
  afterMs: number,
) {
  await expect(
    recoverConversationWork({
      nowMs: Date.now() + afterMs,
      queue: q.wakes,
      state: q.state,
    }),
  ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
}
