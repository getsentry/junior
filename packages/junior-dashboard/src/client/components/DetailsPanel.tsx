import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

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
  const titleId = useId();
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
  if (!panel) {
    return (
      <BottomSheet label={props.label} onClose={props.onClose}>
        {props.children}
      </BottomSheet>
    );
  }

  if (props.overlay) {
    return (
      <Drawer
        closeLabel={closeLabel}
        header={
          <>
            <span className="sr-only" id={titleId}>
              {props.label}
            </span>
            {props.title}
          </>
        }
        onClose={props.onClose}
        openKey={props.label}
        titleId={titleId}
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
        <div className="min-w-0">{props.title}</div>
        <Button
          ref={closeRef}
          aria-label={closeLabel}
          onClick={props.onClose}
          size="icon"
        >
          <X aria-hidden="true" size={15} />
        </Button>
      </header>
      <div className="min-h-0">{props.children}</div>
    </aside>
  );
}
