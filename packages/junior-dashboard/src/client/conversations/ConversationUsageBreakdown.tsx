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

const CELL = "text-right align-top font-sans tabular-nums";

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
    <div className="min-w-0 overflow-x-auto">
      <table
        aria-label={props.label}
        className="w-full min-w-72 table-fixed border-collapse text-xs leading-relaxed"
      >
        <colgroup>
          <col />
          <col className="w-20" />
          <col className="w-20" />
        </colgroup>
        <thead>
          <tr className="border-b border-dashboard-border text-dashboard-text-muted">
            <th scope="col" className="py-2 text-left font-normal">
              {props.label}
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              {props.countLabel}
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              Cost
            </th>
          </tr>
        </thead>
        {props.rows.map((row) => (
          <tbody
            className="border-b border-dashboard-border-subtle last-of-type:border-b-0"
            key={row.key}
          >
            <tr className="text-dashboard-text">
              <th
                scope="row"
                className={`pr-3 text-left font-normal ${row.parts ? "pt-2 pb-0.5" : "py-2"}`}
              >
                <span className="block truncate">{row.label}</span>
              </th>
              <td className={`${CELL} ${row.parts ? "pt-2 pb-0.5" : "py-2"}`}>
                {row.count}
              </td>
              <td className={`${CELL} ${row.parts ? "pt-2 pb-0.5" : "py-2"}`}>
                {row.cost}
              </td>
            </tr>
            {row.parts?.map((part, index, parts) => {
              const padding = index === parts.length - 1 ? "pb-2" : "";
              return (
                <tr
                  className="text-[11px] leading-5 text-dashboard-text-faint"
                  key={part.label}
                >
                  <th
                    scope="row"
                    className={`truncate pl-3 pr-3 text-left font-normal ${padding}`}
                  >
                    {part.label}
                  </th>
                  <td className={`${CELL} ${padding}`}>{part.count}</td>
                  <td className={`${CELL} ${padding}`}>{part.cost}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
        {props.total ? (
          <tfoot>
            <tr className="border-t border-dashboard-border font-semibold text-dashboard-text">
              <th scope="row" className="py-2 text-left font-semibold">
                {props.total.label}
              </th>
              <td className="py-2 text-right font-sans tabular-nums">
                {props.total.count}
              </td>
              <td className="py-2 text-right font-sans tabular-nums">
                {props.total.cost}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
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
  if (!props.conversation) return null;
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
  if (!modelUsage.length && !operations.length) return null;

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
