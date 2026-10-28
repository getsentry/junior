import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../styles";
import { Button } from "./Button";
import { Modal } from "./Modal";

/** Render a side drawer with shared modal focus and dismissal behavior. */
export function Drawer(props: {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  dismissLabel: string;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  titleId: string;
  width?: "default" | "wide" | "narrow";
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      dismissLabel={props.dismissLabel}
      initialFocusRef={closeRef}
      key={props.openKey}
      onClose={props.onClose}
      titleId={props.titleId}
    >
      <aside
        className={cn(
          "absolute right-0 top-0 grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated shadow-[-20px_0_60px_rgba(0,0,0,0.45)] md:border-l md:border-dashboard-border-strong",
          props.width === "wide"
            ? "md:w-[min(760px,94vw)]"
            : props.width === "narrow"
              ? "md:w-[min(440px,94vw)]"
              : "md:w-[min(560px,94vw)]",
        )}
      >
        <header className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-dashboard-border bg-dashboard-bg-elevated px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5">
          <div className="min-w-0">{props.header}</div>
          <div className="flex items-start gap-1.5">
            {props.actions}
            <Button
              ref={closeRef}
              aria-label={props.closeLabel}
              onClick={props.onClose}
              size="icon"
              title="Close"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {props.children}
        </div>
      </aside>
    </Modal>
  );
}
