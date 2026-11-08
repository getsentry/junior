import { Message } from "chat";
import { saveSkippedSlackMessage } from "@/chat/ingress/slack-skipped-message";
import { renderSlackMessageEdit } from "@/chat/slack/message-edit";
import { parseContent } from "@/chat/slack/message/content";
import { editedInboundMessageId } from "@/chat/task-execution/inbound-edit";
import { parseSlackMetadata } from "@/chat/task-execution/slack-work";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";

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
  if (
    messages.length === 0 ||
    messages.some((message) => editedInboundMessageId(message) === undefined)
  ) {
    return undefined;
  }
  for (const record of messages) {
    const metadata = parseSlackMetadata(record.input.metadata);
    if (!metadata) continue;
    const message = Message.fromJSON(metadata.message);
    await saveSkippedSlackMessage({
      conversationId: context.conversationId,
      message,
      skippedReason: "edited message",
      text: renderSlackMessageEdit(message, parseContent(message).text),
    });
  }
  await context.attempt.ack();
  return { status: "completed" };
}
