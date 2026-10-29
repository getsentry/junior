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

/** Report whether details fit beside their source instead of in a sheet. */
export function useDetailsPanel(): boolean {
  return useSyncExternalStore(
    subscribeToPanelLayout,
    hasPanelSpace,
    () => false,
  );
}

/** Show details beside their source, or in a bottom sheet when space is limited. */
export function DetailsPanel(props: {
  actions?: ReactNode;
  children: ReactNode;
  onClose(): void;
  label: string;
  title: ReactNode;
  sheetTitle?: string;
  /** Nested details stay modal inside an existing drawer. */
  overlay?: boolean;
}) {
  const { onClose, overlay } = props;
  const closeLabel = `Close ${props.label.toLowerCase()}`;
  const panel = useDetailsPanel();
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
      <BottomSheet
        label={props.label}
        title={props.sheetTitle}
        onClose={onClose}
      >
        {props.actions ? (
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
            <div className="min-h-0">{props.children}</div>
            <div className="flex justify-end gap-1 border-t border-dashboard-border px-4 py-2">
              {props.actions}
            </div>
          </div>
        ) : (
          props.children
        )}
      </BottomSheet>
    );
  }

  if (overlay) {
    return (
      <Drawer
        actions={props.actions}
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
      <header className="flex items-center justify-between gap-3 border-b border-dashboard-border py-2 pl-5 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">{props.title}</div>
          {props.actions ? (
            <div className="flex items-center gap-0.5">{props.actions}</div>
          ) : null}
        </div>
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
