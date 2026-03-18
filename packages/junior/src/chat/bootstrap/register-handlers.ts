import type { Chat } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type {
  AppRuntimeAssistantLifecycleEvent,
  AppSlackRuntime,
} from "@/chat/app-runtime";
import { getUserTokenStore } from "@/chat/capabilities/factory";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { logException, withSpan } from "@/chat/observability";
import { publishAppHomeView } from "@/chat/app-home";
import { handleSlashCommand } from "@/chat/slash-command";
import { getSlackClient } from "@/chat/slack-actions/client";

export function registerBotHandlers(args: {
  bot: Chat<{ slack: SlackAdapter }>;
  appSlackRuntime: AppSlackRuntime<unknown, AppRuntimeAssistantLifecycleEvent>;
}): void {
  const { bot, appSlackRuntime } = args;

  bot.onNewMention(appSlackRuntime.handleNewMention);
  bot.onSubscribedMessage(appSlackRuntime.handleSubscribedMessage);
  bot.onAssistantThreadStarted((event: AppRuntimeAssistantLifecycleEvent) =>
    appSlackRuntime.handleAssistantThreadStarted(event),
  );
  bot.onAssistantContextChanged((event: AppRuntimeAssistantLifecycleEvent) =>
    appSlackRuntime.handleAssistantContextChanged(event),
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
            getUserTokenStore(),
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
          await Promise.all([
            getUserTokenStore().delete(userId, provider),
            deleteMcpStoredOAuthCredentials(userId, provider),
            deleteMcpServerSessionId(userId, provider),
            deleteMcpAuthSessionsForUserProvider(userId, provider),
          ]);
          await publishAppHomeView(
            getSlackClient(),
            userId,
            getUserTokenStore(),
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
}
