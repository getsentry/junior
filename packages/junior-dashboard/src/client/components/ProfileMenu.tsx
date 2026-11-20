import {
  ChevronDown,
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PersonalSpendReport } from "@sentry/junior/api/schema";

import { formatCostSummary, peoplePath } from "../format";
import { cn, dashboardInteractiveTextClass } from "../styles";
import type { Identity } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { NavLayoutSwitcher } from "./NavLayoutSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  spend?: PersonalSpendReport | undefined;
  /** Pages that live in this menu instead of the primary nav. */
  pages: DashboardHeaderNavItem[];
  /**
   * `popover` is the profile row at the bottom of the desktop nav sidebar.
   * It shows only the avatar while the sidebar is collapsed.
   * `top-bar` is the spend and avatar control in the desktop top bar.
   * `sheet-spend` is the vertical spend callout at the top of the mobile sheet.
   * `sheet-links` is plain account destinations for the mobile nav sheet.
   * `sheet-identity` is the quiet signed-in strip at the bottom of that sheet.
   */
  variant?:
    | "popover"
    | "top-bar"
    | "sheet-spend"
    | "sheet-links"
    | "sheet-identity";
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
  user,
}: {
  className?: string;
  user: Identity["user"];
}) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn("border-0 shadow-black/40", className)}
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
function SpendAmount({ value }: { value?: number | undefined }) {
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
      {shown === undefined ? "—" : formatCostSummary({ total: shown })}
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
  const email = identity.user.email;
  const name = identity.user.name?.trim() || email;
  const sevenDaySpend = spend
    ? formatCostSummary({ total: spend.sevenDaysUsd })
    : "—";
  const thirtyDaySpend = spend
    ? formatCostSummary({ total: spend.thirtyDaysUsd })
    : "—";

  // Plain content, not a group label: it names no menu items.
  const identityBlock = (
    <div className="px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProfileAvatar className="size-8" user={identity.user} />
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-semibold text-dashboard-text">
            {name}
          </p>
          {name !== email ? (
            <p className="mt-0.5 mb-0 truncate text-xs text-dashboard-text-muted">
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
      <DropdownMenuLinkItem render={<Link to="/settings" />}>
        <Settings aria-hidden="true" />
        Settings
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
        aria-label={`Personal model spend: 7 days ${sevenDaySpend}, 30 days ${thirtyDaySpend}`}
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
        <Link className={sheetItemClass} to="/settings">
          Settings
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
          <p className="m-0 truncate text-xs font-semibold text-dashboard-text">
            {name}
          </p>
          {name !== email ? (
            <p className="mt-0.5 mb-0 truncate font-sans text-xs text-dashboard-text-muted">
              {email}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const topBar = variant === "top-bar";
  const menuLabel = `${open ? "Close" : "Open"} profile menu for ${name}`;
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
      {topBar ? (
        <DropdownMenuTrigger
          aria-label={`${menuLabel}. Personal model spend: 7 days ${sevenDaySpend}, 30 days ${thirtyDaySpend}.`}
          className={cn(
            "group flex h-10 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 text-dashboard-text transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
            open && "bg-dashboard-fill-hover text-dashboard-text",
          )}
          {...hoverTrigger}
        >
          <span className="flex items-center gap-2">
            <span className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
              <span className="text-xs font-medium tracking-[0.08em] text-dashboard-text-muted">
                7d
              </span>
              <span className="text-xs font-semibold text-dashboard-text">
                <SpendAmount value={spend?.sevenDaysUsd} />
              </span>
            </span>
            <span
              aria-hidden="true"
              className="h-3 w-px bg-dashboard-fill-strong"
            />
            <span className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
              <span className="text-xs font-medium tracking-[0.08em] text-dashboard-text-muted">
                30d
              </span>
              <span className="text-xs font-semibold text-dashboard-text">
                <SpendAmount value={spend?.thirtyDaysUsd} />
              </span>
            </span>
          </span>
          <ProfileAvatar user={identity.user} />
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "text-dashboard-text-muted transition-[color,transform] group-hover:text-dashboard-text",
              open && "rotate-180 text-dashboard-text",
            )}
            size={14}
            strokeWidth={2}
          />
        </DropdownMenuTrigger>
      ) : (
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={menuLabel}
            className={cn(
              // The collapsed nav sidebar shows only the avatar.
              "h-10 gap-2.5 rounded-lg px-1.5 group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! [&_svg]:size-3.5",
              open && "bg-sidebar-accent",
            )}
            render={<DropdownMenuTrigger {...hoverTrigger} />}
          >
            <ProfileAvatar user={identity.user} />
            <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">
              {name}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="text-dashboard-text-muted group-data-[collapsible=icon]:hidden"
              strokeWidth={2}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      <DropdownMenuContent
        align="end"
        side={topBar ? "bottom" : "right"}
        sideOffset={8}
        className="w-64"
        id="profile-popover"
      >
        {identityBlock}
        <DropdownMenuSeparator />
        <div className="grid gap-1 px-2 py-1.5">
          <ThemeSwitcher menu />
          <NavLayoutSwitcher menu />
        </div>
        <DropdownMenuSeparator />
        {menuLinks}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
