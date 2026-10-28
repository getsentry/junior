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

function subscribeToPanelLayout(onChange: () => void) {
  const media = window.matchMedia(panelMediaQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function hasPanelSpace() {
  return window.matchMedia(panelMediaQuery).matches;
}

/** Keep details beside the chat when space permits, or in a modal bottom sheet. */
export function ConversationDetailsFrame(props: {
  children: ReactNode;
  onClose(): void;
}) {
  const titleId = useId();
  const panel = useSyncExternalStore(
    subscribeToPanelLayout,
    hasPanelSpace,
    () => false,
  );
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
      <header className="flex items-center justify-between gap-3 border-b border-dashboard-border px-5 py-3">
        <h2
          aria-label="Conversation details"
          className="m-0 text-base font-semibold text-dashboard-text"
          id={titleId}
        >
          Details
        </h2>
        <Button
          ref={closeRef}
          aria-label="Close conversation details"
          onClick={props.onClose}
          size="icon"
        >
          <X aria-hidden="true" size={15} />
        </Button>
      </header>
      <div className="min-h-0 p-4">{props.children}</div>
    </aside>
  );
}
