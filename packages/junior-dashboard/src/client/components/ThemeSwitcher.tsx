import { Monitor, Moon, Sun } from "lucide-react";

import type { DashboardThemeChoice } from "../../theme";
import { useDashboardThemeChoice } from "../theme";
import { PreferenceToggle, type PreferenceChoice } from "./PreferenceToggle";

const themeChoices = [
  { Icon: Monitor, label: "System", value: "system" },
  { Icon: Sun, label: "Light", value: "light" },
  { Icon: Moon, label: "Dark", value: "dark" },
] as const satisfies ReadonlyArray<PreferenceChoice<DashboardThemeChoice>>;

/** Choose the dashboard theme for this browser: system, light, or dark. */
export function ThemeSwitcher(props: { className?: string }) {
  const [choice, setChoice] = useDashboardThemeChoice();
  return (
    <PreferenceToggle
      choices={themeChoices}
      className={props.className}
      itemLabel={(item) => `${item.label} theme`}
      label="Theme"
      onChange={setChoice}
      value={choice}
    />
  );
}
