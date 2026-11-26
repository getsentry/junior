/**
 * Reads the authority of an action from the Conversation of its Run.
 *
 * When Guardian reviews an action, the runtime reads the messages of the
 * Conversation that the Run belongs to. It reads no Conversation above it,
 * except a Space's Lead: under a Lead, it also reads the Lead's messages, so
 * what a member told the Lead authorizes the Lead's children and they do not
 * ask the member again. The source is the `message` events: the durable
 * visible transcript.
 * Compaction never rewrites these events, so an early request or a
 * later revocation is still there after the model history changes.
 *
 * A message counts as the user only when its stored author Identity is one
 * of the Identities of the person behind the Run's Actor: every Identity of
 * their User, or only the Actor's own Identity when it has no User. So a
 * Inbox answer from the person's web Identity counts in a Slack thread.
 * A message without a stored author Identity does not count. The local CLI is
 * the one exception, because it has no per-person Identity. A Run that an
 * agent started follows its parent agent, so the tasks and messages that the
 * parent sent with startAgent or messageAgent count as the user there, and no
 * person's message does. Under a Lead, the person is the Run's Actor: the
 * member whose Lead Turn sent the task or message. Then only that member's
 * own words count as the user, in the Lead and in the Run, and the parent's
 * relayed tasks are labeled `parent agent`. Each other message keeps its
 * real author as a label and is only context. Nothing is copied into the Run.
 */
import { and, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as z from "zod";
import type { Actor } from "@/chat/actor";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { sameActorIdentity } from "@/chat/conversations/provenance";
import type { Conversation } from "@/chat/conversations/store";
import {
  ROOT_LINE_BREAK,
  type RootConversation,
  type RootConversationMessage,
} from "@/chat/guardian/proposal";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { juniorConversations } from "@/db/schema";
import { isParentMessageAuthor } from "./parent-message";

/**
 * Most root context messages that Guardian reads, newest first. Codex uses
 * 16. Messages that can authorize do not count toward this number.
 */
const MAX_ROOT_MESSAGES = 16;
/** Most characters of one root message. */
const MAX_ROOT_MESSAGE_CHARS = 4_000;
/** Most characters of all root messages together, with their labels. */
const MAX_ROOT_CONVERSATION_CHARS = 24_000;
/** Message events read from the log. Edits and skipped messages use some. */
const MAX_ROOT_MESSAGE_EVENTS = 64;

type MessageData = Extract<
  ConversationEvent["data"],
  { type: "message" | "message_updated" }
>;

const messageAuthorSchema = z.object({
  isBot: z.unknown().optional(),
  userId: z.string(),
});

/**
 * Build the Actor that wrote one root message, from the runtime-recorded
 * author and the root's provider. Returns nothing when it is not known.
 */
function messageAuthor(
  root: Conversation,
  data: MessageData,
): Actor | undefined {
  const author = messageAuthorSchema.safeParse(data.meta?.["author"]).data;
  const userId = author?.userId.trim();
  if (!userId || author?.isBot === true) {
    return undefined;
  }
  const session = root.sessionSource;
  const platform = session?.kind ?? root.destination?.platform;
  if (platform === "slack") {
    const teamId =
      session?.kind === "slack"
        ? session.teamId
        : root.destination?.platform === "slack"
          ? root.destination.teamId
          : undefined;
    return teamId ? { platform, teamId, userId } : undefined;
  }
  return platform === "local" || platform === "web"
    ? { platform, userId }
    : undefined;
}

/**
 * Return the Identity ids of the person behind `actor`: every Identity of
 * their User, or only the Actor's own Identity when it has no User. A system
 * or local Actor has no user Identity, so this set is empty for it.
 */
async function actorIdentityIds(actor: Actor): Promise<Set<string>> {
  const resolved = await readActorIdentity(actor);
  const identities =
    resolved?.user?.identities ?? (resolved ? [resolved.identity] : []);
  return new Set(identities.map((identity) => identity.id));
}

/** Label one root message with its real author. */
function messageLabel(
  root: Conversation,
  data: MessageData,
  actor: Actor | undefined,
  personIdentityIds: ReadonlySet<string>,
): RootConversationMessage["author"] {
  if (data.role === "assistant") {
    return "assistant";
  }
  if (data.role !== "user") {
    return "system";
  }
  // In a Run that an agent started, a parent message is the instruction. In
  // a Run that a person's words authorize, it is text that an agent relayed.
  if (
    isParentMessageAuthor(
      messageAuthorSchema.safeParse(data.meta?.["author"]).data,
    )
  ) {
    return actor ? "parent agent" : "user";
  }
  // An Event Turn input, such as a child agent result, is not a person.
  if (data.meta?.["eventType"] !== undefined) {
    return "event";
  }
  if (data.authorIdentityId && personIdentityIds.has(data.authorIdentityId)) {
    return "user";
  }
  const author = messageAuthor(root, data);
  // The local CLI has no per-person Identity. Its messages use the system
  // Identity, which events use too, so a local message counts by its Actor.
  if (
    author?.platform === "local" &&
    actor &&
    sameActorIdentity(author, actor)
  ) {
    return "user";
  }
  return "other person";
}

/** Characters of one message as Guardian reads it, with a label per line. */
function renderedChars(message: RootConversationMessage): number {
  const lines = message.text.split("\n").length;
  return message.text.length + lines * (message.author.length + 2);
}

/** Only these labels can authorize an action. */
function canAuthorize(message: RootConversationMessage): boolean {
  return message.author === "user";
}

/** Use one line break, so a label cannot hide inside another line. */
function normalizeLines(text: string): string {
  return text.split(ROOT_LINE_BREAK).join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n[truncated ${text.length - 2 * half} characters]\n${text.slice(-half)}`;
}

/**
 * Read the opening message of a Conversation: the oldest message, which
 * usually holds the original request or task. `seq` is set only when the
 * message is older than the read page.
 */
async function readOpeningMessage(
  root: Conversation,
  page: ReadonlyMap<string, MessageData>,
): Promise<{ data: MessageData; seq?: number } | undefined> {
  const store = getConversationEventStore();
  const event = (
    await store.query(root.conversationId, {
      afterSeq: -1,
      limit: 1,
      types: ["message"],
    })
  ).events[0];
  if (event?.data.type !== "message") {
    return undefined;
  }
  // The read page has the newest edit when the message is in it.
  const inPage = page.get(event.data.messageId);
  return inPage ? { data: inPage } : { data: event.data, seq: event.seq };
}

/**
 * Read the id of the Space Lead that is the tree root of a Conversation, or
 * nothing when the Conversation is not under a Lead. The Lead is the root of
 * the requester's own tree, with the same visibility and audience, so
 * reading it follows `policies/conversation-access.md`.
 */
async function readLeadAbove(
  conversationId: string,
): Promise<string | undefined> {
  const lead = alias(juniorConversations, "lead");
  const [row] = await getDb()
    .select({ conversationId: lead.conversationId })
    .from(juniorConversations)
    .innerJoin(
      lead,
      and(
        eq(lead.conversationId, juniorConversations.rootConversationId),
        eq(lead.kind, "lead"),
        ne(lead.conversationId, juniorConversations.conversationId),
      ),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.conversationId;
}

/**
 * Read a bounded projection of the Run's own Conversation for Guardian review
 * of one action. `actor` is the requester: the Actor whose instructions the
 * Run follows, or nothing when an agent writes them. `runActor` is the Run's
 * Actor. Only the requester's messages are labeled as authority. For a Run
 * that an agent started, those are its parent agent's tasks and messages.
 *
 * Under a Space's Lead, the person is the requester, or else the Run's Actor:
 * the member whose Lead Turn handed off the work. Their own messages to the
 * Lead and to the Run are the authority, and the parent's tasks are relayed
 * text. A Run of a system Actor keeps the parent's tasks as its authority.
 */
export async function readRootConversation(args: {
  actor: Actor | undefined;
  conversationId: string;
  runActor?: Actor | undefined;
}): Promise<RootConversation> {
  const leadId = await readLeadAbove(args.conversationId);
  const person = args.actor ?? args.runActor;
  if (!leadId || !person || person.platform === "system") {
    return await readConversationMessages(args);
  }
  const [own, lead] = await Promise.all([
    readConversationMessages({
      actor: person,
      conversationId: args.conversationId,
    }),
    readConversationMessages({ actor: person, conversationId: leadId }),
  ]);
  return { ...own, lead };
}

/**
 * Read the bounded, author-labeled messages of one Conversation. Only the
 * messages of `actor`, or of the parent agent when `actor` is nothing, are
 * labeled `user`.
 */
async function readConversationMessages(args: {
  actor: Actor | undefined;
  conversationId: string;
}): Promise<Omit<RootConversation, "lead">> {
  const root = await getConversationStore().get({
    conversationId: args.conversationId,
  });
  if (!root) {
    return { messages: [], truncated: false };
  }
  const page = await getConversationEventStore().query(root.conversationId, {
    limit: MAX_ROOT_MESSAGE_EVENTS,
    types: ["message", "message_updated"],
  });
  // Each message keeps the position of its original event. An edit changes
  // only the text, never the author. An edit of a message older than the page
  // has no position, so it is left out like the original.
  const byId = new Map<string, MessageData>();
  const orphanEdits = new Map<string, string>();
  for (const event of page.events) {
    const data = event.data as MessageData;
    if (data.type === "message") {
      byId.set(data.messageId, data);
      continue;
    }
    const original = byId.get(data.messageId);
    if (original) {
      byId.set(data.messageId, { ...original, text: data.text });
    } else {
      orphanEdits.set(data.messageId, data.text);
    }
  }
  // The opening message holds the original request or task, so it stays when
  // newer messages push it out of the window.
  const pinnedRead = await readOpeningMessage(root, byId);
  // The opening message has a position, so an edit of it in the page counts.
  const openingEdit = pinnedRead
    ? orphanEdits.get(pinnedRead.data.messageId)
    : undefined;
  if (pinnedRead) {
    orphanEdits.delete(pinnedRead.data.messageId);
  }
  const opening =
    pinnedRead && openingEdit !== undefined
      ? { ...pinnedRead.data, text: openingEdit }
      : pinnedRead?.data;
  const personIdentityIds = args.actor
    ? await actorIdentityIds(args.actor)
    : new Set<string>();
  const all: Array<RootConversationMessage & { messageId: string }> = [];
  for (const data of byId.values()) {
    const text = normalizeLines(data.text).trim();
    // A message that Junior did not answer still counts. It can hold a
    // restriction or a revocation.
    if (!text || data.messageId === opening?.messageId) {
      continue;
    }
    all.push({
      author: messageLabel(root, data, args.actor, personIdentityIds),
      messageId: data.messageId,
      text: truncate(text, MAX_ROOT_MESSAGE_CHARS),
    });
  }
  // The opening message is not one of the newest messages, so it does not
  // count toward their number. Its characters do count.
  const openingText = opening ? normalizeLines(opening.text).trim() : "";
  const pinned: RootConversationMessage[] =
    opening && openingText
      ? [
          {
            author: messageLabel(root, opening, args.actor, personIdentityIds),
            text: truncate(openingText, MAX_ROOT_MESSAGE_CHARS),
          },
        ]
      : [];
  // Messages that can authorize come first, newest first, so a later
  // restriction or revocation stays when the read is cut. Context messages
  // fill the rest, newest first.
  const kept = new Set<number>();
  let chars = pinned[0] ? renderedChars(pinned[0]) : 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index]!;
    if (!canAuthorize(message)) {
      continue;
    }
    // Stop at the first one that does not fit. An older message must never
    // stay when a newer one that can narrow it is cut.
    if (chars + renderedChars(message) > MAX_ROOT_CONVERSATION_CHARS) {
      break;
    }
    kept.add(index);
    chars += renderedChars(message);
  }
  let contextMessages = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index]!;
    if (canAuthorize(message) || contextMessages >= MAX_ROOT_MESSAGES) {
      continue;
    }
    if (chars + renderedChars(message) > MAX_ROOT_CONVERSATION_CHARS) {
      continue;
    }
    kept.add(index);
    chars += renderedChars(message);
    contextMessages += 1;
  }
  // Keep the event order. A note marks each gap, so a reply is not read as
  // the answer to a message that is not shown.
  const messages: RootConversationMessage[] = [];
  let omitted = 0;
  const addGapNote = () => {
    if (omitted > 0) {
      messages.push({
        author: "system",
        text: `[${omitted} ${omitted === 1 ? "message is" : "messages are"} not shown here. A reply after this note may answer one of them.]`,
      });
      omitted = 0;
    }
  };
  for (const [index, message] of all.entries()) {
    if (!kept.has(index)) {
      omitted += 1;
      continue;
    }
    addGapNote();
    messages.push({ author: message.author, text: message.text });
  }
  addGapNote();
  // When the opening message is older than the page, only messages between
  // it and the page are missing.
  const firstSeq = page.events[0]?.seq;
  const hasOlder =
    pinnedRead?.seq === undefined || firstSeq === undefined
      ? page.hasOlder
      : (
          await getConversationEventStore().query(root.conversationId, {
            afterSeq: pinnedRead.seq,
            beforeSeq: firstSeq,
            limit: 1,
            types: ["message", "message_updated"],
          })
        ).events.length > 0;
  return {
    messages: [...pinned, ...messages],
    truncated: hasOlder || orphanEdits.size > 0 || kept.size < all.length,
  };
}
