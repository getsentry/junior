import type { ConversationModelUsage } from "@sentry/junior/api/schema";
import {
  formatCostSummary,
  formatCompactNumber,
  formatMs,
  formatTime,
  formatTokenSummary,
  summarizeUsage,
  type CostUsageSummary,
  type MessageSummary,
  type TokenUsageSummary,
  type ToolCallSummary,
} from "../format";
import { MetricValue, type MetricTooltipLine } from "./Metric";

function plural(label: string, count: number): string {
  return `${formatCompactNumber(count)} ${label}${count === 1 ? "" : "s"}`;
}

function isMetricTooltipLine(
  line: MetricTooltipLine | undefined,
): line is MetricTooltipLine {
  return Boolean(line);
}

function usageTooltipLines(
  summary: TokenUsageSummary,
): Array<MetricTooltipLine | undefined> {
  return [
    summary.inputTokens !== undefined
      ? { label: "input", value: formatCompactNumber(summary.inputTokens) }
      : undefined,
    summary.outputTokens !== undefined
      ? { label: "output", value: formatCompactNumber(summary.outputTokens) }
      : undefined,
    summary.cachedInputTokens !== undefined
      ? {
          label: "cached",
          value: formatCompactNumber(summary.cachedInputTokens),
        }
      : undefined,
    summary.cacheCreationTokens !== undefined
      ? {
          label: "cache write",
          value: formatCompactNumber(summary.cacheCreationTokens),
        }
      : undefined,
    summary.reasoningTokens !== undefined
      ? {
          label: "reasoning",
          value: formatCompactNumber(summary.reasoningTokens),
        }
      : undefined,
    summary.providerTotalTokens !== undefined
      ? {
          label: "provider",
          value: formatCompactNumber(summary.providerTotalTokens),
        }
      : undefined,
  ];
}

function modelLabel(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

function tokenTooltip(
  modelUsage: ConversationModelUsage[] | undefined,
  compactionCount: number | undefined,
): MetricTooltipLine[] {
  const lines: Array<MetricTooltipLine | undefined> = [
    compactionCount
      ? { label: "compactions", value: formatCompactNumber(compactionCount) }
      : undefined,
  ];
  for (const item of modelUsage ?? []) {
    const modelSummary = summarizeUsage(item.usage);
    if (!modelSummary) continue;
    lines.push(
      { value: modelLabel(item.modelId), valueStyle: "heading" },
      ...usageTooltipLines(modelSummary).map((line) =>
        line?.label ? { ...line, label: `• ${line.label}` } : line,
      ),
    );
  }
  return lines.filter(isMetricTooltipLine);
}

function costTooltip(summary: CostUsageSummary): MetricTooltipLine[] {
  const lines: Array<MetricTooltipLine | undefined> = [
    summary.input !== undefined
      ? { label: "input", value: formatCostSummary({ total: summary.input }) }
      : undefined,
    summary.output !== undefined
      ? {
          label: "output",
          value: formatCostSummary({ total: summary.output }),
        }
      : undefined,
    summary.cacheRead !== undefined
      ? {
          label: "cache read",
          value: formatCostSummary({ total: summary.cacheRead }),
        }
      : undefined,
    summary.cacheWrite !== undefined
      ? {
          label: "cache write",
          value: formatCostSummary({ total: summary.cacheWrite }),
        }
      : undefined,
  ];
  return lines.filter(isMetricTooltipLine);
}

/** Render estimated model cost with a hoverable USD breakdown. */
export function CostMetric(props: {
  align?: "left" | "right";
  summary: CostUsageSummary | undefined;
}) {
  if (!props.summary) return null;
  return (
    <MetricValue align={props.align} tooltip={costTooltip(props.summary)}>
      {formatCostSummary(props.summary)}
    </MetricValue>
  );
}

/** Render total token usage with a hoverable breakdown. */
export function TokenMetric(props: {
  align?: "left" | "right";
  compactionCount?: number;
  modelUsage?: ConversationModelUsage[];
  summary: TokenUsageSummary | undefined;
}) {
  if (!props.summary) return null;
  return (
    <MetricValue
      align={props.align}
      tooltip={tokenTooltip(props.modelUsage, props.compactionCount)}
    >
      {formatTokenSummary(props.summary)}
    </MetricValue>
  );
}

/** Render a duration value with start/end timestamps in the tooltip. */
export function DurationMetric(props: {
  align?: "left" | "right";
  endedAt?: string;
  label: string;
  startedAt?: string;
}) {
  if (!props.label || props.label === "none") return null;
  const lines: Array<MetricTooltipLine | undefined> = [
    props.startedAt
      ? { label: "started", value: formatTime(props.startedAt) }
      : undefined,
    props.endedAt
      ? { label: "ended", value: formatTime(props.endedAt) }
      : undefined,
  ];
  const tooltip = lines.filter(isMetricTooltipLine);
  return (
    <MetricValue align={props.align} tooltip={tooltip}>
      {props.label}
    </MetricValue>
  );
}

/** Render a tool-call count with top tool names, counts, and matched duration. */
export function ToolCallsMetric(props: {
  align?: "left" | "right";
  loading?: boolean;
  summary: ToolCallSummary | undefined;
}) {
  if (props.loading) return <span>tool calls loading</span>;
  if (!props.summary || props.summary.total <= 0) return null;
  const tooltip = props.summary.items.map((item) => ({
    label: item.name,
    labelStyle: "code" as const,
    value: [
      plural("call", item.count),
      item.totalDurationMs !== undefined
        ? formatMs(item.totalDurationMs)
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return (
    <MetricValue align={props.align} tooltip={tooltip}>
      {plural("tool call", props.summary.total)}
    </MetricValue>
  );
}

/** Render a conversational message count. */
export function MessagesMetric(props: {
  loading?: boolean;
  summary: MessageSummary | undefined;
}) {
  if (props.loading) return <span>messages loading</span>;
  if (!props.summary) return null;
  return <MetricValue>{plural("message", props.summary.total)}</MetricValue>;
}

/** Render an actor-initiated conversation turn count. */
export function TurnsMetric(props: {
  loading?: boolean;
  summary: MessageSummary | undefined;
}) {
  if (props.loading) return <span>turns loading</span>;
  if (!props.summary) return null;
  return <MetricValue>{plural("turn", props.summary.total)}</MetricValue>;
}
