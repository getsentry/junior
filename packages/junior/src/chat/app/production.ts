import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  botConfig,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { logException, withSpan } from "@/chat/logging";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { handleSlashCommand } from "@/chat/ingress/slash-command";
import { createNormalizingStream } from "@/chat/runtime/streaming";
import { getStateAdapter } from "@/chat/state/adapter";

export const bot = new JuniorChat<{ slack: SlackAdapter }>({
  userName: botConfig.userName,
  adapters: {
    slack: (() => {
      const signingSecret = getSlackSigningSecret();
      const botToken = getSlackBotToken();
      const clientId = getSlackClientId();
      const clientSecret = getSlackClientSecret();

      if (!signingSecret) {
        throw new Error("SLACK_SIGNING_SECRET is required");
      }

      return createSlackAdapter({
        signingSecret,
        ...(botToken ? { botToken } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
    })(),
  },
  state: getStateAdapter(),
});

const registerSingleton = (
  bot as unknown as { registerSingleton?: () => unknown }
).registerSingleton;
if (typeof registerSingleton === "function") {
  registerSingleton.call(bot);
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack");
}

export const slackRuntime = createSlackRuntime({
  getSlackAdapter,
});

// ---------------------------------------------------------------------------
// Handler registration (composition-root wiring)
// ---------------------------------------------------------------------------

bot.onNewMention(slackRuntime.handleNewMention);
bot.onSubscribedMessage(slackRuntime.handleSubscribedMessage);
bot.onAssistantThreadStarted((event) =>
  slackRuntime.handleAssistantThreadStarted(event),
);
bot.onAssistantContextChanged((event) =>
  slackRuntime.handleAssistantContextChanged(event),
);

bot.onSlashCommand("/jr", (event) =>
  withSpan(
    "chat.slash_command",
    "chat.slash_command",
    { slackUserId: event.user.userId },
    async () => {
      try {
        await handleSlashCommand(event);
      } catch (error) {
        logException(error, "slash_command_failed", {
          slackUserId: event.user.userId,
        });
        throw error;
      }
    },
  ),
);

bot.onAppHomeOpened((event) =>
  withSpan(
    "chat.app_home_opened",
    "chat.app_home_opened",
    { slackUserId: event.userId },
    async () => {
      try {
        await publishAppHomeView(
          getSlackClient(),
          event.userId,
          createUserTokenStore(),
        );
      } catch (error) {
        logException(error, "app_home_opened_failed", {
          slackUserId: event.userId,
        });
      }
    },
  ),
);

bot.onAction("app_home_disconnect", async (event) => {
  const provider = event.value;
  if (!provider) return;
  const userId = event.user.userId;
  await withSpan(
    "chat.app_home_disconnect",
    "chat.app_home_disconnect",
    { slackUserId: userId },
    async () => {
      try {
        await unlinkProvider(userId, provider, createUserTokenStore());
        await publishAppHomeView(
          getSlackClient(),
          userId,
          createUserTokenStore(),
        );
      } catch (error) {
        logException(
          error,
          "app_home_disconnect_failed",
          { slackUserId: userId },
          {
            "app.credential.provider": provider,
          },
        );
      }
    },
  );
});

export { createNormalizingStream };
