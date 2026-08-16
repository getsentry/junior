import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

type DashboardChromeContextValue = {
  mobileHeaderActionsSlot: HTMLElement | null;
  mobileHeaderActionsSlotRef: RefCallback<HTMLDivElement>;
  mobileHeaderLiveSlot: HTMLElement | null;
  mobileHeaderLiveSlotRef: RefCallback<HTMLDivElement>;
  mobileSecondarySlot: HTMLElement | null;
  mobileSecondarySlotRef: RefCallback<HTMLDivElement>;
  openMobileNavigation(): void;
  registerOpenMobileNavigation(open: (() => void) | null): void;
  secondarySlot: HTMLElement | null;
  secondarySlotRef: RefCallback<HTMLDivElement>;
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
  const [mobileHeaderLiveSlot, setMobileHeaderLiveSlot] =
    useState<HTMLElement | null>(null);
  const openMobileNavigationRef = useRef<(() => void) | null>(null);
  const secondarySlotRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setSecondarySlot(node);
  }, []);
  const mobileSecondarySlotRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      setMobileSecondarySlot(node);
    },
    [],
  );
  const mobileHeaderActionsSlotRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      setMobileHeaderActionsSlot(node);
    },
    [],
  );
  const mobileHeaderLiveSlotRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      setMobileHeaderLiveSlot(node);
    },
    [],
  );
  const registerOpenMobileNavigation = useCallback(
    (open: (() => void) | null) => {
      openMobileNavigationRef.current = open;
    },
    [],
  );
  const openMobileNavigation = useCallback(() => {
    openMobileNavigationRef.current?.();
  }, []);
  const value = useMemo(
    () => ({
      mobileHeaderActionsSlot,
      mobileHeaderActionsSlotRef,
      mobileHeaderLiveSlot,
      mobileHeaderLiveSlotRef,
      mobileSecondarySlot,
      mobileSecondarySlotRef,
      openMobileNavigation,
      registerOpenMobileNavigation,
      secondarySlot,
      secondarySlotRef,
    }),
    [
      mobileHeaderActionsSlot,
      mobileHeaderActionsSlotRef,
      mobileHeaderLiveSlot,
      mobileHeaderLiveSlotRef,
      mobileSecondarySlot,
      mobileSecondarySlotRef,
      openMobileNavigation,
      registerOpenMobileNavigation,
      secondarySlot,
      secondarySlotRef,
    ],
  );

  return (
    <DashboardChromeContext.Provider value={value}>
      {props.children}
    </DashboardChromeContext.Provider>
  );
}

/** Sticky shell chrome: primary header, secondary navigation slot, and banner. */
export function DashboardChrome(props: {
  banner?: ReactNode;
  header: ReactNode;
}) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error("DashboardChrome requires DashboardChromeProvider");
  }

  return (
    <div className="sticky top-0 z-30 bg-[#050507]/95 pt-[env(safe-area-inset-top)]">
      {props.header}
      <div className="hidden md:block" ref={chrome.secondarySlotRef} />
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

/** Live-indicator slot next to the mobile conversation title. */
export function MobileHeaderLiveSlot() {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome) {
    throw new Error("MobileHeaderLiveSlot requires DashboardChromeProvider");
  }
  return (
    <div
      className="flex shrink-0 items-center md:hidden"
      ref={chrome.mobileHeaderLiveSlotRef}
    />
  );
}

/** Mount conversation tools into the mobile shell header trailing slot. */
export function MobileHeaderActionsPortal(props: { children: ReactNode }) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome?.mobileHeaderActionsSlot) return null;
  return createPortal(props.children, chrome.mobileHeaderActionsSlot);
}

/** Mount the polled live indicator into the mobile shell title row. */
export function MobileHeaderLivePortal(props: { children: ReactNode }) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome?.mobileHeaderLiveSlot) return null;
  return createPortal(props.children, chrome.mobileHeaderLiveSlot);
}

/** Open the mobile app navigation sheet from conversation chrome. */
export function useOpenMobileNavigation(): (() => void) | null {
  const chrome = useContext(DashboardChromeContext);
  return chrome ? chrome.openMobileNavigation : null;
}

/** Register the shell handler that opens the mobile navigation sheet. */
export function useRegisterOpenMobileNavigation(open?: () => void): void {
  const chrome = useContext(DashboardChromeContext);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!chrome) return;
    const handler = () => {
      openRef.current?.();
    };
    chrome.registerOpenMobileNavigation(open ? handler : null);
    return () => {
      chrome.registerOpenMobileNavigation(null);
    };
  }, [chrome, open]);
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
