/**
 * Build the Guardian request from what core knows about one batch.
 *
 * Code only labels and orders facts here (`facts-from-junior`). It decides
 * who wrote each message from the Run's Source and the author labels of the
 * root Conversation, never from what the text says.
 */
import { instructionAuthor } from "@/chat/conversations/kind-behavior";
import { readTopLevelAgentMessages } from "@/chat/input-tags";
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

type TurnWatch = NonNullable<ToolActionProposal["context"]["watch"]>;
type EventFacts = TurnWatch["events"][number];

/**
 * Whose words an Event author's text is: the creator's own linked account
 * writes `instruction` (`linked-account`), a trusted author `other_person`,
 * and anyone else `context`.
 */
function authorFrom(task: EventFacts, watch: TurnWatch): Message["from"] {
  const author = task.authorText;
  if (!author?.verified) return "context";
  const creator = watch.creator.actor;
  return creator && "userId" in creator && author.authorId === creator.userId
    ? "instruction"
    : "other_person";
}

/**
 * The lines of a Watch Turn, from the saved Event facts
 * (`follows-instruction`). The Watch's intent is the instruction: Guardian
 * allowed it when it was set, or plugin code wrote it. The Event says what
 * to change inside that intent, so its text keeps its author's label.
 */
function watchMessages(watch: TurnWatch): Message[] {
  const plugin = watch.creator.plugin
    ? ` (${watch.creator.plugin} plugin)`
    : "";
  const intents = new Set<string>();
  const messages: Message[] = [];
  for (const task of watch.events) {
    if (!intents.has(task.instructions)) {
      intents.add(task.instructions);
      messages.push({
        from: "instruction",
        text: `Watch intent${plugin}: ${task.instructions}`,
      });
    }
    const about = [task.about, task.trustedSummary].filter(Boolean);
    if (about.length > 0) {
      messages.push({ from: "context", text: `Event: ${about.join(": ")}` });
    }
    if (task.authorText) {
      messages.push({
        from: authorFrom(task, watch),
        text: task.authorText.text,
      });
    }
    if (task.externalText) {
      messages.push({ from: "context", text: task.externalText });
    }
  }
  return messages;
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
  // A Watch Turn's Event is built from its saved facts, not its `<task>`.
  if (context.watch) {
    messages.push(...watchMessages(context.watch));
    return messages;
  }
  // A brief from another top-level agent is the instruction, so its data
  // notice for the agent does not reach Guardian. Each one names its sender.
  const briefs =
    author === "brief"
      ? readTopLevelAgentMessages(context.userIntent)
      : undefined;
  if (briefs) {
    for (const brief of briefs) {
      messages.push(
        {
          from: "context",
          text: `[The agent of Conversation ${brief.conversationId ?? "unknown"} sent this brief:]`,
        },
        { from: "instruction", text: brief.text },
      );
    }
  } else if (!shown && author !== "automation" && context.userIntent) {
    messages.push({
      from: author === "event" ? "context" : "instruction",
      text: context.userIntent,
    });
  }
  return messages;
}
