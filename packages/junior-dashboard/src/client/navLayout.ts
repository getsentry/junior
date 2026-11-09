import { useLocalStorage, useMediaQuery } from "@uidotdev/usehooks";

/**
 * Desktop navigation the viewer chose. `adaptive` uses the top bar on tall
 * windows and the sidebar on shorter ones. Mobile always uses the sheet.
 */
export type NavLayoutChoice = "adaptive" | "sidebar" | "top-bar";

const STORAGE_KEY = "junior:nav:layout";
// Adaptive windows this tall have height to spare for the top bar. Shorter
// windows, such as most laptops, give that height to conversations.
const TALL_QUERY = "(min-height: 68.75rem)";

/** Read and update this browser's desktop navigation choice. */
export function useNavLayoutChoice() {
  const [stored, setChoice] = useLocalStorage<NavLayoutChoice>(
    STORAGE_KEY,
    "adaptive",
  );
  const choice: NavLayoutChoice =
    stored === "sidebar" || stored === "top-bar" ? stored : "adaptive";
  return [choice, setChoice] as const;
}

/** Tell whether desktop navigation is the top bar instead of the sidebar. */
export function useDesktopTopBar(): boolean {
  const [choice] = useNavLayoutChoice();
  const tall = useMediaQuery(TALL_QUERY);
  return choice === "top-bar" || (choice === "adaptive" && tall);
}
