/**
 * Reads the authority of an action from its root Conversation.
 *
 * When Guardian reviews an action, the runtime walks up to the root
 * Conversation and reads the messages there. For a root Run, the root is its
 * own Conversation. A child agent never has a message from a person: its task
 * comes from its parent agent, so it reads the root of its parent chain. The
 * source is the root's `message` events: the durable visible transcript.
 * Compaction and handoff never rewrite these events, so an early request or a
 * later revocation is still there after the root's model history changes.
 *
 * Only a message whose author has the same Actor identity as the Run counts
 * as authority. Each other message keeps its real author as a label and is
 * only context. Nothing is copied into the Run.
 */
import type { Actor } from "@/chat/actor";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { sameActorIdentity } from "@/chat/conversations/provenance";
import type { Conversation } from "@/chat/conversations/store";
import {
  ROOT_LINE_BREAK,
  type RootConversation,
  type RootConversationMessage,
} from "@/chat/guardian/proposal";

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
/** A parent chain longer than this is broken, so it gives no authority. */
const MAX_PARENT_DEPTH = 32;

// A dispatch Conversation id and its input message id are the same value.
const DISPATCH_CONVERSATION_PREFIX = "agent-dispatch:";

type MessageData = Extract<
  ConversationEvent["data"],
  { type: "message" | "message_updated" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Find the root Conversation, or nothing when the parent chain is broken. */
async function findRootConversation(
  conversationId: string,
): Promise<Conversation | undefined> {
  const store = getConversationStore();
  let conversation = await store.get({ conversationId });
  for (let depth = 0; conversation?.parentConversationId; depth += 1) {
    if (depth >= MAX_PARENT_DEPTH) {
      return undefined;
    }
    conversation = await store.get({
      conversationId: conversation.parentConversationId,
    });
  }
  return conversation;
}

/**
 * Build the Actor that wrote one root message, from the runtime-recorded
 * author and the root's provider. Returns nothing when it is not known.
 */
function messageAuthor(
  root: Conversation,
  data: MessageData,
): Actor | undefined {
  const author = isRecord(data.meta?.author) ? data.meta.author : undefined;
  const userId =
    typeof author?.userId === "string" ? author.userId.trim() : undefined;
  if (!userId) {
    return undefined;
  }
  if (author?.isBot === true) {
    // The runtime writes an Automation run's instruction as the dispatch
    // input message, under the run's system Actor.
    return root.conversationId.startsWith(DISPATCH_CONVERSATION_PREFIX) &&
      data.messageId === root.conversationId
      ? { platform: "system", name: userId }
      : undefined;
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

/** Label one root message with its real author. */
function messageLabel(
  root: Conversation,
  data: MessageData,
  actor: Actor,
): RootConversationMessage["author"] {
  if (data.role === "assistant") {
    return "assistant";
  }
  if (data.role !== "user") {
    return "system";
  }
  // An Event Turn input, such as a child agent result, is not a person.
  if (data.meta?.eventType !== undefined) {
    return "event";
  }
  const author = messageAuthor(root, data);
  if (!sameActorIdentity(author, actor)) {
    return author?.platform === "system" ? "event" : "other person";
  }
  return author?.platform === "system" ? "automation" : "user";
}

/** Characters of one message as Guardian reads it, with a label per line. */
function renderedChars(message: RootConversationMessage): number {
  const lines = message.text.split("\n").length;
  return message.text.length + lines * (message.author.length + 2);
}

/** Only these labels can authorize an action. */
function canAuthorize(message: RootConversationMessage): boolean {
  return message.author === "user" || message.author === "automation";
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
 * Read the opening message of a root. For an Automation run root, it is the
 * run's instruction: its dispatch input message, loaded by id. For another
 * root, it is the oldest message, which usually holds the original request.
 * `seq` is set only when the message is older than the read page.
 */
async function readOpeningMessage(
  root: Conversation,
  page: ReadonlyMap<string, MessageData>,
): Promise<{ data: MessageData; seq?: number } | undefined> {
  const store = getConversationEventStore();
  const event = root.conversationId.startsWith(DISPATCH_CONVERSATION_PREFIX)
    ? // Each message event uses this key, as written by conversation ingress.
      await store.loadByIdempotencyKey(
        root.conversationId,
        `message:${root.conversationId}`,
      )
    : (
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
 * Read a bounded projection of the root Conversation for Guardian review of
 * one action. `actor` is the Actor of the Run. Only messages that the same
 * Actor wrote, or the Automation run's own instruction for a system Actor,
 * are labeled as authority. When `conversationId` is a root, it reads that
 * Conversation.
 */
export async function readRootConversation(args: {
  actor: Actor | undefined;
  conversationId: string;
}): Promise<RootConversation> {
  const root = await findRootConversation(args.conversationId);
  if (!root || !args.actor) {
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
  // The opening message holds the original request, or the instruction of an
  // Automation run, so it stays when newer messages push it out of the window.
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
  const all: Array<RootConversationMessage & { messageId: string }> = [];
  for (const data of byId.values()) {
    const text = normalizeLines(data.text).trim();
    // A message that Junior did not answer still counts. It can hold a
    // restriction or a revocation.
    if (!text || data.messageId === opening?.messageId) {
      continue;
    }
    all.push({
      author: messageLabel(root, data, args.actor),
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
            author: messageLabel(root, opening, args.actor),
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
  // When the opening message is older than the page, only messages between
  // it and the page are missing.
  const firstSeq = page.events[0]?.seq;
  const openingGap =
    pinnedRead?.seq !== undefined &&
    firstSeq !== undefined &&
    (
      await getConversationEventStore().query(root.conversationId, {
        afterSeq: pinnedRead.seq,
        beforeSeq: firstSeq,
        limit: 1,
        types: ["message", "message_updated"],
      })
    ).events.length > 0;
  const hasOlder = pinnedRead?.seq === undefined ? page.hasOlder : openingGap;
  // Keep the event order. A note marks each gap, so a reply is not read as
  // the answer to a message that is not shown. A gap after the opening
  // message can hide a newer message that narrows it, so its note says so.
  const messages: RootConversationMessage[] = [];
  let omitted = 0;
  let afterOpening = openingGap;
  const addGapNote = () => {
    if (afterOpening) {
      messages.push({
        author: "system",
        text: "[Messages after the opening message are not shown here. They may narrow or revoke it. A reply after this note may answer one of them.]",
      });
      afterOpening = false;
      omitted = 0;
    } else if (omitted > 0) {
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
  return {
    messages: [...pinned, ...messages],
    truncated: hasOlder || orphanEdits.size > 0 || kept.size < all.length,
  };
}
