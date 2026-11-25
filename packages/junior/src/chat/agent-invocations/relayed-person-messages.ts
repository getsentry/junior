/**
 * Copies of a person's own messages that go with an agent message to another
 * top-level Conversation.
 *
 * When an agent messages another top-level agent in a Turn that a person
 * runs, the runtime copies that person's newest messages from the sender's
 * stored transcript into the message. The agent writes only the message
 * text, and only the runtime writes the copy, so the receiver can tell the
 * person's exact words from the agent's retelling. Guardian in the receiver
 * counts a copy as the person's own message only when that person is whose
 * work the receiver does.
 */
import * as z from "zod";
import type { Actor } from "@/chat/actor";
import { getConversationEventStore } from "@/chat/db";
import { readActorIdentity } from "@/chat/plugins/viewer";

/** Most of the person's messages that one agent message copies. */
const MAX_RELAYED_MESSAGES = 3;
/** Most characters of one copied message. */
const MAX_RELAYED_MESSAGE_CHARS = 4_000;
/** Newest message events that the copy reads from the sender. */
const MAX_SENDER_MESSAGE_EVENTS = 32;

const relayedMessageSchema = z
  .object({
    messageId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .strict();

/**
 * Runtime-written copy of one person's messages from the sender's Turn.
 * Stored transcripts keep it, so a shape change needs a new field name.
 */
export const relayedPersonMessagesSchema = z
  .object({
    /** The person who wrote every copied message. */
    authorIdentityId: z.string().min(1),
    authorName: z.string().min(1).optional(),
    /** The sender Conversation where the person wrote them. */
    conversationId: z.string().min(1),
    messages: z.array(relayedMessageSchema).min(1),
    /**
     * The sender's reply directly before the first copied message, so a bare
     * yes keeps the question that it answers. The agent wrote it, so it is
     * never approval.
     */
    question: z.string().min(1).optional(),
  })
  .strict();
export type RelayedPersonMessages = z.output<
  typeof relayedPersonMessagesSchema
>;

/**
 * Return the Identity ids of the person behind `actor`: every Identity of
 * their User, or only the Actor's own Identity when it has no User. A system
 * or local Actor has no user Identity, so this set is empty for it.
 */
export async function personIdentityIds(actor: Actor): Promise<Set<string>> {
  return identityIdsOf(await readActorIdentity(actor));
}

/**
 * Return the Identity ids of a resolved person: every Identity of their
 * User, or only their own Identity when they have no User.
 */
export function identityIdsOf(
  resolved: Awaited<ReturnType<typeof readActorIdentity>>,
): Set<string> {
  const identities =
    resolved?.user?.identities ?? (resolved ? [resolved.identity] : []);
  return new Set(identities.map((identity) => identity.id));
}

function truncate(text: string): string {
  return text.length <= MAX_RELAYED_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_RELAYED_MESSAGE_CHARS)}\n[truncated ${text.length - MAX_RELAYED_MESSAGE_CHARS} characters]`;
}

/**
 * Read the messages that `actor` wrote in `conversationId` since the last
 * reply there, newest last: the input of the Turn that the person runs,
 * such as their request or an Inbox answer. Returns nothing when the newest
 * messages are not theirs.
 */
export async function readRelayedPersonMessages(args: {
  actor: Actor;
  conversationId: string;
}): Promise<RelayedPersonMessages | undefined> {
  const resolved = await readActorIdentity(args.actor);
  const ids = identityIdsOf(resolved);
  if (!resolved || ids.size === 0) {
    return undefined;
  }
  const page = await getConversationEventStore().query(args.conversationId, {
    limit: MAX_SENDER_MESSAGE_EVENTS,
    types: ["message"],
  });
  const messages: RelayedPersonMessages["messages"] = [];
  let question: string | undefined;
  let authorIdentityId: string | undefined;
  for (let index = page.events.length - 1; index >= 0; index -= 1) {
    const event = page.events[index]!;
    const data = event.data;
    if (data.type !== "message") {
      continue;
    }
    if (data.role === "assistant") {
      question = data.text.trim() ? truncate(data.text.trim()) : undefined;
      break;
    }
    const text = data.text.trim();
    // An Event or another person's message in between is not the person's
    // input, so it is skipped and never copied.
    if (
      data.role !== "user" ||
      !text ||
      data.meta?.["eventType"] !== undefined ||
      !data.authorIdentityId ||
      !ids.has(data.authorIdentityId)
    ) {
      continue;
    }
    authorIdentityId ??= data.authorIdentityId;
    messages.unshift({
      messageId: data.messageId,
      seq: event.seq,
      text: truncate(text),
    });
    if (messages.length >= MAX_RELAYED_MESSAGES) {
      break;
    }
  }
  if (!authorIdentityId || messages.length === 0) {
    return undefined;
  }
  const authorName =
    resolved.user?.displayName ?? resolved.identity.displayName;
  return {
    authorIdentityId,
    ...(authorName ? { authorName } : undefined),
    conversationId: args.conversationId,
    messages,
    ...(question ? { question } : undefined),
  };
}
