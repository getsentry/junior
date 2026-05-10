import * as Sentry from "@/chat/sentry";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";

const SENTRY_CONVERSATION_SEARCH_STATS_PERIOD = "14d";

interface SlackMrkdwnTextObject {
  text: string;
  type: "mrkdwn";
}

/** Slack-flavored Markdown block — accepts a standard Markdown subset and Slack renders it natively. */
interface SlackMarkdownBlock {
  text: string;
  type: "markdown";
}

interface SlackSectionBlock {
  text: SlackMrkdwnTextObject;
  type: "section";
}

interface SlackContextBlock {
  elements: SlackMrkdwnTextObject[];
  type: "context";
}

export type SlackMessageBlock =
  | SlackMarkdownBlock
  | SlackSectionBlock
  | SlackContextBlock;

interface SlackReplyFooterItem {
  label: string;
  url?: string;
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

function escapeSlackLinkUrl(url: string): string {
  return url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
}

function quoteSentrySearchValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function getSentryOrgSlug(): string | undefined {
  const slug = process.env.SENTRY_ORG_SLUG?.trim();
  return slug || undefined;
}

function isSentrySaasDsnHost(host: string): boolean {
  return host === "sentry.io" || host.endsWith(".sentry.io");
}

function buildSentryWebBaseUrl(dsn: {
  host: string;
  path?: string;
  port?: string;
  protocol: string;
}): string {
  if (isSentrySaasDsnHost(dsn.host)) {
    return "https://sentry.io";
  }

  const port = dsn.port ? `:${dsn.port}` : "";
  const path = dsn.path ? `/${dsn.path}` : "";
  return `${dsn.protocol}://${dsn.host}${port}${path}`;
}

function getSentryConversationSearchUrl(
  conversationId: string,
): string | undefined {
  const client = Sentry.getClient();
  const dsn = client?.getDsn();
  if (!dsn?.host || !dsn.projectId) {
    return undefined;
  }

  const orgSlug = getSentryOrgSlug();
  if (!orgSlug) {
    return undefined;
  }

  const params = new URLSearchParams();
  params.set(
    "query",
    `gen_ai.conversation.id:${quoteSentrySearchValue(conversationId)}`,
  );
  params.set("project", dsn.projectId);
  params.set("statsPeriod", SENTRY_CONVERSATION_SEARCH_STATS_PERIOD);

  const search = `explore/traces/?${params.toString()}`;

  if (isSentrySaasDsnHost(dsn.host)) {
    return `https://${orgSlug}.sentry.io/${search}`;
  }

  return `${buildSentryWebBaseUrl(dsn)}/organizations/${orgSlug}/${search}`;
}

function formatSlackTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    // Show up to 2 decimal places, drop trailing zeros
    return `${parseFloat(millions.toFixed(2))}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${parseFloat(thousands.toFixed(1))}k`;
  }
  return `${value}`;
}

function formatSlackDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1_000);

  if (totalSeconds < 10) {
    const precise = durationMs / 1_000;
    return `${precise.toFixed(1).replace(/\.0$/, "")}s`;
  }

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m${seconds}s`;
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

/**
 * Build a compact footer for the finalized Slack reply.
 *
 * This is reply metadata, not part of the in-flight assistant loading state.
 */
export function buildSlackReplyFooter(args: {
  conversationId?: string;
  durationMs?: number;
  thinkingLevel?: TurnThinkingSelection["thinkingLevel"];
  usage?: AgentTurnUsage;
}): SlackReplyFooter | undefined {
  const items: SlackReplyFooterItem[] = [];

  const conversationId = args.conversationId?.trim();
  if (conversationId) {
    const idItem: SlackReplyFooterItem = {
      label: "ID",
      value: conversationId,
    };
    const conversationUrl = getSentryConversationSearchUrl(conversationId);
    if (conversationUrl) {
      idItem.url = conversationUrl;
    }
    items.push(idItem);
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

  if (args.thinkingLevel) {
    items.push({
      label: "Thinking",
      value: args.thinkingLevel,
    });
  }

  return items.length > 0 ? { items } : undefined;
}

/** Build Slack blocks for a reply chunk using the Slack-flavored markdown block for the body. */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const blocks: SlackMessageBlock[] = [
    {
      type: "markdown",
      text,
    },
  ];

  if (footer?.items.length) {
    blocks.push({
      type: "context",
      elements: footer.items.map((item) => ({
        type: "mrkdwn",
        text: item.url
          ? `*${escapeSlackMrkdwn(item.label)}:* <${escapeSlackLinkUrl(item.url)}|${escapeSlackMrkdwn(item.value)}>`
          : `*${escapeSlackMrkdwn(item.label)}:* ${escapeSlackMrkdwn(item.value)}`,
      })),
    });
  }

  return blocks;
}
