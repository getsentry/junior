import { annotationCard } from "@/chat/conversations/cards";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getConversationStore, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { getSlackClient } from "./client";
import { renderSlackObjectCard } from "./object-card";
import { slackMessageTsSchema } from "./timestamp";

const eventSchema = z.object({
  trigger_id: z.string().min(1),
  user: z.string().min(1),
  channel: z.string().min(1),
  message_ts: slackMessageTsSchema,
  thread_ts: slackMessageTsSchema.optional(),
  external_ref: z.object({
    type: z.literal("annotation"),
    id: z.string().max(4096),
  }),
});
const refSchema = z.tuple([z.string().min(1), z.string().min(1)]);

/** Show saved annotation facts only to a viewer who can read their Conversation. */
export async function presentSlackAnnotationDetails(
  event: Record<string, unknown>,
  teamId: string | undefined,
): Promise<void> {
  const triggerId = event.trigger_id;
  if (typeof triggerId !== "string" || !triggerId) return;
  const client = getSlackClient();
  const missing = () =>
    client.entity.presentDetails({
      trigger_id: triggerId,
      error: { status: "not_found" },
    });
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success || !teamId) {
    await missing();
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(parsed.data.external_ref.id);
  } catch {
    await missing();
    return;
  }
  const ref = refSchema.safeParse(value);
  if (!ref.success) {
    await missing();
    return;
  }
  const [plugin, key] = ref.data;
  // Object identity stays stable across threads. Slack's message coordinates
  // select the saved facts; they do not grant the viewer access to those facts.
  const threadTs = parsed.data.thread_ts ?? parsed.data.message_ts;
  const conversationId =
    (await getConversationStore().getConversationIdByProviderConversation({
      provider: "slack",
      providerTenantId: teamId,
      providerDestinationId: parsed.data.channel,
      providerConversationId: threadTs,
    })) ?? `slack:${parsed.data.channel}:${threadTs}`;
  const db = getDb();
  const identity = await readActorIdentity({
    platform: "slack",
    teamId,
    userId: parsed.data.user,
  });
  if (!identity?.user) {
    await missing();
    return;
  }
  const [location] = await db
    .select({
      teamId: juniorDestinations.providerTenantId,
      provider: juniorDestinations.provider,
      channelId: juniorDestinations.providerDestinationId,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(eq(juniorConversations.conversationId, conversationId));
  if (
    location?.provider !== "slack" ||
    location.teamId !== teamId ||
    location.channelId !== parsed.data.channel
  ) {
    await missing();
    return;
  }
  const access = await readConversationAccessFromSql(
    db,
    [conversationId],
    identity.user,
  );
  if (!access.get(conversationId)?.canViewPrivateContent) {
    await missing();
    return;
  }
  const annotation = (
    await listConversationAnnotations(db, conversationId)
  ).find((item) => item.plugin === plugin && item.key === key);
  if (!annotation) {
    await missing();
    return;
  }
  const entity = renderSlackObjectCard(annotationCard(annotation)).entity;
  if (!entity) {
    await missing();
    return;
  }
  await client.entity.presentDetails({
    trigger_id: parsed.data.trigger_id,
    metadata: entity,
  });
}
