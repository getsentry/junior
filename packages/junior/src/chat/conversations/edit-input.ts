import { Message } from "chat";
import { saveSkippedConversationEvents } from "@/chat/conversations/session-stop";
import { saveSkippedSlackMessage } from "@/chat/ingress/slack-skipped-message";
import { renderSlackMessageEdit } from "@/chat/slack/message-edit";
import { parseContent } from "@/chat/slack/message/content";
import { isInboundEdit } from "@/chat/task-execution/inbound-edit";
import { parseSlackMetadata } from "@/chat/task-execution/slack-work";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";

const EDIT_SKIP_REASON = "edited message";

/**
 * Save an attempt that holds only edits as skipped Messages, so later Turns
 * see them. An edit joins a running Turn or an attempt that other input
 * starts. It never starts a Turn by itself. Returns undefined when the
 * attempt holds other input.
 */
export async function skipEditOnlyInput(
  context: ConversationWorkerContext,
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  if (messages.length === 0 || !messages.every(isInboundEdit)) {
    return undefined;
  }
  const events = messages.filter((record) => record.source === "event");
  if (events.length > 0) {
    await saveSkippedConversationEvents(
      context.conversationId,
      events,
      EDIT_SKIP_REASON,
    );
  }
  for (const record of messages) {
    const metadata = parseSlackMetadata(record.input.metadata);
    if (!metadata) continue;
    const message = Message.fromJSON(metadata.message);
    await saveSkippedSlackMessage({
      conversationId: context.conversationId,
      message,
      skippedReason: EDIT_SKIP_REASON,
      text: renderSlackMessageEdit(message, parseContent(message).text),
    });
  }
  await context.attempt.ack();
  return { status: "completed" };
}
