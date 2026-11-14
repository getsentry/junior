/**
 * What a UI shell tells the pages that both shells render. A page reads it
 * with the hooks here and never imports shell-only code, so each shell's
 * chunk keeps only its own UI. The current UI has no pane and no Zen mode,
 * so it uses the defaults and needs no provider.
 */
import { createContext, useContext, useEffect } from "react";

/** Zen mode hides the pane and page chrome around the open page. */
export type ZenMode = {
  active: boolean;
  available: boolean;
  toggle(): void;
};

/** The shell state that shared pages read and report. */
export type DashboardShellContextValue = {
  /** True while the desktop pane shows. */
  paneShows: boolean;
  /** Tell the shell whether a Conversation shows its event log. */
  reportEventLogShown(shown: boolean): void;
  zen: ZenMode;
};

/** Context that a shell provides. Pages read it through the hooks below. */
export const DashboardShellContext = createContext<DashboardShellContextValue>({
  paneShows: false,
  reportEventLogShown: () => undefined,
  zen: { active: false, available: false, toggle: () => undefined },
});

/** Read Zen mode, for pages with details and the conversation menu. */
export function useZenMode(): ZenMode {
  return useContext(DashboardShellContext).zen;
}

/** Read whether the desktop pane shows, for page chrome beside it. */
export function usePaneShows(): boolean {
  return useContext(DashboardShellContext).paneShows;
}

/** Tell the shell that the event log shows, so its palette ranks Events first. */
export function useReportEventLogShown(shown: boolean): void {
  const { reportEventLogShown } = useContext(DashboardShellContext);
  useEffect(() => {
    reportEventLogShown(shown);
    return () => reportEventLogShown(false);
  }, [reportEventLogShown, shown]);
}
