/**
 * Saved agent history: the model context that Junior committed for a
 * Conversation, as the runtime's history reader returns it. Read-only.
 */
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { getConversationEventStore } from "@/chat/db";

/** One saved agent-history item, in commit order. */
export type SavedHistoryItem =
  | {
      type: "user_message";
      seq: number;
      provenance: ConversationMessageProvenance;
      text: string;
    }
  | { type: "assistant_message"; seq: number; text: string }
  | { type: "tool_result"; seq: number; toolName: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: { type?: unknown; text?: unknown }) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

/** Return the saved agent history of a Conversation, in commit order. */
export async function savedAgentHistory(
  conversationId: string,
): Promise<SavedHistoryItem[]> {
  const events = await getConversationEventStore().loadHistory(conversationId);
  return events.flatMap((event): SavedHistoryItem[] => {
    const { data, seq } = event;
    if (data.type === "user_message") {
      return [
        {
          type: data.type,
          seq,
          provenance: data.provenance,
          text: textOf(data.content),
        },
      ];
    }
    if (data.type === "assistant_message") {
      return [{ type: data.type, seq, text: textOf(data.content) }];
    }
    if (data.type === "tool_result") {
      return [{ type: data.type, seq, toolName: String(data.toolName) }];
    }
    return [];
  });
}
