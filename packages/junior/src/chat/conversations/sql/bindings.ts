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

/** Bind provider coordinates to a durable conversation in the caller's SQL scope. */
export async function bindProviderConversation(
  executor: JuniorSqlDatabase,
  args: ProviderConversationBinding,
): Promise<void> {
  const rows = await executor
    .db()
    .insert(juniorConversationBindings)
    .values({ ...args, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ conversationId: juniorConversationBindings.conversationId });
  const boundConversationId =
    rows[0]?.conversationId ??
    (await getConversationIdByProviderConversation(executor, args));
  if (boundConversationId !== args.conversationId) {
    throw new Error(
      "Provider conversation is already bound to another conversation",
    );
  }
}
