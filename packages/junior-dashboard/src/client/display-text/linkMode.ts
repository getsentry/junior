import { Link, Sparkles } from "lucide-react";
import { createContext, useContext } from "react";

import { browserChoice } from "../browserChoice";
import type { BrowserPreference } from "../components/PreferenceToggle";

/**
 * How links and references show. `rich` shows people with their photo,
 * objects with their icon, and a card or thumbnail for a URL alone on its
 * line. `plain` shows every link as text with its title and every person as
 * `@Name`. Both keep the hover card.
 */
type LinkMode = "plain" | "rich";

const useLinkModeChoice = browserChoice<LinkMode>(
  "junior:links:mode",
  ["plain"],
  "rich",
);

/** This browser's link mode: rich or plain. */
export const linkModePreference: BrowserPreference<LinkMode> = {
  choices: [
    { Icon: Sparkles, label: "Rich", value: "rich" },
    { Icon: Link, label: "Plain", value: "plain" },
  ],
  label: "Links",
  useChoice: useLinkModeChoice,
};

const RichLinks = createContext(false);

/**
 * Keep rich links below, whatever this browser chose. An Inbox item card
 * keeps its links as they are.
 */
export const RichLinksProvider = RichLinks.Provider;

/** Tell whether links here show as plain text. */
export function usePlainLinks(): boolean {
  const rich = useContext(RichLinks);
  return useLinkModeChoice()[0] === "plain" && !rich;
}
