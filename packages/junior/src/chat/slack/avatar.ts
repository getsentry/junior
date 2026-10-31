import type { SlackActor } from "@/chat/actor";
import { getSqlExecutor } from "@/chat/db";
import { saveActorAvatar } from "@/chat/identities/actor";
import { lookupSlackUser } from "@/chat/slack/user";

/**
 * Save the Slack photo of one Slack Actor on their Slack Identity. Slack
 * Turns call this, so the saved photo follows profile changes.
 */
export async function saveSlackActorAvatar(actor: SlackActor): Promise<void> {
  const profile = await lookupSlackUser(actor.teamId, actor.userId);
  // A failed lookup says nothing about the photo, so keep the saved one.
  if (!profile) return;
  await saveActorAvatar(getSqlExecutor(), actor, profile.avatarUrl ?? null);
}
