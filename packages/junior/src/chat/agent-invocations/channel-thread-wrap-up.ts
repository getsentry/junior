import type { StateAdapter } from "chat";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { getConversation } from "@/chat/task-execution/store";
import {
  conversationDescendants,
  readConversationTrees,
  setArchivedAt,
} from "@/chat/conversations/sql/conversation-tree";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { readChildConversationSender } from "./child-input";
import { agentMessageInboundId, enqueueAgentMessageToParent } from "./result";
import type { ChildAgentSender } from "./types";

/**
 * Return whether a channel Thread ever sent its parent a message. Its parent
 * mailbox keeps the id of each message, and every Agent message of one
 * sender shares a prefix. The wrap-up itself does not count.
 */
async function messagedParent(
  sender: ChildAgentSender,
  state?: StateAdapter,
): Promise<boolean> {
  const parent = await getConversation({
    conversationId: sender.parentConversationId,
    state,
  });
  const prefix = agentMessageInboundId(sender.childConversationId, "");
  return (
    parent?.execution.inboundMessageIds.some(
      (id) => id.startsWith(prefix) && !id.startsWith(`${prefix}wrap-up:`),
    ) ?? false
  );
}

function wrapUpText(args: {
  messagedParent: boolean;
  outcome?: string;
}): string {
  return [
    "Its code channel was archived, so this Thread is archived.",
    args.outcome
      ? `Latest outcome: ${args.outcome}`
      : "It has no outcome summary yet.",
    args.messagedParent
      ? "It already sent you messages. Do not post its outcome again."
      : "It never sent you a message.",
  ].join("\n");
}

/**
 * Archive a channel Thread and the child agents below it after its provider
 * channel was archived, and send its parent one wrap-up Agent message. The
 * wrap-up is the only message that the runtime sends to the parent for a
 * channel Thread. `eventKey` names the provider archive event, so a
 * redelivered event sends no second wrap-up. The wrap-up goes first: a
 * failed archive is retried with the event, and the wrap-up is not lost.
 */
export async function archiveChannelThread(args: {
  conversationId: string;
  eventKey: string;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<void> {
  const sender = await readChildConversationSender(args.conversationId);
  if (!sender) {
    throw new Error(`Channel Thread ${args.conversationId} has no parent`);
  }
  const brief = await readLatestConversationBrief(getDb(), args.conversationId);
  await enqueueAgentMessageToParent({
    actor: EVENT_SYSTEM_ACTOR,
    messageKey: `wrap-up:${args.eventKey}`,
    queue: args.queue,
    sender,
    state: args.state,
    text: wrapUpText({
      messagedParent: await messagedParent(sender, args.state),
      outcome: brief?.content.outcome.text,
    }),
  });
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const tree = await readConversationTrees(db, [sender.parentConversationId]);
    const node = tree.get(args.conversationId);
    if (!node || node.archivedAt) return;
    await setArchivedAt(
      db,
      [
        args.conversationId,
        ...conversationDescendants(tree, args.conversationId)
          .filter((child) => !child.archivedAt)
          .map((child) => child.conversationId),
      ],
      new Date(),
    );
  });
}
