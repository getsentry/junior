import type { ChannelConfigurationService } from "@/chat/configuration/types";

const GITHUB_REPO_PART = String.raw`[A-Za-z0-9_.-]*[A-Za-z0-9_-]`;
const GITHUB_REPO_RE = new RegExp(
  String.raw`^\s*(?:set|use)\s+(?:the\s+)?default\s+(?:github\s+)?repo(?:sitory)?\s+(?:to|as)\s+(${GITHUB_REPO_PART}/${GITHUB_REPO_PART})(?:\s+for\s+this\s+channel)?[.!?]?\s*$`,
  "i",
);

/** Apply explicit provider-default config requests that do not need agent reasoning. */
export async function maybeApplyProviderDefaultConfigRequest(args: {
  channelConfiguration?: ChannelConfigurationService;
  actorId?: string;
  text: string;
}): Promise<{ text: string } | null> {
  const match = GITHUB_REPO_RE.exec(args.text);
  const repo = match?.[1];
  if (!repo || !args.channelConfiguration) {
    return null;
  }

  await args.channelConfiguration.set({
    key: "github.repo",
    value: repo,
    updatedBy: args.actorId,
    source: "provider-default-config",
  });

  return {
    text: `Default GitHub repo set to \`${repo}\`.`,
  };
}
