import type {
  ConversationAuxiliaryCosts,
  ConversationChildAgentTotals,
  ConversationModelUsage,
} from "@sentry/junior/api/schema";
import {
  formatCostSummary,
  formatCompactNumber,
  formatRuntime,
  formatTime,
  formatTokenSummary,
  summarizeCost,
  summarizeModelCost,
  summarizeUsage,
  totalConversationCost,
  type CostUsageSummary,
  type MessageSummary,
  type TokenUsageSummary,
  type ToolCallSummary,
} from "../format";
import { MetricValue, type MetricTooltipLine } from "../components/Metric";
import { ShimmerText } from "../components/ShimmerText";
import {
  UsageCard,
  type UsageCardProps,
  type UsageCardRow,
  type UsageCardSection,
  type UsageCardSplit,
} from "./UsageCard";

function plural(label: string, count: number): string {
  return `${formatCompactNumber(count)} ${label}${count === 1 ? "" : "s"}`;
}

function isMetricTooltipLine(
  line: MetricTooltipLine | undefined,
): line is MetricTooltipLine {
  return Boolean(line);
}

/** List the recorded token types, such as input and output. */
export function tokenTypeRows(summary: TokenUsageSummary): UsageCardRow[] {
  return (
    [
      ["input", summary.inputTokens],
      ["output", summary.outputTokens],
      ["cached", summary.cachedInputTokens],
      ["cache write", summary.cacheCreationTokens],
      ["reasoning", summary.reasoningTokens],
    ] as const
  ).flatMap(([label, value]) =>
    value ? [{ label, value: formatCompactNumber(value) }] : [],
  );
}

/** Add up the tokens and cost of all subagents, including auxiliary cost. */
export function subagentUsage(
  childAgentTotals: ConversationChildAgentTotals | undefined,
): { cost: number; tokens: number } {
  return {
    cost:
      (summarizeCost(childAgentTotals?.cumulativeUsage)?.total ?? 0) +
      (childAgentTotals?.auxiliaryCostUsd ?? 0),
    tokens: summarizeUsage(childAgentTotals?.cumulativeUsage)?.totalTokens ?? 0,
  };
}

/**
 * Split a total that includes child agents into the part of this agent and the
 * part of its subagents. Return no lines when there are no subagents.
 */
function agentSplitLines(
  childAgentTotals: ConversationChildAgentTotals | undefined,
  total: number,
  subagentPart: number,
  format: (value: number) => string,
): MetricTooltipLine[] {
  if (!childAgentTotals) return [];
  return [
    { value: "By agent", valueStyle: "heading" },
    { label: "this agent", value: format(Math.max(0, total - subagentPart)) },
    {
      label: plural("subagent", childAgentTotals.count),
      value: format(subagentPart),
    },
  ];
}

/** Drop the provider prefix from a model id, such as `openai/gpt-5`. */
export function modelLabel(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

function modelHeading(
  modelId: string,
  liveModelId: string | undefined,
): MetricTooltipLine {
  return {
    live: modelId === liveModelId,
    value: modelLabel(modelId),
    valueStyle: "heading",
  };
}

/** Rows shown before the rest of a list rolls into one "N more" line. */
const MODEL_LIMIT = 4;
const AUXILIARY_LIMIT = 3;
const DETAILS_FOOTER = "Full breakdown in Details";

type RankedRow = UsageCardRow & { amount: number };

/**
 * Keep the largest rows and roll the rest into one "N more" line. A single
 * extra row shows as itself, since "1 more" saves no space.
 */
function capRows(
  rows: RankedRow[],
  limit: number,
  format: (value: number) => string,
): Pick<UsageCardSection, "more" | "rows"> {
  if (rows.length <= limit + 1) return { rows };
  const rest = rows.slice(limit);
  return {
    more: {
      count: rest.length,
      value: format(rest.reduce((sum, row) => sum + row.amount, 0)),
    },
    rows: rows.slice(0, limit),
  };
}

/**
 * One row per model, largest first. The live model leads the list before it
 * reports usage.
 */
function modelRows<Summary>(
  modelUsage: ConversationModelUsage[] | undefined,
  liveModelId: string | undefined,
  summarize: (usage: ConversationModelUsage["usage"]) => Summary | undefined,
  size: (summary: Summary) => number,
  format: (value: number) => string,
): RankedRow[] {
  const rows = (modelUsage ?? [])
    .flatMap((item) => {
      const summary = summarize(item.usage);
      return summary ? [{ amount: size(summary), modelId: item.modelId }] : [];
    })
    .sort((a, b) => b.amount - a.amount)
    .map((item) => ({
      amount: item.amount,
      code: true,
      label: modelLabel(item.modelId),
      live: item.modelId === liveModelId,
      value: format(item.amount),
    }));
  if (liveModelId && !rows.some((row) => row.live)) {
    rows.unshift({
      amount: 0,
      code: true,
      label: modelLabel(liveModelId),
      live: true,
      value: "…",
    });
  }
  return rows;
}

/** Split a total that includes subagents into this agent's part and theirs. */
function agentSplit(
  childAgentTotals: ConversationChildAgentTotals | undefined,
  total: number,
  subagentPart: number,
  format: (value: number) => string,
): UsageCardSplit | undefined {
  if (!childAgentTotals) return undefined;
  const subagents = Math.min(Math.max(0, subagentPart), total);
  return {
    count: childAgentTotals.count,
    self: format(total - subagents),
    selfShare: total > 0 ? (total - subagents) / total : 1,
    subagents: format(subagents),
  };
}

/**
 * Format every amount on one cost card with the same precision, so the
 * decimal points line up down the column.
 */
export function costFormatter(total: number): (value: number) => string {
  const digits = total >= 10 ? 2 : total >= 1 ? 3 : 4;
  const format = new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "currency",
  });
  return (value) => format.format(value);
}

function tokenCard(
  summary: TokenUsageSummary,
  modelUsage: ConversationModelUsage[] | undefined,
  compactionCount: number | undefined,
  liveModelId: string | undefined,
  childAgentTotals: ConversationChildAgentTotals | undefined,
  detailsHint: boolean,
): UsageCardProps {
  const models = modelRows(
    modelUsage,
    liveModelId,
    summarizeUsage,
    (model) => model.totalTokens,
    formatCompactNumber,
  );
  return {
    footer: detailsHint && models.length ? DETAILS_FOOTER : undefined,
    note: compactionCount ? plural("compaction", compactionCount) : undefined,
    sections: models.length
      ? [
          {
            title: "By model",
            ...capRows(models, MODEL_LIMIT, formatCompactNumber),
          },
        ]
      : [{ rows: tokenTypeRows(summary), title: "By type" }].filter(
          (section) => section.rows.length,
        ),
    split: agentSplit(
      childAgentTotals,
      summary.totalTokens,
      subagentUsage(childAgentTotals).tokens,
      formatCompactNumber,
    ),
    title: "Tokens",
    total: formatCompactNumber(summary.totalTokens),
  };
}

function costTypeRows(
  summary: CostUsageSummary,
  format: (value: number) => string,
): UsageCardRow[] {
  return (
    [
      ["input", summary.input],
      ["output", summary.output],
      ["cache read", summary.cacheRead],
      ["cache write", summary.cacheWrite],
    ] as const
  ).flatMap(([label, value]) =>
    value === undefined ? [] : [{ label, value: format(value) }],
  );
}

/** Summarize cost. Return nothing until there is a cost to show. */
function costCard(
  summary: CostUsageSummary | undefined,
  modelUsage: ConversationModelUsage[] | undefined,
  auxiliaryCosts: ConversationAuxiliaryCosts | undefined,
  liveModelId: string | undefined,
  childAgentTotals: ConversationChildAgentTotals | undefined,
  detailsHint: boolean,
): UsageCardProps | undefined {
  const total = totalConversationCost(summary, auxiliaryCosts);
  if (!total) return undefined;
  const format = costFormatter(total.total);
  const models = modelRows(
    modelUsage,
    liveModelId,
    summarizeCost,
    (model) => model.total,
    format,
  );
  const operations: RankedRow[] = [...(auxiliaryCosts?.operations ?? [])]
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((operation) => ({
      amount: operation.costUsd,
      label: auxiliaryOperationLabel(operation),
      value: format(operation.costUsd),
    }));
  const sections: UsageCardSection[] = [];
  if (models.length) {
    sections.push({
      title: "By model",
      ...capRows(models, MODEL_LIMIT, format),
    });
  } else if (summary) {
    const rows = costTypeRows(summary, format);
    if (rows.length) sections.push({ rows, title: "By type" });
  }
  if (auxiliaryCosts && operations.length) {
    sections.push({
      title: "Auxiliary",
      total: format(auxiliaryCosts.costUsd),
      ...capRows(operations, AUXILIARY_LIMIT, format),
    });
  }
  return {
    footer:
      detailsHint && (models.length || operations.length)
        ? DETAILS_FOOTER
        : undefined,
    sections,
    split: agentSplit(
      childAgentTotals,
      total.total,
      subagentUsage(childAgentTotals).cost,
      format,
    ),
    title: "Estimated cost",
    total: format(total.total),
  };
}

/** Name an auxiliary operation, such as memory recall or turn routing. */
export function auxiliaryOperationLabel(
  operation: ConversationAuxiliaryCosts["operations"][number],
): string {
  const knownLabels: Readonly<Record<string, string>> = {
    "junior/guardian_action_reviewed": "Guardian",
    "junior/passive_reply_routed": "Passive reply routing",
    "junior/turn_routed": "Thinking routing",
    "memory/memories_captured": "Memory extraction",
    "memory/memories_recalled": "Memory recall",
  };
  const key = `${operation.namespace}/${operation.name}`;
  return (
    knownLabels[key] ??
    `${operation.namespace} · ${operation.name.replaceAll("_", " ")}`
  );
}

/** Render estimated model cost with a hoverable USD breakdown. */
export function CostMetric(props: {
  align?: "left" | "right";
  auxiliaryCosts?: ConversationAuxiliaryCosts;
  childAgentTotals?: ConversationChildAgentTotals;
  /** Point to the Details drawer, which has the full breakdown. */
  detailsHint?: boolean;
  live?: boolean;
  liveModelId?: string;
  modelUsage?: ConversationModelUsage[];
  summary: CostUsageSummary | undefined;
}) {
  // Model history can include calls not yet counted in saved Run totals.
  const summary = summarizeModelCost(props.modelUsage) ?? props.summary;
  const total = totalConversationCost(summary, props.auxiliaryCosts);
  if (!total && !props.live) return null;
  const pending = Boolean(props.live);
  const label = total
    ? `${formatCostSummary(total)}${pending ? "+" : ""}`
    : "$…";
  const card = costCard(
    summary,
    props.modelUsage,
    props.auxiliaryCosts,
    props.liveModelId,
    props.childAgentTotals,
    Boolean(props.detailsHint),
  );
  return (
    <MetricValue
      align={props.align}
      tooltipPlacement="above"
      tooltip={
        !card && props.liveModelId
          ? [modelHeading(props.liveModelId, props.liveModelId)]
          : undefined
      }
      tooltipCard={card ? <UsageCard {...card} /> : undefined}
    >
      <ShimmerText active={pending}>{label}</ShimmerText>
    </MetricValue>
  );
}

/** Render total token usage with a hoverable breakdown. */
export function TokenMetric(props: {
  align?: "left" | "right";
  childAgentTotals?: ConversationChildAgentTotals;
  compactionCount?: number;
  /** Point to the Details drawer, which has the full breakdown. */
  detailsHint?: boolean;
  live?: boolean;
  liveModelId?: string;
  modelUsage?: ConversationModelUsage[];
  summary: TokenUsageSummary | undefined;
}) {
  if (!props.summary) return null;
  return (
    <MetricValue
      align={props.align}
      tooltipCard={
        <UsageCard
          {...tokenCard(
            props.summary,
            props.modelUsage,
            props.compactionCount,
            props.liveModelId,
            props.childAgentTotals,
            Boolean(props.detailsHint),
          )}
        />
      }
    >
      <ShimmerText active={props.live}>
        {formatTokenSummary(props.summary)}
      </ShimmerText>
    </MetricValue>
  );
}

/** Render a duration value with start/end timestamps in the tooltip. */
export function DurationMetric(props: {
  align?: "left" | "right";
  childAgentTotals?: ConversationChildAgentTotals;
  durationMs?: number;
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
    ...agentSplitLines(
      props.childAgentTotals,
      props.durationMs ?? 0,
      props.childAgentTotals?.cumulativeDurationMs ?? 0,
      (value) => formatRuntime(value) || "0s",
    ),
  ];
  const tooltip = lines.filter(isMetricTooltipLine);
  return (
    <MetricValue align={props.align} tooltip={tooltip}>
      {props.label}
    </MetricValue>
  );
}

/**
 * Say how many subagents the tokens, cost, and runtime of a Conversation
 * include. Render nothing for a Conversation without subagents.
 */
export function SubagentsMetric(props: {
  childAgentTotals: ConversationChildAgentTotals | undefined;
}) {
  if (!props.childAgentTotals) return null;
  const label = plural("subagent", props.childAgentTotals.count);
  return (
    <MetricValue
      tooltip={[
        { value: `Tokens, cost, and runtime include ${label} at any depth.` },
      ]}
    >
      {label}
    </MetricValue>
  );
}

/** Render a tool-call count with top tool names and counts. */
export function ToolCallsMetric(props: {
  align?: "left" | "right";
  live?: boolean;
  loading?: boolean;
  summary: ToolCallSummary | undefined;
}) {
  if (props.loading) return <span>tool calls loading</span>;
  if (!props.summary || props.summary.total <= 0) return null;
  const tooltip = props.summary.items.map((item) => ({
    label: item.name,
    labelStyle: "code" as const,
    value: plural("call", item.count),
  }));
  return (
    <MetricValue align={props.align} tooltip={tooltip}>
      <ShimmerText active={props.live}>
        {plural("tool call", props.summary.total)}
      </ShimmerText>
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
