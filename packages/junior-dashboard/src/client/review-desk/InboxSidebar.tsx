import {
  CheckCheck,
  GitPullRequest,
  Inbox,
  MessageCircleQuestion,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

import { Button } from "../components/ui/button";
import { cn } from "../styles";
import type { InboxView } from "./inboxModel";

/** One bundle in the Inbox list, with its counts. */
export type InboxBundleLink = {
  /** Items in the bundle that a sweep can see. */
  count: number;
  label: string;
  /** Items in the bundle that wait on the viewer. */
  needYou: number;
  view: InboxView;
};

const VIEW_ICONS: Partial<Record<InboxView, LucideIcon>> = {
  all: Inbox,
  automations: Workflow,
  decisions: MessageCircleQuestion,
  prs: GitPullRequest,
};

function viewHref(view: InboxView, search: string): string {
  const params = new URLSearchParams(search);
  if (view === "all") params.delete("bundle");
  else params.set("bundle", view);
  params.delete("item");
  const query = params.toString();
  return `/review${query ? `?${query}` : ""}`;
}

function BundleRow(props: {
  bundle: InboxBundleLink;
  search: string;
  selected: boolean;
}) {
  const { bundle } = props;
  const Icon = VIEW_ICONS[bundle.view];
  return (
    <li className="list-none">
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "grid h-8 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 font-sans text-sm no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          props.selected
            ? "bg-dashboard-accent/[0.12] text-dashboard-accent-text"
            : "text-dashboard-text hover:bg-dashboard-fill-hover",
        )}
        to={viewHref(bundle.view, props.search)}
      >
        {Icon ? (
          <Icon
            aria-hidden="true"
            className="size-4 text-dashboard-text-muted"
            strokeWidth={1.9}
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "size-2 justify-self-center rounded-full",
              bundle.needYou > 0
                ? "bg-dashboard-accent"
                : "border border-dashboard-text-faint",
            )}
          />
        )}
        <span
          className={cn(
            "truncate",
            bundle.needYou > 0 ? "font-medium" : "text-dashboard-text-muted",
          )}
        >
          {bundle.label}
        </span>
        {/* What waits on the viewer counts in accent; otherwise how many
            items the bundle holds. */}
        {bundle.needYou > 0 ? (
          <span
            aria-label={`${bundle.needYou} need you`}
            className="grid h-5 min-w-5 place-items-center rounded-full bg-dashboard-accent/[0.16] px-1.5 text-xs font-semibold tabular-nums text-dashboard-accent-text"
          >
            {bundle.needYou}
          </span>
        ) : (
          <span
            aria-label={`${bundle.count} items`}
            className="px-1.5 text-xs tabular-nums text-dashboard-text-faint"
          >
            {bundle.count}
          </span>
        )}
      </Link>
    </li>
  );
}

/**
 * The Inbox tab list: All, the pull request and decision bundles, then one
 * bundle per Conversation. Every bundle is automatic. Accent numbers count
 * what waits on the viewer; faint numbers count everything.
 */
export function InboxSidebar(props: {
  bundles: InboxBundleLink[];
  conversations: InboxBundleLink[];
  search: string;
  selected: InboxView;
}) {
  return (
    <aside
      aria-label="Inbox bundles"
      className="h-full min-h-0 overflow-y-auto overscroll-contain border-r border-dashboard-border bg-dashboard-surface-panel px-3 pt-3 pb-16 thin-scrollbar"
    >
      <ul className="m-0 grid gap-0.5 p-0">
        {props.bundles.map((bundle) => (
          <BundleRow
            bundle={bundle}
            key={bundle.view}
            search={props.search}
            selected={bundle.view === props.selected}
          />
        ))}
      </ul>
      {props.conversations.length > 0 ? (
        <>
          <h3 className="m-0 pt-4 pr-3 pb-1 pl-10 font-sans text-xs font-medium text-dashboard-text-muted">
            Conversations
          </h3>
          <ul className="m-0 grid gap-0.5 p-0">
            {props.conversations.map((bundle) => (
              <BundleRow
                bundle={bundle}
                key={bundle.view}
                search={props.search}
                selected={bundle.view === props.selected}
              />
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

/**
 * Phones have no pane, so the bundles show as a row of chips above the
 * stream.
 */
export function InboxBundleChips(props: {
  bundles: InboxBundleLink[];
  search: string;
  selected: InboxView;
}) {
  return (
    <nav
      aria-label="Inbox bundles"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:hidden"
    >
      {props.bundles.map((bundle) => (
        <Link
          aria-current={bundle.view === props.selected ? "page" : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 font-sans text-sm no-underline",
            bundle.view === props.selected
              ? "border-dashboard-accent/40 bg-dashboard-accent/[0.12] text-dashboard-accent-text"
              : "border-dashboard-border text-dashboard-text-muted",
          )}
          key={bundle.view}
          to={viewHref(bundle.view, props.search)}
        >
          <span className="max-w-40 truncate">{bundle.label}</span>
          {/* Same numbers as the pane: what needs you, else the total. */}
          <span
            className={cn(
              "text-xs tabular-nums",
              bundle.needYou > 0
                ? "font-semibold text-dashboard-accent-text"
                : "opacity-70",
            )}
          >
            {bundle.needYou > 0 ? bundle.needYou : bundle.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * Sweep some rows: mark their notices and FYI items done. Questions and
 * approvals that wait on the viewer never sweep, so the label says how many
 * stay, as in "Clear 4 · 2 need you".
 */
export function SweepButton(props: {
  className?: string;
  clear: number;
  needYou: number;
  onSweep(): void;
  /** What the rows are, for the accessible name, such as "Today". */
  scope: string;
}) {
  if (props.clear === 0) {
    return props.needYou > 0 ? (
      <span
        className={cn(
          "px-2 font-sans text-xs text-dashboard-text-faint",
          props.className,
        )}
      >
        {props.needYou} need{props.needYou === 1 ? "s" : ""} you
      </span>
    ) : null;
  }
  return (
    <Button
      aria-label={`Clear ${props.clear} in ${props.scope}${
        props.needYou > 0 ? `; ${props.needYou} that need you stay` : ""
      }`}
      className={cn("h-7 gap-1.5 px-2 text-xs", props.className)}
      onClick={props.onSweep}
      title="Mark notices and FYI items done. Questions and approvals stay."
      variant="quiet"
    >
      <CheckCheck aria-hidden="true" className="size-3.5" />
      Clear {props.clear}
      {props.needYou > 0 ? (
        <span className="font-normal text-dashboard-text-faint">
          · {props.needYou} need{props.needYou === 1 ? "s" : ""} you
        </span>
      ) : null}
    </Button>
  );
}
