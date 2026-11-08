import type { ConversationUsage } from "@sentry/junior/api/schema";

import { formatCostBreakdown, summarizeCost } from "../format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableFooter,
  TableHeader,
  TableRow,
} from "../components/ui/table";
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

  const total = rows.find((row) => row.label === "Total");
  return (
    <>
      <Table
        aria-label="Model call token and cost breakdown"
        className="min-w-72 table-fixed text-xs leading-relaxed"
      >
        <colgroup>
          <col />
          <col className="w-24" />
          <col className="w-24" />
        </colgroup>
        <TableHeader>
          <TableRow className="border-dashboard-border">
            <TableHead
              scope="col"
              className="px-0 py-2 leading-relaxed font-normal"
            >
              Usage
            </TableHead>
            <TableHead
              scope="col"
              className="px-0 py-2 text-right leading-relaxed font-normal"
            >
              Tokens
            </TableHead>
            <TableHead
              scope="col"
              className="px-0 py-2 text-right leading-relaxed font-normal"
            >
              Cost (USD)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows
            .filter((row) => row !== total)
            .map((row) => (
              <UsageRow key={row.label} {...row} />
            ))}
        </TableBody>
        {total ? (
          <TableFooter className="font-semibold">
            <UsageRow {...total} total />
          </TableFooter>
        ) : null}
      </Table>
      <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
        This call only · Estimated costs
        <br />
        Input excludes cache reads and writes. Reasoning is included in output.
      </p>
    </>
  );
}

function UsageRow(props: {
  cost?: number;
  label: string;
  tokens?: number;
  total?: boolean;
}) {
  return (
    <TableRow>
      <TableHead
        scope="row"
        className={cn(
          "px-0 py-2 leading-relaxed",
          props.total
            ? "font-semibold text-dashboard-text"
            : "font-normal text-dashboard-text-muted",
        )}
      >
        {props.label}
      </TableHead>
      <TableCell className="px-0 py-2 text-right font-sans tabular-nums">
        {props.tokens === undefined ? (
          <span aria-label="Not recorded" className="text-dashboard-text-faint">
            —
          </span>
        ) : (
          props.tokens.toLocaleString("en-US")
        )}
      </TableCell>
      <TableCell className="px-0 py-2 text-right font-sans tabular-nums">
        {props.cost === undefined ? (
          <span
            aria-label="Not recorded separately"
            className="text-dashboard-text-faint"
          >
            —
          </span>
        ) : (
          <span title={`${props.cost} USD`}>
            {formatCostBreakdown({ total: props.cost })}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
