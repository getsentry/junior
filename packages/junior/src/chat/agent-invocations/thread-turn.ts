/**
 * A person's Turn in a Thread. People message a Thread like a root, but it
 * stays a child: it has no Location or Destination of its own, so replies
 * stay in Junior. Agent invocation input and watch Events keep the child
 * worker. A person's Turn and an Agent invocation Turn are never open at the
 * same time.
 */
import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import type { Conversation } from "@/chat/conversations/store";
import { getLocationConfigurationServiceForLocation } from "@/chat/runtime/location-configuration";
import {
  getActiveConversationTurnId,
  parseWebMessages,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { getLatestAgentInvocationForConversation } from "./store";
import { readChildDepthAndRootLocation } from "./lineage";

/**
 * Select the person's Turn work of a Thread, or undefined for Agent
 * invocation work. A Thread has one open Turn at a time, like a root. Web
 * Messages start a person's Turn, and an empty wake resumes the open person's
 * Turn. Every other input and wake goes to the child worker.
 */
export async function resolveThreadTurnWork(
  context: ConversationWorkerContext,
): Promise<MailboxTurnWork | undefined> {
  const batch = parseWebMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }
  const turnId = await getActiveConversationTurnId(context.conversationId);
  return turnId ? { kind: "resume", turnId } : undefined;
}

/** Run context of a person's Turn in a Thread. */
type ThreadTurnSetup = {
  /**
   * Destination of the latest Agent invocation. AgentRun requires one, and a
   * child id is not a local Destination. It is never stored on the Thread.
   */
  destination: Destination;
  /** Provider defaults of the root's Location. */
  locationConfiguration?: LocationConfigurationService;
  /**
   * The root's visibility. A Thread row stores none, and the parent's task
   * can carry the root's private content, so it runs with the root's
   * visibility.
   */
  visibility: ConversationPrivacy;
};

/**
 * Load the Destination, provider defaults, and visibility of a Thread.
 */
export async function loadThreadTurnSetup(
  thread: Conversation,
): Promise<ThreadTurnSetup> {
  const [latest, tree] = await Promise.all([
    getLatestAgentInvocationForConversation(thread.conversationId),
    readChildDepthAndRootLocation(thread.conversationId),
  ]);
  if (!latest) {
    throw new Error(`Thread ${thread.conversationId} has no Agent invocation`);
  }
  const { root } = tree;
  if (!root) {
    throw new Error(`Thread ${thread.conversationId} has no root`);
  }
  return {
    destination: latest.destination,
    ...(tree.location
      ? {
          locationConfiguration: getLocationConfigurationServiceForLocation(
            tree.location,
          ),
        }
      : undefined),
    // A root Destination with unknown or direct visibility reads back as
    // undefined. Missing visibility is private.
    visibility: root.visibility ?? "private",
  };
}
