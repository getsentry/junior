import type { Chat } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type {
  AssistantLifecycleEvent,
  SlackTurnRuntime,
} from "@/chat/runtime/slack-runtime";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { logException, withSpan } from "@/chat/observability";
import { publishAppHomeView } from "@/chat/app-home";
import { handleSlashCommand } from "@/chat/slash-command";
import { getSlackClient } from "@/chat/slack-actions/client";

export function registerBotHandlers(args: {
  bot: Chat<{ slack: SlackAdapter }>;
  runtime: SlackTurnRuntime<unknown, AssistantLifecycleEvent>;
}): void {
  const { bot, runtime } = args;

  bot.onNewMention(runtime.handleNewMention);
  bot.onSubscribedMessage(runtime.handleSubscribedMessage);
  bot.onAssistantThreadStarted((event: AssistantLifecycleEvent) =>
    runtime.handleAssistantThreadStarted(event),
  );
  bot.onAssistantContextChanged((event: AssistantLifecycleEvent) =>
    runtime.handleAssistantContextChanged(event),
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
}
