import { ArrowLeft, Menu, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
} from "../../bodyScrollLock";
import { JuniorLogo } from "../JuniorLogo";
import {
  MobileHeaderActionsSlot,
  MobileHeaderLiveSlot,
  MobileSecondaryNavigationSlot,
  useRegisterOpenMobileNavigation,
} from "./DashboardChrome";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";

export type DashboardHeaderNavItem = {
  key: string;
  label: string;
  to: string;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Render the primary dashboard shell header and optional mobile nav sheet. */
export function DashboardHeader(props: {
  compact?: boolean;
  /** Back target used on mobile conversation detail. */
  mobileBackTo?: string;
  mobileNavigationOpen: boolean;
  mobileTitle?: string;
  /** Quiet signed-in strip pinned above the sheet version footer. */
  mobileIdentity?: ReactNode;
  /** Plain account destinations inside the mobile navigation sheet. */
  mobileProfile?: ReactNode;
  /** Vertical spend callout pinned above every mobile sheet destination. */
  mobileSpend?: ReactNode;
  navItems: DashboardHeaderNavItem[];
  onMobileNavigationOpenChange(open: boolean): void;
  /** Compact desktop header control. */
  profile?: ReactNode;
  version?: string;
  workspaceActive: boolean;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const onOpenChangeRef = useRef(props.onMobileNavigationOpenChange);
  onOpenChangeRef.current = props.onMobileNavigationOpenChange;
  // Conversation chrome is path-driven. Undefined title keeps the loading
  // fallback; explicit empty string means no title (create compose).
  const conversationMode = Boolean(props.mobileBackTo);
  const mobileTitle =
    props.mobileTitle === undefined
      ? "Conversation"
      : props.mobileTitle.trim();

  useRegisterOpenMobileNavigation(() => {
    onOpenChangeRef.current(true);
  });

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 font-mono text-xs font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );
  const sheetLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-lg px-3 py-3 font-mono text-sm font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );

  useEffect(() => {
    if (!props.mobileNavigationOpen) return;

    // md:hidden only hides the sheet; clear open state so locks do not stick.
    const mobile = window.matchMedia("(max-width: 767px)");
    const closeWhenDesktop = () => {
      if (!mobile.matches) onOpenChangeRef.current(false);
    };
    closeWhenDesktop();
    mobile.addEventListener("change", closeWhenDesktop);

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : (openButtonRef.current ?? undefined);
    acquireBodyScrollLock();
    const focusFrame = requestAnimationFrame(() => {
      sheetRef.current
        ?.querySelector<HTMLElement>("[data-mobile-nav-close]")
        ?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      const focusable = Array.from(
        sheet?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!sheet || !first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !sheet.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      mobile.removeEventListener("change", closeWhenDesktop);
      window.removeEventListener("keydown", onKeyDown);
      releaseBodyScrollLock();
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = undefined;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [props.mobileNavigationOpen]);

  return (
    <header className="relative border-b border-white/[0.05]">
      <div
        className={cn(
          dashboardContainerClass,
          "grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 px-3 py-2 md:gap-x-5 md:gap-y-3 md:px-4 md:py-4",
          props.profile
            ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
            : "md:grid-cols-[auto_minmax(0,1fr)]",
          props.compact ? "md:px-4" : "md:px-8",
        )}
      >
        {conversationMode && props.mobileBackTo ? (
          <Link
            aria-label="Back to conversations"
            className="grid size-10 place-items-center rounded-lg text-dashboard-text no-underline transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70 md:hidden"
            to={props.mobileBackTo}
          >
            <ArrowLeft aria-hidden="true" size={20} strokeWidth={2} />
          </Link>
        ) : (
          <button
            aria-controls="mobile-navigation"
            aria-expanded={props.mobileNavigationOpen}
            aria-hidden={props.mobileNavigationOpen || undefined}
            aria-label="Open navigation"
            className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70 md:hidden"
            onClick={() => props.onMobileNavigationOpenChange(true)}
            ref={openButtonRef}
            tabIndex={props.mobileNavigationOpen ? -1 : undefined}
            type="button"
          >
            <Menu aria-hidden="true" size={20} strokeWidth={2} />
          </button>
        )}
        {conversationMode ? (
          <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-2 md:hidden">
            {mobileTitle ? (
              <h1 className="m-0 min-w-0 truncate text-left font-display text-sm font-medium text-dashboard-text">
                {mobileTitle}
              </h1>
            ) : null}
            <MobileHeaderLiveSlot />
          </div>
        ) : null}
        <Link
          aria-label={`${getDashboardAgentName()} home`}
          className={cn(
            "col-start-2 row-start-1 min-w-0 max-w-full items-center justify-self-center text-inherit no-underline md:col-start-1 md:flex md:justify-self-start",
            conversationMode ? "hidden" : "flex",
          )}
          to="/"
        >
          <span className="truncate font-mono text-sm font-semibold md:hidden">
            {getDashboardAgentName()}
          </span>
          <span className="hidden md:block">
            <JuniorLogo />
          </span>
        </Link>
        <nav
          aria-label="Primary"
          className="hidden min-w-0 items-center gap-1 md:col-start-2 md:flex md:justify-self-start"
        >
          <Link
            aria-current={props.workspaceActive ? "page" : undefined}
            className={navLinkClass({ isActive: props.workspaceActive })}
            to="/"
          >
            Conversations
          </Link>
          {props.navItems.map((item) => (
            <NavLink className={navLinkClass} key={item.key} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        {conversationMode ? <MobileHeaderActionsSlot /> : null}
        {props.profile ? (
          <div className="col-start-3 hidden justify-self-end md:block">
            {props.profile}
          </div>
        ) : null}
      </div>
      {props.mobileNavigationOpen ? (
        <div
          aria-label="Navigation"
          aria-modal="true"
          className="fixed inset-0 z-50 flex flex-col bg-[#070707] md:hidden"
          id="mobile-navigation"
          onClick={(event) => {
            // Close on route taps and sheet actions such as Log out.
            if (
              event.target instanceof Element &&
              event.target.closest("a[href], [data-mobile-nav-dismiss]")
            ) {
              onOpenChangeRef.current(false);
            }
          }}
          ref={sheetRef}
          role="dialog"
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <Link
              aria-label={`${getDashboardAgentName()} home`}
              className="min-w-0 truncate font-mono text-sm font-semibold text-inherit no-underline"
              to="/"
            >
              {getDashboardAgentName()}
            </Link>
            <button
              aria-label="Close navigation"
              className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70"
              data-mobile-nav-close
              onClick={() => props.onMobileNavigationOpenChange(false)}
              type="button"
            >
              <X aria-hidden="true" size={20} strokeWidth={2} />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              {props.mobileSpend ? (
                <div className="mb-3">{props.mobileSpend}</div>
              ) : null}
              <nav aria-label="Primary" className="grid gap-1">
                <Link
                  aria-current={props.workspaceActive ? "page" : undefined}
                  className={sheetLinkClass({
                    isActive: props.workspaceActive,
                  })}
                  to="/"
                >
                  Conversations
                </Link>
                {props.navItems.map((item) => (
                  <NavLink
                    className={sheetLinkClass}
                    key={item.key}
                    to={item.to}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <MobileSecondaryNavigationSlot />
              {props.mobileProfile ? (
                <div className="mt-4 border-t border-white/[0.07] pt-3">
                  {props.mobileProfile}
                </div>
              ) : null}
            </div>
            {props.mobileIdentity || props.version ? (
              <div className="border-t border-white/[0.07] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {props.mobileIdentity ? (
                  <div className={props.version ? "mb-2.5" : undefined}>
                    {props.mobileIdentity}
                  </div>
                ) : null}
                {props.version ? (
                  <p className="m-0 font-mono text-xs text-dashboard-text-muted">
                    junior version {props.version}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
