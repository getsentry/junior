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

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  spend,
  userPages,
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
    if (!open) return;

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
  }, [open]);

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
        <span className="hidden items-center gap-2 sm:flex">
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
            "text-dashboard-text-muted transition-[color,transform] group-hover:text-dashboard-text",
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
          <div className="border-b border-white/10 px-2.5 py-2.5">
            <p className="m-0 truncate text-sm font-semibold text-dashboard-text">
              {name}
            </p>
            {name !== email ? (
              <p className="mt-1 mb-0 truncate text-xs text-dashboard-text-muted">
                {email}
              </p>
            ) : null}
          </div>
          <Link
            className="mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-semibold text-dashboard-text no-underline transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
            onClick={() => setOpen(false)}
            to={peoplePath(email)}
          >
            <UserRound aria-hidden="true" size={16} strokeWidth={2} />
            My profile
          </Link>
          <Link
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-semibold text-dashboard-text no-underline transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
            onClick={() => setOpen(false)}
            to="/settings"
          >
            <Settings aria-hidden="true" size={16} strokeWidth={2} />
            Settings
          </Link>
          <Link
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-semibold text-dashboard-text no-underline transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
            onClick={() => setOpen(false)}
            to="/settings/api-tokens"
          >
            <KeyRound aria-hidden="true" size={16} strokeWidth={2} />
            API tokens
          </Link>
          {userPages
            .filter((page) => page.navigation === "profile")
            .map((page) => (
              <Link
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-semibold text-dashboard-text no-underline transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
                key={`${page.pluginName}:${page.id}`}
                onClick={() => setOpen(false)}
                to={pluginUserPagePath(page.pluginName, page.id)}
              >
                <Boxes aria-hidden="true" size={16} strokeWidth={2} />
                {page.label}
              </Link>
            ))}
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 hover:text-dashboard-text focus-visible:bg-white/10 focus-visible:text-dashboard-text focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            type="button"
          >
            <LogOut aria-hidden="true" size={16} strokeWidth={2} />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}
