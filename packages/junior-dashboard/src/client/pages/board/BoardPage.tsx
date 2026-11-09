import type { BoardColumn } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import { useBoardData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { Skeleton } from "../../components/ui/skeleton";
import { BoardCard } from "./BoardCard";

const COLUMNS: { column: BoardColumn; title: string }[] = [
  { column: "planned", title: "Planned" },
  { column: "in_progress", title: "In progress" },
  { column: "ready", title: "Ready" },
  { column: "done", title: "Done" },
];

const DESCRIPTION = "Work linked to your Conversations.";

/** Show the viewer's code changes and tickets as a kanban Board. */
export function BoardPage() {
  const query = useBoardData();
  const cards = query.data?.cards;
  return (
    <PageLayout>
      <PageHeader description={DESCRIPTION} title="Board" />
      {query.error ? (
        <EmptyTelemetry>
          The Board is unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : (
        <div
          aria-busy={!cards}
          aria-label={cards ? undefined : "Loading the Board"}
          className="grid grid-cols-[repeat(4,minmax(16rem,1fr))] gap-4 overflow-x-auto pb-2"
          role={cards ? undefined : "status"}
        >
          {COLUMNS.map(({ column, title }) => {
            const columnCards = cards?.filter((card) => card.column === column);
            return (
              <BoardColumnView
                count={columnCards?.length}
                key={column}
                scope={
                  column === "done" && query.data
                    ? `Last ${query.data.doneWindowHours} hours`
                    : undefined
                }
                title={title}
              >
                {columnCards ? (
                  columnCards.map((card) => (
                    <BoardCard card={card} key={card.key} />
                  ))
                ) : (
                  <BoardColumnSkeleton />
                )}
              </BoardColumnView>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}

function BoardColumnView(props: {
  children: ReactNode;
  count?: number;
  scope?: string;
  title: string;
}) {
  return (
    <section aria-label={props.title} className="flex min-w-0 flex-col gap-3">
      <header className="flex items-baseline gap-2 px-1">
        <h2 className="font-display text-base font-medium text-dashboard-text">
          {props.title}
        </h2>
        {props.count !== undefined ? (
          <span className="text-xs font-medium tabular-nums text-dashboard-text-faint">
            {props.count}
          </span>
        ) : null}
        {props.scope ? (
          <span className="ml-auto text-xs text-dashboard-text-faint">
            {props.scope}
          </span>
        ) : null}
      </header>
      <div className="grid min-h-40 flex-1 content-start gap-2 rounded-xl bg-dashboard-fill-soft p-2">
        {props.children}
      </div>
    </section>
  );
}

/** Match a column of two cards while the Board loads. */
function BoardColumnSkeleton() {
  return [0, 1].map((index) => (
    <div
      className="grid gap-2.5 rounded-lg border border-dashboard-border bg-dashboard-surface-raised p-3"
      key={index}
    >
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <div className="flex items-center gap-2 border-t border-dashboard-border-subtle pt-2.5">
        <Skeleton className="h-3.5 flex-1" />
        <Skeleton className="size-6 rounded-full" />
      </div>
    </div>
  ));
}
