import type { SlackAdapter } from "@chat-adapter/slack";
import type { ChatInstance, StateAdapter } from "chat";
import { runWithSlackInstallationToken } from "@/chat/slack/client";
import { getStateAdapter } from "@/chat/state/adapter";

interface SlackAdapterInternals {
  defaultBotTokenProvider?: () => string | Promise<string>;
  requestContext?: {
    run<T>(context: SlackTokenContext, fn: () => T): T;
  };
  resolveTokenForTeam?: (
    installationId: string,
    isEnterpriseInstall?: boolean,
  ) => Promise<{ botUserId?: string; token: string } | null>;
  verifySignature?: (
    body: string,
    timestamp: string | null,
    signature: string | null,
  ) => boolean;
}

interface SlackTokenContext {
  botUserId?: string;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  token: string;
}

export interface SlackInstallationContext {
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  teamId?: string;
}

const initializedAdapters = new WeakSet<SlackAdapter>();

async function getConnectedState(
  stateAdapter?: StateAdapter,
): Promise<StateAdapter> {
  const state = stateAdapter ?? getStateAdapter();
  await state.connect();
  return state;
}

/** Initialize the Slack adapter against the repository state adapter. */
export async function ensureSlackAdapterInitialized(args: {
  adapter: SlackAdapter;
  state?: StateAdapter;
}): Promise<void> {
  if (initializedAdapters.has(args.adapter)) {
    return;
  }
  const state = await getConnectedState(args.state);
  await args.adapter.initialize({
    getState: () => state,
  } as unknown as ChatInstance);
  const internals = args.adapter as unknown as SlackAdapterInternals;
  if (internals.defaultBotTokenProvider && !args.adapter.botUserId) {
    // A single-workspace adapter that failed `auth.test` has no bot identity,
    // which disables self-message filtering and mention detection. Caching it
    // would lock that broken state in for the process lifetime, so fail
    // retryably and let the next event re-attempt initialization.
    throw new Error("Slack adapter initialized without a resolved bot user id");
  }
  initializedAdapters.add(args.adapter);
}

/** Verify a Slack request using the adapter's configured signing secret. */
export function verifySlackSignature(args: {
  adapter: SlackAdapter;
  body: string;
  request: Request;
}): boolean {
  const internals = args.adapter as unknown as SlackAdapterInternals;
  const verifySignature = internals.verifySignature;
  if (!verifySignature) {
    throw new Error("Slack adapter does not expose signature verification");
  }
  return verifySignature.call(
    args.adapter,
    args.body,
    args.request.headers.get("x-slack-request-timestamp"),
    args.request.headers.get("x-slack-signature"),
  );
}

/** Run Slack work with the installation token that matches the inbound event. */
export async function runWithSlackInstallation<T>(args: {
  adapter: SlackAdapter;
  installation: SlackInstallationContext;
  state?: StateAdapter;
  task: () => T | Promise<T>;
}): Promise<T> {
  await ensureSlackAdapterInitialized({
    adapter: args.adapter,
    state: args.state,
  });

  const internals = args.adapter as unknown as SlackAdapterInternals;
  if (internals.defaultBotTokenProvider) {
    return await args.task();
  }

  const installationId = args.installation.isEnterpriseInstall
    ? args.installation.enterpriseId
    : args.installation.teamId;
  if (!installationId) {
    throw new Error("Slack installation context is missing team id");
  }
  if (!internals.resolveTokenForTeam || !internals.requestContext) {
    throw new Error("Slack adapter cannot resolve workspace installations");
  }

  const tokenContext = await internals.resolveTokenForTeam.call(
    args.adapter,
    installationId,
    args.installation.isEnterpriseInstall,
  );
  if (!tokenContext) {
    throw new Error(
      `Slack installation token was not found for ${installationId}`,
    );
  }

  return await internals.requestContext.run(
    {
      ...tokenContext,
      enterpriseId: args.installation.enterpriseId,
      isEnterpriseInstall: args.installation.isEnterpriseInstall,
    },
    () => runWithSlackInstallationToken(tokenContext.token, args.task),
  );
}
