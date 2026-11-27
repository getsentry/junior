/**
 * Build the Guardian request from what core knows about one batch.
 *
 * Code only labels and orders facts here (`facts-from-junior`). It decides
 * who wrote each message from the Run's Source and the author labels of the
 * root Conversation, never from what the text says.
 */
import { instructionAuthor } from "@/chat/conversations/kind-behavior";
import type { Message } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

/**
 * Whose words the current message of the Run is. An agent's brief passed
 * Guardian when it was sent, so it is the instruction of this Run
 * (`brief-is-instruction`). A person's Source with a system Actor, such as
 * an Event Turn, is an Event.
 */
function currentAuthor(
  context: ToolActionProposal["context"],
): "person" | "automation" | "brief" | "event" {
  const author = instructionAuthor(context.source);
  return author === "person" && context.actor.platform === "system"
    ? "event"
    : author;
}

/**
 * The ordered messages of the work for one batch. Every proposal of a batch
 * has the same context and root Conversation, so the first one is enough.
 * Only the requester's root messages, which core labels `user`, and the
 * current instruction are `instruction`. A gap note stays as context, so a
 * later reply does not read as an answer to a message that is not shown.
 */
export function guardianMessages(proposal: ToolActionProposal): Message[] {
  const { context, rootConversation } = proposal;
  const author = currentAuthor(context);
  const messages: Message[] = [];
  // An Automation's stored instruction starts its work, so it comes first.
  if (author === "automation") {
    messages.push({ from: "instruction", text: context.userIntent });
  }
  // Lead policy needs to know the Run is a Space's Lead (`handoff-check`).
  if (context.lead) {
    messages.push({ from: "context", text: "[This Run is a Space's Lead.]" });
  }
  if (rootConversation?.truncated) {
    messages.push({ from: "context", text: "[Older messages are not shown.]" });
  }
  for (const message of rootConversation?.messages ?? []) {
    messages.push({
      from:
        message.author === "user"
          ? "instruction"
          : message.author === "other person"
            ? "other_person"
            : "context",
      text: message.text,
    });
  }
  const shown = rootConversation?.messages.some(
    (message) =>
      message.author === "user" && message.text === context.userIntent,
  );
  if (!shown && author !== "automation" && context.userIntent) {
    messages.push({
      from: author === "event" ? "context" : "instruction",
      text: context.userIntent,
    });
  }
  return messages;
}
