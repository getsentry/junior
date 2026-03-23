import type { SlashCommandEvent } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { isPluginProvider } from "@/chat/plugins/registry";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import { logInfo } from "@/chat/observability";

async function postEphemeral(
  event: SlashCommandEvent,
  text: string,
): Promise<void> {
  await event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
}

async function handleLink(
  event: SlashCommandEvent,
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
    requesterId: event.user.userId,
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
  await tokenStore.delete(event.user.userId, provider);

  logInfo(
    "slash_command_unlink",
    { slackUserId: event.user.userId },
    { "app.credential.provider": provider },
    `Unlinked ${formatProviderLabel(provider)} account via /jr slash command`,
  );

  await postEphemeral(
    event,
    `Your ${formatProviderLabel(provider)} account has been unlinked.`,
  );
}

export async function handleSlashCommand(
  event: SlashCommandEvent,
): Promise<void> {
  const [subcommand, provider, ...rest] = event.text.trim().split(/\s+/);

  if (!subcommand || !["link", "unlink"].includes(subcommand)) {
    await postEphemeral(
      event,
      "Usage: `/jr link <provider>` or `/jr unlink <provider>`",
    );
    return;
  }

  if (!provider || rest.length > 0) {
    await postEphemeral(event, `Usage: \`/jr ${subcommand} <provider>\``);
    return;
  }

  const normalized = provider.toLowerCase();

  if (subcommand === "link") {
    await handleLink(event, normalized);
  } else {
    await handleUnlink(event, normalized);
  }
}
