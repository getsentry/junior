import { createContext, useContext } from "react";

/** A dashboard UI shell: `inbox` is the new UI, `classic` the current one. */
export type UiShell = "classic" | "inbox";

/**
 * The UI shell that renders the page. Shared modules read it where the new
 * UI looks or behaves differently, so the current UI stays as it is.
 * `InboxShell` provides `"inbox"`.
 */
export const UiShellContext = createContext<UiShell>("classic");

/** True when the new UI renders this component. */
export function useInboxUi(): boolean {
  return useContext(UiShellContext) === "inbox";
}

/**
 * True when the reader chose comfortable density. Only the new UI has the
 * choice; `InboxShell` provides it.
 */
export const ComfortableDensityContext = createContext(false);
