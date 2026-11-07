import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import {
  formatCompactNumber,
  formatCostSummary,
  summarizeCost,
  summarizeModelCost,
  summarizeModelUsage,
  summarizeUsage,
  totalConversationCost,
  type CostUsageSummary,
  type TokenUsageSummary,
} from "../format";
import { ShimmerText } from "../components/ShimmerText";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import type { Conversation } from "../types";
import { liveModelId } from "./ConversationMeta";
import {
  auxiliaryOperationLabel,
  costFormatter,
  modelLabel,
  subagentShare,
  subagentUsage,
} from "./TelemetryMetrics";

/** One token type of a model, shown as an indented row under the model. */
type BreakdownPart = {
  cost?: string;
  count: string;
  label: string;
};

type BreakdownRow = {
  cost: string;
  count: string;
  key: string;
  label: ReactNode;
  parts?: BreakdownPart[];
};

const NOT_RECORDED = "—";

/**
 * Show token types with a recorded count or cost. Reasoning tokens are part
 * of output tokens and have no cost of their own.
 */
function tokenTypeParts(
  tokens: TokenUsageSummary | undefined,
  costs: CostUsageSummary | undefined,
  formatCost: (value: number) => string,
): BreakdownPart[] | undefined {
  const types = [
    ["input", tokens?.inputTokens, costs?.input],
    ["output", tokens?.outputTokens, costs?.output],
    ["cached", tokens?.cachedInputTokens, costs?.cacheRead],
    ["cache write", tokens?.cacheCreationTokens, costs?.cacheWrite],
    ["reasoning (in output)", tokens?.reasoningTokens, undefined],
  ] as const;
  const parts = types.flatMap(([label, count, cost]) =>
    count || cost !== undefined
      ? [
          {
            cost: cost === undefined ? undefined : formatCost(cost),
            count:
              count === undefined ? NOT_RECORDED : formatCompactNumber(count),
            label,
          },
        ]
      : [],
  );
  return parts.length ? parts : undefined;
}

const CELL = "px-0 text-right align-top font-sans tabular-nums";

/**
 * One usage table. Every table in the breakdown shares column widths, so the
 * cost column lines up from table to table. Each row is its own `tbody`, so
 * the token types of a model stay grouped under it.
 */
function BreakdownTable(props: {
  /** Header of the count column, such as Tokens or Calls. */
  countLabel: string;
  label: string;
  rows: BreakdownRow[];
  total?: { cost: string; count: string; label: string };
}) {
  return (
    <Table
      aria-label={props.label}
      className="min-w-72 table-fixed text-xs leading-relaxed"
    >
      <colgroup>
        <col />
        <col className="w-20" />
        <col className="w-20" />
      </colgroup>
      <TableHeader>
        <TableRow className="border-dashboard-border">
          <TableHead
            scope="col"
            className="px-0 py-2 leading-relaxed font-normal"
          >
            {props.label}
          </TableHead>
          <TableHead
            scope="col"
            className="px-0 py-2 text-right leading-relaxed font-normal"
          >
            {props.countLabel}
          </TableHead>
          <TableHead
            scope="col"
            className="px-0 py-2 text-right leading-relaxed font-normal"
          >
            Cost
          </TableHead>
        </TableRow>
      </TableHeader>
      {props.rows.map((row) => {
        const padding = row.parts ? "pt-2 pb-0.5" : "py-2";
        return (
          <TableBody
            className="border-b border-dashboard-border-subtle last-of-type:border-b-0"
            key={row.key}
          >
            {/* The tbody draws the group border, so its rows have none. */}
            <TableRow className="border-0">
              <TableHead
                scope="row"
                className={cn(
                  "pl-0 pr-3 align-top leading-relaxed font-normal text-dashboard-text",
                  padding,
                )}
              >
                <span className="block truncate">{row.label}</span>
              </TableHead>
              <TableCell className={cn(CELL, padding)}>{row.count}</TableCell>
              <TableCell className={cn(CELL, padding)}>{row.cost}</TableCell>
            </TableRow>
            {row.parts?.map((part, index, parts) => {
              const partPadding =
                index === parts.length - 1 ? "pt-0 pb-2" : "py-0";
              return (
                <TableRow
                  className="border-0 text-2xs leading-5"
                  key={part.label}
                >
                  <TableHead
                    scope="row"
                    className={cn(
                      "truncate pl-3 pr-3 align-top text-2xs leading-5 font-normal text-dashboard-text-faint",
                      partPadding,
                    )}
                  >
                    {part.label}
                  </TableHead>
                  <TableCell
                    className={cn(
                      CELL,
                      "text-dashboard-text-faint",
                      partPadding,
                    )}
                  >
                    {part.count}
                  </TableCell>
                  <TableCell
                    className={cn(
                      CELL,
                      "text-dashboard-text-faint",
                      partPadding,
                    )}
                  >
                    {part.cost}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        );
      })}
      {props.total ? (
        <TableFooter className="font-semibold">
          <TableRow>
            <TableHead
              scope="row"
              className="px-0 py-2 leading-relaxed font-semibold text-dashboard-text"
            >
              {props.total.label}
            </TableHead>
            <TableCell className="px-0 py-2 text-right font-sans tabular-nums">
              {props.total.count}
            </TableCell>
            <TableCell className="px-0 py-2 text-right font-sans tabular-nums">
              {props.total.cost}
            </TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

/** True when the Conversation has model or auxiliary usage to break down. */
export function hasConversationUsageBreakdown(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
}): boolean {
  if (!props.conversation) return false;
  const auxiliaryCosts =
    props.detail?.auxiliaryCosts ?? props.conversation.auxiliaryCosts;
  return Boolean(
    props.detail?.modelUsage?.length || auxiliaryCosts?.operations?.length,
  );
}

/**
 * Summarize usage and let the reader inspect the breakdown by agent, model,
 * and auxiliary operation.
 */
export function ConversationUsageBreakdown(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
}) {
  if (!hasConversationUsageBreakdown(props) || !props.conversation) {
    return null;
  }
  const modelUsage = props.detail?.modelUsage ?? [];
  const auxiliaryCosts =
    props.detail?.auxiliaryCosts ?? props.conversation.auxiliaryCosts;
  const usage =
    props.detail?.cumulativeUsage ?? props.conversation.cumulativeUsage;
  const childAgentTotals =
    props.detail?.childAgentTotals ?? props.conversation.childAgentTotals;
  const modelTokens = summarizeModelUsage(modelUsage);
  const savedTokens = summarizeUsage(usage);
  const tokens = (modelTokens ?? savedTokens)?.totalTokens;
  const modelCost = summarizeModelCost(modelUsage);
  const savedCost = summarizeCost(usage);
  const totalCost = totalConversationCost(
    modelCost ?? savedCost,
    auxiliaryCosts,
  );
  const cost = totalCost?.total;
  const operations = [...(auxiliaryCosts?.operations ?? [])].sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const formatCost = costFormatter(cost ?? 0);
  const formatTokens = (value: number | undefined) =>
    value === undefined ? NOT_RECORDED : formatCompactNumber(value);
  const formatMaybeCost = (value: number | undefined) =>
    value === undefined ? NOT_RECORDED : formatCost(value);
  const activeModelId = liveModelId(props.detail);
  const live = (props.detail?.status ?? props.conversation.status) === "active";
  const aggregateTokenTypes = tokenTypeParts(
    modelTokens ? undefined : savedTokens,
    modelCost ? undefined : savedCost,
    formatCost,
  );
  const compactions = props.detail?.previousCursor
    ? undefined
    : props.detail?.events.filter((event) => event.data.type === "compaction")
        .length;

  const models = modelUsage
    .map((item) => ({
      cost: summarizeCost(item.usage),
      modelId: item.modelId,
      tokens: summarizeUsage(item.usage),
    }))
    .sort(
      (a, b) =>
        (b.cost?.total ?? 0) - (a.cost?.total ?? 0) ||
        (b.tokens?.totalTokens ?? 0) - (a.tokens?.totalTokens ?? 0),
    );
  if (
    activeModelId &&
    !models.some((model) => model.modelId === activeModelId)
  ) {
    models.unshift({
      cost: undefined,
      modelId: activeModelId,
      tokens: undefined,
    });
  }

  const subagents = subagentUsage(childAgentTotals);
  const subagentCost = subagentShare(subagents.cost, cost ?? subagents.cost);
  const subagentTokens = subagentShare(
    subagents.tokens,
    tokens ?? subagents.tokens,
  );

  const breakdown = (
    <div className="grid min-w-0 gap-4 px-1 pb-1">
      {childAgentTotals ? (
        <BreakdownTable
          countLabel="Tokens"
          label="Agent"
          rows={[
            {
              cost: formatMaybeCost(
                cost === undefined ? undefined : cost - subagentCost,
              ),
              count: formatTokens(
                tokens === undefined ? undefined : tokens - subagentTokens,
              ),
              key: "self",
              label: "This agent",
            },
            {
              cost: formatCost(subagentCost),
              count: formatTokens(subagentTokens),
              key: "subagents",
              label: `${formatCompactNumber(childAgentTotals.count)} child conversation${childAgentTotals.count === 1 ? "" : "s"}`,
            },
          ]}
          total={{
            cost: formatMaybeCost(cost),
            count: formatTokens(tokens),
            label: "Total",
          }}
        />
      ) : null}
      {models.length ? (
        <BreakdownTable
          countLabel="Tokens"
          label="Model"
          rows={models.map(({ cost, modelId, tokens }) => {
            const active = modelId === activeModelId;
            return {
              cost: active && !cost ? "…" : formatMaybeCost(cost?.total),
              count:
                active && !tokens ? "…" : formatTokens(tokens?.totalTokens),
              key: modelId,
              label: (
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate font-mono" title={modelId}>
                    {modelLabel(modelId)}
                  </span>
                  {active ? (
                    <span className="shrink-0 text-dashboard-text-muted">
                      <ShimmerText active>in progress</ShimmerText>
                    </span>
                  ) : null}
                </span>
              ),
              parts: tokenTypeParts(tokens, cost, formatCost),
            };
          })}
          total={
            modelUsage.length > 1
              ? {
                  cost: formatMaybeCost(modelCost?.total),
                  count: formatTokens(modelTokens?.totalTokens),
                  label: "All models",
                }
              : undefined
          }
        />
      ) : null}
      {aggregateTokenTypes ? (
        <BreakdownTable
          countLabel="Tokens"
          label="Token type"
          rows={aggregateTokenTypes.map((part) => ({
            cost: part.cost ?? NOT_RECORDED,
            count: part.count,
            key: part.label,
            label: part.label,
          }))}
        />
      ) : null}
      {auxiliaryCosts && operations.length ? (
        <BreakdownTable
          countLabel="Calls"
          label="Auxiliary"
          rows={operations.map((operation) => ({
            cost: formatCost(operation.costUsd),
            count: formatCompactNumber(operation.events),
            key: `${operation.namespace}/${operation.name}`,
            label: auxiliaryOperationLabel(operation),
          }))}
          total={
            operations.length > 1
              ? {
                  cost: formatCost(auxiliaryCosts.costUsd),
                  count: formatCompactNumber(
                    operations.reduce((sum, item) => sum + item.events, 0),
                  ),
                  label: "All auxiliary",
                }
              : undefined
          }
        />
      ) : null}
      <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
        Estimated costs.
        {childAgentTotals
          ? " Totals include child conversations at any depth."
          : null}
        {compactions
          ? ` ${formatCompactNumber(compactions)} compaction${compactions === 1 ? "" : "s"}.`
          : null}
      </p>
    </div>
  );

  const summary = [
    tokens === undefined ? undefined : `${formatTokens(tokens)} tokens`,
    totalCost
      ? `${formatCostSummary(totalCost)}${live ? "+" : ""}`
      : live
        ? "$…"
        : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Collapsible className="min-w-0 border-t border-dashboard-border-subtle">
      <h3 className="m-0">
        <CollapsibleTrigger className="group flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-2 text-left font-sans text-xs font-semibold text-dashboard-text transition-colors hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus">
          <ChevronRight
            aria-hidden="true"
            className={cn(
              dashboardDisclosureChevronClass,
              "text-dashboard-text-muted",
            )}
          />
          Usage
          {summary ? (
            <span className="ml-auto font-normal tabular-nums text-dashboard-text-muted">
              <ShimmerText active={live}>{summary}</ShimmerText>
            </span>
          ) : null}
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent hiddenUntilFound>{breakdown}</CollapsibleContent>
    </Collapsible>
  );
}
