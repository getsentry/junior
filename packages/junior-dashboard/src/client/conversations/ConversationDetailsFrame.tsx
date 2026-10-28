import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Button } from "../components/Button";
import { BottomSheet } from "../components/BottomSheet";

const panelMediaQuery = "(min-width: 1280px)";
// Open details by default only when the chat column stays wide beside them.
const defaultOpenMediaQuery = "(min-width: 1440px)";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Report whether the viewport has room to show details as a panel beside the
 * chat. Narrower viewports show details in a bottom sheet.
 */
export function useConversationDetailsPanel(): boolean {
  return useMediaQuery(panelMediaQuery);
}

/** Report whether details should open beside the chat without a request. */
export function useConversationDetailsDefaultOpen(): boolean {
  return useMediaQuery(defaultOpenMediaQuery);
}

/** Keep details beside the chat when space permits, or in a modal bottom sheet. */
export function ConversationDetailsFrame(props: {
  actions?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  const titleId = useId();
  const panel = useConversationDetailsPanel();
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasPanel = useRef(panel);
  useEffect(() => {
    if (
      panel &&
      !wasPanel.current &&
      !document.querySelector("[data-dashboard-modal]")
    ) {
      closeRef.current?.focus({ preventScroll: true });
    }
    wasPanel.current = panel;
  }, [panel]);
  if (!panel) {
    return (
      <BottomSheet label="Conversation details" onClose={props.onClose}>
        {props.children}
        {/* After the tabs, so the sheet still opens with the first tab focused. */}
        {props.actions ? (
          <div className="flex justify-end gap-1 border-t border-dashboard-border px-4 py-2">
            {props.actions}
          </div>
        ) : null}
      </BottomSheet>
    );
  }

  return (
    <aside
      aria-labelledby={titleId}
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-dashboard-border bg-dashboard-bg-elevated"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !document.querySelector("[data-dashboard-modal]")
        ) {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-dashboard-border py-2 pl-5 pr-3">
        <h2
          aria-label="Conversation details"
          className="m-0 text-base font-semibold text-dashboard-text"
          id={titleId}
        >
          Details
        </h2>
        <div className="flex items-center gap-1">
          {props.actions}
          {props.actions ? (
            <span
              aria-hidden="true"
              className="mx-1 h-4 w-px bg-dashboard-border"
            />
          ) : null}
          <Button
            ref={closeRef}
            aria-label="Close conversation details"
            onClick={props.onClose}
            size="icon"
          >
            <X aria-hidden="true" size={15} />
          </Button>
        </div>
      </header>
      <div className="min-h-0">{props.children}</div>
    </aside>
  );
}
