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
  secondarySlot: HTMLElement | null;
  secondarySlotRef: RefCallback<HTMLDivElement>;
};

const DashboardChromeContext =
  createContext<DashboardChromeContextValue | null>(null);

/** Provide the sticky chrome slot used by page secondary navigation. */
export function DashboardChromeProvider(props: { children: ReactNode }) {
  const [secondarySlot, setSecondarySlot] = useState<HTMLElement | null>(null);
  const secondarySlotRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setSecondarySlot(node);
  }, []);
  const value = useMemo(
    () => ({
      secondarySlot,
      secondarySlotRef,
    }),
    [secondarySlot, secondarySlotRef],
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
    <div className="sticky top-0 z-30 bg-[#050507]/95">
      {props.header}
      <div ref={chrome.secondarySlotRef} />
      {props.banner}
    </div>
  );
}

/** Mount page secondary navigation into the sticky shell chrome. */
export function SecondaryNavigationPortal(props: { children: ReactNode }) {
  const chrome = useContext(DashboardChromeContext);
  if (!chrome?.secondarySlot) return null;
  return createPortal(props.children, chrome.secondarySlot);
}
