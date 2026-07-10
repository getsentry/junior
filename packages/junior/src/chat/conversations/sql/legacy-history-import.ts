/**
 * One-time Redis→SQL legacy history importer (import-only, deletion-scoped).
 *
 * Translates the legacy `junior:agent-session-log:<id>` list shape into
 * `junior_agent_steps` rows: `sessionId` markers become integer context epochs,
 * `projection_reset` entries explode into a `context_epoch_started` marker plus
 * per-message rows, advisor `transcriptRef` links become `childConversationId`,
 * and legacy v1 provenance normalizes exactly as the legacy reducer does. This
 * whole module is removed with the lazy-import path after the Redis TTL horizon;
 * to stay free of the advisor→projection import cycle it duplicates the advisor
 * child-id formula rather than importing it.
 */
import { eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import type { PiMessage } from "@/chat/pi/messages";
import type { NewConversationMessage } from "../messages";
import {
  contextProvenance,
  legacyActorProvenance,
  type PiMessageProvenance,
  type SessionLogEntry,
} from "@/chat/state/session-log";
import { agentStepEntrySchema, type AgentStepEntry } from "../history";
import {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
} from "@/db/schema";

const INITIAL_SESSION_ID = "session_0";

/** A converted legacy step with its explicit order and epoch pinned. */
export interface ImportedStep {
  seq: number;
  contextEpoch: number;
  entry: AgentStepEntry;
  createdAtMs: number;
}

/** Result of converting one conversation's legacy log. */
export interface ConvertedLegacyLog {
  steps: ImportedStep[];
  /** Deterministic advisor child conversation id, when a subagent was recorded. */
  advisorChildConversationId?: string;
}

/**
 * Deterministic advisor child conversation id derived from the parent.
 *
 * Mirrors `advisorChildConversationId` in `tools/advisor/tool.ts`; duplicated
 * here so this one-time import module never imports the advisor tool (which
 * imports the projection this module's caller lives beside).
 */
function importedAdvisorChildConversationId(
  parentConversationId: string,
): string {
  return `advisor:${parentConversationId}`;
}

/** Lift a `session_<n>` marker to its integer epoch; unknown shapes are epoch 0. */
function epochFromSessionId(sessionId: string): number {
  const match = /^session_(\d+)$/.exec(sessionId);
  return match ? Number(match[1]) : 0;
}

function messageTimestampMs(message: PiMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : undefined;
}

/** Decode a legacy pi_message entry's provenance, tolerating v1 actor shapes. */
function piEntryProvenance(
  entry: Extract<SessionLogEntry, { type: "pi_message" }>,
): PiMessageProvenance {
  if (entry.provenance) {
    return entry.provenance;
  }
  if (entry.actor) {
    return legacyActorProvenance(entry.actor);
  }
  return contextProvenance;
}

/**
 * Convert a legacy session log into ordered step rows with explicit epochs.
 *
 * `fallbackCreatedAtMs` supplies `created_at` for rows without an intrinsic
 * timestamp (epoch markers, provider facts, timestamp-less messages); a real
 * conversation-derived value is always passed so no import-time `now` is used.
 */
export function convertLegacySessionLog(args: {
  conversationId: string;
  entries: SessionLogEntry[];
  fallbackCreatedAtMs: number;
}): ConvertedLegacyLog {
  const steps: ImportedStep[] = [];
  const fallback = args.fallbackCreatedAtMs;
  let advisorChildConversationId: string | undefined;
  let seq = 0;
  const push = (
    contextEpoch: number,
    entry: AgentStepEntry,
    createdAtMs: number,
  ): void => {
    steps.push({ seq, contextEpoch, entry, createdAtMs });
    seq += 1;
  };

  for (const entry of args.entries) {
    const epoch = epochFromSessionId(entry.sessionId ?? INITIAL_SESSION_ID);
    switch (entry.type) {
      case "pi_message": {
        push(
          epoch,
          {
            type: "pi_message",
            message: entry.message,
            provenance: piEntryProvenance(entry),
          },
          messageTimestampMs(entry.message) ?? fallback,
        );
        break;
      }
      case "projection_reset": {
        const provenance =
          entry.provenance ?? entry.messages.map(() => contextProvenance);
        if (provenance.length !== entry.messages.length) {
          throw new Error(
            "projection_reset provenance must align one-to-one with messages",
          );
        }
        // The reset opens a new epoch: a marker followed by its embedded
        // messages as ordinary rows, matching the SQL compaction shape.
        push(
          epoch,
          { type: "context_epoch_started", reason: "compaction" },
          fallback,
        );
        entry.messages.forEach((message, index) => {
          push(
            epoch,
            {
              type: "pi_message",
              message,
              provenance: provenance[index]!,
            },
            messageTimestampMs(message) ?? fallback,
          );
        });
        break;
      }
      case "mcp_provider_connected": {
        push(
          epoch,
          { type: "mcp_provider_connected", provider: entry.provider },
          fallback,
        );
        break;
      }
      case "authorization_requested": {
        push(
          epoch,
          {
            type: "authorization_requested",
            kind: entry.kind,
            provider: entry.provider,
            actorId: entry.actorId,
            authorizationId: entry.authorizationId,
            delivery: entry.delivery,
          },
          entry.createdAtMs,
        );
        break;
      }
      case "authorization_completed": {
        push(
          epoch,
          {
            type: "authorization_completed",
            kind: entry.kind,
            provider: entry.provider,
            actorId: entry.actorId,
            authorizationId: entry.authorizationId,
          },
          entry.createdAtMs,
        );
        break;
      }
      case "tool_execution_started": {
        push(
          epoch,
          {
            type: "tool_execution_started",
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            ...(entry.args !== undefined ? { args: entry.args } : {}),
          },
          entry.createdAtMs,
        );
        break;
      }
      case "subagent_started": {
        const childConversationId = importedAdvisorChildConversationId(
          args.conversationId,
        );
        advisorChildConversationId = childConversationId;
        push(
          epoch,
          {
            type: "subagent_started",
            subagentInvocationId: entry.subagentInvocationId,
            subagentKind: entry.subagentKind,
            ...(entry.parentToolCallId
              ? { parentToolCallId: entry.parentToolCallId }
              : {}),
            childConversationId,
            historyMode: "shared",
          },
          entry.createdAtMs,
        );
        break;
      }
      case "subagent_ended": {
        // transcriptEnd/StartMessageIndex are dropped: the child conversation is
        // now the transcript, so message-index cursors carry no meaning.
        push(
          epoch,
          {
            type: "subagent_ended",
            subagentInvocationId: entry.subagentInvocationId,
            outcome: entry.outcome,
            ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          },
          entry.createdAtMs,
        );
        break;
      }
      case "actor_recorded": {
        // Legacy v1 latest-wins actor event: never projected by the reducer and
        // has no v2 step type, so it produces no row (attribution fails closed).
        break;
      }
    }
  }

  return {
    steps,
    ...(advisorChildConversationId ? { advisorChildConversationId } : {}),
  };
}

/** Convert an advisor session blob into epoch-0 child pi_message rows. */
export function convertAdvisorMessages(
  messages: PiMessage[],
  fallbackCreatedAtMs: number,
): ImportedStep[] {
  return messages.map((message, seq) => ({
    seq,
    contextEpoch: 0,
    entry: { type: "pi_message", message, provenance: contextProvenance },
    createdAtMs: messageTimestampMs(message) ?? fallbackCreatedAtMs,
  }));
}

type AgentStepInsert = typeof juniorAgentSteps.$inferInsert;

function messageRole(entry: AgentStepEntry): string | null {
  if (entry.type !== "pi_message") {
    return null;
  }
  const role = (entry.message as { role?: unknown }).role;
  return typeof role === "string" ? role : null;
}

function insertRow(
  conversationId: string,
  step: ImportedStep,
): AgentStepInsert {
  const { type, ...payload } = agentStepEntrySchema.parse(step.entry);
  return {
    conversationId,
    seq: step.seq,
    contextEpoch: step.contextEpoch,
    type,
    role: messageRole(step.entry),
    payload,
    createdAt: new Date(step.createdAtMs),
  };
}

/** One conversation's converted history plus optional advisor child history. */
export interface LegacyImportWrite {
  conversationId: string;
  fallbackCreatedAtMs: number;
  lastActivityAtMs: number;
  messages?: Array<NewConversationMessage & { repliedAtMs?: number }>;
  steps: ImportedStep[];
  child?: { conversationId: string; steps: ImportedStep[] };
}

/**
 * Write a converted legacy history for one conversation, all-or-nothing.
 *
 * Serialized by a per-conversation advisory lock and skipped when step rows
 * already exist, so a re-run (bulk or lazy) never double-imports. Parent and
 * advisor-child rows land in one transaction; explicit `seq`/`context_epoch`
 * are what make this need a dedicated writer rather than the narrow port.
 */
export async function writeLegacyImport(
  executor: JuniorSqlDatabase,
  args: LegacyImportWrite,
): Promise<boolean> {
  return executor.withLock(
    `junior_conversation:legacy-import:${args.conversationId}`,
    () =>
      executor.transaction(async () => {
        const db = executor.db();
        const conversations = await db
          .select({
            transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
          })
          .from(juniorConversations)
          .where(eq(juniorConversations.conversationId, args.conversationId))
          .for("update");
        if (conversations[0]?.transcriptPurgedAt) {
          return false;
        }
        const existing = await db
          .select({ seq: juniorAgentSteps.seq })
          .from(juniorAgentSteps)
          .where(eq(juniorAgentSteps.conversationId, args.conversationId))
          .limit(1);
        if (existing.length > 0) {
          return false;
        }
        const createdAt = new Date(args.fallbackCreatedAtMs);
        await ensureConversationRow(
          executor,
          args.conversationId,
          createdAt,
          new Date(args.lastActivityAtMs),
        );
        if (args.messages && args.messages.length > 0) {
          await db
            .insert(juniorConversationMessages)
            .values(
              args.messages.map((message) => ({
                conversationId: args.conversationId,
                messageId: message.messageId,
                role: message.role,
                authorIdentityId: message.authorIdentityId ?? null,
                text: message.text,
                meta: message.meta ?? null,
                repliedAt:
                  message.repliedAtMs === undefined
                    ? null
                    : new Date(message.repliedAtMs),
                createdAt: new Date(message.createdAtMs),
              })),
            )
            .onConflictDoUpdate({
              target: [
                juniorConversationMessages.conversationId,
                juniorConversationMessages.messageId,
              ],
              set: {
                meta: sql`nullif(coalesce(${juniorConversationMessages.meta}, '{}'::jsonb) || coalesce(excluded.meta, '{}'::jsonb), '{}'::jsonb)`,
                repliedAt: sql`coalesce(${juniorConversationMessages.repliedAt}, excluded.replied_at)`,
              },
            });
        }
        if (args.steps.length > 0) {
          await db
            .insert(juniorAgentSteps)
            .values(
              args.steps.map((step) => insertRow(args.conversationId, step)),
            );
        }
        if (args.child) {
          const childCreatedAtMs =
            args.child.steps.length > 0
              ? Math.min(...args.child.steps.map((step) => step.createdAtMs))
              : args.fallbackCreatedAtMs;
          const childLastActivityAtMs =
            args.child.steps.length > 0
              ? Math.max(...args.child.steps.map((step) => step.createdAtMs))
              : childCreatedAtMs;
          await ensureChildConversationRow(
            executor,
            args.child.conversationId,
            args.conversationId,
            new Date(childCreatedAtMs),
            new Date(childLastActivityAtMs),
          );
          if (args.child.steps.length > 0) {
            await db
              .insert(juniorAgentSteps)
              .values(
                args.child.steps.map((step) =>
                  insertRow(args.child!.conversationId, step),
                ),
              );
          }
        }
        return true;
      }),
  );
}

async function ensureConversationRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  createdAt: Date,
  lastActivityAt: Date,
): Promise<void> {
  await executor
    .db()
    .insert(juniorConversations)
    .values({
      conversationId,
      schemaVersion: 1,
      createdAt,
      lastActivityAt,
      updatedAt: lastActivityAt,
      executionStatus: "idle",
    })
    .onConflictDoUpdate({
      target: juniorConversations.conversationId,
      set: {
        createdAt: sql`least(${juniorConversations.createdAt}, excluded.created_at)`,
        lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
        updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
      },
    });
}

async function ensureChildConversationRow(
  executor: JuniorSqlDatabase,
  childConversationId: string,
  parentConversationId: string,
  createdAt: Date,
  lastActivityAt: Date,
): Promise<void> {
  await ensureConversationRow(
    executor,
    parentConversationId,
    createdAt,
    lastActivityAt,
  );
  await executor
    .db()
    .insert(juniorConversations)
    .values({
      conversationId: childConversationId,
      schemaVersion: 1,
      parentConversationId,
      createdAt,
      lastActivityAt,
      updatedAt: lastActivityAt,
      executionStatus: "idle",
    })
    .onConflictDoUpdate({
      target: juniorConversations.conversationId,
      set: {
        parentConversationId: sql`coalesce(${juniorConversations.parentConversationId}, excluded.parent_conversation_id)`,
        createdAt: sql`least(${juniorConversations.createdAt}, excluded.created_at)`,
        lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
        updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
      },
    });
}
