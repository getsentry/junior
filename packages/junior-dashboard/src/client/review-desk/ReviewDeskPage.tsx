import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { AutomationSummary } from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { LoadMorePagination } from "../components/Pagination";
import { SearchInput } from "../components/SearchInput";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { ChatLayout } from "../conversations/ChatLayout";
import { ConversationSectionHeading } from "../conversations/ConversationSectionHeading";
import { conversationPath } from "../conversations/conversationRoutes";
import { useDocumentTitle } from "../documentTitle";
import { automationPath, formatRelativeTime } from "../format";
import { useDebouncedSearchParam } from "../searchParams";
import { cn } from "../styles";
import { InboxBundleView } from "./InboxBundleView";
import { snoozeChoices, useInboxSnoozes } from "./inboxSnooze";
import {
  useBlockedAutomationsData,
  useLinkedConversationTitles,
  useReviewItemAction,
  useReviewItemData,
  useReviewItemsData,
} from "./queries";
import { inboxBundles, type InboxBundle } from "./reviewItemFormat";
import { useInboxKeys } from "./useInboxKeys";

type SectionKey = "blocked" | "fyi" | "needs-you" | "snoozed";

const KEY_HINTS = [
  ["j k", "move"],
  ["Enter", "open"],
  ["e", "done"],
  ["h", "snooze"],
  ["r", "reply"],
  ["o", "conversation"],
] as const;

function BundleRowsLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid gap-1"
      role="status"
    >
      <span className="sr-only">Loading review items</span>
      {[0, 1, 2, 3, 4].map((row) => (
        <div className="grid gap-1.5 px-4 py-3" key={row}>
          <Skeleton className={cn("h-4", row % 2 ? "w-2/5" : "w-3/5")} />
          <Skeleton className="h-3 w-4/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}

/** Keep the inbox frame while the dashboard shell loads. */
export function ReviewDeskLoading() {
  return (
    <div className="mx-auto w-full max-w-[52.5rem] px-4 pt-5 md:px-7">
      <Skeleton className="mb-4 h-6 w-20" />
      <BundleRowsLoading />
    </div>
  );
}

function Section(props: {
  children: ReactNode;
  collapsed: boolean;
  count: number;
  label: string;
  onToggle(): void;
}) {
  if (props.count === 0) return null;
  return (
    <section aria-label={props.label} className="grid gap-0.5">
      <ConversationSectionHeading
        className="px-4 pb-1 pt-4"
        collapsed={props.collapsed}
        count={props.count}
        label={props.label}
        onToggle={props.onToggle}
      />
      {props.collapsed ? null : (
        <ul className="m-0 grid gap-0.5 p-0">{props.children}</ul>
      )}
    </section>
  );
}

function BlockedAutomationRow(props: { automation: AutomationSummary }) {
  return (
    <li className="list-none">
      <Link
        className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-x-3 rounded-xl px-4 py-3 font-sans text-inherit no-underline hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        to={automationPath(props.automation.id)}
      >
        <span
          aria-hidden="true"
          className="mt-[0.4rem] size-2 justify-self-center rounded-full bg-amber-300"
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium text-dashboard-text">
            {props.automation.title}
          </span>
          <span className="truncate text-xs text-dashboard-text-muted">
            {props.automation.statusReason ?? "Blocked"}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Render the inbox as one triage queue, one bundle per Conversation. A
 * bundle expands in place, where the viewer answers, marks it done, or
 * snoozes it, then moves on to the next one. Keys follow Gmail and Linear.
 */
export function ReviewDeskPage() {
  useDocumentTitle("Inbox");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch, q] = useDebouncedSearchParam();
  const {
    items: list,
    moreArchived,
    query: items,
  } = useReviewItemsData({
    forViewer: true,
    q,
  });
  const showBlocked = !q;
  const blocked = useBlockedAutomationsData(showBlocked);
  const blockedAutomations = showBlocked
    ? (blocked.data?.automations ?? [])
    : [];

  // A link can name an item that is not open, such as an answered one.
  const itemParam = searchParams.get("item") ?? undefined;
  const listed = list.some((item) => item.id === itemParam);
  const direct = useReviewItemData(listed ? undefined : itemParam);
  // An open item that left the list was just closed; its cached copy is old.
  const linked = direct.data?.status === "open" ? undefined : direct.data;
  const all = useMemo(
    () =>
      inboxBundles(
        linked && !list.some((item) => item.id === linked.id)
          ? [linked, ...list]
          : list,
      ),
    [linked, list],
  );

  const nowMs = Date.now();
  const snoozes = useInboxSnoozes(nowMs);
  // A search shows every match, snoozed or not.
  const queue = q ? all : all.filter((bundle) => !snoozes.isSnoozed(bundle));
  const snoozed = q ? [] : all.filter((bundle) => snoozes.isSnoozed(bundle));
  const needsYou = queue.filter((bundle) => bundle.needsYou);
  const fyi = queue.filter((bundle) => !bundle.needsYou);

  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(
    () => new Set(["snoozed"]),
  );
  const toggleSection = (key: SectionKey) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const navigable = [
    ...(collapsed.has("needs-you") ? [] : needsYou),
    ...(collapsed.has("fyi") ? [] : fyi),
  ];

  const titles = useLinkedConversationTitles(
    all.map((bundle) => bundle.conversationId),
  );
  const titleOf = (bundle: InboxBundle) =>
    titles[all.indexOf(bundle)] ?? undefined;

  const linkedKey = itemParam
    ? all.find((bundle) => bundle.items.some((item) => item.id === itemParam))
        ?.conversationId
    : undefined;
  const [expandedKey, setExpandedKey] = useState<string>();
  const [activeKey, setActiveKey] = useState<string>();
  const [snoozeMenuKey, setSnoozeMenuKey] = useState<string>();
  const [replyKey, setReplyKey] = useState<string>();
  // A link opens its bundle once it loads.
  useEffect(() => {
    if (!linkedKey) return;
    setExpandedKey(linkedKey);
    setActiveKey(linkedKey);
  }, [linkedKey]);

  const action = useReviewItemAction();
  const done = async (bundle: InboxBundle) => {
    // Done closes every item that the viewer can close. One at a time, so
    // a failure leaves the rest open. The failure shows from `action`.
    for (const item of bundle.items) {
      if (item.status !== "open" || !item.canAct) continue;
      const closed = await action
        .mutateAsync({ body: { action: "dismiss" }, id: item.id })
        .then(
          () => true,
          () => false,
        );
      if (!closed) return;
    }
  };

  // When the open bundle leaves the queue (answered, done, or snoozed), open
  // the bundle that took its place, so the reader moves straight on.
  const [lastExpanded, setLastExpanded] = useState<{
    index: number;
    key: string;
  }>();
  const [focusKey, setFocusKey] = useState<string>();
  const expandedIndex = navigable.findIndex(
    (bundle) => bundle.conversationId === expandedKey,
  );
  if (
    expandedKey &&
    expandedIndex >= 0 &&
    (lastExpanded?.key !== expandedKey || lastExpanded.index !== expandedIndex)
  ) {
    setLastExpanded({ index: expandedIndex, key: expandedKey });
  } else if (
    expandedKey &&
    expandedIndex === -1 &&
    lastExpanded?.key === expandedKey
  ) {
    const next = navigable[Math.min(lastExpanded.index, navigable.length - 1)];
    setLastExpanded(undefined);
    setExpandedKey(next?.conversationId);
    setActiveKey(next?.conversationId);
    setFocusKey(next?.conversationId ?? "");
  }
  useEffect(() => {
    if (focusKey === undefined) return;
    if (focusKey) focusBundle(focusKey);
    setFocusKey(undefined);
    // The linked item is done, so a link must not bring it back.
    setSearchParams(
      (params) => {
        params.delete("item");
        return params;
      },
      { replace: true },
    );
  }, [focusKey, setSearchParams]);

  // `r` opens the bundle first, so focus its answer after it renders.
  useEffect(() => {
    if (!replyKey || replyKey !== expandedKey) return;
    const area = document.querySelector(
      `[data-inbox-answer="${CSS.escape(replyKey)}"]`,
    );
    area
      ?.querySelector<HTMLElement>(
        "[data-inbox-item] :is(textarea, input:not([type='hidden']), button)",
      )
      ?.focus();
    setReplyKey(undefined);
  }, [expandedKey, replyKey]);

  const active =
    navigable.find((bundle) => bundle.conversationId === activeKey) ??
    navigable[0];
  const toggle = (bundle: InboxBundle) => {
    setActiveKey(bundle.conversationId);
    setSnoozeMenuKey(undefined);
    setExpandedKey((current) =>
      current === bundle.conversationId ? undefined : bundle.conversationId,
    );
  };
  useInboxKeys({
    move(step) {
      if (navigable.length === 0) return;
      // The first key press only shows where the reader is.
      const index = activeKey && active ? navigable.indexOf(active) + step : 0;
      const next =
        navigable[Math.max(0, Math.min(navigable.length - 1, index))]!;
      setActiveKey(next.conversationId);
      focusBundle(next.conversationId);
    },
    toggle() {
      if (active) toggle(active);
    },
    done() {
      if (active) void done(active);
    },
    snoozeMenu() {
      if (!active) return;
      setExpandedKey(active.conversationId);
      setSnoozeMenuKey((current) =>
        current === active.conversationId ? undefined : active.conversationId,
      );
    },
    snoozeChoice(index) {
      const choice = snoozeChoices[index];
      if (!active || !choice || snoozeMenuKey !== active.conversationId) {
        return false;
      }
      snoozes.snooze(active, choice);
      setSnoozeMenuKey(undefined);
      return true;
    },
    escape() {
      if (snoozeMenuKey) {
        setSnoozeMenuKey(undefined);
        return true;
      }
      if (!expandedKey) return false;
      setExpandedKey(undefined);
      return true;
    },
    open() {
      if (!active) return;
      navigate(
        conversationPath(active.conversationId, {
          turnId: active.newest.addedByTurnId,
        }),
      );
    },
    reply() {
      if (!active) return;
      setExpandedKey(active.conversationId);
      setReplyKey(active.conversationId);
    },
  });

  const loaded = Boolean(items.data);
  const empty =
    loaded && !q && queue.length === 0 && blockedAutomations.length === 0;
  const bundleView = (bundle: InboxBundle) => (
    <InboxBundleView
      active={bundle === active}
      bundle={bundle}
      donePending={action.isPending}
      expanded={bundle.conversationId === expandedKey}
      key={bundle.conversationId}
      onActivate={() => setActiveKey(bundle.conversationId)}
      onDone={() => void done(bundle)}
      onSnooze={(choice) => {
        snoozes.snooze(bundle, choice);
        setSnoozeMenuKey(undefined);
      }}
      onSnoozeMenu={(open) =>
        setSnoozeMenuKey(open ? bundle.conversationId : undefined)
      }
      onToggle={() => toggle(bundle)}
      snoozeMenuOpen={snoozeMenuKey === bundle.conversationId}
      title={titleOf(bundle)}
    />
  );

  return (
    <ChatLayout
      header={
        <header className="border-b border-dashboard-border bg-dashboard-bg">
          <div className="mx-auto grid w-full max-w-[52.5rem] gap-3 px-4 py-3 md:px-7 md:py-5">
            <div className="flex min-w-0 items-baseline justify-between gap-4">
              <h2 className="m-0 font-display text-xl font-medium leading-tight tracking-tight">
                Inbox
              </h2>
              <p
                aria-label="Keyboard shortcuts"
                className="m-0 flex flex-wrap justify-end gap-x-3 gap-y-1 font-sans text-xs text-dashboard-text-faint max-md:hidden"
              >
                {KEY_HINTS.map(([keys, label]) => (
                  <span key={label}>
                    <kbd className="font-sans text-dashboard-text-muted">
                      {keys}
                    </kbd>{" "}
                    {label}
                  </span>
                ))}
              </p>
            </div>
            <SearchInput
              label="Search review items"
              onChange={setSearch}
              placeholder="Search items…"
              size="compact"
              value={search}
            />
          </div>
        </header>
      }
      scrollAriaLabel="Inbox"
      scrollClassName="px-2 pb-6 md:px-5"
      scroll={
        <div className="mx-auto grid w-full min-w-0 max-w-[52.5rem] pt-2">
          {action.isError ? (
            <InlineError className="px-4 py-2">
              Could not close every item. Try again.
            </InlineError>
          ) : null}
          {items.error && !items.data ? (
            <InlineError className="px-4 py-3">
              Could not load review items.
            </InlineError>
          ) : !loaded ? (
            <BundleRowsLoading />
          ) : q ? (
            <ul aria-label="Search results" className="m-0 grid gap-0.5 p-0">
              {all.map(bundleView)}
            </ul>
          ) : (
            <>
              <Section
                collapsed={collapsed.has("needs-you")}
                count={needsYou.length}
                label="Needs you"
                onToggle={() => toggleSection("needs-you")}
              >
                {needsYou.map(bundleView)}
              </Section>
              <Section
                collapsed={collapsed.has("fyi")}
                count={fyi.length}
                label="FYI"
                onToggle={() => toggleSection("fyi")}
              >
                {fyi.map(bundleView)}
              </Section>
              <Section
                collapsed={collapsed.has("blocked")}
                count={blockedAutomations.length}
                label="Blocked automations"
                onToggle={() => toggleSection("blocked")}
              >
                {blockedAutomations.map((automation) => (
                  <BlockedAutomationRow
                    automation={automation}
                    key={automation.id}
                  />
                ))}
              </Section>
              <Section
                collapsed={collapsed.has("snoozed")}
                count={snoozed.length}
                label="Snoozed"
                onToggle={() => toggleSection("snoozed")}
              >
                {snoozed.map((bundle) => (
                  <li
                    className="flex min-w-0 list-none items-center gap-3 px-4 py-2"
                    key={bundle.conversationId}
                  >
                    <span className="min-w-0 flex-1 truncate font-sans text-sm text-dashboard-text-muted">
                      {titleOf(bundle) ?? bundle.newest.title}
                    </span>
                    <span className="shrink-0 text-xs text-dashboard-text-faint">
                      {formatRelativeTime(
                        new Date(snoozes.until(bundle) ?? nowMs).toISOString(),
                      )}
                    </span>
                    <Button
                      onClick={() => snoozes.wake(bundle)}
                      variant="quiet"
                    >
                      Wake
                    </Button>
                  </li>
                ))}
              </Section>
            </>
          )}
          {moreArchived ? (
            <p className="m-0 px-4 py-2 text-xs text-dashboard-text-muted">
              Narrow the search to find older archived items.
            </p>
          ) : null}
          {loaded && q && all.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-sm text-dashboard-text-muted">
              No items match "{q}".
            </p>
          ) : null}
          {empty ? (
            <p className="m-0 py-12 text-center font-display text-lg font-medium text-dashboard-text">
              Nothing needs you
            </p>
          ) : null}
          <LoadMorePagination
            className="mx-4 mt-2"
            hasMore={!items.isPlaceholderData && Boolean(items.hasNextPage)}
            loading={items.isFetchingNextPage}
            onLoadMore={() => void items.fetchNextPage()}
          />
          {items.isFetchNextPageError ? (
            <InlineError className="px-4 py-2">
              Could not load more items. Try again.
            </InlineError>
          ) : null}
        </div>
      }
    />
  );
}

function focusBundle(conversationId: string) {
  // Focus now, so a key pressed next goes to this bundle. Its tab stop
  // follows on render.
  document
    .querySelector<HTMLElement>(
      `[data-inbox-bundle="${CSS.escape(conversationId)}"]`,
    )
    ?.focus();
}
