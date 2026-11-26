import { applyPluginFormatMarkdown } from "@/chat/plugins/hooks/prompt";
import { wrapBareSlackUserIds } from "@/chat/slack/mrkdwn";
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
 * provider's text. In a chat reply, a bare `@U123` is a Slack user, as in
 * Slack, and not an account of a plugin's provider. A person's message gets
 * the same links, so a typed `owner/repo#12` shows the card that a pasted
 * URL shows. Raw Event text shows as written.
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
  if (data.text === undefined || data.role === "system") return event;
  const text =
    data.role === "assistant" ? wrapBareSlackUserIds(data.text) : data.text;
  return { ...event, data: { ...data, text: format(text) } };
}
