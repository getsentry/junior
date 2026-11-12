import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { useActorCodeData, useDashboardCoreData } from "../api";
import { SidebarAnnotationIcon } from "../conversations/ConversationMeta";
import {
  IdleText,
  isIdleChange,
  lastActivity,
} from "../conversations/codeChangeIdle";
import { cn } from "../styles";
import { inboxCardClass } from "./inboxRowStyles";
import type { InboxBundle } from "./reviewItemFormat";

/** One open code change, with the pull request asks that name it. */
export type PullRequestChangeRow = {
  change: CodeChangeSummaryReport;
  items: InboxBundle[];
};

/** One group of the Pull requests view. */
export type PullRequestSection = {
  changes: PullRequestChangeRow[];
  /** Pull request asks that name no open change of the viewer's. */
  items: InboxBundle[];
  key: string;
  label: string;
};

const sameUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();

const waitedSince = (row: PullRequestChangeRow) =>
  Math.min(
    ...row.items
      .filter((item) => item.needsYou)
      .map((item) => Date.parse(item.waitingSince)),
  );

/**
 * Group the viewer's open code changes with the pull request asks. A change
 * with an ask that waits on the viewer comes first, longest wait first; then
 * idle changes, longest idle first; then the rest, newest activity first.
 * An ask whose pull request is not an open change of the viewer's still
 * shows, so nothing gets lost. Empty groups drop out.
 */
export function pullRequestSections(
  changes: readonly CodeChangeSummaryReport[],
  itemRows: readonly InboxBundle[],
  nowMs: number,
): PullRequestSection[] {
  const rows = changes
    .filter((change) => change.state === "open")
    .map(
      (change): PullRequestChangeRow => ({
        change,
        items: change.url
          ? itemRows.filter(
              (row) =>
                row.newest.subject?.url &&
                sameUrl(row.newest.subject.url) === sameUrl(change.url!),
            )
          : [],
      }),
    );
  const attached = new Set(rows.flatMap((row) => row.items));
  const loose = itemRows.filter((row) => !attached.has(row));
  const waiting = rows
    .filter((row) => row.items.some((item) => item.needsYou))
    .sort((a, b) => waitedSince(a) - waitedSince(b));
  const rest = rows.filter((row) => !waiting.includes(row));
  const idle = rest
    .filter((row) => isIdleChange(nowMs, row.change))
    .sort((a, b) =>
      lastActivity(a.change).localeCompare(lastActivity(b.change)),
    );
  const moving = rest
    .filter((row) => !idle.includes(row))
    .sort((a, b) =>
      lastActivity(b.change).localeCompare(lastActivity(a.change)),
    );
  return [
    {
      changes: waiting,
      items: loose.filter((row) => row.needsYou),
      key: "pr-waiting",
      label: "Waiting on you",
    },
    { changes: idle, items: [], key: "pr-idle", label: "Idle" },
    { changes: moving, items: [], key: "pr-open", label: "Open" },
    {
      changes: [],
      items: loose.filter((row) => !row.needsYou),
      key: "pr-other",
      label: "Other",
    },
  ].filter((section) => section.changes.length + section.items.length > 0);
}

/**
 * Read the Pull requests view: the viewer's open code changes from their
 * person Code overview, grouped with the pull request asks. The overview
 * lists at most 100 changes, open ones first, so past 100 open changes the
 * view shows the first 100. It has no paging.
 */
export function usePullRequestSections(
  itemRows: readonly InboxBundle[],
  enabled: boolean,
) {
  const email = useDashboardCoreData().data?.me.user.email;
  // The same query as the home summary, so the two share one read.
  const code = useActorCodeData(enabled ? email : undefined);
  // Signed out, or before the overview loads, the asks show on their own.
  const changes = code.data?.changes ?? [];
  const nowMs = code.data ? Date.parse(code.data.generatedAt) : Date.now();
  return {
    loading: enabled && Boolean(email) && code.isPending,
    nowMs,
    sections: pullRequestSections(changes, itemRows, nowMs),
  };
}

/**
 * One open code change: its pull request, which opens on the code host, and
 * under it the asks that name it, as `children`.
 */
export function PullRequestChange(props: {
  children?: ReactNode;
  nowMs: number;
  row: PullRequestChangeRow;
}) {
  const { change } = props.row;
  const title = change.title ?? `${change.repository} #${change.number}`;
  return (
    <li aria-label={title} className="grid list-none gap-1.5">
      <div
        className={cn(
          inboxCardClass(false),
          "flex min-w-0 items-center justify-between gap-4 px-4 py-2.5 font-sans",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-dashboard-text">
          <SidebarAnnotationIcon decorative icon="git-pull-request" size={14} />
          {change.url ? (
            <a
              className="inline-flex min-w-0 items-center gap-1.5 text-inherit no-underline hover:underline"
              href={change.url}
              rel="noreferrer"
              target="_blank"
            >
              <span className="truncate">{title}</span>
              <ArrowUpRight aria-hidden="true" className="shrink-0" size={14} />
            </a>
          ) : (
            <span className="truncate">{title}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs text-dashboard-text-muted">
          <span className="hidden sm:inline">
            {change.repository}{" "}
            <span className="tabular-nums">#{change.number}</span>
          </span>
          <span className="w-10 text-right tabular-nums">
            <IdleText change={change} nowMs={props.nowMs} />
          </span>
        </div>
      </div>
      {props.children ? (
        <ul className="m-0 grid gap-2 p-0 pl-6">{props.children}</ul>
      ) : null}
    </li>
  );
}
