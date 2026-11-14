import { and, eq } from "drizzle-orm";
import { juniorConversationBindings } from "@/db/schema";
import type { JuniorSqlDatabase } from "@/db/db";

export interface ProviderConversationBinding {
  conversationId: string;
  provider: string;
  providerDestinationId: string;
  providerTenantId: string;
  providerConversationId: string;
}

export type ProviderConversationReference = Omit<
  ProviderConversationBinding,
  "conversationId"
>;

/** Resolve the durable conversation bound to provider-owned coordinates. */
export async function getConversationIdByProviderConversation(
  executor: JuniorSqlDatabase,
  args: ProviderConversationReference,
): Promise<string | undefined> {
  const rows = await executor
    .db()
    .select({ conversationId: juniorConversationBindings.conversationId })
    .from(juniorConversationBindings)
    .where(
      and(
        eq(juniorConversationBindings.provider, args.provider),
        eq(juniorConversationBindings.providerTenantId, args.providerTenantId),
        eq(
          juniorConversationBindings.providerDestinationId,
          args.providerDestinationId,
        ),
        eq(
          juniorConversationBindings.providerConversationId,
          args.providerConversationId,
        ),
      ),
    )
    .limit(1);
  return rows[0]?.conversationId;
}

/**
 * Bind provider coordinates to a durable conversation unless another
 * conversation has them. Return the conversation that has them.
 */
export async function claimProviderConversationOwner(
  executor: JuniorSqlDatabase,
  args: ProviderConversationBinding,
): Promise<string> {
  const rows = await executor
    .db()
    .insert(juniorConversationBindings)
    .values({ ...args, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ conversationId: juniorConversationBindings.conversationId });
  const ownerId =
    rows[0]?.conversationId ??
    (await getConversationIdByProviderConversation(executor, args));
  if (!ownerId) {
    throw new Error("Provider conversation binding disappeared during claim");
  }
  return ownerId;
}

/**
 * Bind provider coordinates to a durable conversation unless another
 * conversation has them. Return whether they belong to this conversation.
 */
export async function claimProviderConversation(
  executor: JuniorSqlDatabase,
  args: ProviderConversationBinding,
): Promise<boolean> {
  return (
    (await claimProviderConversationOwner(executor, args)) ===
    args.conversationId
  );
}

/** Bind provider coordinates to a durable conversation in the caller's SQL scope. */
export async function bindProviderConversation(
  executor: JuniorSqlDatabase,
  args: ProviderConversationBinding,
): Promise<void> {
  if (!(await claimProviderConversation(executor, args))) {
    throw new Error(
      "Provider conversation is already bound to another conversation",
    );
  }
}

/**
 * The `providerConversationId` of a binding that gives a whole provider
 * place, such as a Slack code channel, to one Conversation. Every message
 * in that place goes to it, top-level or in a provider thread.
 */
export const WHOLE_DESTINATION_BINDING_ID = "*";

/** Resolve the Conversation that owns a whole provider place, if one does. */
export async function getConversationIdByWholeDestination(
  executor: JuniorSqlDatabase,
  args: Omit<ProviderConversationReference, "providerConversationId">,
): Promise<string | undefined> {
  return await getConversationIdByProviderConversation(executor, {
    ...args,
    providerConversationId: WHOLE_DESTINATION_BINDING_ID,
  });
}

/** Read the whole provider place that one Conversation owns, if it owns one. */
export async function getWholeDestinationBinding(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<ProviderConversationBinding | undefined> {
  const [row] = await executor
    .db()
    .select({
      conversationId: juniorConversationBindings.conversationId,
      provider: juniorConversationBindings.provider,
      providerConversationId: juniorConversationBindings.providerConversationId,
      providerDestinationId: juniorConversationBindings.providerDestinationId,
      providerTenantId: juniorConversationBindings.providerTenantId,
    })
    .from(juniorConversationBindings)
    .where(
      and(
        eq(juniorConversationBindings.conversationId, conversationId),
        eq(
          juniorConversationBindings.providerConversationId,
          WHOLE_DESTINATION_BINDING_ID,
        ),
      ),
    )
    .limit(1);
  return row;
}
