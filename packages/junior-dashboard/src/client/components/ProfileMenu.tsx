import {
  Boxes,
  ChevronDown,
  KeyRound,
  LogOut,
  Settings,
  UserRound,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link } from "react-router";
import type { PersonalSpendReport } from "@sentry/junior/api/schema";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { formatCostSummary, peoplePath } from "../format";
import { pluginUserPagePath } from "../pages/user/PluginUserPage";
import { cn } from "../styles";
import type { Identity } from "../types";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  spend?: PersonalSpendReport;
  userPages: PluginUserPageLink[];
  /**
   * `popover` is the desktop header control.
   * `sheet-links` is plain account destinations for the mobile nav sheet.
   * `sheet-identity` is the quiet signed-in strip at the bottom of that sheet.
   */
  variant?: "popover" | "sheet-links" | "sheet-identity";
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

const profileLinkClass =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-semibold text-dashboard-text no-underline transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none";

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  spend,
  userPages,
  variant = "popover",
}: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;
  const sevenDaySpend = spend
    ? formatCostSummary({ total: spend.sevenDaysUsd })
    : "—";
  const thirtyDaySpend = spend
    ? formatCostSummary({ total: spend.thirtyDaysUsd })
    : "—";
  const profilePages = userPages.filter((page) => page.navigation === "profile");

  function clearHoverTimers() {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = undefined;
    closeTimerRef.current = undefined;
  }

  function openOnHover(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    clearHoverTimers();
    openTimerRef.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }

  function closeOnHover(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    clearHoverTimers();
    closeTimerRef.current = setTimeout(
      () => setOpen(false),
      HOVER_CLOSE_DELAY_MS,
    );
  }

  useEffect(() => clearHoverTimers, []);

  useEffect(() => {
    if (variant !== "popover" || !open) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, variant]);

  const avatar = (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-full bg-[#beaaff] text-xs font-bold tracking-wide text-black shadow-sm shadow-black/40"
    >
      {initials(identity.user.name, email)}
    </span>
  );

  const identityBlock = (
    <div className="border-b border-white/10 px-2.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {avatar}
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
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-dashboard-text-muted">
        <span>
          7d{" "}
          <span className="font-semibold text-dashboard-text">
            {sevenDaySpend}
          </span>
        </span>
        <span>
          30d{" "}
          <span className="font-semibold text-dashboard-text">
            {thirtyDaySpend}
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
      <Link
        className={profileLinkClass}
        onClick={close}
        to="/settings/api-tokens"
      >
        <KeyRound aria-hidden="true" size={16} strokeWidth={2} />
        API tokens
      </Link>
      {profilePages.map((page) => (
        <Link
          className={profileLinkClass}
          key={`${page.pluginName}:${page.id}`}
          onClick={close}
          to={pluginUserPagePath(page.pluginName, page.id)}
        >
          <Boxes aria-hidden="true" size={16} strokeWidth={2} />
          {page.label}
        </Link>
      ))}
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
        onClick={() => {
          close();
          void onSignOut();
        }}
        type="button"
      >
        <LogOut aria-hidden="true" size={16} strokeWidth={2} />
        Log out
      </button>
    </>
  );

  if (variant === "sheet-links") {
    // Mobile drawer prior art (Gmail/Linear/Material): plain destination rows
    // matching primary nav. No purple hero avatar, spend card, or icon stack.
    const sheetItemClass =
      "rounded-lg border-0 bg-transparent px-3 py-3 text-left font-mono text-sm font-medium tracking-normal text-dashboard-text no-underline transition-colors hover:bg-white/[0.035] focus-visible:bg-white/[0.035] focus-visible:outline-none";
    return (
      <nav aria-label={`Account menu for ${name}`} className="grid gap-1">
        <Link className={sheetItemClass} to={peoplePath(email)}>
          My profile
        </Link>
        <Link className={sheetItemClass} to="/settings">
          Settings
        </Link>
        <Link className={sheetItemClass} to="/settings/api-tokens">
          API tokens
        </Link>
        {profilePages.map((page) => (
          <Link
            className={sheetItemClass}
            key={`${page.pluginName}:${page.id}`}
            to={pluginUserPagePath(page.pluginName, page.id)}
          >
            {page.label}
          </Link>
        ))}
        <button
          className={cn(sheetItemClass, "w-full cursor-pointer")}
          onClick={() => {
            void onSignOut();
          }}
          type="button"
        >
          Log out
        </button>
      </nav>
    );
  }

  if (variant === "sheet-identity") {
    return (
      <div
        aria-label={`Signed in as ${name}`}
        className="flex min-w-0 items-center gap-2.5 px-1"
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] text-[10px] font-semibold tracking-wide text-dashboard-text-muted"
        >
          {initials(identity.user.name, email)}
        </span>
        <div className="min-w-0">
          <p className="m-0 truncate text-xs font-medium text-dashboard-text">
            {name}
          </p>
          {name !== email ? (
            <p className="mt-0.5 mb-0 truncate font-mono text-[11px] text-dashboard-text-muted">
              {email}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onPointerEnter={openOnHover}
      onPointerLeave={closeOnHover}
      ref={rootRef}
    >
      <button
        aria-controls="profile-popover"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${open ? "Close" : "Open"} profile menu for ${name}. Personal model spend: 7 days ${sevenDaySpend}, 30 days ${thirtyDaySpend}.`}
        className={cn(
          "group flex h-10 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 text-dashboard-text transition-colors hover:bg-white/[0.06] hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70",
          open && "bg-white/[0.08] text-dashboard-text",
        )}
        onClick={(event) => {
          clearHoverTimers();
          setOpen(event.detail === 0 ? (value) => !value : true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="hidden items-center gap-2 md:flex">
          <span className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
            <span className="text-xs font-medium tracking-[0.08em] text-dashboard-text-muted">
              7d
            </span>
            <span className="text-xs font-semibold text-dashboard-text">
              {sevenDaySpend}
            </span>
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-white/10" />
          <span className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
            <span className="text-xs font-medium tracking-[0.08em] text-dashboard-text-muted">
              30d
            </span>
            <span className="text-xs font-semibold text-dashboard-text">
              {thirtyDaySpend}
            </span>
          </span>
        </span>
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-full bg-[#beaaff] text-xs font-bold tracking-wide text-black shadow-sm shadow-black/40"
        >
          {initials(identity.user.name, email)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "hidden text-dashboard-text-muted transition-[color,transform] group-hover:text-dashboard-text md:block",
            open && "rotate-180 text-dashboard-text",
          )}
          size={14}
          strokeWidth={2}
        />
      </button>

      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl"
          id="profile-popover"
        >
          {identityBlock}
          {menuLinks(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
