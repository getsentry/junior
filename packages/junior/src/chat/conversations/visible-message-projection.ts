import type { ConversationEvent } from "./history";
import type {
  ConversationAuthor,
  ConversationMessage,
  ConversationMessageMeta,
} from "@/chat/state/conversation";

type VisibleMessageEvent = ConversationEvent & {
  data: Extract<
    ConversationEvent["data"],
    {
      type:
        | "visible_message_recorded"
        | "visible_message_metadata_updated"
        | "visible_message_replied";
    }
  >;
};

interface ProjectedMessage {
  message: ConversationMessage;
  repliedAtMs?: number;
}

function isVisibleMessageEvent(
  event: ConversationEvent,
): event is VisibleMessageEvent {
  return (
    event.data.type === "visible_message_recorded" ||
    event.data.type === "visible_message_metadata_updated" ||
    event.data.type === "visible_message_replied"
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
    ...(author ? { author } : {}),
    ...(Object.keys(rest).length > 0
      ? { meta: rest as ConversationMessageMeta }
      : {}),
  };
}

function storedMeta(message: ConversationMessage): Record<string, unknown> {
  return {
    ...(message.author ? { author: message.author } : {}),
    ...(message.meta ?? {}),
  };
}

/** Reduce canonical visible-message facts into the destination-facing transcript. */
export function projectVisibleConversationMessages(
  events: ConversationEvent[],
): ConversationMessage[] {
  const byId = new Map<string, ProjectedMessage>();

  for (const event of events) {
    if (!isVisibleMessageEvent(event)) continue;
    const data = event.data;
    const current = byId.get(data.messageId);

    if (data.type === "visible_message_recorded") {
      const message: ConversationMessage = {
        id: data.messageId,
        role: data.role,
        text: data.text,
        createdAtMs: event.createdAtMs,
        ...splitMeta(data.meta),
      };
      if (current)
        throw new Error(
          `Duplicate visible_message_recorded event for ${data.messageId} at seq ${event.seq}`,
        );
      byId.set(data.messageId, { message });
      continue;
    }

    // A compacted prefix can have a later metadata/reply fact inside the live
    // suffix query. Its absent baseline means the whole message stays compacted.
    if (!current) continue;
    if (data.type === "visible_message_metadata_updated") {
      const merged = { ...storedMeta(current.message), ...data.meta };
      const { author: _author, meta: _meta, ...baseline } = current.message;
      current.message = {
        ...baseline,
        ...splitMeta(merged),
      };
      continue;
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
