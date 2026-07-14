import { and, eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAgentSteps, juniorConversationTurns } from "@/db/schema";
import { agentStepEntrySchema } from "../history";
import {
  conversationTurnSchema,
  newConversationTurnSchema,
  type ConversationTurn,
  type ConversationTurnStore,
  type NewConversationTurn,
} from "../turns";

type ConversationTurnRow = typeof juniorConversationTurns.$inferSelect;

function turnFromRow(
  row: ConversationTurnRow,
  startingModelId: string,
): ConversationTurn {
  return conversationTurnSchema.parse({
    conversationId: row.conversationId,
    turnId: row.turnId,
    startingModelId,
    startingSeq: row.startingSeq,
  });
}

class SqlConversationTurnStore implements ConversationTurnStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  private async materialize(
    row: ConversationTurnRow,
  ): Promise<ConversationTurn> {
    const boundaries = await this.executor
      .db()
      .select({ contextEpoch: juniorAgentSteps.contextEpoch })
      .from(juniorAgentSteps)
      .where(
        and(
          eq(juniorAgentSteps.conversationId, row.conversationId),
          eq(juniorAgentSteps.seq, row.startingSeq),
        ),
      )
      .limit(1);
    const boundary = boundaries[0];
    if (!boundary) {
      throw new Error("Conversation turn starting step does not exist");
    }
    const markers = await this.executor
      .db()
      .select({ payload: juniorAgentSteps.payload })
      .from(juniorAgentSteps)
      .where(
        and(
          eq(juniorAgentSteps.conversationId, row.conversationId),
          eq(juniorAgentSteps.contextEpoch, boundary.contextEpoch),
          eq(juniorAgentSteps.type, "context_epoch_started"),
        ),
      )
      .limit(1);
    const marker = markers[0];
    if (!marker) {
      throw new Error("Conversation turn starting epoch is unbound");
    }
    const entry = agentStepEntrySchema.parse({
      type: "context_epoch_started",
      ...marker.payload,
    });
    if (entry.type !== "context_epoch_started" || !entry.modelId) {
      throw new Error("Conversation turn starting epoch has no model binding");
    }
    return turnFromRow(row, entry.modelId);
  }

  async recordStart(input: NewConversationTurn): Promise<ConversationTurn> {
    const turn = newConversationTurnSchema.parse(input);
    const existing = await this.executor
      .db()
      .select()
      .from(juniorConversationTurns)
      .where(
        and(
          eq(juniorConversationTurns.conversationId, turn.conversationId),
          eq(juniorConversationTurns.turnId, turn.turnId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return this.materialize(existing[0]);
    }
    await this.materialize({
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      startingSeq: turn.startingSeq,
    });
    await this.executor
      .db()
      .insert(juniorConversationTurns)
      .values({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        startingSeq: turn.startingSeq,
      })
      .onConflictDoNothing();
    const stored = await this.executor
      .db()
      .select()
      .from(juniorConversationTurns)
      .where(
        and(
          eq(juniorConversationTurns.conversationId, turn.conversationId),
          eq(juniorConversationTurns.turnId, turn.turnId),
        ),
      )
      .limit(1);
    if (!stored[0]) {
      throw new Error("Conversation turn start was not persisted");
    }
    return this.materialize(stored[0]);
  }

  async get(
    conversationId: string,
    turnId: string,
  ): Promise<ConversationTurn | undefined> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationTurns)
      .where(
        and(
          eq(juniorConversationTurns.conversationId, conversationId),
          eq(juniorConversationTurns.turnId, turnId),
        ),
      )
      .limit(1);
    return rows[0] ? this.materialize(rows[0]) : undefined;
  }
}

/** Create a SQL-backed durable conversation turn store. */
export function createSqlConversationTurnStore(
  executor: JuniorSqlDatabase,
): ConversationTurnStore {
  return new SqlConversationTurnStore(executor);
}
