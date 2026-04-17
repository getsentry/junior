import type { AgentTurnUsage } from "@/chat/usage";

interface SlackMrkdwnTextObject {
  text: string;
  type: "mrkdwn";
}

interface SlackSectionBlock {
  text: SlackMrkdwnTextObject;
  type: "section";
}

interface SlackContextBlock {
  elements: SlackMrkdwnTextObject[];
  type: "context";
}

export type SlackMessageBlock = SlackSectionBlock | SlackContextBlock;

export interface SlackReplyFooterItem {
  label: string;
  value: string;
}

export interface SlackReplyFooter {
  items: SlackReplyFooterItem[];
}

function escapeSlackMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSlackTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSlackDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  const durationSeconds = durationMs / 1_000;
  if (durationSeconds < 10) {
    return `${durationSeconds.toFixed(1).replace(/\.0$/, "")}s`;
  }

  return `${Math.round(durationSeconds)}s`;
}

function resolveTotalTokens(
  usage: AgentTurnUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }

  // Sum every individual counter the provider reported so cached + cache
  // creation tokens are included in the displayed total. Provider `totalTokens`
  // fields are inconsistent across vendors (some exclude cached tokens, some
  // include them), so prefer the sum when component counts exist.
  const components = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);

  if (components.length > 0) {
    return components.reduce((sum, value) => sum + value, 0);
  }

  return usage.totalTokens;
}

/** Build a compact Slack reply footer so operators can correlate visible replies with backend state. */
export function buildSlackReplyFooter(args: {
  conversationId?: string;
  durationMs?: number;
  traceId?: string;
  usage?: AgentTurnUsage;
}): SlackReplyFooter | undefined {
  const items: SlackReplyFooterItem[] = [];

  const conversationId = args.conversationId?.trim();
  if (conversationId) {
    items.push({
      label: "ID",
      value: conversationId,
    });
  }

  const totalTokens = resolveTotalTokens(args.usage);
  if (totalTokens !== undefined) {
    items.push({
      label: "Tokens",
      value: formatSlackTokenCount(totalTokens),
    });
  }

  if (typeof args.durationMs === "number" && Number.isFinite(args.durationMs)) {
    const durationMs = Math.max(0, Math.floor(args.durationMs));
    items.push({
      label: "Time",
      value: formatSlackDuration(durationMs),
    });
  }

  const traceId = args.traceId?.trim();
  if (traceId) {
    items.push({
      label: "Trace",
      value: traceId,
    });
  }

  return items.length > 0 ? { items } : undefined;
}

/** Build Slack blocks for a finalized reply plus its optional footer context block. */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
): SlackMessageBlock[] | undefined {
  if (!text.trim() || !footer?.items.length) {
    return undefined;
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
    {
      type: "context",
      elements: footer.items.map((item) => ({
        type: "mrkdwn",
        text: `*${escapeSlackMrkdwn(item.label)}:* ${escapeSlackMrkdwn(item.value)}`,
      })),
    },
  ];
}
