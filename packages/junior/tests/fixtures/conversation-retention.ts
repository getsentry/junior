import { randomUUID } from "node:crypto";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import type { JuniorSqlDatabase } from "@/db/db";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const BASE_MS = Date.UTC(2026, 0, 1);

/** Add one Slack channel Destination with the given visibility. */
export async function seedDestination(
  executor: JuniorSqlDatabase,
  visibility: JuniorDestinationVisibility,
): Promise<string> {
  const id = randomUUID();
  await executor
    .db()
    .insert(juniorDestinations)
    .values({
      id,
      provider: "slack",
      providerTenantId: "T1",
      providerDestinationId: `C-${id.slice(0, 8)}`,
      kind: "channel",
      visibility,
      createdAt: new Date(BASE_MS),
      updatedAt: new Date(BASE_MS),
    });
  return id;
}

/** Add one Conversation, with one message event unless `withContent` is false. */
export async function seedConversation(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    destinationId?: string;
    lastActivityAtMs: number;
    parentConversationId?: string;
    title?: string | null;
    channelName?: string | null;
    withContent?: boolean;
  },
): Promise<void> {
  const at = new Date(args.lastActivityAtMs);
  await executor
    .db()
    .insert(juniorConversations)
    .values({
      conversationId: args.conversationId,
      schemaVersion: 1,
      destinationId: args.destinationId ?? null,
      parentConversationId: args.parentConversationId ?? null,
      title: args.title === undefined ? "A title" : args.title,
      channelName: args.channelName === undefined ? "eng" : args.channelName,
      actor: { platform: "slack", slackUserId: "U1", teamId: "T1" },
      createdAt: new Date(BASE_MS),
      lastActivityAt: at,
      updatedAt: at,
      executionStatus: "idle",
    });
  if (args.withContent !== false) {
    await executor
      .db()
      .insert(juniorConversationEvents)
      .values({
        conversationId: args.conversationId,
        seq: 0,
        historyVersion: 0,
        schemaVersion: 1,
        type: "message",
        payload: { messageId: "m1", role: "user", text: "hi" },
        createdAt: at,
      });
  }
}
