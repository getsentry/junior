import type { ConversationReportEvent } from "@/api/schema/conversation";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";
import type { BriefEntry } from "./schema";

const TOOL_TEXT_LIMIT = 1_500;

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

/** Map reporting events to the entries used by every Brief input adapter. */
export function briefEntriesFromReportEvents(
  events: ConversationReportEvent[],
): BriefEntry[] {
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
