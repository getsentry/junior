import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

type DashboardChromeContextValue = {
  mobileSecondarySlot: HTMLElement | null;
  mobileSecondarySlotRef: RefCallback<HTMLDivElement>;
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
  const secondarySlotRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setSecondarySlot(node);
  }, []);
  const mobileSecondarySlotRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      setMobileSecondarySlot(node);
    },
    [],
  );
  const value = useMemo(
    () => ({
      mobileSecondarySlot,
      mobileSecondarySlotRef,
      secondarySlot,
      secondarySlotRef,
    }),
    [
      mobileSecondarySlot,
      mobileSecondarySlotRef,
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
    <div className="sticky top-0 z-30 bg-dashboard-bg/95 pt-[env(safe-area-inset-top)]">
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
