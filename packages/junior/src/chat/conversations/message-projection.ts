import type { ConversationEvent, MessageHistory } from "./history";
import type {
  ConversationAuthor,
  ConversationMessage,
  ConversationMessageMeta,
} from "@/chat/state/conversation";

type MessageEvent = ConversationEvent & {
  data: Extract<
    ConversationEvent["data"],
    {
      type: "message" | "message_updated" | "message_handled";
    }
  >;
};

interface ProjectedMessage {
  message: ConversationMessage;
  repliedAtMs?: number;
}

function isMessageEvent(event: ConversationEvent): event is MessageEvent {
  return (
    event.data.type === "message" ||
    event.data.type === "message_updated" ||
    event.data.type === "message_handled"
  );
}

function splitMeta(meta: Record<string, unknown> | undefined): {
  author?: ConversationAuthor;
  meta?: ConversationMessageMeta;
} {
  const rest = { ...(meta ?? {}) };
  const author = rest.author as ConversationAuthor | undefined;
  delete rest.author;
  return {
    ...(author ? { author } : undefined),
    ...(Object.keys(rest).length > 0
      ? { meta: rest as ConversationMessageMeta }
      : undefined),
  };
}

function missingBaselineError(event: MessageEvent): Error {
  return new Error(
    `Message event ${event.data.type} at seq ${event.seq} references ${event.data.messageId} before message`,
  );
}

/** Reduce a boundary-bearing message-history suffix into destination history. */
export function projectConversationMessages(
  history: Pick<MessageHistory, "events" | "historyFromSeq">,
): ConversationMessage[] {
  const byId = new Map<string, ProjectedMessage>();

  for (const event of history.events) {
    if (!isMessageEvent(event)) continue;
    const data = event.data;
    const current = byId.get(data.messageId);

    if (data.type === "message" || data.type === "message_updated") {
      const message: ConversationMessage = {
        id: data.messageId,
        role: data.role,
        text: data.text,
        createdAtMs: event.createdAtMs,
        ...splitMeta(data.meta),
      };
      if (data.type === "message" && current)
        throw new Error(
          `Duplicate message event for ${data.messageId} at seq ${event.seq}`,
        );
      if (data.type === "message_updated" && !current) {
        if (history.historyFromSeq > 0) continue;
        throw missingBaselineError(event);
      }
      byId.set(data.messageId, {
        message: {
          ...message,
          createdAtMs: current?.message.createdAtMs ?? message.createdAtMs,
        },
        ...(current?.repliedAtMs === undefined
          ? undefined
          : { repliedAtMs: current.repliedAtMs }),
      });
      continue;
    }

    if (!current) {
      if (history.historyFromSeq > 0) continue;
      throw missingBaselineError(event);
    }
    current.repliedAtMs ??= event.createdAtMs;
  }

  return [...byId.values()].map(({ message, repliedAtMs }) => {
    if (repliedAtMs === undefined) return message;
    return {
      ...message,
      meta: { ...(message.meta ?? {}), replied: true },
    };
  });
}
