import type { ConversationUsage } from "@sentry/junior/api/schema";

import { formatCostBreakdown, summarizeCost } from "../format";
import { cn } from "../styles";

/** Align recorded token counts with their costs without adding overlapping counters. */
export function EventUsage({ usage }: { usage?: ConversationUsage }) {
  const cost = summarizeCost(usage);
  const rows = [
    { label: "Input", tokens: usage?.inputTokens, cost: usage?.cost?.input },
    { label: "Output", tokens: usage?.outputTokens, cost: usage?.cost?.output },
    {
      label: "Cache read",
      tokens: usage?.cachedInputTokens,
      cost: usage?.cost?.cacheRead,
    },
    {
      label: "Cache write",
      tokens: usage?.cacheCreationTokens,
      cost: usage?.cost?.cacheWrite,
    },
    { label: "Reasoning", tokens: usage?.reasoningTokens },
    { label: "Total", tokens: usage?.totalTokens, cost: cost?.total },
  ].filter((row) => row.tokens !== undefined || row.cost !== undefined);

  if (rows.length === 0) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted">
        Token usage and cost were not recorded for this call.
      </p>
    );
  }

  return (
    <>
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label="Model call token and cost breakdown"
          className="w-full min-w-72 table-fixed border-collapse text-xs leading-relaxed"
        >
          <colgroup>
            <col />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <thead>
            <tr className="border-b border-dashboard-border text-dashboard-text-muted">
              <th scope="col" className="py-2 text-left font-normal">
                Usage
              </th>
              <th scope="col" className="py-2 text-right font-normal">
                Tokens
              </th>
              <th scope="col" className="py-2 text-right font-normal">
                Cost (USD)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className={cn(
                  "border-b border-dashboard-border-subtle last:border-b-0",
                  row.label === "Total" &&
                    "border-t border-dashboard-border font-semibold",
                )}
              >
                <th
                  scope="row"
                  className={cn(
                    "py-2 text-left font-normal",
                    row.label === "Total"
                      ? "font-semibold text-dashboard-text"
                      : "text-dashboard-text-muted",
                  )}
                >
                  {row.label}
                </th>
                <td className="py-2 text-right font-mono tabular-nums text-dashboard-text">
                  {row.tokens === undefined ? (
                    <span
                      aria-label="Not recorded"
                      className="text-dashboard-text-faint"
                    >
                      —
                    </span>
                  ) : (
                    row.tokens.toLocaleString("en-US")
                  )}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-dashboard-text">
                  {row.cost === undefined ? (
                    <span
                      aria-label="Not recorded separately"
                      className="text-dashboard-text-faint"
                    >
                      —
                    </span>
                  ) : (
                    <span title={`${row.cost} USD`}>
                      {formatCostBreakdown({ total: row.cost })}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
        This call only · Estimated costs
        <br />
        Input excludes cache reads and writes. Reasoning is included in output.
      </p>
    </>
  );
}
