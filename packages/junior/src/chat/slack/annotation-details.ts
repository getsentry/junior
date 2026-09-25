import type { SlackEvent } from "@slack/types";
import { annotationCard } from "@/chat/conversations/cards";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { getSlackClient } from "./client";
import { renderSlackObjectCard } from "./object-card";
import { slackEntitySchema, slackExternalRefIdSchema } from "./work-object";

const eventSchema = z.object({
  trigger_id: z.string().min(1),
  user: z.string().min(1),
  external_ref: z.object({
    type: z.literal("annotation"),
    id: slackExternalRefIdSchema.max(4096),
  }),
}) satisfies z.ZodType<
  Pick<
    Extract<SlackEvent, { type: "entity_details_requested" }>,
    "trigger_id" | "user" | "external_ref"
  >
>;
const refSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
]);

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
    value = JSON.parse(
      Buffer.from(parsed.data.external_ref.id, "base64url").toString("utf8"),
    );
  } catch {
    await missing();
    return;
  }
  const ref = refSchema.safeParse(value);
  if (!ref.success) {
    await missing();
    return;
  }
  const [conversationId, plugin, key] = ref.data;
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
    })
    .from(juniorConversations)
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(eq(juniorConversations.conversationId, conversationId));
  if (location?.provider !== "slack" || location.teamId !== teamId) {
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
  const entity = renderSlackObjectCard(
    annotationCard(annotation),
    conversationId,
  ).entity;
  if (!entity) {
    await missing();
    return;
  }
  await client.entity.presentDetails({
    trigger_id: parsed.data.trigger_id,
    metadata: slackEntitySchema.parse(entity),
  });
}
