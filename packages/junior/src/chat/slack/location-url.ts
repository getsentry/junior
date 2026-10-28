import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

/** Parse a Slack workspace subdomain used in `https://{domain}.slack.com` URLs. */
export function parseSlackTeamDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const domain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)) {
    return undefined;
  }
  return domain;
}

/** Convert a Slack message ts into the `p…` segment used by archive URLs. */
function archivePathFromThreadTs(threadTs: SlackMessageTs): string {
  const [seconds, fraction = ""] = threadTs.split(".");
  return `p${seconds}${(fraction ?? "").padEnd(6, "0").slice(0, 6)}`;
}

/**
 * Build a direct Slack archive URL for a thread when the workspace domain is
 * known. Omits a link rather than falling back to `app_redirect`.
 */
export function buildSlackLocationUrl(args: {
  channelId: string;
  teamDomain: string;
  threadTs: string;
}): string | undefined {
  const channelId = parseSlackChannelId(args.channelId);
  const teamDomain = parseSlackTeamDomain(args.teamDomain);
  const threadTs = parseSlackMessageTs(args.threadTs);
  if (!channelId || !teamDomain || !threadTs) return undefined;

  const url = new URL(
    `https://${teamDomain}.slack.com/archives/${channelId}/${archivePathFromThreadTs(threadTs)}`,
  );
  url.searchParams.set("thread_ts", threadTs);
  url.searchParams.set("cid", channelId);
  return url.toString();
}
