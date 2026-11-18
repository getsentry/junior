import {
  ChevronsUpDown,
  LogOut,
  MessageSquareHeart,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PersonalSpendReport } from "@sentry/junior/api/schema";

import { formatCostSummary, peoplePath } from "../../format";
import { canSendFeedback } from "../../sentry";
import { cn, dashboardInteractiveTextClass } from "../../styles";
import { SIDEBAR_ROW_GRID_CLASS } from "../../components/layout/sidebarGrid";
import type { Identity } from "../../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "../../components/layout/navIcons";
import { ThemeSwitcher } from "../../components/ThemeSwitcher";
import { DensitySwitcher } from "../../conversations/conversationDensity";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "../../components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { FeedbackDialog } from "./FeedbackDialog";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../textFade";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  spend?: PersonalSpendReport | undefined;
  /** Pages that live in this menu instead of the primary nav. */
  pages: DashboardHeaderNavItem[];
  /**
   * `popover` is the profile row at the bottom of the desktop pane.
   * `sheet-spend` is the vertical spend callout at the top of the mobile sheet.
   * `sheet-links` is plain account destinations for the mobile nav sheet.
   * `sheet-identity` is the quiet signed-in strip at the bottom of that sheet.
   */
  variant?: "popover" | "sheet-spend" | "sheet-links" | "sheet-identity";
};

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 140;

function initials(name: string | null | undefined, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  return email.slice(0, 1).toUpperCase();
}

/** Show the viewer's photo, with initials while it loads or when there is none. */
function ProfileAvatar({
  className,
  size,
  user,
}: {
  className?: string;
  size?: "sm";
  user: Identity["user"];
}) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn("border-0 shadow-black/40", className)}
      size={size}
    >
      <AvatarImage alt="User avatar" src={user.avatarUrl} />
      <AvatarFallback className="font-bold tracking-wide">
        {initials(user.name, user.email)}
      </AvatarFallback>
    </Avatar>
  );
}

const SPEND_COUNT_UP_MS = 700;

/**
 * Show one spend total. When the total changes, count up from the last shown
 * value and tint the figure until the count ends.
 */
function SpendAmount({
  compact,
  value,
}: {
  compact?: boolean;
  value?: number | undefined;
}) {
  const [shown, setShown] = useState(value);
  const [counting, setCounting] = useState(false);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (
      value === undefined ||
      from === undefined ||
      from === value ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      shownRef.current = value;
      setShown(value);
      setCounting(false);
      return;
    }

    const startedAt = performance.now();
    let frame = 0;
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / SPEND_COUNT_UP_MS);
      const eased = 1 - (1 - progress) ** 3;
      const next = progress < 1 ? from + (value - from) * eased : value;
      shownRef.current = next;
      setShown(next);
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        setCounting(false);
      }
    };
    setCounting(true);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span
      className={cn(
        "transition-colors duration-700 motion-reduce:transition-none",
        counting && "text-dashboard-accent-text",
      )}
    >
      {shown === undefined ? "—" : formatSpend(shown, compact)}
    </span>
  );
}

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

/** Format a spend total; `compact` shortens $1,000 and up to "$2.1K". */
function formatSpend(total: number, compact?: boolean): string {
  return compact && Math.abs(total) >= 1000
    ? COMPACT_USD.format(total)
    : formatCostSummary({ total });
}

/**
 * The spend meter under the name in the pane footer. Windows with the height
 * show 7d and 30d on two rows with the full amounts; shorter ones fit one
 * compact row. The tooltip keeps the exact amounts in both.
 */
function PaneSpendMeter({ spend }: { spend?: PersonalSpendReport }) {
  const labelClass = "font-medium tracking-[0.08em] text-dashboard-text-muted";
  const amountClass = "font-semibold text-dashboard-text";
  return (
    <span
      className="min-w-0 font-sans text-xs tabular-nums"
      data-spend-meter
      title={personalSpendLabel(spend)}
    >
      <span
        className="hidden grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 pane-tall:grid"
        data-spend-meter-mode="rows"
      >
        <span className={labelClass}>7d</span>
        <span className={amountClass}>
          <SpendAmount value={spend?.sevenDaysUsd} />
        </span>
        <span className={labelClass}>30d</span>
        <span className={amountClass}>
          <SpendAmount value={spend?.thirtyDaysUsd} />
        </span>
      </span>
      <span
        className="flex min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap pane-tall:hidden"
        data-spend-meter-mode="compact"
      >
        <span className={labelClass}>7d</span>
        <span className={amountClass}>
          <SpendAmount compact value={spend?.sevenDaysUsd} />
        </span>
        <span aria-hidden="true" className="text-dashboard-text-faint">
          ·
        </span>
        <span className={labelClass}>30d</span>
        <span className={amountClass}>
          <SpendAmount compact value={spend?.thirtyDaysUsd} />
        </span>
      </span>
    </span>
  );
}

/** Name the 7-day and 30-day spend totals for assistive tech. */
function personalSpendLabel(spend?: PersonalSpendReport): string {
  const total = (value?: number) =>
    value === undefined ? "—" : formatCostSummary({ total: value });
  return `Personal model spend: 7 days ${total(spend?.sevenDaysUsd)}, 30 days ${total(spend?.thirtyDaysUsd)}`;
}

/**
 * Keep the running 7-day and 30-day spend totals in view, in one compact row.
 * `labelled` names the row as a group; leave it off inside a control that
 * already says the spend in its own label.
 */
export function SpendSummary(props: {
  labelled?: boolean;
  spend?: PersonalSpendReport;
}) {
  return (
    <span
      aria-label={props.labelled ? personalSpendLabel(props.spend) : undefined}
      className="flex items-center gap-2 whitespace-nowrap font-sans text-xs tabular-nums"
      role={props.labelled ? "group" : undefined}
    >
      <span className="flex items-baseline gap-1">
        <span className="font-medium tracking-[0.08em] text-dashboard-text-muted">
          7d
        </span>
        <span className="font-semibold text-dashboard-text">
          <SpendAmount value={props.spend?.sevenDaysUsd} />
        </span>
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-dashboard-fill-strong" />
      <span className="flex items-baseline gap-1">
        <span className="font-medium tracking-[0.08em] text-dashboard-text-muted">
          30d
        </span>
        <span className="font-semibold text-dashboard-text">
          <SpendAmount value={props.spend?.thirtyDaysUsd} />
        </span>
      </span>
    </span>
  );
}

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  spend,
  pages,
  variant = "popover",
}: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const email = identity.user.email;
  const name = identity.user.name?.trim() || email;
  // Without a DSN, the dashboard sends no feedback, so it offers none.
  const feedback = canSendFeedback();
  // The menu or the mobile sheet stays mounted under the dialog, so the
  // dialog lives here, not in the closed menu.
  const feedbackDialog = feedbackOpen ? (
    <FeedbackDialog
      onClose={() => setFeedbackOpen(false)}
      reader={identity.user}
    />
  ) : null;

  // Plain content, not a group label: it names no menu items.
  const identityBlock = (
    <div className="px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProfileAvatar className="size-8" user={identity.user} />
        <div className="min-w-0">
          <p
            className={cn(
              fadeOverflowClass,
              "m-0 text-sm font-semibold text-dashboard-text",
            )}
            ref={fadeWhenOverflowing}
          >
            {name}
          </p>
          {name !== email ? (
            <p
              className={cn(
                fadeOverflowClass,
                "mt-0.5 mb-0 text-xs text-dashboard-text-muted",
              )}
              ref={fadeWhenOverflowing}
            >
              {email}
            </p>
          ) : null}
        </div>
      </div>
      <div
        aria-label="Personal model spend"
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-xs tabular-nums text-dashboard-text-muted"
        role="group"
      >
        <span>
          7d{" "}
          <span className="font-semibold text-dashboard-text">
            <SpendAmount value={spend?.sevenDaysUsd} />
          </span>
        </span>
        <span>
          30d{" "}
          <span className="font-semibold text-dashboard-text">
            <SpendAmount value={spend?.thirtyDaysUsd} />
          </span>
        </span>
      </div>
    </div>
  );

  const menuLinks = (
    <>
      <DropdownMenuLinkItem render={<Link to={peoplePath(email)} />}>
        <UserRound aria-hidden="true" />
        My profile
      </DropdownMenuLinkItem>
      {pages.map((page) => {
        const Icon = navItemIcon(page.key);
        return (
          <DropdownMenuLinkItem key={page.key} render={<Link to={page.to} />}>
            <Icon aria-hidden="true" />
            {page.label}
          </DropdownMenuLinkItem>
        );
      })}
      {identity.user.isAdmin ? (
        <DropdownMenuLinkItem render={<Link to="/admin" />}>
          <ShieldCheck aria-hidden="true" />
          Admin
        </DropdownMenuLinkItem>
      ) : null}
      <DropdownMenuLinkItem render={<Link to="/settings" />}>
        <Settings aria-hidden="true" />
        Settings
      </DropdownMenuLinkItem>
      {feedback ? (
        <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
          <MessageSquareHeart aria-hidden="true" />
          Send feedback
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={() => void onSignOut()}>
        <LogOut aria-hidden="true" />
        Log out
      </DropdownMenuItem>
    </>
  );

  if (variant === "sheet-spend") {
    // Vertical mobile callout pinned above every sheet destination.
    return (
      <div
        aria-label={personalSpendLabel(spend)}
        className="grid gap-1.5 rounded-lg border border-dashboard-border bg-dashboard-fill-soft px-3 py-2.5 font-sans text-xs tabular-nums text-dashboard-text-muted"
      >
        <span className="text-xs font-medium">Spend</span>
        <span className="whitespace-nowrap">
          7d{" "}
          <span className="font-semibold text-dashboard-text">
            <SpendAmount value={spend?.sevenDaysUsd} />
          </span>
        </span>
        <span className="whitespace-nowrap">
          30d{" "}
          <span className="font-semibold text-dashboard-text">
            <SpendAmount value={spend?.thirtyDaysUsd} />
          </span>
        </span>
      </div>
    );
  }

  if (variant === "sheet-links") {
    // Match primary sheet rows exactly.
    const sheetItemClass = cn(
      "rounded-lg border-0 bg-transparent px-3 py-3 text-left font-sans text-sm font-medium no-underline transition-colors hover:bg-dashboard-fill-soft focus-visible:bg-dashboard-fill-soft focus-visible:outline-none",
      dashboardInteractiveTextClass,
    );
    return (
      <nav aria-label={`Account menu for ${name}`} className="grid gap-1">
        <Link className={sheetItemClass} to={peoplePath(email)}>
          My profile
        </Link>
        {pages.map((page) => (
          <Link className={sheetItemClass} key={page.key} to={page.to}>
            {page.label}
          </Link>
        ))}
        {identity.user.isAdmin ? (
          <Link className={sheetItemClass} to="/admin">
            Admin
          </Link>
        ) : null}
        <Link className={sheetItemClass} to="/settings">
          Settings
        </Link>
        {feedback ? (
          <button
            className={cn(sheetItemClass, "w-full cursor-pointer")}
            onClick={() => setFeedbackOpen(true)}
            type="button"
          >
            Send feedback
          </button>
        ) : null}
        <button
          className={cn(sheetItemClass, "w-full cursor-pointer")}
          data-mobile-nav-dismiss
          onClick={() => {
            void onSignOut();
          }}
          type="button"
        >
          Log out
        </button>
        <ThemeSwitcher className="px-3 py-2" />
        <DensitySwitcher className="px-3 py-2" />
        {feedbackDialog}
      </nav>
    );
  }

  if (variant === "sheet-identity") {
    return (
      <div
        aria-label={`Signed in as ${name}`}
        className="flex min-w-0 items-center gap-2.5 px-1"
      >
        <ProfileAvatar user={identity.user} />
        <div className="min-w-0">
          <p
            className={cn(
              fadeOverflowClass,
              "m-0 text-xs font-semibold text-dashboard-text",
            )}
            ref={fadeWhenOverflowing}
          >
            {name}
          </p>
          {name !== email ? (
            <p
              className={cn(
                fadeOverflowClass,
                "mt-0.5 mb-0 font-sans text-xs text-dashboard-text-muted",
              )}
              ref={fadeWhenOverflowing}
            >
              {email}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const hoverTrigger = {
    closeDelay: HOVER_CLOSE_DELAY_MS,
    delay: HOVER_OPEN_DELAY_MS,
    openOnHover: true,
  };
  return (
    // Not modal, so the page keeps scrolling while the menu is open.
    <DropdownMenu
      modal={false}
      onOpenChange={(nextOpen, details) => {
        // A mouse click always keeps the menu open, also after hover opened it.
        // A keyboard press (detail 0) still toggles it.
        const mouseClick =
          details.event instanceof MouseEvent && details.event.detail > 0;
        if (!nextOpen && details.reason === "trigger-press" && mouseClick) {
          return;
        }
        setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label={`${open ? "Close" : "Open"} profile menu for ${name}. ${personalSpendLabel(spend)}.`}
        className={cn(
          // The sidebar row grid: the avatar on the icon axis, the name on
          // the label edge, the chevron on the right content edge.
          SIDEBAR_ROW_GRID_CLASS,
          "min-h-12 w-full min-w-0 cursor-pointer items-center rounded-lg py-1.5 border-0 bg-transparent text-left font-sans text-sm text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
          open && "bg-dashboard-fill-hover",
        )}
        {...hoverTrigger}
      >
        <ProfileAvatar
          className="justify-self-center"
          size="sm"
          user={identity.user}
        />
        <span className="grid min-w-0 gap-0.5">
          <span
            className={cn(fadeOverflowClass, "font-medium leading-tight")}
            ref={fadeWhenOverflowing}
          >
            {name}
          </span>
          <PaneSpendMeter spend={spend} />
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted"
          size={14}
          strokeWidth={2}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="right"
        sideOffset={8}
        className="w-64"
        id="profile-popover"
      >
        {identityBlock}
        <DropdownMenuSeparator />
        <div className="grid gap-1 px-2 py-1.5">
          <ThemeSwitcher menu />
          <DensitySwitcher menu />
        </div>
        <DropdownMenuSeparator />
        {menuLinks}
      </DropdownMenuContent>
      {feedbackDialog}
    </DropdownMenu>
  );
}
