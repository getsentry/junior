import { Monitor, Moon, Sun } from "lucide-react";

import {
  DASHBOARD_THEME_CHANGE_EVENT,
  DASHBOARD_THEME_STORAGE_KEY,
  type DashboardThemeChoice,
} from "../theme";
import { browserChoice } from "./browserChoice";
import type { BrowserPreference } from "./components/PreferenceToggle";

/**
 * This browser's dashboard theme: system, light, or dark. The shell theme
 * script applies it and keeps following the system color scheme for
 * `system`.
 */
export const themePreference: BrowserPreference<DashboardThemeChoice> = {
  choices: [
    { Icon: Monitor, label: "System", value: "system" },
    { Icon: Sun, label: "Light", value: "light" },
    { Icon: Moon, label: "Dark", value: "dark" },
  ],
  label: "Theme",
  useChoice: browserChoice<DashboardThemeChoice>(
    DASHBOARD_THEME_STORAGE_KEY,
    ["dark", "light"],
    "system",
    DASHBOARD_THEME_CHANGE_EVENT,
  ),
};
