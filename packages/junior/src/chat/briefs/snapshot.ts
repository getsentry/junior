import { z } from "zod";
import {
  conversationDetailReportSchema,
  conversationEventPageSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationReportEvent,
} from "@/api/schema/conversation";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";
import {
  briefCodeChangeSchema,
  parseBriefInput,
  type BriefCodeChange,
  type BriefEntry,
  type BriefInput,
} from "./schema";

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

type MessageActor = Extract<
  ConversationReportEvent["data"],
  { type: "message" }
>["actorIdentity"];

function actorIdentityKey(actor: MessageActor): string | undefined {
  const slackUserId = actor?.slackUserId?.trim();
  if (slackUserId) return `slack:${slackUserId}`;
  const email = actor?.email?.trim();
  return email ? `email:${email.toLowerCase()}` : undefined;
}

function bestActorName(actor: MessageActor): string | undefined {
  return (
    actor?.fullName?.trim() ||
    actor?.slackUserName?.trim() ||
    actor?.email?.trim() ||
    undefined
  );
}

function actorNames(events: ConversationReportEvent[]): Map<string, string> {
  const actors = new Map<
    string,
    { email?: string; fullName?: string; slackUserName?: string }
  >();
  for (const event of events) {
    if (event.data.type !== "message") continue;
    const actor = event.data.actorIdentity;
    const key = actorIdentityKey(actor);
    if (!key) continue;
    const known = actors.get(key) ?? {};
    actors.set(key, {
      fullName: known.fullName ?? (actor?.fullName?.trim() || undefined),
      slackUserName:
        known.slackUserName ?? (actor?.slackUserName?.trim() || undefined),
      email: known.email ?? (actor?.email?.trim() || undefined),
    });
  }
  const names = new Map<string, string>();
  for (const [key, actor] of actors) {
    const name = bestActorName(actor);
    if (name) names.set(key, name);
  }
  return names;
}

function actorName(
  actor: MessageActor,
  resolvedNames: ReadonlyMap<string, string>,
): string | undefined {
  if (!actor) return undefined;
  const key = actorIdentityKey(actor);
  return (key ? resolvedNames.get(key) : undefined) ?? bestActorName(actor);
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
  const resolvedActorNames = actorNames(events);
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
      const author = actorName(data.actorIdentity, resolvedActorNames);
      const role =
        data.role === "user" &&
        (Boolean(data.eventType) ||
          data.actorIdentity?.slackUserId === RESOURCE_EVENT_AUTHOR_ID)
          ? "event"
          : data.role;
      entries.push({
        index: event.seq,
        role,
        ...(author ? { author } : undefined),
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

function codeChangeAt(
  change: BriefCodeChange,
  boundaryMs: number,
): BriefCodeChange | undefined {
  if (change.openedAt && Date.parse(change.openedAt) > boundaryMs) {
    return undefined;
  }
  const mergedAt =
    change.mergedAt && Date.parse(change.mergedAt) <= boundaryMs
      ? change.mergedAt
      : undefined;
  const closedAt =
    change.closedAt && Date.parse(change.closedAt) <= boundaryMs
      ? change.closedAt
      : undefined;
  const { mergedAt: _mergedAt, closedAt: _closedAt, ...rest } = change;
  return {
    ...rest,
    state: mergedAt ? "merged" : closedAt ? "closed" : "open",
    ...(mergedAt ? { mergedAt } : undefined),
    ...(closedAt ? { closedAt } : undefined),
  };
}

/**
 * Project a downloaded conversation snapshot into generator input. Evidence
 * is limited to what existed at the `throughIndex` event, so a replayed
 * earlier version cannot cite a later pull request or resource.
 */
export function briefInputFromSnapshot(
  snapshot: ConversationSnapshot,
  throughIndex: number,
): BriefInput {
  assertAvailableHistory(snapshot);
  const detail = snapshot.detail;
  const boundary = allEvents(snapshot)
    .filter((event) => event.seq <= throughIndex)
    .at(-1);
  if (!boundary) {
    throw new Error(`Snapshot has no event at or before index ${throughIndex}`);
  }
  const boundaryMs = Date.parse(boundary.createdAt);
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
    codeChanges: snapshot.codeChanges.flatMap((change) => {
      const bounded = codeChangeAt(change, boundaryMs);
      return bounded ? [bounded] : [];
    }),
    resources: (detail.annotations ?? [])
      .filter((annotation) => Date.parse(annotation.createdAt) <= boundaryMs)
      .map((annotation) => ({
        label: annotation.label,
        url: annotation.url,
        ...(annotation.status ? { status: annotation.status } : undefined),
      })),
  });
}

/** Return the last event index included in a conversation snapshot. */
export function throughIndexFromSnapshot(
  snapshot: ConversationSnapshot,
): number | undefined {
  return allEvents(snapshot).at(-1)?.seq;
}

/** Return event indexes for turns that reached a successful terminal state. */
export function completedTurnIndexesFromSnapshot(
  snapshot: ConversationSnapshot,
): number[] {
  return allEvents(snapshot)
    .filter(
      (event) =>
        event.data.type === "turn_lifecycle" &&
        (event.data.state === "succeeded" || event.data.state === "no_reply"),
    )
    .map((event) => event.seq);
}
