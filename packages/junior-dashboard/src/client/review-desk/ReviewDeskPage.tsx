import { ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { conversationPath } from "../conversations/conversationRoutes";
import { useDocumentTitle } from "../documentTitle";
import { automationPath, formatRelativeTime } from "../format";
import { useDebouncedSearchParam } from "../searchParams";
import { cn } from "../styles";
import { InboxAutomationRow } from "./InboxAutomationRow";
import { InboxBundleView } from "./InboxBundleView";
import { doneKeys, InboxDoneView } from "./InboxDoneView";
import { InboxSection } from "./InboxSection";
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
  DONE_LINK,
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
  done: "Done",
  prs: "Pull requests",
} as const;

// Done is read-only, so only moving, opening, and leaving apply.
const DONE_KEY_HINTS = KEY_HINTS.filter(([, label]) =>
  ["move", "open", "conversation"].includes(label),
);

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

/** One group in the stream: Review item rows, then Automations. */
type StreamSection = {
  automations: AutomationSummary[];
  key: string;
  label: string;
  rows: InboxBundle[];
};

const automationKey = (automation: AutomationSummary) =>
  `automation:${automation.id}`;

/**
 * Render the inbox the way Google Inbox did: the pane lists the bundles
 * (All, Pull requests, Decisions, Automations, one per Conversation, then
 * Done), and the page groups the chosen bundle the way its filter reads
 * best. A click on any row expands it in place; only labelled buttons leave
 * the inbox. Each section sweeps its notices and FYI items with an Undo;
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
  const isDone = view === "done";
  const { items: doneItems, query: doneQuery } = useReviewItemsData({
    closed: true,
    enabled: isDone,
    forViewer: true,
    q,
  });
  // The viewer's Automations that need attention are asks too: they lead
  // All and fill their own bundle. A sweep leaves them.
  const attention = useAutomationAttentionData(true);
  const attentionAll = attention.data?.automations ?? [];

  // A link can name an item that is not in the list: an open one on a later
  // page, or a closed one, such as an answered one.
  const itemParam = searchParams.get("item") ?? undefined;
  const listed = list.some((item) => item.id === itemParam);
  const direct = useReviewItemData(listed ? undefined : itemParam);
  // How the link first loaded. A linked item that was in the list, or was
  // open, leaves the queue when it closes, like any other row. Only an item
  // that was closed when the link opened stays shown.
  const [linkStart, setLinkStart] = useState<{
    closed: boolean;
    id: string;
    listed: boolean;
  }>();
  // Wait for the open list, so `listed` says where the item really is.
  if (
    itemParam &&
    linkStart?.id !== itemParam &&
    items.data &&
    (listed || direct.data)
  ) {
    setLinkStart({
      closed: !listed && direct.data?.status !== "open",
      id: itemParam,
      listed,
    });
  }
  const start = linkStart?.id === itemParam ? linkStart : undefined;
  const linked =
    direct.data &&
    // A failed fetch keeps its last copy, which can be old.
    !direct.error &&
    start &&
    !start.listed &&
    (start.closed || direct.data.status === "open")
      ? direct.data
      : undefined;
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
    () => [
      ...new Set(
        [...allItems, ...doneItems].map((item) => item.addedByConversationId),
      ),
    ],
    [allItems, doneItems],
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

  // Counts include snoozed items, as the Inbox tab badge does, so All's
  // main number matches the badge. Automations have their own bundle.
  const link = (target: InboxView, label: string): InboxBundleLink => {
    const inView = itemsInView(live, target);
    return {
      asks: inView.filter(itemNeedsViewer).length,
      fyi: inView.filter(
        (item) => item.kind === "notice" && item.status === "open",
      ).length,
      label,
      view: target,
    };
  };
  const bundleLinks: InboxBundleLink[] = [
    link("all", VIEW_LABELS.all),
    link("prs", VIEW_LABELS.prs),
    link("decisions", VIEW_LABELS.decisions),
    {
      asks: attentionAll.length,
      fyi: 0,
      label: VIEW_LABELS.automations,
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
    const todo = sections.find((section) => section.key === "todo");
    if (todo) todo.automations = attentionAll;
    else
      sections.unshift({
        automations: attentionAll,
        key: "todo",
        label: "To do",
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
  // Automations are not Review items, so the server search skips them.
  // Match them here, in the bundles that list them.
  const needle = q.toLowerCase();
  const searchedAutomations =
    q && (view === "all" || view === "automations")
      ? attentionAll.filter((automation) =>
          [automation.title, automation.statusReason ?? ""].some((text) =>
            text.toLowerCase().includes(needle),
          ),
        )
      : [];
  const snoozedRows = q ? [] : viewRows(sleeping, view);
  const conversationCount = new Set(rows.map((row) => row.conversationId)).size;
  const viewLabel =
    view === "needs-you"
      ? "By conversation"
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
  const navigable = isDone
    ? doneKeys(doneItems, nowMs, collapsed)
    : q
      ? [
          ...rows.map((row) => row.key),
          ...searchedAutomations.map(automationKey),
        ]
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
  // Another bundle starts with nothing open. This runs before the link
  // effect, so a cached list on mount keeps the linked row open.
  useEffect(() => {
    setExpandedKey(undefined);
    setSnoozeMenuKey(undefined);
  }, [view]);
  // A link opens its row once it loads.
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
  const sweepRows = (target: readonly InboxBundle[]) =>
    sweeper.sweep(sweepOf(target, isPinned));

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
    lastExpanded?.key === expandedKey &&
    // Done is read-only, so its rows never leave. A row in a collapsed
    // section is hidden, not gone.
    !isDone &&
    !rowByKey.has(expandedKey) &&
    !automationByKey.has(expandedKey)
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
  const activeDone = isDone
    ? doneItems.find((item) => item.id === activeId)
    : undefined;
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
      else if (activeDone)
        navigate(
          conversationPath(activeDone.addedByConversationId, {
            turnId: activeDone.addedByTurnId,
          }),
        );
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
  // Done pages its own list.
  const listQuery = isDone ? doneQuery : items;
  // All and Automations show the viewer's Automations. Until they load, or
  // when they fail, those views are not empty.
  const showsAutomations = view === "all" || view === "automations";
  const automationsMissing = showsAutomations && !attention.data;
  const empty =
    loaded &&
    !q &&
    !isDone &&
    !automationsMissing &&
    navigable.length === 0 &&
    sections.length === 0;
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

  const page = (
    <ChatLayout
      header={
        <header className="border-b border-dashboard-border bg-dashboard-bg">
          {/* On desktop the title row shares the pane's header row. */}
          <div className="md:box-content md:h-header md:border-b md:border-dashboard-border">
            <div className="mx-auto flex h-full w-full min-w-0 max-w-[52.5rem] items-center justify-between gap-4 px-4 pt-3 md:px-7 md:pt-0">
              <h2 className="m-0 min-w-0 truncate font-display text-xl font-medium leading-tight tracking-tight">
                {viewLabel}
                {view === "needs-you" ? (
                  <>
                    {" "}
                    <span className="ml-2 font-sans text-sm font-normal text-dashboard-text-muted">
                      {conversationCount} conversation
                      {conversationCount === 1 ? "" : "s"}
                    </span>
                  </>
                ) : null}
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
                {q || isDone ? null : (
                  <SweepButton
                    clear={viewSweep.length}
                    onSweep={() => sweepRows(rows)}
                    scope={viewLabel}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="mx-auto grid w-full max-w-[52.5rem] gap-3 px-4 py-3 md:px-7">
            <InboxBundleChips
              bundles={[...bundleLinks, ...conversationLinks, DONE_LINK]}
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
                {(isDone ? DONE_KEY_HINTS : KEY_HINTS).map(([keys, label]) => (
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
          {showsAutomations && attention.error && !attention.data ? (
            <InlineError className="px-4 py-2">
              Could not load your Automations.
            </InlineError>
          ) : null}
          {isDone ? (
            doneQuery.error && !doneQuery.data ? (
              <InlineError className="px-4 py-3">
                Could not load done items.
              </InlineError>
            ) : !doneQuery.data ? (
              <BundleRowsLoading />
            ) : doneItems.length === 0 ? (
              <p className="m-0 py-12 text-center font-display text-lg font-medium text-dashboard-text">
                {q ? `No done items match "${q}".` : "Nothing done yet"}
              </p>
            ) : (
              <InboxDoneView
                activeKey={activeId}
                collapsed={collapsed}
                expandedKey={expandedKey}
                items={doneItems}
                nowMs={nowMs}
                onActivate={setActiveKey}
                onToggle={toggle}
                onToggleSection={toggleSection}
                titleOf={titleOf}
              />
            )
          ) : items.error && !items.data ? (
            <InlineError className="px-4 py-3">
              Could not load review items.
            </InlineError>
          ) : !loaded ||
            (showsAutomations &&
              attention.isPending &&
              navigable.length === 0 &&
              snoozedRows.length === 0) ? (
            <BundleRowsLoading />
          ) : q ? (
            <ul aria-label="Search results" className="m-0 grid gap-2 p-0">
              {rows.map(rowView)}
              {searchedAutomations.map(automationView)}
            </ul>
          ) : (
            <>
              {sections.map((section) => {
                const sweep = sweepOf(section.rows, isPinned);
                return (
                  <InboxSection
                    action={
                      <SweepButton
                        clear={sweep.length}
                        onSweep={() => sweepRows(section.rows)}
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
                  </InboxSection>
                );
              })}
              <InboxSection
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
              </InboxSection>
            </>
          )}
          {moreArchived && !isDone ? (
            <p className="m-0 px-4 py-2 text-xs text-dashboard-text-muted">
              Narrow the search to find older archived items.
            </p>
          ) : null}
          {loaded &&
          q &&
          !isDone &&
          rows.length === 0 &&
          searchedAutomations.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-sm text-dashboard-text-muted">
              No items match "{q}".
            </p>
          ) : null}
          {empty ? (
            <p className="m-0 py-12 text-center font-display text-lg font-medium text-dashboard-text">
              {view === "all" || view === "needs-you"
                ? "All caught up"
                : "Nothing left here"}
            </p>
          ) : null}
          <LoadMorePagination
            className="mx-4 mt-2"
            hasMore={
              !listQuery.isPlaceholderData && Boolean(listQuery.hasNextPage)
            }
            loading={listQuery.isFetchingNextPage}
            onLoadMore={() => void listQuery.fetchNextPage()}
          />
          {listQuery.isFetchNextPageError ? (
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
      <ListPane className="max-md:hidden" tab="inbox">
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
