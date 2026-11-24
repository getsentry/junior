import { mapBounded } from "@/chat/fan-out";
import { readMessageAttachments } from "@/chat/attachments/input";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import type { AgentInstructionInput } from "@/chat/agent/types";
import type { InboxItemChangeRecord } from "@/chat/inbox-items/change-record";
import {
  eventInboxItemInputs,
  loadInboxItemInput,
} from "@/chat/inbox-items/prompt-input";
import {
  eventBatchMessageMeta,
  isEventMailboxMetadata,
  renderEventBatchInputs,
} from "@/chat/events/notification";
import type { MailboxTurnInput } from "@/chat/task-execution/mailbox-turn";
import type { InboundMessage } from "@/chat/task-execution/store";

/**
 * Return the Turn inputs of web Messages, one per non-empty Message, in
 * order. Each one becomes its own prompt content part. A Message that
 * records an answer becomes its Inbox item tag. A batch with only
 * attachments keeps one empty input, so the prompt still has an instruction.
 */
export async function webTurnInputs(
  messages: readonly {
    reviewItemChange?: InboxItemChangeRecord | undefined;
    text: string;
  }[],
): Promise<AgentInstructionInput[]> {
  const inputs = await mapBounded(
    messages,
    async (message): Promise<AgentInstructionInput[]> => {
      const inboxItem = await loadInboxItemInput(message.reviewItemChange);
      if (inboxItem) return [inboxItem];
      const text = message.text.trim();
      return text ? [{ kind: "person", text }] : [];
    },
  );
  const flat = inputs.flat();
  return flat.length ? flat : [{ kind: "person", text: "" }];
}

/**
 * Build the transcript Message for one web mailbox Message. Each web Message
 * keeps its own transcript Message and Inbox item change record, so the
 * dashboard shows what each Message did even when several share a Turn.
 */
export function webConversationMessage(
  message: InboundMessage,
  author: ConversationAuthor,
): ConversationMessage {
  const attachments = readMessageAttachments(message.input.attachments);
  const { reviewItemChange } = message.input;
  return {
    id: message.inboundMessageId,
    role: "user",
    text: normalizeConversationText(message.input.text),
    createdAtMs: message.createdAtMs,
    author,
    ...(message.input.authorIdentityId
      ? { authorIdentityId: message.input.authorIdentityId }
      : undefined),
    meta: {
      ...(attachments.length ? { attachments } : undefined),
      explicitMention: true,
      ...(message.input.metadata?.["fromLead"] === true
        ? { fromLead: true as const }
        : undefined),
      ...(reviewItemChange
        ? { reviewItemChanges: [reviewItemChange] }
        : undefined),
      source: "web",
    },
  };
}

/**
 * Return the saved input Messages of a resumed Turn in input order. A web
 * batch saves each Message apart. An older Turn saved one joined Message, so
 * its other input ids have no saved Message.
 */
export function savedTurnInputMessages(
  conversation: ThreadConversationState,
  turnMessage: ConversationMessage,
  inputMessageIds: readonly string[] | undefined,
): ConversationMessage[] {
  const saved = (inputMessageIds ?? []).flatMap(
    (id) =>
      conversation.messages.find(
        (message) => message.id === id && message.role === "user",
      ) ?? [],
  );
  return saved.some((message) => message.id === turnMessage.id)
    ? saved
    : [turnMessage];
}

/**
 * Render the Turn inputs of one new mailbox batch. A parent batch is the
 * parent's task. An Event batch also returns the
 * meta of its one saved Message. A web batch returns one transcript Message
 * per input.
 */
export async function mailboxTurnInputs(
  batch: readonly MailboxTurnInput[],
  fromParent: boolean,
): Promise<{
  eventMeta: ReturnType<typeof eventBatchMessageMeta>;
  inputs: AgentInstructionInput[];
  webInputMessages: ConversationMessage[];
}> {
  const messages = batch.map((entry) => entry.message);
  if (fromParent) {
    return {
      eventMeta: {},
      inputs: batch.map(({ message, requestText }) => ({
        kind: "runtime",
        text: message.input.text.trim(),
        ...(requestText ? { requestText } : undefined),
      })),
      webInputMessages: [],
    };
  }
  if (isEventMailboxMetadata(messages[0]?.input.metadata)) {
    return {
      eventMeta: eventBatchMessageMeta(messages),
      inputs: renderEventBatchInputs(
        messages,
        await eventInboxItemInputs(messages),
      ),
      webInputMessages: [],
    };
  }
  return {
    eventMeta: {},
    inputs: await webTurnInputs(messages.map((message) => message.input)),
    webInputMessages: batch.map((entry) =>
      webConversationMessage(entry.message, entry.author),
    ),
  };
}

/**
 * Return the author Identity id that every batched input shares.
 * A batch with more than one author has no single author yet.
 */
export function sharedAuthorIdentityId(
  messages: readonly InboundMessage[],
): string | undefined {
  const ids = new Set(
    messages.map((message) => message.input.authorIdentityId),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}
