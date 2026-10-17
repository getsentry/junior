/**
 * Reads the authority of a child agent from its root Conversation.
 *
 * A child agent never has a message from a person. Its task comes from its
 * parent agent. When Guardian reviews an action of a child, the runtime walks
 * up to the root Conversation and reads the messages there. The source is the
 * root's `message` events: the durable visible transcript. Compaction and
 * handoff never rewrite these events, so an early request or a later
 * revocation is still there after the root's model history changes.
 *
 * Only a message whose author has the same Actor identity as the task Actor
 * of the child's current Turn counts as authority (see
 * `conversations/task-actor.ts`). Each other message keeps its real author as
 * a label and is only context. Nothing is copied into the child.
 */
import type { Actor } from "@/chat/actor";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { sameActorIdentity } from "@/chat/conversations/provenance";
import { loadTurnTaskActor } from "@/chat/conversations/task-actor";
import type { Conversation } from "@/chat/conversations/store";
import type {
  RootConversation,
  RootConversationMessage,
} from "@/chat/tool-support/action-review";

/** Most root messages that Guardian reads, newest first. Codex uses 16. */
const MAX_ROOT_MESSAGES = 16;
/** Most characters of one root message. */
const MAX_ROOT_MESSAGE_CHARS = 4_000;
/** Most characters of all root messages together. */
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
  taskActor: Actor,
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
  if (!sameActorIdentity(author, taskActor)) {
    return author?.platform === "system" ? "event" : "other person";
  }
  return author?.platform === "system" ? "automation" : "user";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n[truncated ${text.length - 2 * half} characters]\n${text.slice(-half)}`;
}

/**
 * Read the instruction of an Automation run root: its dispatch input
 * message, loaded by id. Returns nothing for another root. `seq` is set only
 * when the instruction is older than the read page.
 */
async function readAutomationInstruction(
  root: Conversation,
  page: ReadonlyMap<string, MessageData>,
): Promise<{ data: MessageData; seq?: number } | undefined> {
  if (!root.conversationId.startsWith(DISPATCH_CONVERSATION_PREFIX)) {
    return undefined;
  }
  // The read page has the newest edit when the message is in it.
  const inPage = page.get(root.conversationId);
  if (inPage) {
    return { data: inPage };
  }
  // Each message event uses this key, as written by conversation ingress.
  const event = await getConversationEventStore().loadByIdempotencyKey(
    root.conversationId,
    `message:${root.conversationId}`,
  );
  return event?.data.type === "message"
    ? { data: event.data, seq: event.seq }
    : undefined;
}

/**
 * Read a bounded projection of the root Conversation for Guardian review of
 * one child agent action in Turn `turnId`. Only messages that the task Actor
 * of that Turn wrote, or the Automation run's own instruction for its system
 * Actor, are labeled as authority. The task Actor is not the Run Actor: a
 * watch event Turn runs as the event system Actor. When the Turn has no task
 * Actor, nothing is authority. When `conversationId` is a root, it returns
 * nothing.
 */
export async function readRootConversation(args: {
  conversationId: string;
  turnId: string;
}): Promise<RootConversation> {
  const root = await findRootConversation(args.conversationId);
  if (!root || root.conversationId === args.conversationId) {
    return { messages: [], truncated: false };
  }
  const taskActor = await loadTurnTaskActor(args);
  if (!taskActor) {
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
  let orphanEdits = false;
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
      orphanEdits = true;
    }
  }
  // The instruction of an Automation run is its authority, so it stays in
  // the projection when newer messages push it out of the window.
  const pinnedRead = await readAutomationInstruction(root, byId);
  const instruction = pinnedRead?.data;
  const all: Array<RootConversationMessage & { messageId: string }> = [];
  for (const data of byId.values()) {
    const text = data.text.trim();
    // A message that Junior did not answer still counts. It can hold a
    // restriction or a revocation.
    if (!text || data.messageId === instruction?.messageId) {
      continue;
    }
    all.push({
      author: messageLabel(root, data, taskActor),
      messageId: data.messageId,
      text: truncate(text, MAX_ROOT_MESSAGE_CHARS),
    });
  }
  // The pinned instruction is not one of the newest messages, so it does
  // not count toward their number. Its characters do count.
  const instructionText = instruction?.text.trim();
  const pinned: RootConversationMessage[] =
    instruction && instructionText
      ? [
          {
            author: messageLabel(root, instruction, taskActor),
            text: truncate(instructionText, MAX_ROOT_MESSAGE_CHARS),
          },
        ]
      : [];
  const messages: RootConversationMessage[] = [];
  let chars = pinned[0]?.text.length ?? 0;
  for (const message of [...all].reverse()) {
    if (
      messages.length >= MAX_ROOT_MESSAGES ||
      chars + message.text.length > MAX_ROOT_CONVERSATION_CHARS
    ) {
      break;
    }
    messages.unshift({ author: message.author, text: message.text });
    chars += message.text.length;
  }
  // When the instruction is older than the page, only messages between it
  // and the page are missing.
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
    truncated: hasOlder || orphanEdits || messages.length < all.length,
  };
}
