import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";
import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { useActorOpenCodeChanges, useDashboardCoreData } from "../api";
import { SidebarAnnotationIcon } from "../conversations/ConversationMeta";
import { IdleText, lastActivity } from "../conversations/codeChangeIdle";
import { cn } from "../styles";
import { inboxCardClass } from "./inboxRowStyles";
import type { InboxFeedPages } from "./inboxData";
import type { InboxBundle } from "./reviewItemFormat";

/** One open code change, with the pull request asks that name it. */
export type PullRequestChangeRow = {
  change: CodeChangeSummaryReport;
  items: InboxBundle[];
};

/** One group of the Pull requests view. */
export type PullRequestSection = {
  changes: PullRequestChangeRow[];
  /** The pile starts collapsed until the viewer opens it. */
  collapsedByDefault?: boolean;
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

const byActivity = (a: PullRequestChangeRow, b: PullRequestChangeRow) =>
  lastActivity(b.change).localeCompare(lastActivity(a.change));

/**
 * Sort the viewer's open code changes and the pull request asks into three
 * piles. Waiting on you: changes with an ask that waits on the viewer,
 * longest wait first, and such asks that name no open change of theirs.
 * Waiting on others: every other open change, waiting on a reviewer, CI or
 * Junior, newest activity first, and the other asks, so nothing gets lost.
 * Drafts: draft changes with their asks, newest activity first, collapsed.
 * Empty piles drop out.
 */
export function pullRequestSections(
  changes: readonly CodeChangeSummaryReport[],
  itemRows: readonly InboxBundle[],
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
  const drafts = rows.filter((row) => row.change.draft).sort(byActivity);
  const ready = rows.filter((row) => !row.change.draft);
  const waiting = ready
    .filter((row) => row.items.some((item) => item.needsYou))
    .sort((a, b) => waitedSince(a) - waitedSince(b));
  const others = ready.filter((row) => !waiting.includes(row)).sort(byActivity);
  return [
    {
      changes: waiting,
      items: loose.filter((row) => row.needsYou),
      key: "pr-waiting",
      label: "Waiting on you",
    },
    {
      changes: others,
      items: loose.filter((row) => !row.needsYou),
      key: "pr-others",
      label: "Waiting on others",
    },
    {
      changes: drafts,
      collapsedByDefault: true,
      items: [],
      key: "pr-drafts",
      label: "Drafts",
    },
  ].filter((section) => section.changes.length + section.items.length > 0);
}

/**
 * Read the Pull requests view: every open code change of the viewer, from
 * their person Code overview, grouped with the pull request asks. The pages
 * of both load one after another only while the view is open, so each ask
 * finds its change wherever the list is scrolled.
 */
export function usePullRequestSections(
  itemRows: readonly InboxBundle[],
  asks: InboxFeedPages,
  enabled: boolean,
) {
  const email = useDashboardCoreData().data?.me.user.email;
  const code = useActorOpenCodeChanges(enabled ? email : undefined);
  const { fetchNextPage, hasNextPage, isFetchNextPageError, isFetching } = code;
  // A failed page stops the paging; the loaded changes still show.
  useEffect(() => {
    if (enabled && hasNextPage && !isFetching && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [enabled, fetchNextPage, hasNextPage, isFetchNextPageError, isFetching]);
  // Every page of asks loads too, so no change waits apart from its ask. A
  // failed page waits for the list's Try again.
  const asksLeft = enabled && asks.hasMore && !asks.loadingMore && !asks.failed;
  useEffect(() => {
    if (asksLeft) asks.loadMore();
  }, [asks, asksLeft]);
  // Signed out, or before the overview loads, the asks show on their own.
  const pages = code.data?.pages ?? [];
  const changes = pages.flatMap((page) => page.changes);
  const nowMs = pages[0] ? Date.parse(pages[0].generatedAt) : Date.now();
  return {
    loading: enabled && Boolean(email) && code.isPending,
    nowMs,
    sections: pullRequestSections(changes, itemRows),
  };
}

/**
 * One open code change: its pull request, which opens on the code host, and
 * under it the asks that name it, as `children`.
 */
export function PullRequestChange(props: {
  children?: ReactNode;
  /** One of its asks is open, so the dock leaves the change still. */
  expanded: boolean;
  nowMs: number;
  row: PullRequestChangeRow;
}) {
  const { change } = props.row;
  const title = change.title ?? `${change.repository} #${change.number}`;
  return (
    <li
      aria-label={title}
      className="grid list-none gap-1.5"
      data-expanded={props.expanded || undefined}
    >
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
