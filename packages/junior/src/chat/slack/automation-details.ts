import { z } from "zod";
import { readViewerAutomationCard } from "@/chat/automations/read";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { renderSlackAutomationCard } from "./automation-card";
import { getSlackClient } from "./client";

const detailsEventSchema = z.object({
  trigger_id: z.string().min(1),
  user: z.string().min(1),
  external_ref: z.object({
    id: z.string().min(1),
    type: z.literal("automation"),
  }),
});

/** Answer a Work Object open or refresh with current, viewer-visible facts. */
export async function presentSlackAutomationDetails(
  event: Record<string, unknown>,
  teamId: string | undefined,
): Promise<void> {
  const parsed = detailsEventSchema.safeParse(event);
  const client = getSlackClient();
  const triggerId = event.trigger_id;
  if (typeof triggerId !== "string" || !triggerId) return;

  if (!parsed.success || !teamId) {
    await client.entity.presentDetails({
      trigger_id: triggerId,
      error: { status: "not_found" },
    });
    return;
  }

  const identity = await readActorIdentity({
    platform: "slack",
    teamId,
    userId: parsed.data.user,
  });
  const card = identity?.user
    ? await readViewerAutomationCard(identity.user, parsed.data.external_ref.id)
    : undefined;
  const entity = card ? renderSlackAutomationCard(card)?.entity : undefined;
  if (!entity) {
    // Use one response for inaccessible and deleted objects. Do not leak titles.
    await client.entity.presentDetails({
      trigger_id: triggerId,
      error: { status: "not_found" },
    });
    return;
  }

  await client.entity.presentDetails({
    trigger_id: triggerId,
    metadata: entity,
  });
}
