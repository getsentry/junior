import type { SlashCommandEvent } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { isPluginProvider } from "@/chat/plugins/registry";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import { logInfo } from "@/chat/logging";
import { getChatConfig } from "@/chat/config";
import { parseActorUserId } from "@/chat/services/requester-identity";

async function postEphemeral(
  event: SlashCommandEvent,
  text: string,
): Promise<void> {
  await event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
}

function requireRequesterId(event: SlashCommandEvent): string {
  const userId = parseActorUserId(event.user.userId);
  if (!userId) {
    throw new Error("Slack slash command requires a requester user id");
  }
  return userId;
}

function getCommandName(): string {
  return getChatConfig().slack.slashCommand;
}

async function handleLink(
  event: SlashCommandEvent,
  requesterId: string,
  provider: string,
): Promise<void> {
  if (!isPluginProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }

  if (!getPluginOAuthConfig(provider)) {
    await postEphemeral(
      event,
      `${formatProviderLabel(provider)} doesn't support account linking.`,
    );
    return;
  }

  const raw = event.raw as { channel_id?: string };
  const result = await startOAuthFlow(provider, {
    requesterId,
    channelId: raw.channel_id,
  });

  if (!result.ok) {
    await postEphemeral(event, `Failed to start linking: ${result.error}`);
    return;
  }

  if (result.delivery === "fallback_dm") {
    await postEphemeral(
      event,
      `Check your DMs for a ${formatProviderLabel(provider)} authorization link.`,
    );
  } else if (result.delivery === false) {
    await postEphemeral(
      event,
      "I wasn't able to send you a private authorization link. Please try again in a direct message.",
    );
  }
}

async function handleUnlink(
  event: SlashCommandEvent,
  requesterId: string,
  provider: string,
): Promise<void> {
  if (!isPluginProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }

  if (!getPluginOAuthConfig(provider)) {
    await postEphemeral(
      event,
      `${formatProviderLabel(provider)} doesn't support account unlinking.`,
    );
    return;
  }

  const tokenStore = createUserTokenStore();
  await tokenStore.delete(requesterId, provider);

  logInfo(
    "slash_command_unlink",
    { slackUserId: requesterId },
    { "app.credential.provider": provider },
    `Unlinked ${formatProviderLabel(provider)} account via ${getCommandName()} slash command`,
  );

  await postEphemeral(
    event,
    `Your ${formatProviderLabel(provider)} account has been unlinked.`,
  );
}

/** Route link and unlink slash commands to the appropriate OAuth flow. */
export async function handleSlashCommand(
  event: SlashCommandEvent,
): Promise<void> {
  const [subcommand, provider, ...rest] = event.text.trim().split(/\s+/);

  if (!subcommand || !["link", "unlink"].includes(subcommand)) {
    await postEphemeral(
      event,
      `Usage: \`${getCommandName()} link <provider>\` or \`${getCommandName()} unlink <provider>\``,
    );
    return;
  }

  if (!provider || rest.length > 0) {
    await postEphemeral(
      event,
      `Usage: \`${getCommandName()} ${subcommand} <provider>\``,
    );
    return;
  }

  const normalized = provider.toLowerCase();
  const requesterId = requireRequesterId(event);

  if (subcommand === "link") {
    await handleLink(event, requesterId, normalized);
  } else {
    await handleUnlink(event, requesterId, normalized);
  }
}
