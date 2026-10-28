import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Button } from "../components/Button";
import { Drawer } from "../components/Drawer";

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
  conversationId: string;
  onClose(): void;
}) {
  const titleId = useId();
  const panel = useSyncExternalStore(
    subscribeToPanelLayout,
    hasPanelSpace,
    () => false,
  );
  const panelRef = useRef<HTMLElement>(null);
  const wasPanel = useRef(panel);
  useEffect(() => {
    if (
      panel &&
      !wasPanel.current &&
      !document.querySelector("[data-dashboard-drawer]")
    ) {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    wasPanel.current = panel;
  }, [panel]);
  const heading = (
    <h2
      aria-label="Conversation details"
      className={
        panel ? "m-0 text-base font-semibold text-dashboard-text" : "sr-only"
      }
      id={titleId}
    >
      Details
    </h2>
  );

  if (!panel) {
    return (
      <Drawer
        closeLabel="Close conversation details"
        dismissLabel="Dismiss conversation details"
        header={heading}
        onClose={props.onClose}
        openKey={props.conversationId}
        placement="bottom"
        titleId={titleId}
      >
        {props.children}
      </Drawer>
    );
  }

  return (
    <aside
      ref={panelRef}
      aria-labelledby={titleId}
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-dashboard-border bg-dashboard-bg-elevated"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !document.querySelector("[data-dashboard-drawer]")
        ) {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-dashboard-border px-5 py-3">
        {heading}
        <Button
          aria-label="Close conversation details"
          onClick={props.onClose}
          size="icon"
        >
          <X aria-hidden="true" size={15} />
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
        {props.children}
      </div>
    </aside>
  );
}
