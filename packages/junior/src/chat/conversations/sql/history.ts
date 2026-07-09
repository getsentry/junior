import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/chat/sql/db";
import {
  agentStepEntrySchema,
  type AgentStepEntry,
  type AgentStepStore,
  type EpochReason,
  type NewAgentStep,
  type PiMessageStep,
  type StoredAgentStep,
} from "../history";
import {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
} from "./schema";

type AgentStepRow = typeof juniorAgentSteps.$inferSelect;
type AgentStepInsert = typeof juniorAgentSteps.$inferInsert;

function messageRole(entry: AgentStepEntry): string | null {
  if (entry.type !== "pi_message") {
    return null;
  }
  const role = (entry.message as { role?: unknown }).role;
  return typeof role === "string" ? role : null;
}

/** Split the validated entry into its column-lifted envelope and jsonb payload. */
function insertFromStep(
  conversationId: string,
  seq: number,
  contextEpoch: number,
  step: NewAgentStep,
): AgentStepInsert {
  const { type, ...payload } = agentStepEntrySchema.parse(step.entry);
  return {
    conversationId,
    seq,
    contextEpoch,
    type,
    role: messageRole(step.entry),
    payload,
    createdAt: new Date(step.createdAtMs),
  };
}

/** Reconstruct the domain entry from a row; corrupt envelopes fail loudly. */
function stepFromRow(row: AgentStepRow): StoredAgentStep {
  const entry = agentStepEntrySchema.parse({ type: row.type, ...row.payload });
  return {
    seq: row.seq,
    contextEpoch: row.contextEpoch,
    createdAtMs: row.createdAt.getTime(),
    entry,
  };
}

function piMessageStep(step: PiMessageStep): NewAgentStep {
  return {
    entry: {
      type: "pi_message",
      message: step.message,
      ...(step.schemaVersion !== undefined
        ? { schemaVersion: step.schemaVersion }
        : {}),
      ...(step.provenance ? { provenance: step.provenance } : {}),
    },
    createdAtMs: step.createdAtMs,
  };
}

class SqlAgentStepStore implements AgentStepStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async append(conversationId: string, steps: NewAgentStep[]): Promise<void> {
    if (steps.length === 0) {
      return;
    }
    await this.executor.transaction(async () => {
      await this.ensureConversation(conversationId, steps[0]!.createdAtMs);
      const cursor = await this.readCursor(conversationId);
      const contextEpoch = cursor.maxEpoch ?? 0;
      let seq = cursor.nextSeq;
      const rows = steps.map((step) =>
        insertFromStep(conversationId, seq++, contextEpoch, step),
      );
      await this.executor.db().insert(juniorAgentSteps).values(rows);
    });
  }

  async startEpoch(
    conversationId: string,
    opts: { reason: EpochReason; messages: PiMessageStep[] },
  ): Promise<void> {
    await this.executor.transaction(async () => {
      await this.ensureConversation(conversationId, Date.now());
      const cursor = await this.readCursor(conversationId);
      const contextEpoch = (cursor.maxEpoch ?? -1) + 1;
      let seq = cursor.nextSeq;
      const marker: NewAgentStep = {
        entry: { type: "context_epoch_started", reason: opts.reason },
        createdAtMs: Date.now(),
      };
      const rows = [marker, ...opts.messages.map(piMessageStep)].map((step) =>
        insertFromStep(conversationId, seq++, contextEpoch, step),
      );
      await this.executor.db().insert(juniorAgentSteps).values(rows);
    });
  }

  /**
   * Establish the conversation metadata row on first contact, matching the
   * metadata store's lazy-upsert semantics: local and dispatch surfaces write
   * steps before activity recording has created the row, and the steps table
   * FKs to it.
   */
  private async ensureConversation(
    conversationId: string,
    atMs: number,
  ): Promise<void> {
    const at = new Date(atMs);
    await this.executor
      .db()
      .insert(juniorConversations)
      .values({
        conversationId,
        createdAt: at,
        lastActivityAt: at,
        updatedAt: at,
        executionStatus: "idle",
      })
      .onConflictDoNothing({ target: juniorConversations.conversationId });
  }

  async loadCurrentEpoch(conversationId: string): Promise<StoredAgentStep[]> {
    const cursor = await this.readCursor(conversationId);
    if (cursor.maxEpoch === null) {
      return [];
    }
    const rows = await this.executor
      .db()
      .select()
      .from(juniorAgentSteps)
      .where(
        and(
          eq(juniorAgentSteps.conversationId, conversationId),
          eq(juniorAgentSteps.contextEpoch, cursor.maxEpoch),
        ),
      )
      .orderBy(asc(juniorAgentSteps.seq));
    return rows.map(stepFromRow);
  }

  async loadHistory(conversationId: string): Promise<StoredAgentStep[]> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorAgentSteps)
      .where(eq(juniorAgentSteps.conversationId, conversationId))
      .orderBy(asc(juniorAgentSteps.seq));
    return rows.map(stepFromRow);
  }

  async purgeConversation(conversationId: string): Promise<void> {
    await this.executor.transaction(async () => {
      const ids = await this.descendantIds(conversationId);
      await this.executor
        .db()
        .delete(juniorAgentSteps)
        .where(inArray(juniorAgentSteps.conversationId, ids));
      await this.executor
        .db()
        .delete(juniorConversationMessages)
        .where(inArray(juniorConversationMessages.conversationId, ids));
      await this.executor
        .db()
        .update(juniorConversations)
        .set({ transcriptPurgedAt: new Date() })
        .where(inArray(juniorConversations.conversationId, ids));
    });
  }

  /** Read the next `seq` and current highest epoch for one conversation. */
  private async readCursor(
    conversationId: string,
  ): Promise<{ maxEpoch: number | null; nextSeq: number }> {
    const rows = await this.executor
      .db()
      .select({
        maxSeq: sql<number | null>`max(${juniorAgentSteps.seq})`,
        maxEpoch: sql<number | null>`max(${juniorAgentSteps.contextEpoch})`,
      })
      .from(juniorAgentSteps)
      .where(eq(juniorAgentSteps.conversationId, conversationId));
    const maxSeq = rows[0]?.maxSeq;
    const maxEpoch = rows[0]?.maxEpoch;
    return {
      maxEpoch:
        maxEpoch === null || maxEpoch === undefined ? null : Number(maxEpoch),
      nextSeq: maxSeq === null || maxSeq === undefined ? 0 : Number(maxSeq) + 1,
    };
  }

  /** Collect this conversation and every descendant via parent_conversation_id. */
  private async descendantIds(conversationId: string): Promise<string[]> {
    const all = new Set<string>([conversationId]);
    let frontier = [conversationId];
    while (frontier.length > 0) {
      const children = await this.executor
        .db()
        .select({ id: juniorConversations.conversationId })
        .from(juniorConversations)
        .where(inArray(juniorConversations.parentConversationId, frontier));
      frontier = [];
      for (const child of children) {
        if (!all.has(child.id)) {
          all.add(child.id);
          frontier.push(child.id);
        }
      }
    }
    return [...all];
  }
}

/** Create a SQL-backed agent step store. */
export function createSqlAgentStepStore(
  executor: JuniorSqlDatabase,
): AgentStepStore {
  return new SqlAgentStepStore(executor);
}
