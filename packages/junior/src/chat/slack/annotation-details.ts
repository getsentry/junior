import type { SlackEvent } from "@slack/types";
import { annotationCard } from "@/chat/conversations/cards";
import * as z from "zod";
import { eq } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { readLiveAnnotations } from "@/api/objects/live-annotations";
import { getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { annotationKeyDigest, decodeAnnotationRef } from "./annotation-ref";
import { getSlackClient } from "./client";
import { renderSlackObjectCard } from "./object-card";
import { slackEntitySchema, slackExternalRefIdSchema } from "./work-object";

const eventSchema = z.object({
  trigger_id: z.string().min(1),
  user: z.string().min(1),
  external_ref: z.object({
    type: z.literal("annotation"),
    id: slackExternalRefIdSchema,
  }),
}) satisfies z.ZodType<
  Pick<
    Extract<SlackEvent, { type: "entity_details_requested" }>,
    "trigger_id" | "user" | "external_ref"
  >
>;

/**
 * Show an annotation's object, as the viewer can read it now, only to a
 * viewer who can read its Conversation.
 */
export async function presentSlackAnnotationDetails(
  event: Record<string, unknown>,
  teamId: string | undefined,
): Promise<void> {
  const triggerId = event["trigger_id"];
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
  const ref = decodeAnnotationRef(parsed.data.external_ref.id);
  if (!ref) {
    await missing();
    return;
  }
  const { conversationId, keyDigest } = ref;
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
  const saved = (await listConversationAnnotations(db, conversationId)).find(
    (item) => annotationKeyDigest(item.plugin, item.key) === keyDigest,
  );
  if (!saved) {
    await missing();
    return;
  }
  // The posted card keeps its facts. Its details read the object live.
  const [annotation] = await readLiveAnnotations(identity.user, [saved]);
  const entity =
    annotation &&
    renderSlackObjectCard(annotationCard(annotation), conversationId, "details")
      .entity;
  if (!entity) {
    await missing();
    return;
  }
  await client.entity.presentDetails({
    trigger_id: parsed.data.trigger_id,
    // Echo the posted reference so a legacy card keeps its identity.
    metadata: slackEntitySchema.parse({
      ...entity,
      external_ref: parsed.data.external_ref,
    }),
  });
}
