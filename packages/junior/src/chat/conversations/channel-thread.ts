import type { Conversation } from "@/chat/conversations/store";
import { and, eq, isNull } from "drizzle-orm";
import {
  getWholeDestinationBinding,
  WHOLE_DESTINATION_BINDING_ID,
} from "@/chat/conversations/sql/bindings";
import { juniorConversationBindings, juniorConversations } from "@/db/schema";
import { getSqlExecutor } from "@/chat/db";
import { canOwnChannel } from "@/chat/conversations/kind-behavior";

/**
 * Return whether a Conversation is a channel Thread: a Thread that owns a
 * whole provider place, such as a Slack code channel, as its Location. The
 * binding decides, not a feature flag, so a channel keeps working after the
 * flag turns off.
 */
export async function isChannelThread(
  conversation: Pick<Conversation, "conversationId" | "kind"> | undefined,
): Promise<boolean> {
  if (!conversation || !canOwnChannel(conversation.kind)) return false;
  return (
    (await getWholeDestinationBinding(
      getSqlExecutor(),
      conversation.conversationId,
    )) !== undefined
  );
}

/**
 * Return the open channel Thread of one parent, if it has one. A root owns
 * one origin thread, so this enforces one open channel Thread per origin
 * thread.
 */
export async function findOpenChannelThread(
  parentConversationId: string,
): Promise<
  { conversationId: string; providerDestinationId: string } | undefined
> {
  const [row] = await getSqlExecutor()
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      providerDestinationId: juniorConversationBindings.providerDestinationId,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorConversationBindings,
      eq(
        juniorConversationBindings.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorConversations.parentConversationId, parentConversationId),
        eq(juniorConversations.kind, "thread"),
        isNull(juniorConversations.archivedAt),
        eq(
          juniorConversationBindings.providerConversationId,
          WHOLE_DESTINATION_BINDING_ID,
        ),
      ),
    )
    .limit(1);
  return row;
}

/** Return the ids of the channel Threads of one parent, open or archived. */
export async function listChannelThreadIds(
  parentConversationId: string,
): Promise<Set<string>> {
  const rows = await getSqlExecutor()
    .db()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .innerJoin(
      juniorConversationBindings,
      eq(
        juniorConversationBindings.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorConversations.parentConversationId, parentConversationId),
        eq(
          juniorConversationBindings.providerConversationId,
          WHOLE_DESTINATION_BINDING_ID,
        ),
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}
