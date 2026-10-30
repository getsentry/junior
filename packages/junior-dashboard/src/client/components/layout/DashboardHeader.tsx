import { ArrowLeft, Menu, X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Link, NavLink } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import { Sheet, SheetClose, SheetContent } from "../ui/sheet";
import { useSheet } from "../ui/useSheet";
import {
  MobileHeaderActionsSlot,
  MobileHeaderLiveSlot,
  MobileSecondaryNavigationSlot,
  useRegisterOpenMobileNavigation,
} from "./DashboardChrome";
import { cn, dashboardInteractiveTextClass } from "../../styles";

export type DashboardHeaderNavItem = {
  /** Shown beside the label when it is above zero. */
  count?: number;
  key: string;
  label: string;
  to: string;
};

function NavCount(props: { count?: number }) {
  if (!props.count) return null;
  return (
    <span className="ml-1.5 rounded-full bg-violet-300/20 px-1.5 py-0.5 text-xs text-violet-200">
      {props.count.toLocaleString("en-US")}
    </span>
  );
}

/** Render the primary dashboard shell header and optional mobile nav sheet. */
export function DashboardHeader(props: {
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(props.onMobileNavigationOpenChange);
  onOpenChangeRef.current = props.onMobileNavigationOpenChange;
  // Conversation chrome is path-driven. Undefined title keeps the loading
  // fallback; explicit empty string means no title (create compose).
  const conversationMode = Boolean(props.mobileBackTo);
  const mobileTitle =
    props.mobileTitle === undefined ? "Conversation" : props.mobileTitle.trim();

  useRegisterOpenMobileNavigation(() => {
    onOpenChangeRef.current(true);
  });

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 font-sans text-sm font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-dashboard-accent/[0.1] text-dashboard-accent-text"
        : cn("hover:bg-dashboard-fill-soft", dashboardInteractiveTextClass),
    );
  const sheetLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-lg px-3 py-3 font-sans text-sm font-medium no-underline transition-colors",
      isActive
        ? "bg-dashboard-accent/[0.1] text-dashboard-accent-text"
        : cn("hover:bg-dashboard-fill-soft", dashboardInteractiveTextClass),
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
    return () => mobile.removeEventListener("change", closeWhenDesktop);
  }, [props.mobileNavigationOpen]);

  return (
    <header className="relative bg-dashboard-bg">
      <div
        className={cn(
          "grid w-full min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 px-3 py-2 md:gap-x-5 md:gap-y-3 md:px-7 md:py-3",
          props.profile
            ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
            : "md:grid-cols-[auto_minmax(0,1fr)]",
        )}
      >
        {conversationMode && props.mobileBackTo ? (
          <Link
            aria-label="Back to conversations"
            className="grid size-10 place-items-center rounded-lg text-dashboard-text no-underline transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 md:hidden"
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
            className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 md:hidden"
            onClick={() => props.onMobileNavigationOpenChange(true)}
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
          <span className="truncate font-sans text-sm font-semibold md:hidden">
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
              <NavCount count={item.count} />
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
        <MobileNavigationSheet
          closeRef={closeRef}
          onClose={() => onOpenChangeRef.current(false)}
        >
          <div className="flex items-center justify-between gap-3 border-b border-dashboard-border-subtle bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <Link
              aria-label={`${getDashboardAgentName()} home`}
              className="min-w-0 truncate font-sans text-sm font-semibold text-inherit no-underline"
              to="/"
            >
              {getDashboardAgentName()}
            </Link>
            <SheetClose
              aria-label="Close navigation"
              className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
              ref={closeRef}
            >
              <X aria-hidden="true" size={20} strokeWidth={2} />
            </SheetClose>
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
                    <NavCount count={item.count} />
                  </NavLink>
                ))}
              </nav>
              <MobileSecondaryNavigationSlot />
              {props.mobileProfile ? (
                <div className="mt-4 border-t border-dashboard-border-subtle pt-3">
                  {props.mobileProfile}
                </div>
              ) : null}
            </div>
            {props.mobileIdentity || props.version ? (
              <div className="border-t border-dashboard-border-subtle px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {props.mobileIdentity ? (
                  <div className={props.version ? "mb-2.5" : undefined}>
                    {props.mobileIdentity}
                  </div>
                ) : null}
                {props.version ? (
                  <p className="m-0 font-sans text-xs text-dashboard-text-muted">
                    junior version {props.version}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </MobileNavigationSheet>
      ) : null}
    </header>
  );
}

/** Show the mobile navigation in a full-screen shared sheet. */
function MobileNavigationSheet(props: {
  children: ReactNode;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const sheet = useSheet(props.onClose, props.closeRef);
  return (
    <Sheet {...sheet.rootProps}>
      <SheetContent
        {...sheet.contentProps}
        aria-label="Navigation"
        className="inset-0 gap-0 bg-dashboard-bg-elevated outline-none data-[side=left]:w-full data-[side=left]:border-r-0 data-[side=left]:sm:max-w-none md:hidden"
        id="mobile-navigation"
        onClick={(event) => {
          // Close on route taps and sheet actions such as Log out.
          if (
            event.target instanceof Element &&
            event.target.closest("a[href], [data-mobile-nav-dismiss]")
          ) {
            props.onClose();
          }
        }}
        showCloseButton={false}
        side="left"
      >
        {props.children}
      </SheetContent>
    </Sheet>
  );
}
