import {
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
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  spend?: PersonalSpendReport;
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
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;

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
      <PopoverTrigger
        aria-label={`${open ? "Close" : "Open"} profile menu for ${name}. ${personalSpendLabel(spend)}.`}
        className={cn(
          "flex h-12 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-1.5 text-left font-sans text-sm text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
          open && "bg-dashboard-fill-hover",
        )}
        {...hoverTrigger}
      >
        <ProfileAvatar user={identity.user} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-medium leading-tight">{name}</span>
          <SpendSummary spend={spend} />
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted"
          size={14}
          strokeWidth={2}
        />
      </PopoverTrigger>
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
