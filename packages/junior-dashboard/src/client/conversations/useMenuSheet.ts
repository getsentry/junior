import { useEffect, useRef, useState } from "react";

/**
 * Hold the open state of a menu sheet. A chosen row runs only after the
 * sheet unmounts and gives focus back, so an action that moves focus, such
 * as Rename or Search, keeps it.
 */
export function useMenuSheet() {
  const [open, setOpen] = useState(false);
  const chosen = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (open) return;
    const action = chosen.current;
    chosen.current = undefined;
    // Base UI gives focus back in a microtask after the unmount, so the
    // action waits one task more.
    if (action) setTimeout(action);
  }, [open]);
  return {
    close(action?: () => void) {
      chosen.current = action;
      setOpen(false);
    },
    open,
    show: () => setOpen(true),
  };
}
