import { applyPluginFormatMarkdown } from "@/chat/plugins/agent-hooks";
import type { ConversationReportEvent } from "../schema/conversation";

function format(text: string, provider?: string): string {
  return applyPluginFormatMarkdown(text, {
    platform: "web",
    ...(provider ? { provider } : undefined),
  });
}

/**
 * Apply plugin Markdown rewrites to transcript text for the dashboard, such
 * as GitHub reference and `@login` links that show as object cards. A reply
 * posted to a provider, and the summary of an Event from one, is that
 * provider's text. Raw Event text and user text show as written.
 */
export function formatConversationEventText(
  event: ConversationReportEvent,
): ConversationReportEvent {
  const { data } = event;
  if (data.type === "reply_posted") {
    return {
      ...event,
      data: { ...data, text: format(data.text, data.plugin) },
    };
  }
  if (data.type !== "message" || data.redacted) return event;
  const provider = data.eventNamespace;
  if (provider) {
    return {
      ...event,
      data: {
        ...data,
        ...(data.trustedSummary
          ? { trustedSummary: format(data.trustedSummary, provider) }
          : undefined),
        ...(data.events
          ? {
              events: data.events.map((item) =>
                item.trustedSummary
                  ? {
                      ...item,
                      trustedSummary: format(item.trustedSummary, provider),
                    }
                  : item,
              ),
            }
          : undefined),
      },
    };
  }
  return data.role === "assistant" && data.text !== undefined
    ? { ...event, data: { ...data, text: format(data.text) } }
    : event;
}
