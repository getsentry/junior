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
 * Only a message whose author has the same Actor identity as the child counts
 * as authority. Each other message keeps its real author as a label and is
 * only context. Nothing is copied into the child.
 */
import type { Actor } from "@/chat/actor";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { sameActorIdentity } from "@/chat/conversations/provenance";
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n[truncated ${text.length - 2 * half} characters]\n${text.slice(-half)}`;
}

/**
 * Read a bounded projection of the root Conversation for Guardian review of
 * one child agent action. `actor` is the child's Actor. Only messages that
 * the same Actor wrote, or the Automation run's own instruction for a system
 * Actor, are labeled as authority. When `conversationId` is a root, it
 * returns nothing.
 */
export async function readRootConversation(args: {
  actor: Actor | undefined;
  conversationId: string;
}): Promise<RootConversation> {
  const root = await findRootConversation(args.conversationId);
  if (!root || root.conversationId === args.conversationId || !args.actor) {
    return { messages: [], truncated: false };
  }
  const page = await getConversationEventStore().query(root.conversationId, {
    limit: MAX_ROOT_MESSAGE_EVENTS,
    types: ["message", "message_updated"],
  });
  // Keep the newest version of each message in its first position.
  const byId = new Map<string, MessageData>();
  for (const event of page.events) {
    const data = event.data as MessageData;
    byId.set(data.messageId, data);
  }
  const all: RootConversationMessage[] = [];
  for (const data of byId.values()) {
    const text = data.text.trim();
    // A message that Junior did not answer still counts. It can hold a
    // restriction or a revocation.
    if (!text) {
      continue;
    }
    all.push({
      author: messageLabel(root, data, args.actor),
      text: truncate(text, MAX_ROOT_MESSAGE_CHARS),
    });
  }
  const messages: RootConversationMessage[] = [];
  let chars = 0;
  for (const message of [...all].reverse()) {
    if (
      messages.length >= MAX_ROOT_MESSAGES ||
      chars + message.text.length > MAX_ROOT_CONVERSATION_CHARS
    ) {
      break;
    }
    messages.unshift(message);
    chars += message.text.length;
  }
  return {
    messages,
    truncated: page.hasOlder || messages.length < all.length,
  };
}
