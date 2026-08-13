import { Menu, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import { MobileSecondaryNavigationSlot } from "./DashboardChrome";
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
  mobileNavigationOpen: boolean;
  navItems: DashboardHeaderNavItem[];
  onMobileNavigationOpenChange(open: boolean): void;
  profile?: ReactNode;
  workspaceActive: boolean;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const onOpenChangeRef = useRef(props.onMobileNavigationOpenChange);
  onOpenChangeRef.current = props.onMobileNavigationOpenChange;

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 font-mono text-xs font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-dashboard-fill-muted", dashboardInteractiveTextClass),
    );
  const sheetLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-lg px-3 py-3 font-mono text-sm font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-dashboard-fill-muted", dashboardInteractiveTextClass),
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = undefined;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [props.mobileNavigationOpen]);

  return (
    <header className="relative border-b border-dashboard-border-faint">
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
        <button
          aria-controls="mobile-navigation"
          aria-expanded={props.mobileNavigationOpen}
          aria-hidden={props.mobileNavigationOpen || undefined}
          aria-label="Open navigation"
          className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-dashboard-fill-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 md:hidden"
          onClick={() => props.onMobileNavigationOpenChange(true)}
          ref={openButtonRef}
          tabIndex={props.mobileNavigationOpen ? -1 : undefined}
          type="button"
        >
          <Menu aria-hidden="true" size={20} strokeWidth={2} />
        </button>
        <Link
          aria-label={`${getDashboardAgentName()} home`}
          className="flex min-w-0 max-w-full items-center justify-self-center text-inherit no-underline md:justify-self-start"
          to="/"
        >
          <JuniorLogo />
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
        {props.profile ? (
          <div className="col-start-3 justify-self-end">{props.profile}</div>
        ) : null}
      </div>
      {props.mobileNavigationOpen ? (
        <div
          aria-label="Navigation"
          aria-modal="true"
          className="fixed inset-0 z-50 flex flex-col bg-dashboard-bg-elevated md:hidden"
          id="mobile-navigation"
          onClick={(event) => {
            // Close on any in-sheet route tap, including the current page.
            if (
              event.target instanceof Element &&
              event.target.closest("a[href]")
            ) {
              onOpenChangeRef.current(false);
            }
          }}
          ref={sheetRef}
          role="dialog"
        >
          <div className="flex items-center justify-between gap-3 border-b border-dashboard-border bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <Link
              aria-label={`${getDashboardAgentName()} home`}
              className="flex min-w-0 items-center text-inherit no-underline"
              to="/"
            >
              <JuniorLogo />
            </Link>
            <button
              aria-label="Close navigation"
              className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-dashboard-fill-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
              data-mobile-nav-close
              onClick={() => props.onMobileNavigationOpenChange(false)}
              type="button"
            >
              <X aria-hidden="true" size={20} strokeWidth={2} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <nav aria-label="Primary" className="grid gap-1">
              <Link
                aria-current={props.workspaceActive ? "page" : undefined}
                className={sheetLinkClass({ isActive: props.workspaceActive })}
                to="/"
              >
                Conversations
              </Link>
              {props.navItems.map((item) => (
                <NavLink className={sheetLinkClass} key={item.key} to={item.to}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <MobileSecondaryNavigationSlot />
          </div>
        </div>
      ) : null}
    </header>
  );
}
