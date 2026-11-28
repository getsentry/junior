/**
 * Features that react to a committed change of a Conversation's own data,
 * such as the Inbox, which adds the item of a question that an agent asked.
 * Core calls `reactToConversationChange` after the commit that it reports,
 * so a reaction never shares a transaction with core and core never names a
 * feature. `coreConversationReactions()` lists the reactions.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import type { User } from "@sentry/junior-plugin-api";
import { coreConversationReactions } from "@/chat/plugins/core-registrations";
import type { ResolvedAssignees } from "@/chat/questions/assignees";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/** What core gives a reaction to show its change, such as a Slack card. */
export interface ConversationChangeServices {
  queue: () => ConversationWorkQueue;
  /** The adapter with the token of the workspace, outside Slack work. */
  slackAdapter?: (() => SlackAdapter) | undefined;
}

/** One committed change of a Conversation's own data. */
export type ConversationChange =
  | {
      /** A question that an agent asked. A replay of the ask reports it again. */
      kind: "question_asked";
      asked: ResolvedAssignees;
      conversationId: string;
      questionId: string;
      services: ConversationChangeServices;
    }
  | {
      /**
       * A message that a person sent to Junior. `canAnswer` checks the
       * author when the message did not mention Junior. `viewed` is set
       * when the person sent it from the dashboard, where they also saw the
       * transcript so far.
       */
      kind: "person_message";
      canAnswer?: (() => Promise<boolean>) | undefined;
      conversationId: string;
      resolveUser: () => Promise<User | undefined>;
      services: ConversationChangeServices;
      text: string;
      viewed?: boolean;
    }
  /** Slack delivery of a detached Conversation started again. */
  | { kind: "delivery_resumed"; conversationId: string }
  | { kind: "todos_changed"; conversationId: string; nowMs: number };

/** A feature's reaction to one committed Conversation change. */
export type ConversationChangeReaction = (
  change: ConversationChange,
) => Promise<void>;

/**
 * Run every feature's reaction to one committed change, in order. A failure
 * reaches the caller, which reports it the way it reports its own work: a
 * tool call fails and can run again, because each reaction is safe to
 * repeat.
 */
export async function reactToConversationChange(
  change: ConversationChange,
): Promise<void> {
  for (const react of coreConversationReactions()) {
    // oxlint-disable-next-line no-await-in-loop -- Reactions run in registration order.
    await react(change);
  }
}
