import { z } from "zod";
import {
  conversationDetailReportSchema,
  conversationEventPageSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationReportEvent,
} from "@/api/schema/conversation";
import {
  briefCodeChangeSchema,
  parseBriefInput,
  type BriefCodeChange,
  type BriefEntry,
  type BriefInput,
} from "./input";

const TOOL_TEXT_LIMIT = 1_500;

export const conversationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    pulledAt: z.string().datetime(),
    detail: conversationDetailReportSchema,
    eventPages: z.array(conversationEventPageSchema),
    codeChanges: z.array(briefCodeChangeSchema),
  })
  .strict();

export type ConversationSnapshot = z.output<typeof conversationSnapshotSchema>;

/** Create the self-contained wire snapshot used for local Brief replay. */
export function createConversationSnapshot(args: {
  codeChanges?: BriefCodeChange[];
  detail: ConversationDetailReport;
  eventPages: ConversationEventPage[];
  pulledAt?: string;
}): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    schemaVersion: 1,
    pulledAt: args.pulledAt ?? new Date().toISOString(),
    detail: args.detail,
    eventPages: args.eventPages,
    codeChanges: args.codeChanges ?? [],
  });
}

function allEvents(snapshot: ConversationSnapshot): ConversationReportEvent[] {
  const bySequence = new Map<number, ConversationReportEvent>();
  for (const event of [
    ...snapshot.eventPages.flatMap((page) => page.events),
    ...snapshot.detail.events,
  ]) {
    bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

function actorName(
  actor: Extract<
    ConversationReportEvent["data"],
    { type: "message" }
  >["actorIdentity"],
): string | undefined {
  return (
    actor?.fullName ??
    actor?.slackUserName ??
    actor?.email ??
    actor?.slackUserId
  );
}

function toolText(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const text =
    typeof output === "string" ? output : JSON.stringify(output, undefined, 2);
  if (!text?.trim()) return undefined;
  return text.length <= TOOL_TEXT_LIMIT
    ? text
    : `${text.slice(0, TOOL_TEXT_LIMIT - 1)}…`;
}

function entriesFromEvents(events: ConversationReportEvent[]): BriefEntry[] {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (
      event.data.type === "turn_lifecycle" &&
      event.data.state === "started"
    ) {
      for (const messageId of event.data.inputMessageIds ?? []) {
        turnByMessageId.set(messageId, event.data.turnId);
      }
    }
  }

  const entries: BriefEntry[] = [];
  let activeTurnId: string | undefined;
  for (const event of events) {
    const data = event.data;
    if (data.type === "turn_lifecycle") {
      if (data.state === "started") {
        activeTurnId = data.turnId;
      } else if (data.turnId === activeTurnId) {
        activeTurnId = undefined;
      }
      continue;
    }
    if (data.type === "message" && data.text && data.role !== "system") {
      const turnId =
        data.role === "user"
          ? turnByMessageId.get(data.messageId)
          : activeTurnId;
      entries.push({
        index: event.seq,
        role: data.role,
        ...(actorName(data.actorIdentity)
          ? { author: actorName(data.actorIdentity) }
          : undefined),
        text: data.text,
        createdAtMs: Date.parse(event.createdAt),
        ...(turnId ? { turnId } : undefined),
      });
      continue;
    }
    if (data.type !== "tool_calls") continue;
    for (const call of data.calls) {
      const text = toolText(call.output);
      if (!text) continue;
      entries.push({
        index: event.seq,
        role: "tool",
        author: call.name,
        text,
        createdAtMs: Date.parse(event.createdAt),
        ...(activeTurnId ? { turnId: activeTurnId } : undefined),
      });
    }
  }
  return entries;
}

function assertAvailableHistory(snapshot: ConversationSnapshot): void {
  const histories = [
    snapshot.detail.eventHistory,
    ...snapshot.eventPages.map((page) => page.eventHistory),
  ];
  if (histories.some((history) => history.status !== "available")) {
    throw new Error("A Brief snapshot requires available event history");
  }
}

/** Project a downloaded conversation snapshot into generator input. */
export function briefInputFromSnapshot(raw: unknown): BriefInput {
  const snapshot = conversationSnapshotSchema.parse(raw);
  assertAvailableHistory(snapshot);
  const detail = snapshot.detail;
  const channelName = detail.channelName?.trim() || detail.channel?.trim();
  const hasLocation = Boolean(channelName || detail.locationId);
  return parseBriefInput({
    conversationId: detail.conversationId,
    ...(detail.displayTitle.trim()
      ? { title: detail.displayTitle.trim() }
      : undefined),
    visibility: detail.visibility ?? "public",
    ...(hasLocation
      ? {
          location: {
            provider: "slack",
            ...(channelName ? { channelName } : undefined),
          },
        }
      : undefined),
    entries: entriesFromEvents(allEvents(snapshot)),
    codeChanges: snapshot.codeChanges,
    resources: (detail.annotations ?? []).map((annotation) => ({
      label: annotation.label,
      url: annotation.url,
      ...(annotation.status ? { status: annotation.status } : undefined),
    })),
  });
}

/** Return the last event index included in a conversation snapshot. */
export function throughIndexFromSnapshot(raw: unknown): number | undefined {
  const snapshot = conversationSnapshotSchema.parse(raw);
  return allEvents(snapshot).at(-1)?.seq;
}

/** Return event indexes for turns that reached a successful terminal state. */
export function completedTurnIndexesFromSnapshot(raw: unknown): number[] {
  const snapshot = conversationSnapshotSchema.parse(raw);
  return allEvents(snapshot)
    .filter(
      (event) =>
        event.data.type === "turn_lifecycle" &&
        (event.data.state === "succeeded" || event.data.state === "no_reply"),
    )
    .map((event) => event.seq);
}
