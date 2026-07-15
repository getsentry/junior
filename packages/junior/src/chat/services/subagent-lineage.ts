import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import type {
  ConversationEvent,
  ConversationEventData,
} from "@/chat/conversations/history";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";

export type SubagentHistoryMode = "isolated" | "shared";

export interface StartSubagentReferenceInput {
  childConversationId: string;
  historyMode: SubagentHistoryMode;
  modelId?: string;
  nowMs?: number;
  parentConversationId: string;
  parentToolCallId?: string;
  parentTurnId: string;
  reasoningLevel?: string;
  subagentInvocationId: string;
  subagentKind: string;
}

export interface SubagentLineage {
  childConversationId: string;
  contextForkSeq: number | null;
  parentConversationId: string;
  parentEventSeq: number;
  parentTurnId: string;
  rootConversationId: string;
}

export interface FinishSubagentReferenceInput {
  nowMs?: number;
  outcome: "aborted" | "error" | "success";
  parentConversationId: string;
  parentTurnId: string;
  subagentInvocationId: string;
}

/** Raised when a retry attempts to change an immutable subagent reference. */
export class SubagentLineageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentLineageConflictError";
  }
}

function startedKey(subagentInvocationId: string): string {
  return `subagent:${subagentInvocationId}:started`;
}

function endedKey(subagentInvocationId: string): string {
  return `subagent:${subagentInvocationId}:ended`;
}

function eventWithKey(
  history: ConversationEvent[],
  idempotencyKey: string,
): ConversationEvent | undefined {
  return history.find((event) => event.idempotencyKey === idempotencyKey);
}

function expectedStartData(
  input: StartSubagentReferenceInput,
): Extract<ConversationEventData, { type: "subagent_started" }> {
  return {
    type: "subagent_started",
    subagentInvocationId: input.subagentInvocationId,
    subagentKind: input.subagentKind,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.parentToolCallId
      ? { parentToolCallId: input.parentToolCallId }
      : {}),
    ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
    childConversationId: input.childConversationId,
    parentTurnId: input.parentTurnId,
    historyMode: input.historyMode,
  };
}

function expectedEndData(
  input: FinishSubagentReferenceInput,
): Extract<ConversationEventData, { type: "subagent_ended" }> {
  return {
    type: "subagent_ended",
    subagentInvocationId: input.subagentInvocationId,
    parentTurnId: input.parentTurnId,
    outcome: input.outcome,
  };
}

function assertExactEvent(
  event: ConversationEvent | undefined,
  expected: ConversationEventData,
  label: string,
): asserts event is ConversationEvent {
  if (!event || !isDeepStrictEqual(event.data, expected)) {
    throw new SubagentLineageConflictError(
      `${label} conflicts with the persisted subagent reference`,
    );
  }
}

/**
 * Own immutable SQL lineage and parent-stream references for subagent runs.
 * Child execution events remain in the child conversation's event stream.
 */
export class SubagentLineageService {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  /** Append the parent start reference and establish the correlated child row atomically. */
  async start(input: StartSubagentReferenceInput): Promise<SubagentLineage> {
    if (input.childConversationId === input.parentConversationId) {
      throw new SubagentLineageConflictError(
        "A subagent conversation cannot be its own parent",
      );
    }
    const eventStore = createSqlConversationEventStore(this.executor);
    const expected = expectedStartData(input);

    return await withConversationEventLock(
      this.executor,
      input.parentConversationId,
      async () =>
        await this.executor.transaction(async () => {
          const rootConversationId = await this.resolveRootConversationId(
            input.parentConversationId,
          );
          let history = await eventStore.loadHistory(
            input.parentConversationId,
          );
          if (
            !history.some(
              (event) =>
                event.data.type === "turn_started" &&
                event.data.turnId === input.parentTurnId,
            )
          ) {
            throw new SubagentLineageConflictError(
              "Subagent start does not match a parent turn",
            );
          }
          const existingInvocation = history.find(
            (event) =>
              event.data.type === "subagent_started" &&
              event.data.subagentInvocationId === input.subagentInvocationId,
          );
          const key = startedKey(input.subagentInvocationId);
          let start = eventWithKey(history, key);
          if (!start && existingInvocation) {
            throw new SubagentLineageConflictError(
              "Subagent invocation already has a different start reference",
            );
          }
          if (!start) {
            await eventStore.append(input.parentConversationId, [
              {
                data: expected,
                idempotencyKey: key,
                createdAtMs: input.nowMs ?? Date.now(),
              },
            ]);
            history = await eventStore.loadHistory(input.parentConversationId);
            start = eventWithKey(history, key);
          }
          assertExactEvent(start, expected, "Subagent start retry");

          const contextForkSeq =
            input.historyMode === "shared" ? start.seq : null;
          await this.establishChild({
            childConversationId: input.childConversationId,
            contextForkSeq,
            nowMs: input.nowMs ?? Date.now(),
            parentConversationId: input.parentConversationId,
            parentEventSeq: start.seq,
            parentTurnId: input.parentTurnId,
            rootConversationId,
          });
          return {
            childConversationId: input.childConversationId,
            contextForkSeq,
            parentConversationId: input.parentConversationId,
            parentEventSeq: start.seq,
            parentTurnId: input.parentTurnId,
            rootConversationId,
          };
        }),
    );
  }

  /** Append the idempotent terminal reference after validating its exact start correlation. */
  async finish(input: FinishSubagentReferenceInput): Promise<void> {
    const eventStore = createSqlConversationEventStore(this.executor);
    const expected = expectedEndData(input);
    await withConversationEventLock(
      this.executor,
      input.parentConversationId,
      async () =>
        await this.executor.transaction(async () => {
          let history = await eventStore.loadHistory(
            input.parentConversationId,
          );
          const start = history.find(
            (event) =>
              event.data.type === "subagent_started" &&
              event.data.subagentInvocationId === input.subagentInvocationId,
          );
          if (
            !start ||
            start.data.type !== "subagent_started" ||
            start.data.parentTurnId !== input.parentTurnId
          ) {
            throw new SubagentLineageConflictError(
              "Subagent finish does not match an exact parent start reference",
            );
          }
          await this.assertChildMatchesStart(
            input.parentConversationId,
            await this.resolveRootConversationId(input.parentConversationId),
            start,
          );

          const key = endedKey(input.subagentInvocationId);
          let end = eventWithKey(history, key);
          if (!end) {
            await eventStore.append(input.parentConversationId, [
              {
                data: expected,
                idempotencyKey: key,
                createdAtMs: input.nowMs ?? Date.now(),
              },
            ]);
            history = await eventStore.loadHistory(input.parentConversationId);
            end = eventWithKey(history, key);
          }
          assertExactEvent(end, expected, "Subagent finish retry");
        }),
    );
  }

  private async establishChild(lineage: SubagentLineage & { nowMs: number }) {
    const at = new Date(lineage.nowMs);
    await this.executor
      .db()
      .insert(juniorConversations)
      .values({
        conversationId: lineage.childConversationId,
        parentConversationId: lineage.parentConversationId,
        rootConversationId: lineage.rootConversationId,
        parentTurnId: lineage.parentTurnId,
        parentEventSeq: lineage.parentEventSeq,
        contextForkSeq: lineage.contextForkSeq,
        createdAt: at,
        lastActivityAt: at,
        updatedAt: at,
        executionStatus: "idle",
      })
      .onConflictDoNothing({ target: juniorConversations.conversationId });

    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversations)
      .where(
        eq(juniorConversations.conversationId, lineage.childConversationId),
      )
      .for("update");
    const child = rows[0];
    if (!child) {
      throw new Error("Subagent child conversation was not created");
    }
    const isBare =
      child.parentConversationId === null &&
      child.rootConversationId === null &&
      child.parentTurnId === null &&
      child.parentEventSeq === null &&
      child.contextForkSeq === null &&
      child.transcriptPurgedAt === null &&
      child.source === null &&
      child.originType === null &&
      child.originId === null &&
      child.originRunId === null &&
      child.destinationId === null &&
      child.destination === null &&
      child.actorIdentityId === null &&
      child.creatorIdentityId === null &&
      child.credentialSubjectIdentityId === null &&
      child.actor === null &&
      child.channelName === null &&
      child.title === null &&
      child.executionUpdatedAt === null &&
      child.executionStatus === "idle" &&
      child.runId === null &&
      child.lastCheckpointAt === null &&
      child.lastEnqueuedAt === null &&
      child.durationMs === 0 &&
      child.usage === null &&
      child.executionDurationMs === 0 &&
      child.executionUsage === null &&
      child.metricRunId === null;
    if (isBare) {
      await this.executor
        .db()
        .update(juniorConversations)
        .set({
          parentConversationId: lineage.parentConversationId,
          rootConversationId: lineage.rootConversationId,
          parentTurnId: lineage.parentTurnId,
          parentEventSeq: lineage.parentEventSeq,
          contextForkSeq: lineage.contextForkSeq,
        })
        .where(
          eq(juniorConversations.conversationId, lineage.childConversationId),
        );
      return;
    }
    if (
      child.parentConversationId !== lineage.parentConversationId ||
      child.rootConversationId !== lineage.rootConversationId ||
      child.parentTurnId !== lineage.parentTurnId ||
      child.parentEventSeq !== lineage.parentEventSeq ||
      child.contextForkSeq !== lineage.contextForkSeq
    ) {
      throw new SubagentLineageConflictError(
        "Subagent child conversation already has different lineage",
      );
    }
  }

  private async assertChildMatchesStart(
    parentConversationId: string,
    rootConversationId: string,
    start: ConversationEvent,
  ): Promise<void> {
    if (start.data.type !== "subagent_started") {
      throw new SubagentLineageConflictError(
        "Subagent start reference has an invalid event type",
      );
    }
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversations)
      .where(
        eq(juniorConversations.conversationId, start.data.childConversationId),
      )
      .for("update");
    const child = rows[0];
    const expectedFork = start.data.historyMode === "shared" ? start.seq : null;
    if (
      !child ||
      child.parentConversationId !== parentConversationId ||
      child.rootConversationId !== rootConversationId ||
      child.parentTurnId !== start.data.parentTurnId ||
      child.parentEventSeq !== start.seq ||
      child.contextForkSeq !== expectedFork
    ) {
      throw new SubagentLineageConflictError(
        "Subagent child lineage no longer matches its parent start reference",
      );
    }
  }

  private async resolveRootConversationId(
    parentConversationId: string,
  ): Promise<string> {
    let currentId = parentConversationId;
    const seen = new Set<string>();
    let declaredRootConversationId: string | undefined;
    while (!seen.has(currentId)) {
      seen.add(currentId);
      const rows = await this.executor
        .db()
        .select({
          conversationId: juniorConversations.conversationId,
          parentConversationId: juniorConversations.parentConversationId,
          rootConversationId: juniorConversations.rootConversationId,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, currentId));
      const row = rows[0];
      if (!row) {
        throw new Error(`Parent conversation does not exist: ${currentId}`);
      }
      if (
        row.rootConversationId &&
        declaredRootConversationId &&
        row.rootConversationId !== declaredRootConversationId
      ) {
        throw new SubagentLineageConflictError(
          "Conversation parent lineage declares conflicting roots",
        );
      }
      if (row.rootConversationId) {
        declaredRootConversationId = row.rootConversationId;
      }
      if (!row.parentConversationId) {
        if (
          declaredRootConversationId &&
          declaredRootConversationId !== row.conversationId
        ) {
          throw new SubagentLineageConflictError(
            "Conversation parent lineage does not resolve to its declared root",
          );
        }
        return row.conversationId;
      }
      currentId = row.parentConversationId;
    }
    throw new SubagentLineageConflictError(
      "Conversation parent lineage contains a cycle",
    );
  }
}
