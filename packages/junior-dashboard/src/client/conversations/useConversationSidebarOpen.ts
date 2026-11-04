import { useState } from "react";

const STORAGE_KEY = "junior:conversation:sidebar-open";

/** Remember the conversation sidebar layout in this browser. */
export function useConversationSidebarOpen() {
  const [open, setOpen] = useState(readOpen);

  function updateOpen(next: boolean) {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // The sidebar still toggles when browser storage is unavailable.
    }
  }

  return [open, updateOpen] as const;
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}
