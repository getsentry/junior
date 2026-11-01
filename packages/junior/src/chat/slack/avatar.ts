import type { SlackActor } from "@/chat/actor";
import { getSqlExecutor } from "@/chat/db";
import { saveActorAvatar } from "@/chat/identities/actor";
import { lookupSlackUser } from "@/chat/slack/user";
import { getStateAdapter } from "@/chat/state/adapter";

// Save each person's Slack photo at most once a day, not on every Turn.
const AVATAR_SAVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Save the Slack photo of one Slack Actor on their Slack Identity. Slack
 * Turns call this, so the saved photo follows profile changes within a day.
 */
export async function saveSlackActorAvatar(actor: SlackActor): Promise<void> {
  const state = getStateAdapter();
  const savedKey = `junior:slack:avatar-saved:${actor.teamId}:${actor.userId}`;
  if (await state.get(savedKey)) return;
  const profile = await lookupSlackUser(actor.teamId, actor.userId);
  // A failed lookup says nothing about the photo, so keep the saved one and
  // try again on the next Turn.
  if (!profile) return;
  await saveActorAvatar(getSqlExecutor(), actor, profile.avatarUrl ?? null);
  await state.set(savedKey, true, AVATAR_SAVE_INTERVAL_MS);
}
