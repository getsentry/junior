import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Card } from "../../components/layout/Card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { CodeChangeRow } from "./CodeChangeRow";
import { formatCodeCost, formatMergeRate } from "./CodeSummaryCards";
import { codeRepositoryPath } from "./codeRepositoryRoutes";

/** Every repository with code changes, with its numbers. */
export function CodeRepositoriesCard(props: {
  repositories: CodeOverviewReport["repositories"];
}) {
  return (
    <Card as="section">
      <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
        Repositories
      </div>
      {props.repositories.length === 0 ? (
        <div className="p-4">
          <EmptyTelemetry>
            No code activity has been recorded yet.
          </EmptyTelemetry>
        </div>
      ) : (
        <Table className="min-w-[36rem] table-fixed">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-28" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Repository</TableHead>
              <TableHead className="px-4 text-right">Created</TableHead>
              <TableHead className="px-4 text-right">Merge rate</TableHead>
              <TableHead className="px-4 text-right">Median cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.repositories.map((repository) => (
              <TableRow key={repository.id}>
                <TableCell className="min-w-0 px-4 py-3">
                  <div className="truncate font-display text-sm text-dashboard-text">
                    <Link
                      className="text-inherit no-underline hover:text-dashboard-accent-text"
                      to={codeRepositoryPath(repository.id)}
                    >
                      {repository.name}
                    </Link>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
                    {repository.provider}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {repository.created}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {formatMergeRate(repository.mergeRate)}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {formatCodeCost(repository.medianCostUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** The newest code changes, when there are any. */
export function CodeRecentChanges(props: {
  changes: CodeOverviewReport["changes"];
}) {
  if (props.changes.length === 0) return null;
  return (
    <Card as="section">
      <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
        Recent changes
      </div>
      <div>
        {props.changes.map((change) => (
          <CodeChangeRow change={change} key={change.id} />
        ))}
      </div>
    </Card>
  );
}
