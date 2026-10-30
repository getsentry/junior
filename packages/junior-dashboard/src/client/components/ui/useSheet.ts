import type { Dialog } from "@base-ui/react/dialog";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
} from "../../bodyScrollLock";

// A resize can mount conversation details below an already open side drawer.
// Document order keeps the front modal in charge across these separate roots.
function subscribeToSheets(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** Keep an app sheet mounted through dismissal and share the document scroll lock. */
export function useSheet(
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const [open, setOpen] = useState(false);
  const closingRef = useRef(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const topmost = useSyncExternalStore(
    subscribeToSheets,
    () => {
      const modals = document.querySelectorAll("[data-dashboard-modal]");
      const last = modals[modals.length - 1];
      return popupRef.current ? last === popupRef.current : !last;
    },
    () => true,
  );
  useEffect(() => {
    acquireBodyScrollLock();
    setOpen(true);
    return releaseBodyScrollLock;
  }, []);

  return {
    rootProps: {
      open,
      modal: topmost ? "trap-focus" : false,
      disablePointerDismissal: !topmost,
      // Dialog and Drawer roots both use this handler, so read only `cancel`.
      onOpenChange(
        nextOpen: boolean,
        details: Pick<Dialog.Root.ChangeEventDetails, "cancel">,
      ) {
        if (!nextOpen && !topmost) {
          details.cancel();
          return;
        }
        closingRef.current = !nextOpen;
        setOpen(nextOpen);
      },
      onOpenChangeComplete(nextOpen) {
        if (!nextOpen && closingRef.current) onClose();
      },
    } satisfies Dialog.Root.Props,
    contentProps: {
      ref: popupRef,
      "aria-modal": topmost ? true : undefined,
      finalFocus: () => Boolean(closingRef.current && topmost),
      initialFocus: () => {
        const modals = document.querySelectorAll("[data-dashboard-modal]");
        if (modals[modals.length - 1] !== popupRef.current) return false;
        return initialFocusRef?.current ?? true;
      },
    } satisfies Dialog.Popup.Props,
  };
}
