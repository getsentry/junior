import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import type { DashboardThemeChoice } from "../../theme";
import { cn } from "../styles";
import { useDashboardThemeChoice } from "../theme";
import { ToggleButton } from "./ToggleButton";

const themeChoices = [
  { Icon: Monitor, label: "System", value: "system" },
  { Icon: Sun, label: "Light", value: "light" },
  { Icon: Moon, label: "Dark", value: "dark" },
] as const satisfies ReadonlyArray<{
  Icon: LucideIcon;
  label: string;
  value: DashboardThemeChoice;
}>;

/** Choose the dashboard theme for this browser: system, light, or dark. */
export function ThemeSwitcher(props: { className?: string }) {
  const [choice, setChoice] = useDashboardThemeChoice();
  return (
    <div
      className={cn("flex items-center justify-between gap-3", props.className)}
    >
      <span className="font-sans text-sm font-semibold text-dashboard-text">
        Theme
      </span>
      <div
        aria-label="Theme"
        className="flex gap-0.5 rounded-lg border border-dashboard-border p-0.5"
        role="group"
      >
        {themeChoices.map(({ Icon, label, value }) => (
          <ToggleButton
            aria-label={`${label} theme`}
            key={value}
            onClick={() => setChoice(value)}
            pressed={choice === value}
            title={label}
            variant="segment"
          >
            <Icon aria-hidden="true" size={14} strokeWidth={2} />
          </ToggleButton>
        ))}
      </div>
    </div>
  );
}
