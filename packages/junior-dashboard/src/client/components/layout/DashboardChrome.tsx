import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

/**
 * Replaces the mobile header back link while a page shows a nested view, or
 * a Conversation that has no route yet. `title` names it when the route
 * cannot. Without `onClick`, back shows but waits.
 */
type MobileHeaderBack = {
  label: string;
  onClick?(): void;
  title?: string | undefined;
};

type DashboardChromeContextValue = {
  mobileHeaderBack: MobileHeaderBack | null;
  mobileHeaderActionsSlot: HTMLElement | null;
  mobileHeaderActionsSlotRef: RefCallback<HTMLDivElement>;
  mobileHeaderTitleSlot: HTMLElement | null;
  mobileHeaderTitleSlotRef: RefCallback<HTMLDivElement>;
  mobileSecondarySlot: HTMLElement | null;
  mobileSecondarySlotRef: RefCallback<HTMLDivElement>;
  secondarySlot: HTMLElement | null;
  secondarySlotRef: RefCallback<HTMLDivElement>;
  setMobileHeaderBack(back: MobileHeaderBack | null): void;
};

const DashboardChromeContext =
  createContext<DashboardChromeContextValue | null>(null);

/** Provide the sticky chrome slot used by page secondary navigation. */
export function DashboardChromeProvider(props: { children: ReactNode }) {
  const [secondarySlot, setSecondarySlot] = useState<HTMLElement | null>(null);
  const [mobileSecondarySlot, setMobileSecondarySlot] =
    useState<HTMLElement | null>(null);
  const [mobileHeaderActionsSlot, setMobileHeaderActionsSlot] =
    useState<HTMLElement | null>(null);
  const [mobileHeaderTitleSlot, setMobileHeaderTitleSlot] =
    useState<HTMLElement | null>(null);
  const [mobileHeaderBack, setMobileHeaderBack] =
    useState<MobileHeaderBack | null>(null);
  // A state setter is a stable ref callback, so each slot ref is its setter.
  const value = useMemo(
    () => ({
      mobileHeaderBack,
      mobileHeaderActionsSlot,
      mobileHeaderActionsSlotRef: setMobileHeaderActionsSlot,
      mobileHeaderTitleSlot,
      mobileHeaderTitleSlotRef: setMobileHeaderTitleSlot,
      mobileSecondarySlot,
      mobileSecondarySlotRef: setMobileSecondarySlot,
      secondarySlot,
      secondarySlotRef: setSecondarySlot,
      setMobileHeaderBack,
    }),
    [
      mobileHeaderBack,
      mobileHeaderActionsSlot,
      mobileHeaderTitleSlot,
      mobileSecondarySlot,
      secondarySlot,
    ],
  );

  return (
    <DashboardChromeContext.Provider value={value}>
      {props.children}
    </DashboardChromeContext.Provider>
  );
}

/**
 * The sticky shell chrome: mobile header, secondary navigation
 * slot, and banner. One bottom border closes the header and page links, so page link
 * underlines sit on it. Banners render below that border. Desktop has no
 * app header, so there the border shows only under page links.
 */
export function InboxDashboardChrome(props: {
  banner?: ReactNode;
  /** Desktop controls before the page links, such as the hidden pane's. */
  desktopControls?: ReactNode;
  header: ReactNode;
}) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error("DashboardChrome requires DashboardChromeProvider");
  }

  return (
    <div
      className="sticky top-0 z-30 bg-dashboard-bg/95 pt-[env(safe-area-inset-top)]"
      data-dashboard-chrome=""
    >
      <div className="border-b border-dashboard-border-strong md:border-b-0 md:has-[[data-secondary-slot]>*]:border-b">
        {props.header}
        {/* One header row on desktop: the hidden pane's controls, then the
            page links, so hiding the pane does not add a row. */}
        <div className="md:flex md:items-center">
          {props.desktopControls ? (
            <div className="hidden h-header shrink-0 items-center pl-6 md:flex md:empty:hidden">
              {props.desktopControls}
            </div>
          ) : null}
          <div
            className="hidden min-w-0 md:block md:flex-1"
            data-secondary-slot=""
            ref={chrome.secondarySlotRef}
          />
        </div>
      </div>
      {props.banner}
    </div>
  );
}

/** Provide the current page navigation target inside the mobile drawer. */
export function MobileSecondaryNavigationSlot() {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error(
      "MobileSecondaryNavigationSlot requires DashboardChromeProvider",
    );
  }
  return <div ref={chrome.mobileSecondarySlotRef} />;
}

/** Right-side actions slot for the mobile conversation shell header. */
export function MobileHeaderActionsSlot() {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error("MobileHeaderActionsSlot requires DashboardChromeProvider");
  }
  return (
    <div
      className="col-start-3 row-start-1 flex min-w-0 items-center justify-self-end md:hidden"
      ref={chrome.mobileHeaderActionsSlotRef}
    />
  );
}

/**
 * Slot for a mobile conversation title that the page owns, such as one that
 * it renames in place. It goes before the shell's own title, which shows
 * only while the slot is empty (`peer-empty/title:block`).
 */
export function MobileHeaderTitleSlot() {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error("MobileHeaderTitleSlot requires DashboardChromeProvider");
  }
  return (
    <div
      className="peer/title contents"
      ref={chrome.mobileHeaderTitleSlotRef}
    />
  );
}

/** Mount the page's conversation title into the mobile shell header. */
export function MobileHeaderTitlePortal(props: { children: ReactNode }) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome?.mobileHeaderTitleSlot) return null;
  return createPortal(props.children, chrome.mobileHeaderTitleSlot);
}

/** Mount conversation tools into the mobile shell header trailing slot. */
export function MobileHeaderActionsPortal(props: { children: ReactNode }) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome?.mobileHeaderActionsSlot) return null;
  return createPortal(props.children, chrome.mobileHeaderActionsSlot);
}

/** Read the back action that replaces the mobile header back link. */
export function useMobileHeaderBack(): MobileHeaderBack | null {
  return useContext(DashboardChromeContext)?.mobileHeaderBack ?? null;
}

/**
 * Point the mobile header back control at `onClick` while `label` is set,
 * such as from the event log back to its Conversation. `title` names a
 * Conversation that has no route yet.
 */
export function useRegisterMobileHeaderBack(
  label: string | undefined,
  onClick: (() => void) | undefined,
  title?: string,
): void {
  const setBack = useContext(DashboardChromeContext)?.setMobileHeaderBack;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const enabled = Boolean(onClick);

  // Before paint, so the header never shows a frame of the old chrome.
  useLayoutEffect(() => {
    if (!setBack || !label) return;
    setBack({
      label,
      onClick: enabled ? () => onClickRef.current?.() : undefined,
      title,
    });
    return () => setBack(null);
  }, [enabled, label, setBack, title]);
}

/** Mount page navigation into the desktop chrome and mobile drawer. */
export function SecondaryNavigationPortal(props: {
  desktop: ReactNode;
  mobile: ReactNode;
}) {
  const chrome = useContext(DashboardChromeContext);
  // Partial/static mounts have no shell provider. Keep desktop nav inline.
  // When the provider exists, wait for the sticky slot before mounting.
  if (!chrome) return props.desktop;
  if (!chrome.secondarySlot) return null;
  return (
    <>
      {createPortal(props.desktop, chrome.secondarySlot)}
      {chrome.mobileSecondarySlot
        ? createPortal(props.mobile, chrome.mobileSecondarySlot)
        : null}
    </>
  );
}
