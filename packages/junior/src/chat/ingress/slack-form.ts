/** Slack interactive payload forms. */
import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message, StateAdapter } from "chat";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { handleSlackInteractivePayload } from "@/chat/ingress/slack-interactive";
import { logException, withLogContext } from "@/chat/logging";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { WaitUntilFn } from "@/handlers/types";
import {
  slackInteractivePayloadSchema,
  type SlackInteractivePayload,
} from "./slack-payload";

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function installationFromInteractive(
  payload: SlackInteractivePayload,
): SlackInstallationContext {
  return {
    teamId: payload.team?.id ?? payload.user?.team_id,
  };
}

/** Handle a Slack interactive payload form. */
export async function handleSlackForm(args: {
  adapter: SlackAdapter;
  body: string;
  getUserTokenStore: () => UserTokenStore;
  /** Return whether a Slack author may start a Turn, such as by an answer. */
  isAuthorAllowed: (
    userId: string,
    installation: SlackInstallationContext,
  ) => Promise<boolean>;
  /** Save one Slack input, such as a user input answer, as a mention. */
  persistMessage: (
    message: Message,
    installation: SlackInstallationContext,
  ) => Promise<void>;
  queue: ConversationWorkQueue;
  state: StateAdapter;
  waitUntil: WaitUntilFn;
}): Promise<Response> {
  const params = new URLSearchParams(args.body);
  const { adapter, state } = args;
  await state.connect();

  const rawPayload = params.get("payload");
  if (!rawPayload) {
    return new Response("Missing payload", { status: 400 });
  }
  const result = slackInteractivePayloadSchema.safeParse(parseJson(rawPayload));
  if (!result.success) {
    return new Response("Invalid payload JSON", { status: 400 });
  }
  const payload = result.data;
  const installation = installationFromInteractive(payload);

  args.waitUntil(
    withLogContext(
      {
        platform: "slack",
        userId: payload.user?.id?.trim() || undefined,
      },
      () =>
        runWithWorkspaceTeamId(installation.teamId, () =>
          runWithSlackInstallation({
            adapter,
            installation,
            state,
            task: () =>
              handleSlackInteractivePayload({
                adapter,
                payload,
                isAuthorAllowed: (userId) =>
                  args.isAuthorAllowed(userId, installation),
                persistMessage: (message) =>
                  args.persistMessage(message, installation),
                queue: args.queue,
                state,
                userTokenStore: args.getUserTokenStore(),
              }),
          }),
        ).catch((error) => {
          logException(error, "slack.interactive.payload.failed");
        }),
    ),
  );
  return new Response("", { status: 200 });
}
