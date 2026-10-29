import { X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "./Button";
import { BottomSheet } from "./BottomSheet";
import { Drawer } from "./Drawer";

const panelMediaQuery = "(min-width: 1280px)";

function subscribeToPanelLayout(onChange: () => void) {
  const media = window.matchMedia(panelMediaQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function hasPanelSpace() {
  return window.matchMedia(panelMediaQuery).matches;
}

/** Show details beside their source, or in a bottom sheet when space is limited. */
export function DetailsPanel(props: {
  children: ReactNode;
  onClose(): void;
  label: string;
  title: ReactNode;
  /** Nested details stay modal inside an existing drawer. */
  overlay?: boolean;
}) {
  const { onClose, overlay } = props;
  const closeLabel = `Close ${props.label.toLowerCase()}`;
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
  useEffect(() => {
    if (!panel || overlay) return;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("[data-dashboard-modal]")
      ) {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel, overlay, onClose]);
  if (!panel) {
    return (
      <BottomSheet label={props.label} onClose={onClose}>
        {props.children}
      </BottomSheet>
    );
  }

  if (overlay) {
    return (
      <Drawer
        closeLabel={closeLabel}
        header={props.title}
        label={props.label}
        onClose={onClose}
        openKey={props.label}
        width="wide"
      >
        {props.children}
      </Drawer>
    );
  }

  return (
    <aside
      aria-label={props.label}
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-dashboard-border bg-dashboard-bg-elevated"
    >
      <header className="flex items-center justify-between gap-3 border-b border-dashboard-border px-5 py-3">
        <div className="min-w-0">{props.title}</div>
        <Button
          ref={closeRef}
          aria-label={closeLabel}
          onClick={onClose}
          size="icon"
        >
          <X aria-hidden="true" size={15} />
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {props.children}
      </div>
    </aside>
  );
}
