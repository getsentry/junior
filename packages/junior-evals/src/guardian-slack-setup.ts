/**
 * Slack's answers about channels in Guardian evals, which reach no Slack or
 * database. A channel that a case names resolves as a channel Junior already
 * saw. `conversations.info` says a channel is shared with another
 * organization only for the Slack Connect channels below.
 */
import { vi } from "vitest";

/** Channels that the cases treat as Slack Connect. */
const SLACK_CONNECT_CHANNELS = new Set(["acme-shared"]);

const names = new Map<string, string>();

vi.mock("@/chat/slack/tool-support/channel-target", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/chat/slack/tool-support/channel-target")
    >();
  return {
    ...actual,
    resolveSlackChannelRef: async (
      input: Parameters<typeof actual.resolveSlackChannelRef>[0],
    ) => {
      const name = input.value.trim().replace(/^#/, "");
      if (!/^[a-z0-9_-]+$/.test(name)) {
        return await actual.resolveSlackChannelRef(input);
      }
      const channelId = `C${name.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      names.set(channelId, name);
      return { channelId, channelName: name };
    },
  };
});

vi.mock("@/chat/slack/channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/slack/channel")>()),
  getConversationInfo: async (channelId: string) => {
    const name = names.get(channelId);
    return {
      id: channelId,
      ...(name ? { name } : undefined),
      isChannel: true,
      isPrivate: false,
      isIm: false,
      isMpim: false,
      isExtShared: name !== undefined && SLACK_CONNECT_CHANNELS.has(name),
      isMember: true,
    };
  },
}));
