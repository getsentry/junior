import type {
  ConversationDetailReport,
  ConversationModelUsage,
} from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import {
  formatCompactNumber,
  summarizeCost,
  summarizeModelCost,
  summarizeModelUsage,
  summarizeUsage,
  totalConversationCost,
} from "../format";
import { ShimmerText } from "../components/ShimmerText";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { liveModelId } from "./ConversationMeta";
import {
  auxiliaryOperationLabel,
  costFormatter,
  modelLabel,
  subagentShare,
  subagentUsage,
  tokenTypeRows,
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
 * List each recorded token type of one model with its own count and, when
 * the provider reports it, its own cost. Reasoning tokens are part of the
 * output tokens, so they have no cost of their own.
 */
function tokenTypeParts(
  usage: ConversationModelUsage["usage"],
  formatCost: (value: number) => string,
): BreakdownPart[] | undefined {
  const summary = summarizeUsage(usage);
  if (!summary) return undefined;
  const cost = summarizeCost(usage);
  const costs: Readonly<Record<string, number | undefined>> = {
    cached: cost?.cacheRead,
    "cache write": cost?.cacheWrite,
    input: cost?.input,
    output: cost?.output,
  };
  const parts = tokenTypeRows(summary).map((row) => {
    const value = costs[row.label];
    return {
      cost: value === undefined ? undefined : formatCost(value),
      count: row.value,
      label: row.label === "reasoning" ? "reasoning (in output)" : row.label,
    };
  });
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
 * Break a Conversation's usage down by agent, model, and auxiliary
 * operation. The header tooltips show only the largest items; this lists
 * every one with its token types. Render nothing without model or auxiliary
 * usage.
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
  const tokens =
    summarizeModelUsage(modelUsage)?.totalTokens ??
    summarizeUsage(usage)?.totalTokens;
  const modelCost = summarizeModelCost(modelUsage) ?? summarizeCost(usage);
  const cost = totalConversationCost(modelCost, auxiliaryCosts)?.total;
  const operations = [...(auxiliaryCosts?.operations ?? [])].sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const formatCost = costFormatter(cost ?? 0);
  const formatTokens = (value: number | undefined) =>
    value === undefined ? NOT_RECORDED : formatCompactNumber(value);
  const formatMaybeCost = (value: number | undefined) =>
    value === undefined ? NOT_RECORDED : formatCost(value);
  const activeModelId = liveModelId(props.detail);

  const models = modelUsage
    .map((item) => ({
      cost: summarizeCost(item.usage)?.total,
      item,
      tokens: summarizeUsage(item.usage)?.totalTokens,
    }))
    .sort(
      (a, b) =>
        (b.cost ?? 0) - (a.cost ?? 0) || (b.tokens ?? 0) - (a.tokens ?? 0),
    );

  const subagents = subagentUsage(childAgentTotals);
  const subagentCost = subagentShare(subagents.cost, cost ?? subagents.cost);
  const subagentTokens = subagentShare(
    subagents.tokens,
    tokens ?? subagents.tokens,
  );

  return (
    <div className="grid min-w-0 gap-5">
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
              label: `${formatCompactNumber(childAgentTotals.count)} subagent${childAgentTotals.count === 1 ? "" : "s"}`,
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
          rows={models.map(({ cost: itemCost, item, tokens: itemTokens }) => ({
            cost: formatMaybeCost(itemCost),
            count: formatTokens(itemTokens),
            key: item.modelId,
            label: (
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className="min-w-0 truncate font-mono"
                  title={item.modelId}
                >
                  {modelLabel(item.modelId)}
                </span>
                {item.modelId === activeModelId ? (
                  <span className="shrink-0 text-dashboard-text-muted">
                    <ShimmerText active>in progress</ShimmerText>
                  </span>
                ) : null}
              </span>
            ),
            parts: tokenTypeParts(item.usage, formatCost),
          }))}
          total={
            models.length > 1
              ? {
                  cost: formatMaybeCost(modelCost?.total),
                  count: formatTokens(tokens),
                  label: "All models",
                }
              : undefined
          }
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
        {childAgentTotals ? " Totals include subagents at any depth." : null}
      </p>
    </div>
  );
}
