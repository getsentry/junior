import {
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import type { PersonalSpendReport } from "@sentry/junior/api/schema";

import { formatCostSummary, peoplePath } from "../format";
import { cn, dashboardInteractiveTextClass } from "../styles";
import type { Identity } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  spend?: PersonalSpendReport;
  /** Pages that live in this menu instead of the primary nav. */
  pages: DashboardHeaderNavItem[];
  /**
   * `popover` is the profile and spend row at the bottom of the desktop
   * sidebar. It shows only the avatar while the sidebar is collapsed.
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
        {initials(user.name, user.email!)}
      </AvatarFallback>
    </Avatar>
  );
}

const SPEND_COUNT_UP_MS = 700;

/**
 * Show one spend total. When the total changes, count up from the last shown
 * value and tint the figure until the count ends.
 */
function SpendAmount({ value }: { value?: number }) {
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

const profileLinkClass = buttonVariants({ size: "menu" });

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  spend,
  pages,
  variant = "popover",
}: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const spendId = useId();
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;
  const sevenDaySpend = spend
    ? formatCostSummary({ total: spend.sevenDaysUsd })
    : "—";
  const thirtyDaySpend = spend
    ? formatCostSummary({ total: spend.thirtyDaysUsd })
    : "—";

  const identityBlock = (
    <div className="border-b border-dashboard-border-strong px-2.5 py-2.5">
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
    </div>
  );

  const menuLinks = (close: () => void) => (
    <>
      <Link
        className={cn(profileLinkClass, "mt-1")}
        onClick={close}
        to={peoplePath(email)}
      >
        <UserRound aria-hidden="true" size={16} strokeWidth={2} />
        My profile
      </Link>
      <Link className={profileLinkClass} onClick={close} to="/settings">
        <Settings aria-hidden="true" size={16} strokeWidth={2} />
        Settings
      </Link>
      {pages.map((page) => {
        const Icon = navItemIcon(page.key);
        return (
          <Link
            className={profileLinkClass}
            key={page.key}
            onClick={close}
            to={page.to}
          >
            <Icon aria-hidden="true" size={16} strokeWidth={2} />
            {page.label}
          </Link>
        );
      })}
      {identity.user.isAdmin ? (
        <Link className={profileLinkClass} onClick={close} to="/admin">
          <ShieldCheck aria-hidden="true" size={16} strokeWidth={2} />
          Admin
        </Link>
      ) : null}
      <Button
        onClick={() => {
          close();
          void onSignOut();
        }}
        size="menu"
      >
        <LogOut aria-hidden="true" size={16} strokeWidth={2} />
        Log out
      </Button>
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

  const menuLabel = `${open ? "Close" : "Open"} profile menu for ${name}`;
  const hoverTrigger = {
    closeDelay: HOVER_CLOSE_DELAY_MS,
    delay: HOVER_OPEN_DELAY_MS,
    openOnHover: true,
  };
  return (
    <Popover
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
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-describedby={spendId}
          aria-label={menuLabel}
          className={cn(
            // The collapsed sidebar shows only the avatar.
            "h-12 gap-2.5 rounded-lg px-1.5 group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! [&_svg]:size-3.5",
            open && "bg-sidebar-accent",
          )}
          render={<PopoverTrigger {...hoverTrigger} />}
        >
          <ProfileAvatar user={identity.user} />
          {/* Spend stays in view on every page, under the name. */}
          <span className="grid min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">{name}</span>
            <span
              aria-label={`Personal model spend: 7 days ${sevenDaySpend}, 30 days ${thirtyDaySpend}`}
              className="flex gap-2 font-sans text-xs tabular-nums text-dashboard-text-muted"
              id={spendId}
            >
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
            </span>
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="text-dashboard-text-muted group-data-[collapsible=icon]:hidden"
            strokeWidth={2}
          />
        </SidebarMenuButton>
      </SidebarMenuItem>
      <PopoverContent
        align="end"
        side="right"
        className="w-64 rounded-xl border-0 bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl"
        id="profile-popover"
      >
        {identityBlock}
        <div className="grid gap-1 border-b border-dashboard-border-strong px-2.5 py-2">
          <ThemeSwitcher />
        </div>
        {menuLinks(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}
