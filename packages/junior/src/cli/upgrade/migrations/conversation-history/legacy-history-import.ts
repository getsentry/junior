/**
 * One-time Redis→SQL legacy history importer used only by `junior upgrade`.
 *
 * Translates the legacy `junior:agent-session-log:<id>` list shape into
 * `junior_conversation_events` rows: `sessionId` markers become history versions,
 * `projection_reset` entries become compaction events,
 * advisor `transcriptRef` links become `childConversationId`,
 * and legacy v1 provenance normalizes exactly as the legacy reducer does. This
 * whole module is removed after the operator-migration horizon; its
 * self-contained child-id formula reproduces historical advisor ids during
 * that bounded backfill.
 */
import { eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { sanitizePostgresJson } from "@/db/postgres-json";
import type { PiMessage } from "@/chat/pi/messages";
import { unescapeXml } from "@/chat/xml";
import type { NewConversationMessage } from "@/chat/conversations/messages";
import { legacyActorProvenance, type SessionLogEntry } from "./session-log";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  conversationEventDataSchema,
  type ConversationEventData,
} from "@/chat/conversations/history";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import {
  isLegacyOrCurrentCheckpointMessage,
  normalizeLegacyContextMessage,
} from "./legacy-context-message";

const INITIAL_SESSION_ID = "session_0";
const ADVISOR_TASK_OPEN = "<advisor-task>\n";
const ADVISOR_TASK_CLOSE = "\n</advisor-task>";
const ADVISOR_CONTEXT_OPEN = "<executor-context>\n";
const ADVISOR_CONTEXT_CLOSE = "\n</executor-context>";

/** A converted legacy event with its explicit order and epoch pinned. */
export interface ImportedEvent {
  seq: number;
  historyVersion: number;
  idempotencyKey?: string;
  data: ConversationEventData;
  createdAtMs: number;
}

/** Result of converting one conversation's legacy log. */
export interface ConvertedLegacyLog {
  events: ImportedEvent[];
  /** Deterministic advisor child conversation id, when a subagent was recorded. */
  advisorChildConversationId?: string;
}

/** Reproduce historical advisor child ids inside the bounded import path. */
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

function readAdvisorRequest(text: string): string | undefined {
  if (
    !text.startsWith(ADVISOR_TASK_OPEN) ||
    !text.endsWith(ADVISOR_CONTEXT_CLOSE)
  ) {
    return undefined;
  }
  const taskEnd = text.indexOf(ADVISOR_TASK_CLOSE, ADVISOR_TASK_OPEN.length);
  if (taskEnd < 0) {
    return undefined;
  }
  const contextStart = taskEnd + ADVISOR_TASK_CLOSE.length + 2;
  if (!text.startsWith(ADVISOR_CONTEXT_OPEN, contextStart)) {
    return undefined;
  }
  const task = text.slice(ADVISOR_TASK_OPEN.length, taskEnd);
  const context = text.slice(
    contextStart + ADVISOR_CONTEXT_OPEN.length,
    -ADVISOR_CONTEXT_CLOSE.length,
  );
  return `${unescapeXml(task)}\n\nExecutor context:\n${unescapeXml(context)}`;
}

function normalizeAdvisorMessage(message: PiMessage): PiMessage {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "user" || !Array.isArray(record.content)) {
    return message;
  }
  let changed = false;
  const content = record.content.map((part) => {
    if (
      !part ||
      typeof part !== "object" ||
      (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string"
    ) {
      return part;
    }
    const text = readAdvisorRequest((part as { text: string }).text);
    if (text === undefined) {
      return part;
    }
    changed = true;
    return { ...part, text };
  });
  return changed ? ({ ...record, content } as unknown as PiMessage) : message;
}

/** Decode a legacy pi_message entry's provenance, tolerating v1 actor shapes. */
function piEntryProvenance(
  entry: Extract<SessionLogEntry, { type: "pi_message" }>,
): ConversationMessageProvenance {
  if (entry.provenance) {
    return entry.provenance;
  }
  if (entry.actor) {
    return legacyActorProvenance(entry.actor);
  }
  return contextProvenance;
}

/**
 * Convert a legacy session log into ordered events with explicit epochs.
 *
 * `fallbackCreatedAtMs` supplies `created_at` for rows without an intrinsic
 * timestamp (epoch markers, provider facts, timestamp-less messages); a real
 * conversation-derived value is always passed so no import-time `now` is used.
 */
export function convertLegacySessionLog(args: {
  conversationId: string;
  entries: SessionLogEntry[];
  fallbackCreatedAtMs: number;
  modelId: string;
}): ConvertedLegacyLog {
  const events: ImportedEvent[] = [];
  const fallback = args.fallbackCreatedAtMs;
  let advisorChildConversationId: string | undefined;
  let seq = 0;
  const push = (
    historyVersion: number,
    data: ConversationEventData,
    createdAtMs: number,
  ): void => {
    events.push({ seq, historyVersion, data, createdAtMs });
    seq += 1;
  };

  for (const entry of args.entries) {
    const epoch = epochFromSessionId(entry.sessionId ?? INITIAL_SESSION_ID);
    switch (entry.type) {
      case "pi_message": {
        const message = entry.message;
        push(
          epoch,
          {
            type: "agent_step",
            message,
            provenance: piEntryProvenance(entry),
          },
          messageTimestampMs(message) ?? fallback,
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
        // The reset opens a new epoch whose marker owns the replacement model
        // context. Later pi_message entries remain original append-only facts.
        const resetCreatedAtMs =
          entry.messages
            .map(messageTimestampMs)
            .find(
              (timestamp): timestamp is number => timestamp !== undefined,
            ) ?? fallback;
        const checkpointIndex = entry.messages.findIndex(
          isLegacyOrCurrentCheckpointMessage,
        );
        push(
          epoch,
          {
            type: "compaction",
            modelProfile: "standard",
            modelId: args.modelId,
            replacementHistory: entry.messages.map((message, index) => ({
              message:
                index === checkpointIndex
                  ? normalizeLegacyContextMessage(message)
                  : message,
              provenance: provenance[index]!,
            })),
          },
          resetCreatedAtMs,
        );
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
    events,
    ...(advisorChildConversationId ? { advisorChildConversationId } : {}),
  };
}

/** Import advisor child rows while decoding the historical request envelope. */
export function convertAdvisorMessages(
  messages: PiMessage[],
  fallbackCreatedAtMs: number,
): ImportedEvent[] {
  return messages.map((sourceMessage, seq) => {
    const message = normalizeAdvisorMessage(sourceMessage);
    return {
      seq,
      historyVersion: 0,
      data: { type: "agent_step", message, provenance: contextProvenance },
      createdAtMs: messageTimestampMs(message) ?? fallbackCreatedAtMs,
    };
  });
}

type ConversationEventInsert = typeof juniorConversationEvents.$inferInsert;

/** Encode one validated imported event as a physical SQL row. */
function insertRow(
  conversationId: string,
  event: ImportedEvent,
): ConversationEventInsert {
  const { type, ...payload } = conversationEventDataSchema.parse(event.data);
  return {
    conversationId,
    seq: event.seq,
    historyVersion: event.historyVersion,
    schemaVersion: 1,
    idempotencyKey: event.idempotencyKey ?? null,
    type,
    payload: sanitizePostgresJson(payload),
    createdAt: new Date(event.createdAtMs),
  };
}

/** One conversation's converted history plus optional advisor child history. */
export interface LegacyImportWrite {
  conversationId: string;
  fallbackCreatedAtMs: number;
  lastActivityAtMs: number;
  messages?: Array<NewConversationMessage & { repliedAtMs?: number }>;
  events: ImportedEvent[];
  child?: { conversationId: string; events: ImportedEvent[] };
}

/** Merge destination-visible facts into retained execution order by timestamp. */
function mergeImportedChronology(
  executionEvents: ImportedEvent[],
  messages: Array<NewConversationMessage & { repliedAtMs?: number }>,
): ImportedEvent[] {
  const visibleEvents = messages
    .flatMap((message): ImportedEvent[] => {
      const recorded: ImportedEvent = {
        seq: 0,
        historyVersion: 0,
        idempotencyKey: `message:${message.messageId}`,
        data: {
          type: "message",
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.authorIdentityId
            ? { authorIdentityId: message.authorIdentityId }
            : {}),
          ...(message.meta ? { meta: message.meta } : {}),
        },
        createdAtMs: message.createdAtMs,
      };
      return message.repliedAtMs === undefined
        ? [recorded]
        : [
            recorded,
            {
              seq: 0,
              historyVersion: 0,
              idempotencyKey: `message:${message.messageId}:handled`,
              data: {
                type: "message_handled",
                messageId: message.messageId,
              },
              createdAtMs: message.repliedAtMs,
            },
          ];
    })
    .map((event, sourceOrder) => ({ event, sourceOrder }))
    .sort(
      (left, right) =>
        left.event.createdAtMs - right.event.createdAtMs ||
        left.sourceOrder - right.sourceOrder,
    );

  const merged: ImportedEvent[] = [];
  let visibleIndex = 0;
  let currentEpoch = 0;
  const push = (event: ImportedEvent, historyVersion: number): void => {
    merged.push({ ...event, seq: merged.length, historyVersion });
  };
  for (const executionEvent of [...executionEvents].sort(
    (left, right) => left.seq - right.seq,
  )) {
    while (
      visibleIndex < visibleEvents.length &&
      visibleEvents[visibleIndex]!.event.createdAtMs <=
        executionEvent.createdAtMs
    ) {
      push(visibleEvents[visibleIndex]!.event, currentEpoch);
      visibleIndex += 1;
    }
    push(executionEvent, executionEvent.historyVersion);
    currentEpoch = Math.max(currentEpoch, executionEvent.historyVersion);
  }
  while (visibleIndex < visibleEvents.length) {
    push(visibleEvents[visibleIndex]!.event, currentEpoch);
    visibleIndex += 1;
  }
  const firstVisibleSeq = merged.find(
    (event) => event.data.type === "message",
  )?.seq;
  return merged.map((event) =>
    event.data.type === "messages_summarized"
      ? {
          ...event,
          data: {
            ...event.data,
            historyFromSeq: firstVisibleSeq ?? event.seq + 1,
          },
        }
      : event,
  );
}

/**
 * Write a converted legacy history for one conversation, all-or-nothing.
 *
 * Serialized by a per-conversation advisory lock and skipped when event rows
 * already exist, so a repeated operator run never double-imports. Parent and
 * advisor-child rows land in one transaction; explicit `seq`/`history_version`
 * are what make this need a dedicated writer rather than the narrow port.
 */
export async function writeLegacyImport(
  executor: JuniorSqlDatabase,
  args: LegacyImportWrite,
): Promise<boolean> {
  return withConversationEventLock(executor, args.conversationId, async () => {
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
      .select({ seq: juniorConversationEvents.seq })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, args.conversationId))
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
    const mergedEvents = mergeImportedChronology(
      args.events,
      args.messages ?? [],
    );
    if (mergedEvents.length > 0) {
      await db
        .insert(juniorConversationEvents)
        .values(
          mergedEvents.map((event) => insertRow(args.conversationId, event)),
        );
    }
    if (args.child) {
      const childCreatedAtMs =
        args.child.events.length > 0
          ? Math.min(...args.child.events.map((event) => event.createdAtMs))
          : args.fallbackCreatedAtMs;
      const childLastActivityAtMs =
        args.child.events.length > 0
          ? Math.max(...args.child.events.map((event) => event.createdAtMs))
          : childCreatedAtMs;
      await insertLegacyAdvisorChildRow(
        executor,
        args.child.conversationId,
        args.conversationId,
        new Date(childCreatedAtMs),
        new Date(childLastActivityAtMs),
      );
      if (args.child.events.length > 0) {
        await db
          .insert(juniorConversationEvents)
          .values(
            args.child.events.map((event) =>
              insertRow(args.child!.conversationId, event),
            ),
          );
      }
    }
    return true;
  });
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

async function insertLegacyAdvisorChildRow(
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
        createdAt: sql`least(${juniorConversations.createdAt}, excluded.created_at)`,
        lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
        updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
      },
    });
  const rows = await executor
    .db()
    .select({
      parentConversationId: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, childConversationId));
  const child = rows[0];
  if (!child || child.parentConversationId !== parentConversationId) {
    throw new Error(
      "Legacy advisor child conflicts with existing conversation lineage",
    );
  }
}
