import { ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { ListPane } from "../components/layout/PaneNav";
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
import { InboxAutomationRow } from "./InboxAutomationRow";
import { InboxBundleView } from "./InboxBundleView";
import {
  automationSections,
  conversationView,
  itemsInView,
  parseInboxView,
  sweepOf,
  viewConversationId,
  viewRows,
  viewSections,
  type InboxView,
} from "./inboxModel";
import {
  InboxBundleChips,
  InboxSidebar,
  SweepButton,
  type InboxBundleLink,
} from "./InboxSidebar";
import { snoozeChoices, useInboxPins, useInboxSnoozes } from "./inboxSnooze";
import {
  useAutomationAttentionData,
  useLinkedConversationTitles,
  useReviewItemAction,
  useReviewItemData,
  useReviewItemsData,
} from "./queries";
import {
  inboxBundles,
  itemNeedsViewer,
  type InboxBundle,
} from "./reviewItemFormat";
import { useInboxKeys } from "./useInboxKeys";
import { useInboxSweep } from "./useInboxSweep";

const KEY_HINTS = [
  ["j k", "move"],
  ["Enter", "open"],
  ["e", "done"],
  ["p", "pin"],
  ["h", "snooze"],
  ["r", "reply"],
  ["o", "conversation"],
] as const;

const VIEW_LABELS = {
  all: "All",
  automations: "Automations",
  decisions: "Decisions",
  prs: "Pull requests",
} as const;

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
  /** Shows at the end of the heading, such as the section's sweep. */
  action?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  count: number;
  label: string;
  onToggle(): void;
}) {
  if (props.count === 0) return null;
  return (
    <section aria-label={props.label} className="grid gap-2 pt-5 first:pt-1">
      {/* A bold heading and a rule split the stream of cards. */}
      <div className="flex min-h-9 items-end justify-between gap-3 border-b border-dashboard-border pr-1 pb-1.5">
        <ConversationSectionHeading
          className="px-1 font-semibold text-dashboard-text [&_*]:text-dashboard-text"
          collapsed={props.collapsed}
          count={props.count}
          label={props.label}
          onToggle={props.onToggle}
        />
        {props.action}
      </div>
      {props.collapsed ? null : (
        <ul className="m-0 grid gap-2 p-0">{props.children}</ul>
      )}
    </section>
  );
}

/** One group in the stream: Review item rows, then Automations. */
type StreamSection = {
  automations: AutomationSummary[];
  key: string;
  label: string;
  rows: InboxBundle[];
};

const automationKey = (automation: AutomationSummary) =>
  `automation:${automation.id}`;

function needsYouHeading(conversations: number): string {
  return `${conversations} conversation${conversations === 1 ? "" : "s"} need${
    conversations === 1 ? "s" : ""
  } you`;
}

/**
 * Render the inbox the way Google Inbox did: the pane lists the bundles
 * (All, Pull requests, Decisions, Automations, then one per Conversation),
 * and the page groups the chosen bundle the way its filter reads best. A
 * click on any row expands it in place; only labelled buttons leave the
 * inbox. Each section sweeps its notices and FYI items with an Undo;
 * what needs the viewer stays. Keys follow Gmail and Linear.
 */
export function ReviewDeskPage() {
  useDocumentTitle("Inbox");
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseInboxView(searchParams);
  const [search, setSearch, q] = useDebouncedSearchParam();
  const {
    items: list,
    moreArchived,
    query: items,
  } = useReviewItemsData({ forViewer: true, q });
  // The viewer's Automations that need attention are asks too: they lead
  // All and fill their own bundle. A sweep leaves them.
  const attention = useAutomationAttentionData(true);
  const attentionAll = attention.data?.automations ?? [];

  // A link can name an item that is not open, such as an answered one.
  const itemParam = searchParams.get("item") ?? undefined;
  const listed = list.some((item) => item.id === itemParam);
  const direct = useReviewItemData(listed ? undefined : itemParam);
  // An open item that left the list was just closed; its cached copy is old.
  const linked = direct.data?.status === "open" ? undefined : direct.data;
  const allItems = useMemo(
    () =>
      linked && !list.some((item) => item.id === linked.id)
        ? [linked, ...list]
        : list,
    [linked, list],
  );

  const nowMs = Date.now();
  const snoozes = useInboxSnoozes(nowMs);
  const pins = useInboxPins();
  const sweeper = useInboxSweep();
  const conversationIds = useMemo(
    () => [...new Set(allItems.map((item) => item.addedByConversationId))],
    [allItems],
  );
  const titles = useLinkedConversationTitles(conversationIds);
  const titleById = new Map(
    conversationIds.map((id, index) => [id, titles[index]]),
  );
  const titleOf = (conversationId: string) => titleById.get(conversationId);

  // A search shows every match, snoozed or not.
  const sleepingConversations = new Set(
    q
      ? []
      : inboxBundles(allItems)
          .filter((bundle) => snoozes.sleeps(bundle.key, bundle.newest.id))
          .map((bundle) => bundle.conversationId),
  );
  const asleep = (item: ReviewItemPayload) =>
    !q &&
    (sleepingConversations.has(item.addedByConversationId) ||
      snoozes.sleeps(item.id, item.id));
  const isPinned = (item: ReviewItemPayload) =>
    pins.pinned(item.id) || pins.pinned(item.addedByConversationId);
  const live = allItems.filter((item) => !sweeper.isSwept(item.id));
  const awake = live.filter((item) => !asleep(item));
  const sleeping = live.filter(asleep);

  const link = (target: InboxView, label: string): InboxBundleLink => {
    const inView = itemsInView(awake, target);
    return {
      count: inView.length,
      label,
      needYou: inView.filter(itemNeedsViewer).length,
      view: target,
    };
  };
  const allLink = link("all", VIEW_LABELS.all);
  const bundleLinks: InboxBundleLink[] = [
    {
      ...allLink,
      count: allLink.count + attentionAll.length,
      needYou: allLink.needYou + attentionAll.length,
    },
    link("prs", VIEW_LABELS.prs),
    link("decisions", VIEW_LABELS.decisions),
    {
      count: attentionAll.length,
      label: VIEW_LABELS.automations,
      needYou: attentionAll.length,
      view: "automations",
    },
  ];
  const conversationLinks = inboxBundles(awake)
    .sort(
      (a, b) =>
        Number(b.needsYou) - Number(a.needsYou) ||
        Date.parse(b.newest.createdAt) - Date.parse(a.newest.createdAt),
    )
    .map((bundle) =>
      link(
        conversationView(bundle.conversationId),
        titleOf(bundle.conversationId) ?? bundle.newest.title,
      ),
    );

  const conversationId = viewConversationId(view);
  const rows = viewRows(q ? allItems : awake, view);
  const rowPinned = (row: InboxBundle) => row.items.some(isPinned);
  const pinnedRows = q ? [] : rows.filter(rowPinned);
  const sections: StreamSection[] = q
    ? []
    : viewSections(
        view,
        rows.filter((row) => !rowPinned(row)),
        { nowMs, titleOf },
      ).map((section) => ({ ...section, automations: [] }));
  if (!q && view === "all" && attentionAll.length > 0) {
    // Automations that need attention wait on the viewer, after the asks.
    const needs = sections.find((section) => section.key === "needs");
    if (needs) needs.automations = attentionAll;
    else
      sections.unshift({
        automations: attentionAll,
        key: "needs",
        label: "Needs you",
        rows: [],
      });
  }
  if (!q && view === "automations")
    sections.push(
      ...automationSections(attentionAll).map((section) => ({
        automations: section.automations,
        key: section.label,
        label: section.label,
        rows: [],
      })),
    );
  if (pinnedRows.length > 0)
    sections.unshift({
      automations: [],
      key: "pinned",
      label: "Pinned",
      rows: pinnedRows,
    });
  const snoozedRows = q ? [] : viewRows(sleeping, view);
  const needsYouConversations = new Set(rows.map((row) => row.conversationId))
    .size;
  const viewLabel =
    view === "needs-you"
      ? needsYouHeading(needsYouConversations)
      : view.startsWith("c:")
        ? (titleOf(view.slice(2)) ?? "Conversation")
        : VIEW_LABELS[view as keyof typeof VIEW_LABELS];

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(["snoozed"]),
  );
  const toggleSection = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const automationByKey = new Map(
    attentionAll.map((automation) => [automationKey(automation), automation]),
  );
  const navigable = q
    ? rows.map((row) => row.key)
    : sections.flatMap((section) =>
        collapsed.has(section.key)
          ? []
          : [
              ...section.rows.map((row) => row.key),
              ...section.automations.map(automationKey),
            ],
      );

  const linkedKey = itemParam
    ? rows.find((row) => row.items.some((item) => item.id === itemParam))?.key
    : undefined;
  const [expandedKey, setExpandedKey] = useState<string>();
  const [activeKey, setActiveKey] = useState<string>();
  const [snoozeMenuKey, setSnoozeMenuKey] = useState<string>();
  const [replyKey, setReplyKey] = useState<string>();
  // A link opens its row once it loads.
  useEffect(() => {
    if (!linkedKey) return;
    setExpandedKey(linkedKey);
    setActiveKey(linkedKey);
  }, [linkedKey]);
  // Another bundle starts with nothing open.
  useEffect(() => {
    setExpandedKey(undefined);
    setSnoozeMenuKey(undefined);
  }, [view]);

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
  // `staying` counts the Automations shown with the rows: a sweep leaves them.
  const sweepRows = (target: readonly InboxBundle[], staying: number) => {
    const { clear, needYou } = sweepOf(target, isPinned);
    sweeper.sweep(clear, needYou + staying);
  };

  // When the open row leaves the queue (answered, done, or snoozed), open
  // the row that took its place, so the reader moves straight on.
  const [lastExpanded, setLastExpanded] = useState<{
    index: number;
    key: string;
  }>();
  const [focusKey, setFocusKey] = useState<string>();
  const expandedIndex = expandedKey ? navigable.indexOf(expandedKey) : -1;
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
    setExpandedKey(next);
    setActiveKey(next);
    setFocusKey(next ?? "");
  }
  useEffect(() => {
    if (focusKey === undefined) return;
    if (focusKey) focusRow(focusKey);
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
    document
      .querySelector(`[data-inbox-answer="${CSS.escape(replyKey)}"]`)
      ?.querySelector<HTMLElement>(
        "[data-inbox-item] :is(textarea, input:not([type='hidden']), button)",
      )
      ?.focus();
    setReplyKey(undefined);
  }, [expandedKey, replyKey]);

  const activeId =
    activeKey && navigable.includes(activeKey) ? activeKey : navigable[0];
  const activeRow = activeId ? rowByKey.get(activeId) : undefined;
  const activeAutomation = activeId ? automationByKey.get(activeId) : undefined;
  const toggle = (key: string) => {
    setActiveKey(key);
    setSnoozeMenuKey(undefined);
    setExpandedKey((current) => (current === key ? undefined : key));
  };
  useInboxKeys({
    move(step) {
      if (navigable.length === 0) return;
      // The first key press only shows where the reader is.
      const index =
        activeKey && activeId ? navigable.indexOf(activeId) + step : 0;
      const next =
        navigable[Math.max(0, Math.min(navigable.length - 1, index))]!;
      setActiveKey(next);
      focusRow(next);
    },
    toggle() {
      if (activeId) toggle(activeId);
    },
    done() {
      if (activeRow) void done(activeRow);
    },
    pin() {
      if (activeRow) pins.toggle(activeRow, rowPinned(activeRow));
    },
    snoozeMenu() {
      if (!activeRow) return;
      setExpandedKey(activeRow.key);
      setSnoozeMenuKey((current) =>
        current === activeRow.key ? undefined : activeRow.key,
      );
    },
    snoozeChoice(index) {
      const choice = snoozeChoices[index];
      if (!activeRow || !choice || snoozeMenuKey !== activeRow.key) {
        return false;
      }
      snoozes.snooze(activeRow, choice);
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
      if (activeAutomation)
        navigate(automationPath(activeAutomation.id, "edit"));
      else if (activeRow)
        navigate(
          conversationPath(activeRow.conversationId, {
            turnId: activeRow.newest.addedByTurnId,
          }),
        );
    },
    reply() {
      if (!activeRow) return;
      setExpandedKey(activeRow.key);
      setReplyKey(activeRow.key);
    },
  });

  const loaded = Boolean(items.data);
  const empty = loaded && !q && navigable.length === 0 && sections.length === 0;
  // A single-item row names its Conversation unless a heading already does.
  const itemRow =
    view === "all"
      ? undefined
      : {
          showConversation:
            !conversationId && view !== "decisions" && view !== "needs-you",
        };
  const rowView = (row: InboxBundle) => (
    <InboxBundleView
      active={row.key === activeId}
      bundle={row}
      donePending={action.isPending}
      expanded={row.key === expandedKey}
      itemRow={itemRow}
      key={row.key}
      onActivate={() => setActiveKey(row.key)}
      onDone={() => void done(row)}
      onPin={() => pins.toggle(row, rowPinned(row))}
      onSnooze={(choice) => {
        snoozes.snooze(row, choice);
        setSnoozeMenuKey(undefined);
      }}
      onSnoozeMenu={(open) => setSnoozeMenuKey(open ? row.key : undefined)}
      onToggle={() => toggle(row.key)}
      pinned={rowPinned(row)}
      snoozeMenuOpen={snoozeMenuKey === row.key}
      title={titleOf(row.conversationId)}
    />
  );
  const automationView = (automation: AutomationSummary) => {
    const key = automationKey(automation);
    return (
      <InboxAutomationRow
        active={key === activeId}
        automation={automation}
        expanded={key === expandedKey}
        key={key}
        onActivate={() => setActiveKey(key)}
        onToggle={() => toggle(key)}
        rowKey={key}
      />
    );
  };
  const viewSweep = sweepOf(rows, isPinned);
  const viewAutomations =
    view === "all" || view === "automations" ? attentionAll.length : 0;

  const page = (
    <ChatLayout
      header={
        <header className="border-b border-dashboard-border bg-dashboard-bg">
          <div className="mx-auto grid w-full max-w-[52.5rem] gap-3 px-4 py-3 md:px-7 md:py-5">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <h2 className="m-0 min-w-0 truncate font-display text-xl font-medium leading-tight tracking-tight">
                {viewLabel}
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                {conversationId ? (
                  <Link
                    className="inline-flex items-center gap-1.5 font-sans text-sm font-medium text-dashboard-text-muted no-underline hover:text-dashboard-text max-md:hidden"
                    to={conversationPath(conversationId)}
                  >
                    Open conversation
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </Link>
                ) : null}
                {q ? null : (
                  <SweepButton
                    clear={viewSweep.clear.length}
                    needYou={viewSweep.needYou + viewAutomations}
                    onSweep={() => sweepRows(rows, viewAutomations)}
                    scope={viewLabel}
                  />
                )}
              </div>
            </div>
            <InboxBundleChips
              bundles={[...bundleLinks, ...conversationLinks]}
              search={location.search}
              selected={view}
            />
            <div className="flex min-w-0 items-center gap-4">
              <SearchInput
                className="min-w-0 flex-1"
                label="Search review items"
                onChange={setSearch}
                placeholder="Search items…"
                size="compact"
                value={search}
              />
              <p
                aria-label="Keyboard shortcuts"
                className="m-0 flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1 font-sans text-xs text-dashboard-text-faint max-lg:hidden"
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
            <ul aria-label="Search results" className="m-0 grid gap-2 p-0">
              {rows.map(rowView)}
            </ul>
          ) : (
            <>
              {sections.map((section) => {
                const sweep = sweepOf(section.rows, isPinned);
                return (
                  <Section
                    action={
                      <SweepButton
                        clear={sweep.clear.length}
                        needYou={sweep.needYou + section.automations.length}
                        onSweep={() =>
                          sweepRows(section.rows, section.automations.length)
                        }
                        scope={section.label}
                      />
                    }
                    collapsed={collapsed.has(section.key)}
                    count={section.rows.length + section.automations.length}
                    key={section.key}
                    label={section.label}
                    onToggle={() => toggleSection(section.key)}
                  >
                    {section.rows.map(rowView)}
                    {section.automations.map(automationView)}
                  </Section>
                );
              })}
              <Section
                collapsed={collapsed.has("snoozed")}
                count={snoozedRows.length}
                label="Snoozed"
                onToggle={() => toggleSection("snoozed")}
              >
                {snoozedRows.map((row) => (
                  <li
                    className="flex min-w-0 list-none items-center gap-3 px-4 py-2"
                    key={row.key}
                  >
                    <span className="min-w-0 flex-1 truncate font-sans text-sm text-dashboard-text-muted">
                      {view === "all"
                        ? (titleOf(row.conversationId) ?? row.newest.title)
                        : row.newest.title}
                    </span>
                    <span className="shrink-0 text-xs text-dashboard-text-faint">
                      {formatRelativeTime(
                        new Date(snoozes.until(row) || nowMs).toISOString(),
                      )}
                    </span>
                    <Button onClick={() => snoozes.wake(row)} variant="quiet">
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
          {loaded && q && rows.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-sm text-dashboard-text-muted">
              No items match "{q}".
            </p>
          ) : null}
          {empty ? (
            <p className="m-0 py-12 text-center font-display text-lg font-medium text-dashboard-text">
              {view === "all" || view === "needs-you"
                ? "Nothing needs you"
                : "Nothing left here"}
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

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-dashboard-bg">
      {/* Phones show the bundles as chips above the stream. */}
      <ListPane className="max-md:hidden">
        <InboxSidebar
          bundles={bundleLinks}
          conversations={conversationLinks}
          search={location.search}
          selected={view}
        />
      </ListPane>
      <div className="h-full min-h-0 min-w-0 flex-1">{page}</div>
    </div>
  );
}

function focusRow(key: string) {
  // Focus now, so a key pressed next goes to this row. Its tab stop
  // follows on render.
  document
    .querySelector<HTMLElement>(`[data-inbox-bundle="${CSS.escape(key)}"]`)
    ?.focus();
}
