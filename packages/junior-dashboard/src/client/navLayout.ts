import { useSyncExternalStore } from "react";

/**
 * Desktop navigation the viewer chose. `adaptive` uses the top bar on tall
 * windows and the sidebar on shorter ones. Mobile always uses the sheet.
 */
export type NavLayoutChoice = "adaptive" | "sidebar" | "top-bar";

// No value means `adaptive`.
const STORAGE_KEY = "junior:nav:layout";
const CHANGE_EVENT = "junior:nav-layout";
// Adaptive windows this tall have height to spare for the top bar. Shorter
// windows, such as most laptops, give that height to conversations.
const TALL_QUERY = "(min-height: 68.75rem)";

function readChoice(): NavLayoutChoice {
  try {
    const choice = window.localStorage.getItem(STORAGE_KEY);
    return choice === "sidebar" || choice === "top-bar" ? choice : "adaptive";
  } catch {
    return "adaptive";
  }
}

function subscribeChoice(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function saveChoice(choice: NavLayoutChoice): void {
  try {
    if (choice === "adaptive") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // Storage is blocked, so the dashboard stays adaptive.
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Read and update this browser's desktop navigation choice. */
export function useNavLayoutChoice(): [
  NavLayoutChoice,
  (choice: NavLayoutChoice) => void,
] {
  const choice = useSyncExternalStore(subscribeChoice, readChoice);
  return [choice, saveChoice];
}

/** Follow one CSS media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** Tell whether desktop navigation is the top bar instead of the sidebar. */
export function useDesktopTopBar(choice: NavLayoutChoice): boolean {
  const tall = useMediaQuery(TALL_QUERY);
  return choice === "top-bar" || (choice === "adaptive" && tall);
}
