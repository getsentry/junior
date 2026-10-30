import { useSyncExternalStore } from "react";

import {
  DASHBOARD_THEME_CHANGE_EVENT,
  DASHBOARD_THEME_STORAGE_KEY,
  type DashboardThemeChoice,
} from "../theme";

function readThemeChoice(): DashboardThemeChoice {
  try {
    const choice = window.localStorage.getItem(DASHBOARD_THEME_STORAGE_KEY);
    return choice === "light" || choice === "dark" ? choice : "system";
  } catch {
    return "system";
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(DASHBOARD_THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DASHBOARD_THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Save a theme choice for this browser. The shell theme script applies it
 * and keeps following the system color scheme for `system`.
 */
function saveThemeChoice(choice: DashboardThemeChoice): void {
  try {
    if (choice === "system") {
      window.localStorage.removeItem(DASHBOARD_THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Storage is blocked, so the dashboard keeps following the system.
    return;
  }
  window.dispatchEvent(new Event(DASHBOARD_THEME_CHANGE_EVENT));
}

/** Read and update this browser's dashboard theme choice. */
export function useDashboardThemeChoice(): [
  DashboardThemeChoice,
  (choice: DashboardThemeChoice) => void,
] {
  const choice = useSyncExternalStore(subscribe, readThemeChoice);
  return [choice, saveThemeChoice];
}
