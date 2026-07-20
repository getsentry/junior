import { isDeepStrictEqual } from "node:util";
import { getChatConfig, type BotConfig } from "@/chat/config";
import { modelIdForProfile, modelProfileSchema } from "@/chat/model-profile";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import { sanitizePostgresJson } from "@/db/postgres-json";
import type { MigrationContext, MigrationResult } from "../types";
import {
  isLegacyOrCurrentCheckpointText,
  normalizeLegacyContextMessage,
} from "./conversation-history/legacy-context-message";
import { prepareConversationEventResequence } from "./conversation-event-cursors";
import type { PiMessage } from "@/chat/pi/messages";
import { conversationEventDataSchema } from "@/chat/conversations/history";

const PAGE_SIZE = 250;

interface StoredEventRow {
  historyVersion: number;
  payload: Record<string, unknown>;
  seq: number;
  type: string;
}

interface ReplacementEntry {
  message: Record<string, unknown>;
  provenance?: unknown;
}

function messageTextParts(message: Record<string, unknown>): string[] {
  if (typeof message.content === "string") {
    return [message.content];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part) =>
    part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
}

function checkpointEnd(messages: StoredEventRow[]): number {
  return messages.findIndex((row) => {
    const message = row.payload.message;
    return (
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      messageTextParts(message as Record<string, unknown>).some(
        isLegacyOrCurrentCheckpointText,
      )
    );
  });
}

function matchingMessagePrefix(
  previous: StoredEventRow[],
  current: StoredEventRow[],
): number {
  const limit = Math.min(previous.length, current.length);
  let count = 0;
  while (
    count < limit &&
    isDeepStrictEqual(
      previous[count]!.payload.message,
      current[count]!.payload.message,
    )
  ) {
    count += 1;
  }
  return count;
}

function replacementEntry(
  row: StoredEventRow,
  normalizeCheckpoint: boolean,
): ReplacementEntry {
  const message = row.payload.message;
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    throw new Error(
      `Conversation message event ${row.seq} has no message object`,
    );
  }
  return {
    message: (normalizeCheckpoint
      ? normalizeLegacyContextMessage(message as unknown as PiMessage)
      : message) as Record<string, unknown>,
    ...(row.payload.provenance === undefined
      ? {}
      : { provenance: row.payload.provenance }),
  };
}

function resolvedBinding(
  payload: Record<string, unknown>,
  bot: BotConfig,
): { modelId: string; modelProfile: string } {
  const modelProfile =
    payload.modelProfile === undefined
      ? "standard"
      : modelProfileSchema.parse(payload.modelProfile);
  const modelId = payload.modelId;
  if (modelId !== undefined && (typeof modelId !== "string" || !modelId)) {
    throw new Error("Context checkpoint modelId must be a non-empty string");
  }
  return {
    modelProfile,
    modelId: modelId ?? modelIdForProfile(bot, modelProfile),
  };
}

function handoffToolCallId(
  rows: StoredEventRow[],
  marker: StoredEventRow,
): string {
  if (
    typeof marker.payload.triggeringToolCallId === "string" &&
    marker.payload.triggeringToolCallId.length > 0
  ) {
    return marker.payload.triggeringToolCallId;
  }
  const tool = [...rows]
    .reverse()
    .find(
      (row) =>
        row.seq < marker.seq &&
        row.type === "tool_execution_started" &&
        row.payload.toolName === "handoff" &&
        typeof row.payload.toolCallId === "string" &&
        row.payload.toolCallId.length > 0,
    );
  if (typeof tool?.payload.toolCallId !== "string") {
    throw new Error(
      `Cannot correlate handoff checkpoint at event ${marker.seq} during upgrade`,
    );
  }
  return tool.payload.toolCallId;
}

/** Normalize one event stream atomically while closing copied-message gaps. */
async function normalizeConversation(args: {
  bot: BotConfig;
  conversationId: string;
  executor: JuniorSqlExecutor;
}): Promise<number> {
  return await args.executor.withLock(
    `junior_conversation:event:${args.conversationId}`,
    async () =>
      await args.executor.transaction(async () => {
        const rows = await args.executor.query<StoredEventRow>(
          `SELECT
         seq,
         history_version AS "historyVersion",
         type,
         payload
       FROM junior_conversation_events
       WHERE conversation_id = $1
         AND type IN ('context_epoch_started', 'agent_step', 'tool_execution_started')
       ORDER BY seq`,
          [args.conversationId],
        );
        const messagesByEpoch = new Map<number, StoredEventRow[]>();
        for (const row of rows) {
          if (row.type !== "agent_step") continue;
          const messages = messagesByEpoch.get(row.historyVersion) ?? [];
          messages.push(row);
          messagesByEpoch.set(row.historyVersion, messages);
        }

        let migrated = 0;
        const removedSeqs: number[] = [];
        for (const marker of rows) {
          if (marker.type !== "context_epoch_started") {
            continue;
          }
          const reason = marker.payload.reason;
          if (reason === "initial") {
            removedSeqs.push(marker.seq);
            migrated += 1;
            continue;
          }
          if (
            reason !== "compaction" &&
            reason !== "handoff" &&
            reason !== "rollback"
          ) {
            throw new Error(
              `Unknown context checkpoint reason at event ${marker.seq}`,
            );
          }
          let replacementHistory = marker.payload.replacementHistory;
          if (!Array.isArray(replacementHistory)) {
            const current = messagesByEpoch.get(marker.historyVersion) ?? [];
            let replacementCount: number;
            if (reason === "rollback") {
              const previous =
                messagesByEpoch.get(marker.historyVersion - 1) ?? [];
              replacementCount = matchingMessagePrefix(previous, current);
            } else {
              const end = checkpointEnd(current);
              if (end < 0) {
                throw new Error(
                  `Cannot find ${reason} summary at event ${marker.seq} during upgrade`,
                );
              }
              replacementCount = end + 1;
            }
            const replacementRows = current.slice(0, replacementCount);
            replacementHistory = replacementRows.map((row, index) =>
              replacementEntry(
                row,
                reason !== "rollback" && index === replacementRows.length - 1,
              ),
            );
            removedSeqs.push(...replacementRows.map((row) => row.seq));
          }
          const binding = resolvedBinding(marker.payload, args.bot);
          const parsed = conversationEventDataSchema.parse({
            type: reason,
            ...binding,
            ...(reason === "handoff"
              ? { triggeringToolCallId: handoffToolCallId(rows, marker) }
              : {}),
            replacementHistory,
          });
          const { type, ...payload } = parsed;
          await args.executor.execute(
            `UPDATE junior_conversation_events
         SET type = $3, payload = $4::jsonb
         WHERE conversation_id = $1 AND seq = $2`,
            [
              args.conversationId,
              marker.seq,
              type,
              JSON.stringify(sanitizePostgresJson(payload)),
            ],
          );
          migrated += 1;
        }
        if (removedSeqs.length > 0) {
          await args.executor.execute(
            `UPDATE junior_conversation_events
         SET payload = jsonb_set(
           payload,
           '{historyFromSeq}',
           to_jsonb(
             (payload->>'historyFromSeq')::integer - (
               SELECT count(*)::integer
               FROM unnest($2::integer[]) removed(seq)
               WHERE removed.seq < (payload->>'historyFromSeq')::integer
             )
           )
         )
         WHERE conversation_id = $1
           AND type = 'messages_summarized'
           AND jsonb_typeof(payload->'historyFromSeq') = 'number'`,
            [args.conversationId, removedSeqs],
          );
          await args.executor.execute(
            `DELETE FROM junior_conversation_events
         WHERE conversation_id = $1 AND seq = ANY($2::integer[])`,
            [args.conversationId, removedSeqs],
          );
          await args.executor.execute(
            `UPDATE junior_conversation_events
         SET seq = -seq - 1
         WHERE conversation_id = $1`,
            [args.conversationId],
          );
          await args.executor.execute(
            `WITH ranked AS (
           SELECT
             ctid,
             row_number() OVER (ORDER BY -seq - 1) - 1 AS next_seq
           FROM junior_conversation_events
           WHERE conversation_id = $1
         )
         UPDATE junior_conversation_events event
         SET seq = ranked.next_seq
         FROM ranked
         WHERE event.ctid = ranked.ctid`,
            [args.conversationId],
          );
        }
        return migrated;
      }),
  );
}

/**
 * Rewrite old context resets into the one shape understood by live workers.
 * Copied context moves onto the marker; messages created after the reset stay
 * as ordinary events.
 */
export async function normalizeConversationContextCheckpoints(
  context: MigrationContext,
  options: { bot?: BotConfig; executor?: JuniorSqlExecutor } = {},
): Promise<MigrationResult> {
  const config = options.executor && options.bot ? undefined : getChatConfig();
  const bot = options.bot ?? config?.bot;
  if (!bot) throw new Error("Context checkpoint upgrade requires bot config");
  let executor = options.executor;
  if (!executor) {
    if (!config)
      throw new Error("Context checkpoint upgrade requires SQL config");
    executor = createJuniorSqlExecutor({
      connectionString: config.sql.databaseUrl,
      driver: config.sql.driver,
    });
  }
  try {
    const result: MigrationResult = {
      existing: 0,
      migrated: 0,
      missing: 0,
      scanned: 0,
    };
    while (true) {
      const conversations = await executor.query<{ conversationId: string }>(
        `SELECT DISTINCT conversation_id AS "conversationId"
         FROM junior_conversation_events
         WHERE type = 'context_epoch_started'
         ORDER BY conversation_id
         LIMIT $1`,
        [PAGE_SIZE],
      );
      if (conversations.length === 0) break;
      await prepareConversationEventResequence(
        context,
        new Set(conversations.map(({ conversationId }) => conversationId)),
      );
      for (const { conversationId } of conversations) {
        result.scanned += 1;
        result.migrated += await normalizeConversation({
          bot,
          conversationId,
          executor,
        });
      }
    }
    return result;
  } finally {
    if (!options.executor) await executor.close();
  }
}

export const conversationContextCheckpointMigration = {
  name: "normalize-conversation-context-checkpoints",
  run: normalizeConversationContextCheckpoints,
};
