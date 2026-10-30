/** Slack interactive payload forms. */
import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import { parseActorUserId } from "@/chat/actor";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { logException, withLogContext, withSpan } from "@/chat/logging";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import {
  getWorkspaceTeamId,
  runWithWorkspaceTeamId,
} from "@/chat/slack/workspace-context";
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

function requireSlackPayloadUserId(
  value: string | null | undefined,
  source: string,
): string {
  const userId = parseActorUserId(value);
  if (!userId) {
    throw new Error(`${source} is missing a Slack user id`);
  }
  return userId;
}

async function handleInteractivePayload(args: {
  payload: SlackInteractivePayload;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  if (args.payload.type !== "block_actions") {
    return;
  }
  const action = args.payload.actions?.find(
    (candidate) => candidate.action_id === "app_home_disconnect",
  );
  const provider = action?.selected_option?.value ?? action?.value;
  if (!provider) {
    return;
  }
  const userId = requireSlackPayloadUserId(
    args.payload.user?.id,
    "Slack app home disconnect payload",
  );

  await withSpan(
    "chat.app_home_disconnect",
    "chat.app_home_disconnect",
    { userId: userId },
    async () => {
      try {
        await unlinkProvider(
          userId,
          provider,
          args.userTokenStore,
          getWorkspaceTeamId(),
        );
      } catch (error) {
        logException(error, "app_home.disconnect_unlink.failed", {
          "app.credential.provider": provider,
        });
      }

      try {
        await publishAppHomeView(getSlackClient(), userId, args.userTokenStore);
      } catch (error) {
        logException(error, "app_home.disconnect_publish.failed", {
          "app.credential.provider": provider,
        });
      }
    },
  );
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
              handleInteractivePayload({
                payload,
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
