import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { SearchInput } from "../components/SearchInput";
import { ScrollArea } from "../components/ui/scroll-area";
import { Skeleton } from "../components/ui/skeleton";
import { ConversationSectionHeading } from "../conversations/ConversationSectionHeading";
import { automationPath, formatRelativeTime } from "../format";
import { pathWithSearch } from "../searchParams";
import { cn } from "../styles";
import { reviewItemPath, reviewItemStatusLabel } from "./reviewItemFormat";

/** A sidebar group key. The page owns which groups are collapsed. */
export type InboxGroupKey = "blocked" | "fyi" | "needs-you";

type Dot = "accent" | "muted" | "warning" | "closed";

const dotClass: Record<Dot, string> = {
  accent: "bg-dashboard-accent",
  closed: "border border-dashboard-text-faint",
  muted: "bg-dashboard-text-faint",
  warning: "bg-amber-300",
};

const rowClass =
  "block min-w-0 rounded-lg px-3 py-2 text-inherit no-underline transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus";

function InboxRow(props: {
  dot: Dot;
  meta: ReactNode;
  selected?: "always" | "wide";
  title: string;
  to: string;
}) {
  return (
    <li>
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          rowClass,
          props.selected === "always" && "bg-dashboard-surface-active",
          props.selected === "wide" && "md:bg-dashboard-surface-active",
        )}
        to={props.to}
      >
        <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3">
          <span
            aria-hidden="true"
            className={cn(
              "mt-[0.4rem] size-2 shrink-0 justify-self-center rounded-full",
              dotClass[props.dot],
            )}
          />
          <span
            className={cn(
              "truncate font-sans text-sm font-medium leading-snug",
              props.dot === "closed"
                ? "text-dashboard-text-muted"
                : "text-dashboard-text",
            )}
          >
            {props.title}
          </span>
          <span className="col-start-2 mt-1 truncate font-sans text-xs leading-tight text-dashboard-text-muted">
            {props.meta}
          </span>
        </div>
      </Link>
    </li>
  );
}

function InboxGroup(props: {
  children: ReactNode;
  collapsed: boolean;
  count: number;
  first: boolean;
  label: string;
  onToggle(): void;
}) {
  if (props.count === 0) return null;
  return (
    <section aria-label={props.label}>
      <ConversationSectionHeading
        className={cn("px-3 pb-1", props.first ? "pt-1" : "pt-3")}
        collapsed={props.collapsed}
        count={props.count}
        label={props.label}
        onToggle={props.onToggle}
      />
      {props.collapsed ? null : (
        <ul className="m-0 grid list-none gap-0.5 p-0">{props.children}</ul>
      )}
    </section>
  );
}

function InboxRowsLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid gap-0.5"
      role="status"
    >
      <span className="sr-only">Loading review items</span>
      <Skeleton className="mb-1 ml-3 mt-1.5 h-2.5 w-16" />
      {[0, 1, 2, 3, 4].map((row) => (
        <div className="grid gap-1 rounded-lg px-3 py-2" key={row}>
          <Skeleton className={cn("h-4", row % 2 ? "w-3/5" : "w-4/5")} />
          <Skeleton className="h-3 w-2/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}

/**
 * List the inbox: open items that need the viewer, notices, and blocked
 * Automations, each in a group that collapses. A search shows one list of
 * open and archived matches instead.
 */
export function ReviewDeskSidebar(props: {
  blocked: AutomationSummary[];
  collapsed: ReadonlySet<InboxGroupKey>;
  /** Shown under the groups, such as an empty state or load more. */
  footer?: ReactNode;
  error: boolean;
  fyi: ReviewItemPayload[];
  loading: boolean;
  needsYou: ReviewItemPayload[];
  onSearchChange(value: string): void;
  onToggle(key: InboxGroupKey): void;
  /** Search matches in API order. Set while a search is active. */
  results?: ReviewItemPayload[];
  search: string;
  searchParams: URLSearchParams;
  selectedId?: string;
  /** False while small screens show the list instead of the selected item. */
  selectedShown: boolean;
  /** The title of the Conversation that added an item, when it is known. */
  sourceTitle(item: ReviewItemPayload): string | undefined;
}) {
  const groups = [
    { items: props.needsYou, key: "needs-you", label: "Needs you" },
    { items: props.fyi, key: "fyi", label: "FYI" },
  ] as const;
  const shown = [
    ...groups.map((group) => group.items.length),
    props.blocked.length,
  ];
  const firstKey = (index: number) =>
    shown.slice(0, index).every((count) => count === 0);
  const itemRow = (item: ReviewItemPayload) => {
    const open = item.status === "open";
    const source = item.automationId ? "Automation" : props.sourceTitle(item);
    const meta = [
      open ? undefined : reviewItemStatusLabel(item),
      source,
      formatRelativeTime(open ? item.createdAt : item.closedAt),
    ];
    return (
      <InboxRow
        dot={open ? (item.kind === "action" ? "accent" : "muted") : "closed"}
        key={item.id}
        meta={meta.filter(Boolean).join(" · ")}
        selected={
          item.id !== props.selectedId
            ? undefined
            : props.selectedShown
              ? "always"
              : "wide"
        }
        title={item.title}
        to={pathWithSearch(reviewItemPath(item.id), props.searchParams)}
      />
    );
  };

  return (
    <aside className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-dashboard-border bg-dashboard-surface-panel">
      {/* The heading starts on the pane's icon edge, 24px in. */}
      <div className="px-6 py-3">
        <h2 className="m-0 font-display text-lg font-medium leading-tight text-dashboard-text">
          Inbox
        </h2>
      </div>
      {/* The field's edge matches the rows. Its icon sits on the pane's icon
          axis and its text starts on the label edge. */}
      <div className="px-3 pb-2">
        <SearchInput
          className="h-8 rounded-lg [&>[data-align=inline-start]]:pl-3 [&_input]:pl-3.5"
          label="Search review items"
          onChange={props.onSearchChange}
          placeholder="Search items…"
          size="compact"
          value={props.search}
        />
      </div>
      <ScrollArea>
        <nav
          aria-label="Review items"
          className="px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          {props.error ? (
            <InlineError className="px-3 py-2">
              Could not load review items.
            </InlineError>
          ) : props.loading ? (
            <InboxRowsLoading />
          ) : props.results ? (
            <>
              {props.results.length > 0 ? (
                <ul
                  aria-label="Search results"
                  className="m-0 grid list-none gap-0.5 p-0 pt-1"
                >
                  {props.results.map(itemRow)}
                </ul>
              ) : null}
              {props.footer}
            </>
          ) : (
            <>
              {groups.map((group, index) => (
                <InboxGroup
                  collapsed={props.collapsed.has(group.key)}
                  count={group.items.length}
                  first={firstKey(index)}
                  key={group.key}
                  label={group.label}
                  onToggle={() => props.onToggle(group.key)}
                >
                  {group.items.map(itemRow)}
                </InboxGroup>
              ))}
              <InboxGroup
                collapsed={props.collapsed.has("blocked")}
                count={props.blocked.length}
                first={firstKey(2)}
                label="Blocked automations"
                onToggle={() => props.onToggle("blocked")}
              >
                {props.blocked.map((automation) => (
                  <InboxRow
                    dot="warning"
                    key={automation.id}
                    meta={automation.statusReason ?? "Blocked"}
                    title={automation.title}
                    to={automationPath(automation.id)}
                  />
                ))}
              </InboxGroup>
              {props.footer}
            </>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );
}
