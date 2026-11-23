import {
  CircleCheck,
  Clock3,
  GitPullRequest,
  Inbox,
  MessageCircleQuestion,
  MessagesSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router";

import { navItemIcon } from "../components/layout/navIcons";
import { usePaneNavItems, usePaneRowLink } from "../components/layout/PaneNav";
import {
  isLeadPath,
  type PaneRow,
  type PaneRowMark,
} from "../components/layout/paneRows";
import { cn, dashboardCountClass } from "../styles";
import { LEAD_NAV_KEY } from "../shell/primaryNav";
import { useInboxData } from "./inboxData";
import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  parseInboxView,
  type InboxView,
} from "./inboxModel";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

const ICONS: Record<InboxView, LucideIcon> = {
  conversations: MessagesSquare,
  decisions: MessageCircleQuestion,
  done: CircleCheck,
  inbox: Inbox,
  prs: GitPullRequest,
  snoozed: Clock3,
};

/**
 * The row style that the destinations and the In flight rows share. The
 * list that opened the page keeps the accent text without the fill, so only
 * the page's own row is lit.
 */
export const paneEntryClass = (mark?: PaneRowMark, phone?: boolean) =>
  cn(
    // A count adds its own column, so a row without one gives its title the
    // full width, with no gap left for a count.
    "grid min-w-0 grid-flow-col grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3 font-sans text-sm no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
    phone ? "h-11" : "h-8",
    mark === "page"
      ? "bg-dashboard-accent/[0.12]"
      : "hover:bg-dashboard-fill-hover",
    mark ? "text-dashboard-accent-text" : "text-dashboard-text",
  );

function Entry(props: {
  count?: number;
  icon: LucideIcon;
  label: string;
  phone?: boolean;
  row: PaneRow;
  /** Where the row opens on a phone, where each tap opens its page. */
  phoneTo: string;
  /**
   * Marks the row on a phone, where the entries are their own page. The
   * pane marks the row that owns the page, such as the view that opened a
   * Conversation.
   */
  phoneSelected: boolean;
  /** The count waits on the viewer, so it shows in the row's text color. */
  strong?: boolean;
}) {
  const link = usePaneRowLink(props.row);
  const mark = props.phone
    ? props.phoneSelected
      ? "page"
      : undefined
    : link.mark;
  const Icon = props.icon;
  return (
    <li className="list-none">
      <Link
        // The list that opened the page is current in the pane's set of
        // lists, but it is not the page.
        aria-current={mark === "origin" ? "true" : mark}
        // A count that waits on the viewer reads as one, as the tab title's.
        aria-label={
          props.strong && props.count
            ? `${props.label}, ${props.count} waiting`
            : undefined
        }
        className={paneEntryClass(mark, props.phone)}
        to={props.phone ? props.phoneTo : link.to}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4",
            mark ? "text-current" : "text-dashboard-text-muted",
          )}
          strokeWidth={1.9}
        />
        <span
          className={cn(fadeOverflowClass, "font-medium")}
          ref={fadeWhenOverflowing}
        >
          {props.label}
        </span>
        {props.count ? (
          props.strong ? (
            <span className="text-xs font-semibold tabular-nums">
              {props.count > 99 ? "99+" : props.count}
            </span>
          ) : (
            <span className={cn("text-xs", dashboardCountClass)}>
              {props.count}
            </span>
          )
        ) : null}
      </Link>
    </li>
  );
}

/**
 * The pane's destinations, in one list: the Lead, the Inbox, Snoozed, and
 * Done; then Conversations, Automations, and the primary plugin pages. The
 * Inbox filters its asks by type itself. Each row reopens where the reader
 * left it, and the Inbox and Automations rows count what waits on the viewer.
 */
export function PaneDestinations(props: { phone?: boolean }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const data = useInboxData();
  const navItems = usePaneNavItems();
  const onList =
    pathname === inboxViewPath("inbox") && (!props.phone || params.has("view"));
  const current = onList ? parseInboxView(params.get("view")) : undefined;
  const view = (row: InboxView, strong?: boolean) => (
    <Entry
      count={data.counts[row]}
      icon={ICONS[row]}
      key={row}
      label={INBOX_VIEW_LABELS[row]}
      phone={props.phone}
      // On a phone the Inbox entry needs `?view=`, since `/inbox` alone
      // lists the entries.
      phoneTo={
        row === "inbox"
          ? `${inboxViewPath("inbox")}?view=inbox`
          : inboxViewPath(row)
      }
      row={row}
      phoneSelected={current === row}
      strong={strong}
    />
  );
  // Automations shows where its page does. Primary plugin pages, and Code
  // and System without an account, follow it.
  const automationsItem = navItems.find((item) => item.key === "automations");
  const leadItem = navItems.find((item) => item.key === LEAD_NAV_KEY);
  const pages = navItems.filter(
    (item) =>
      item.key !== "inbox" &&
      item.key !== "automations" &&
      item.key !== LEAD_NAV_KEY,
  );
  return (
    <>
      <ul className="m-0 grid gap-0.5 p-0">
        {leadItem ? (
          <Entry
            icon={navItemIcon(leadItem.key)}
            label={leadItem.label}
            phone={props.phone}
            phoneTo={leadItem.to}
            row={leadItem.key}
            phoneSelected={isLeadPath(pathname, navItems)}
          />
        ) : null}
        {view("inbox", true)}
        {data.signedIn ? (
          <>
            {view("snoozed")}
            {view("done")}
          </>
        ) : null}
      </ul>
      <ul className="m-0 mt-3 grid gap-0.5 border-t border-dashboard-border-subtle p-0 pt-3">
        {view("conversations")}
        {automationsItem ? (
          <Entry
            count={data.counts.automations}
            icon={Zap}
            label={automationsItem.label}
            phone={props.phone}
            phoneTo="/automations"
            row="automations"
            phoneSelected={pathname.startsWith("/automations")}
            strong
          />
        ) : null}
        {pages.map((item) => (
          <Entry
            icon={navItemIcon(item.key)}
            key={item.key}
            label={item.label}
            phone={props.phone}
            phoneTo={item.to}
            row={item.key}
            phoneSelected={
              pathname === item.to || pathname.startsWith(`${item.to}/`)
            }
          />
        ))}
      </ul>
    </>
  );
}
