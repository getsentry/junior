import { Ellipsis } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { HeaderIconButton } from "./ConversationHeaderActions";

/**
 * Show the conversation `⋯` button and its menu. The menu closes on an
 * outside click or Escape. `children` gets `close` so an item can close the
 * menu before it acts.
 */
export function ConversationOverflowMenu(props: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  children(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const localButtonRef = useRef<HTMLButtonElement>(null);
  const buttonRef = props.buttonRef ?? localButtonRef;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }

    // Capture runs before the details panel's document listener, and
    // preventDefault tells it that this Escape is taken.
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      if (menuRef.current?.contains(document.activeElement)) {
        buttonRef.current?.focus({ preventScroll: true });
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [buttonRef, open]);

  return (
    <div className="relative" ref={menuRef}>
      <HeaderIconButton
        ref={buttonRef}
        label={open ? "Close conversation menu" : "Conversation menu"}
        onClick={() => setOpen((value) => !value)}
        pressed={open}
        tooltipDisabled={open}
      >
        <Ellipsis aria-hidden="true" size={16} strokeWidth={1.9} />
      </HeaderIconButton>
      {open ? (
        <div
          // Esc closes it before Esc leaves the page.
          data-escape-owner=""
          className="absolute right-0 top-[calc(100%+0.35rem)] z-40 w-56 rounded-xl border border-dashboard-border-strong bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl"
        >
          {props.children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
