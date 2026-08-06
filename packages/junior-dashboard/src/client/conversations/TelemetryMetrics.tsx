import type {
  ConversationAuxiliaryCosts,
  ConversationDetailReport,
  ConversationModelUsage,
} from "@sentry/junior/api/schema";
import {
  formatCostBreakdown,
  formatCostSummary,
  formatCompactNumber,
  formatTime,
  formatTokenSummary,
  summarizeCost,
  summarizeUsage,
  totalConversationCost,
  type CostUsageSummary,
  type MessageSummary,
  type TokenUsageSummary,
  type ToolCallSummary,
} from "../format";
import { MetricValue, type MetricTooltipLine } from "../components/Metric";
import { ShimmerText } from "../components/ShimmerText";

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

const terminalTurnLifecycleStates = new Set([
  "succeeded",
  "no_reply",
  "failed",
]);

/** Return the open turn's routed model, when one is still in progress. */
export function activeTurnModelId(
  conversation: Pick<ConversationDetailReport, "events" | "status"> | undefined,
): string | undefined {
  return activeTurn(conversation)?.modelId;
}

/** Whether the conversation currently has a started turn that has not finished. */
export function hasOpenTurn(
  conversation: Pick<ConversationDetailReport, "events" | "status"> | undefined,
): boolean {
  return Boolean(activeTurn(conversation));
}

function activeTurn(
  conversation: Pick<ConversationDetailReport, "events" | "status"> | undefined,
): { modelId?: string; turnId: string } | undefined {
  if (conversation?.status !== "active") return undefined;
  const closedTurnIds = new Set<string>();
  let openTurnId: string | undefined;
  let modelId: string | undefined;
  let modelTurnId: string | undefined;
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const data = conversation.events[index]?.data;
    if (!data) continue;
    if (data.type === "turn_lifecycle") {
      if (terminalTurnLifecycleStates.has(data.state)) {
        closedTurnIds.add(data.turnId);
        continue;
      }
      if (data.state === "started" && !closedTurnIds.has(data.turnId)) {
        openTurnId = data.turnId;
        break;
      }
      continue;
    }
    if (
      data.type === "turn_routed" &&
      !closedTurnIds.has(data.turnId) &&
      modelId === undefined
    ) {
      modelId = data.modelId;
      modelTurnId = data.turnId;
    }
  }
  if (!openTurnId) {
    if (!modelTurnId || closedTurnIds.has(modelTurnId)) return undefined;
    openTurnId = modelTurnId;
  }
  return {
    turnId: openTurnId,
    modelId: modelTurnId === openTurnId ? modelId : undefined,
  };
}

function tokenTooltip(
  summary: TokenUsageSummary,
  modelUsage: ConversationModelUsage[] | undefined,
  compactionCount: number | undefined,
): MetricTooltipLine[] {
  const lines: Array<MetricTooltipLine | undefined> = [
    compactionCount
      ? { label: "compactions", value: formatCompactNumber(compactionCount) }
      : undefined,
  ];
  if (!modelUsage?.length) {
    lines.push(...usageTooltipLines(summary));
  }
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

function costTooltipLines(summary: CostUsageSummary): MetricTooltipLine[] {
  const lines: Array<MetricTooltipLine | undefined> = [
    { label: "total", value: formatCostBreakdown(summary) },
    summary.input !== undefined
      ? {
          label: "input",
          value: formatCostBreakdown({ total: summary.input }),
        }
      : undefined,
    summary.output !== undefined
      ? {
          label: "output",
          value: formatCostBreakdown({ total: summary.output }),
        }
      : undefined,
    summary.cacheRead !== undefined
      ? {
          label: "cache read",
          value: formatCostBreakdown({ total: summary.cacheRead }),
        }
      : undefined,
    summary.cacheWrite !== undefined
      ? {
          label: "cache write",
          value: formatCostBreakdown({ total: summary.cacheWrite }),
        }
      : undefined,
  ];
  return lines.filter(isMetricTooltipLine);
}

function costTooltip(
  summary: CostUsageSummary | undefined,
  modelUsage: ConversationModelUsage[] | undefined,
  auxiliaryCosts: ConversationAuxiliaryCosts | undefined,
  pendingModelId: string | undefined,
): {
  tooltip?: MetricTooltipLine[];
  tooltipColumns?: MetricTooltipLine[][];
} {
  const total = totalConversationCost(summary, auxiliaryCosts);
  const modelSummaries = (modelUsage ?? []).flatMap((item) => {
    const modelSummary = summarizeCost(item.usage);
    return modelSummary
      ? [{ modelId: item.modelId, summary: modelSummary }]
      : [];
  });
  const pendingLines: MetricTooltipLine[] = pendingModelId
    ? [
        { value: modelLabel(pendingModelId), valueStyle: "heading" },
        { value: "in progress" },
      ]
    : [];
  if (!total) return { tooltip: pendingLines };
  if (!auxiliaryCosts) {
    if (!modelSummaries.length) {
      return {
        tooltip: [
          ...(summary ? costTooltipLines(summary) : []),
          ...pendingLines,
        ],
      };
    }
    return {
      tooltip: [
        ...modelSummaries.flatMap((item) => [
          { value: modelLabel(item.modelId), valueStyle: "heading" as const },
          ...costTooltipLines(item.summary).map((line) => ({
            ...line,
            label: `• ${line.label}`,
          })),
        ]),
        ...pendingLines,
      ],
    };
  }

  const conversationLines: MetricTooltipLine[] = [
    { value: "Conversation", valueStyle: "heading" },
    { label: "total", value: formatCostBreakdown(total) },
  ];
  if (summary) {
    conversationLines.push({
      label: "agent",
      value: formatCostBreakdown(summary),
    });
    if (!modelSummaries.length) {
      conversationLines.push(
        ...costTooltipLines(summary)
          .filter((line) => line.label !== "total")
          .map((line) => ({ ...line, label: `• ${line.label}` })),
      );
    } else {
      for (const item of modelSummaries) {
        conversationLines.push(
          { value: modelLabel(item.modelId), valueStyle: "heading" },
          ...costTooltipLines(item.summary).map((line) => ({
            ...line,
            label: `• ${line.label}`,
          })),
        );
      }
    }
  }
  conversationLines.push(...pendingLines);
  const auxiliaryLines: MetricTooltipLine[] = [
    { value: "Auxiliary", valueStyle: "heading" },
    {
      label: "total",
      value: formatCostBreakdown({ total: auxiliaryCosts.costUsd }),
    },
  ];
  for (const operation of auxiliaryCosts.operations) {
    auxiliaryLines.push({
      label: `${auxiliaryOperationLabel(operation)} (${formatCompactNumber(operation.events)})`,
      value: formatCostBreakdown({ total: operation.costUsd }),
    });
  }
  return { tooltipColumns: [conversationLines, auxiliaryLines] };
}

function auxiliaryOperationLabel(
  operation: ConversationAuxiliaryCosts["operations"][number],
): string {
  const knownLabels: Readonly<Record<string, string>> = {
    "junior/guardian_action_reviewed": "Guardian",
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
  modelUsage?: ConversationModelUsage[];
  pendingModelId?: string;
  summary: CostUsageSummary | undefined;
}) {
  const total = totalConversationCost(props.summary, props.auxiliaryCosts);
  if (!total && !props.pendingModelId) return null;
  const pending = Boolean(props.pendingModelId);
  const label = total
    ? `${formatCostSummary(total)}${pending ? "+" : ""}`
    : "$…";
  return (
    <MetricValue
      align={props.align}
      tooltipPlacement="above"
      {...costTooltip(
        props.summary,
        props.modelUsage,
        props.auxiliaryCosts,
        props.pendingModelId,
      )}
    >
      <ShimmerText active={pending}>{label}</ShimmerText>
    </MetricValue>
  );
}

/** Render total token usage with a hoverable breakdown. */
export function TokenMetric(props: {
  align?: "left" | "right";
  compactionCount?: number;
  live?: boolean;
  modelUsage?: ConversationModelUsage[];
  summary: TokenUsageSummary | undefined;
}) {
  if (!props.summary) return null;
  return (
    <MetricValue
      align={props.align}
      tooltip={tokenTooltip(
        props.summary,
        props.modelUsage,
        props.compactionCount,
      )}
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
