import { and, asc, eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  agentStepEntrySchema,
  type AgentStepEntry,
  type AgentStepStore,
  type EpochReason,
  type NewAgentStep,
  type PiMessageStep,
  type StoredAgentStep,
} from "../history";
import { ensureConversationRow } from "./conversation-row";
import { juniorAgentSteps } from "@/db/schema";

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
    const newestCreatedAtMs = Math.max(
      ...steps.map((step) => step.createdAtMs),
    );
    await this.executor.transaction(async () => {
      await ensureConversationRow(
        this.executor,
        conversationId,
        newestCreatedAtMs,
      );
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
      await ensureConversationRow(this.executor, conversationId, Date.now());
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
}

/** Create a SQL-backed agent step store. */
export function createSqlAgentStepStore(
  executor: JuniorSqlDatabase,
): AgentStepStore {
  return new SqlAgentStepStore(executor);
}
