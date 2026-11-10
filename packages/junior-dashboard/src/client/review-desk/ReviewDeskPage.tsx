import { ArrowRight, TriangleAlert } from "lucide-react";
import { displayPlainText } from "../display-text/plainText";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { ListPane, NewButton } from "../components/layout/PaneNav";
import { useSidebarFits } from "../conversations/conversationSidebarLayout";
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
import { snoozeChoices, useInboxPins, useInboxSnoozes } from "./inboxSnooze";
import {
  conversationView,
  itemsInView,
  parseInboxView,
  sweepOf,
  TIME_SECTIONS,
  timeSectionOf,
  viewRows,
  type InboxView,
} from "./inboxModel";
import {
  InboxBundleChips,
  InboxSidebar,
  SweepButton,
  type InboxBundleLink,
} from "./InboxSidebar";
import { useInboxSweep } from "./useInboxSweep";
import { automationAttentionReason } from "../pages/automations/automationAttention";
import { BriefOutcomeChip } from "../conversations/ConversationBrief";
import { useConversationBriefs } from "../conversations/conversationGlance";
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

const KEY_HINTS = [
  ["j k", "move"],
  ["Enter", "open"],
  ["e", "done"],
  ["p", "pin"],
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
      {/* A strong heading and a rule split the stream of bundle cards. */}
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
        <ul className="m-0 grid gap-2 p-0 comfortable:gap-3">
          {props.children}
        </ul>
      )}
    </section>
  );
}

/**
 * An Automation that needs attention. It says why and opens the editor. A
 * sweep never clears it; it leaves when the Automation is fixed or resumed.
 */
function AutomationAttentionRow(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const detail =
    automation.statusReason ??
    (automation.kind === "event" ? automation.trigger.problems[0] : undefined);
  return (
    <li className="min-w-0 list-none rounded-xl border border-dashboard-border bg-dashboard-surface-panel shadow-[0_1px_2px_rgb(0_0_0/0.4)] light:shadow-[0_1px_3px_rgb(15_15_30/0.08)]">
      <Link
        className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl px-4 py-3 font-sans text-inherit no-underline hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus comfortable:py-4"
        to={automationPath(automation.id, "edit")}
      >
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-3.5 justify-self-center text-amber-400"
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-semibold leading-snug text-dashboard-text">
            {automation.title}
          </span>
          <span className="truncate text-xs text-dashboard-text-muted">
            <span className="font-medium text-amber-400 light:text-amber-700">
              {automationAttentionReason(automation)}
            </span>
            {detail ? ` · ${detail}` : null}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs text-dashboard-text-faint">
          Automation
        </span>
      </Link>
    </li>
  );
}

type SectionKey = "earlier" | "needs" | "pinned" | "snoozed" | "today" | "week";

const VIEW_LABELS: Record<"all" | "automations" | "decisions" | "prs", string> =
  {
    all: "All",
    automations: "Automations",
    decisions: "Decisions",
    prs: "Pull requests",
  };

/**
 * Render the inbox the way Google Inbox did: the pane lists the bundles
 * (All, Pull requests, Decisions, then one per Conversation), and the page
 * shows the chosen bundle in Pinned, Today, This week, and Earlier. All
 * shows each Conversation as one collapsed bundle, as #3036 does. A row
 * expands in place, where the viewer answers, marks it done, pins, or
 * snoozes it. Each section and each bundle sweeps its notices and FYI items;
 * questions and approvals stay. Keys follow Gmail and Linear.
 */
export function ReviewDeskPage() {
  useDocumentTitle("Inbox");
  const navigate = useNavigate();
  const sidebarFits = useSidebarFits();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseInboxView(searchParams.get("bundle"));
  const [search, setSearch, q] = useDebouncedSearchParam();
  const {
    items: list,
    moreArchived,
    query: items,
  } = useReviewItemsData({
    forViewer: true,
    q,
  });
  // Automations that need attention are asks too: they show in All and in
  // their own bundle, count toward "need you", and a sweep leaves them.
  const attention = useAutomationAttentionData(true);
  const attentionAll = attention.data?.automations ?? [];
  const attentionAutomations =
    !q && (view === "all" || view === "automations") ? attentionAll : [];

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
  const conversationBundles = useMemo(() => inboxBundles(allItems), [allItems]);
  const titles = useLinkedConversationTitles(
    conversationBundles.map((bundle) => bundle.conversationId),
  );
  const briefs = useConversationBriefs(
    conversationBundles.map((bundle) => bundle.conversationId),
  );
  const briefById = new Map(
    conversationBundles.map((bundle, index) => [
      bundle.conversationId,
      briefs[index],
    ]),
  );
  const titleById = new Map(
    conversationBundles.map((bundle, index) => [
      bundle.conversationId,
      titles[index] ?? undefined,
    ]),
  );
  const titleOf = (bundle: InboxBundle) => titleById.get(bundle.conversationId);

  // A search shows every match, snoozed or not.
  const sleepingConversations = new Set(
    q
      ? []
      : conversationBundles
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
  const bundleLinks = (["all", "prs", "decisions"] as const).map((key) => {
    const bundle = link(key, VIEW_LABELS[key]);
    return key === "all"
      ? {
          ...bundle,
          count: bundle.count + attentionAll.length,
          needYou: bundle.needYou + attentionAll.length,
        }
      : bundle;
  });
  if (attentionAll.length > 0)
    bundleLinks.push({
      count: attentionAll.length,
      label: VIEW_LABELS.automations,
      needYou: attentionAll.length,
      view: "automations",
    });
  const conversationLinks = inboxBundles(awake)
    .sort(
      (a, b) =>
        Number(b.needsYou) - Number(a.needsYou) ||
        Date.parse(b.newest.createdAt) - Date.parse(a.newest.createdAt),
    )
    .map((bundle) =>
      link(
        conversationView(bundle.conversationId),
        titleOf(bundle) ?? bundle.newest.title,
      ),
    );
  const viewLabel =
    view === "all" ||
    view === "prs" ||
    view === "decisions" ||
    view === "automations"
      ? VIEW_LABELS[view]
      : (titleById.get(view.slice(2)) ?? "Conversation");
  const viewConversationId = view.startsWith("c:") ? view.slice(2) : undefined;
  const viewBrief = viewConversationId
    ? briefById.get(viewConversationId)
    : undefined;

  const rows = viewRows(q ? allItems : awake, view);
  const rowPinned = (row: InboxBundle) => row.items.some(isPinned);
  const pinnedRows = q ? [] : rows.filter(rowPinned);
  // What waits on the viewer leads, longest wait first. The rest follows in
  // time sections by how long it has waited.
  const needsRows = q
    ? []
    : rows
        .filter((row) => !rowPinned(row) && row.needsYou)
        .sort(
          (a, b) =>
            Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
            a.key.localeCompare(b.key),
        );
  const timeSections = TIME_SECTIONS.map((section) => ({
    ...section,
    rows: q
      ? []
      : rows.filter(
          (row) =>
            !rowPinned(row) &&
            !row.needsYou &&
            timeSectionOf(row, nowMs) === section.key,
        ),
  }));
  const snoozedRows = q ? [] : viewRows(sleeping, view);

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
  const navigable = q
    ? rows
    : [
        ...(collapsed.has("pinned") ? [] : pinnedRows),
        ...(collapsed.has("needs") ? [] : needsRows),
        ...timeSections.flatMap((section) =>
          collapsed.has(section.key) ? [] : section.rows,
        ),
      ];

  const linkedKey = itemParam
    ? navigable.find((row) => row.items.some((item) => item.id === itemParam))
        ?.key
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
  const sweepRows = (target: readonly InboxBundle[]) => {
    const { clear, needYou } = sweepOf(target, isPinned);
    sweeper.sweep(clear, needYou);
  };

  // When the open bundle leaves the queue (answered, done, or snoozed), open
  // the bundle that took its place, so the reader moves straight on.
  const [lastExpanded, setLastExpanded] = useState<{
    index: number;
    key: string;
  }>();
  const [focusKey, setFocusKey] = useState<string>();
  const expandedIndex = navigable.findIndex((row) => row.key === expandedKey);
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
    setExpandedKey(next?.key);
    setActiveKey(next?.key);
    setFocusKey(next?.key ?? "");
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

  const active = navigable.find((row) => row.key === activeKey) ?? navigable[0];
  const toggle = (row: InboxBundle) => {
    setActiveKey(row.key);
    setSnoozeMenuKey(undefined);
    setExpandedKey((current) => (current === row.key ? undefined : row.key));
  };
  useInboxKeys({
    move(step) {
      if (navigable.length === 0) return;
      // The first key press only shows where the reader is.
      const index = activeKey && active ? navigable.indexOf(active) + step : 0;
      const next =
        navigable[Math.max(0, Math.min(navigable.length - 1, index))]!;
      setActiveKey(next.key);
      focusBundle(next.key);
    },
    toggle() {
      if (active) toggle(active);
    },
    done() {
      if (active) void done(active);
    },
    pin() {
      if (active) pins.toggle(active, rowPinned(active));
    },
    snoozeMenu() {
      if (!active) return;
      setExpandedKey(active.key);
      setSnoozeMenuKey((current) =>
        current === active.key ? undefined : active.key,
      );
    },
    snoozeChoice(index) {
      const choice = snoozeChoices[index];
      if (!active || !choice || snoozeMenuKey !== active.key) {
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
      setExpandedKey(active.key);
      setReplyKey(active.key);
    },
  });

  const loaded = Boolean(items.data);
  const empty =
    loaded &&
    !q &&
    navigable.length === 0 &&
    pinnedRows.length === 0 &&
    needsRows.length === 0 &&
    timeSections.every((section) => section.rows.length === 0) &&
    attentionAutomations.length === 0;
  const rowView = (row: InboxBundle) => (
    <InboxBundleView
      active={row === active}
      brief={briefById.get(row.conversationId)}
      bundle={row}
      donePending={action.isPending}
      expanded={row.key === expandedKey}
      itemRow={
        view === "all" ? undefined : { showConversation: !viewConversationId }
      }
      key={row.key}
      onActivate={() => setActiveKey(row.key)}
      onDone={() => void done(row)}
      onPin={() => pins.toggle(row, rowPinned(row))}
      onSnooze={(choice) => {
        snoozes.snooze(row, choice);
        setSnoozeMenuKey(undefined);
      }}
      onSnoozeMenu={(open) => setSnoozeMenuKey(open ? row.key : undefined)}
      onToggle={() => toggle(row)}
      pinned={rowPinned(row)}
      snoozeMenuOpen={snoozeMenuKey === row.key}
      title={titleOf(row)}
    />
  );
  const viewSweep = sweepOf(rows, isPinned);
  const newConversation = { label: "New conversation", to: "/" };

  const page = (
    <ChatLayout
      header={
        <header className="border-b border-dashboard-border bg-dashboard-bg">
          <div className="mx-auto grid w-full max-w-[52.5rem] gap-3 px-4 py-3 md:px-7 md:py-5">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <div className="grid min-w-0 gap-1">
                <h2 className="m-0 min-w-0 truncate font-display text-xl font-medium leading-tight tracking-tight">
                  {viewLabel}
                </h2>
                {/* A Conversation bundle says what the work is about. */}
                {viewBrief ? (
                  <p className="m-0 flex min-w-0 items-baseline gap-2 font-sans text-sm text-dashboard-text-muted">
                    <BriefOutcomeChip
                      className="shrink-0"
                      status={viewBrief.content.outcome.status}
                    />
                    <span className="line-clamp-2 min-w-0">
                      {displayPlainText(
                        viewBrief.content.summary,
                        viewBrief.mentions,
                      )}
                    </span>
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {viewConversationId ? (
                  <Link
                    className="inline-flex items-center gap-1.5 font-sans text-sm font-medium text-dashboard-text-muted no-underline hover:text-dashboard-text max-md:hidden"
                    to={conversationPath(viewConversationId)}
                  >
                    Open conversation
                    <ArrowRight aria-hidden="true" size={14} />
                  </Link>
                ) : null}
                {q ? null : (
                  <SweepButton
                    clear={viewSweep.clear.length}
                    needYou={viewSweep.needYou + attentionAutomations.length}
                    onSweep={() => sweepRows(rows)}
                    scope={viewLabel}
                  />
                )}
                {sidebarFits ? null : (
                  <NewButton action={newConversation} inline />
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
            <ul aria-label="Search results" className="m-0 grid gap-0.5 p-0">
              {rows.map(rowView)}
            </ul>
          ) : (
            <>
              <Section
                collapsed={collapsed.has("pinned")}
                count={pinnedRows.length}
                label="Pinned"
                onToggle={() => toggleSection("pinned")}
              >
                {pinnedRows.map(rowView)}
              </Section>
              <Section
                action={
                  <SweepButton
                    clear={0}
                    needYou={needsRows.reduce(
                      (total, row) =>
                        total + row.items.filter(itemNeedsViewer).length,
                      attentionAutomations.length,
                    )}
                    onSweep={() => undefined}
                    scope="Needs you"
                  />
                }
                collapsed={collapsed.has("needs")}
                count={needsRows.length + attentionAutomations.length}
                label="Needs you"
                onToggle={() => toggleSection("needs")}
              >
                {needsRows.map(rowView)}
                {attentionAutomations.map((automation) => (
                  <AutomationAttentionRow
                    automation={automation}
                    key={automation.id}
                  />
                ))}
              </Section>
              {timeSections.map((section) => {
                const sweep = sweepOf(section.rows, isPinned);
                return (
                  <Section
                    action={
                      <SweepButton
                        clear={sweep.clear.length}
                        needYou={sweep.needYou}
                        onSweep={() => sweepRows(section.rows)}
                        scope={section.label}
                      />
                    }
                    collapsed={collapsed.has(section.key)}
                    count={section.rows.length}
                    key={section.key}
                    label={section.label}
                    onToggle={() => toggleSection(section.key)}
                  >
                    {section.rows.map(rowView)}
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
                        ? (titleOf(row) ?? row.newest.title)
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
              {view === "all" ? "Nothing needs you" : "Nothing left here"}
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
      {sidebarFits ? (
        <ListPane newAction={newConversation} tab="inbox">
          <InboxSidebar
            bundles={bundleLinks}
            conversations={conversationLinks}
            search={location.search}
            selected={view}
          />
        </ListPane>
      ) : null}
      <div className="h-full min-h-0 min-w-0 flex-1">{page}</div>
    </div>
  );
}

function focusBundle(key: string) {
  // Focus now, so a key pressed next goes to this bundle. Its tab stop
  // follows on render.
  document
    .querySelector<HTMLElement>(`[data-inbox-bundle="${CSS.escape(key)}"]`)
    ?.focus();
}
