import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import type { DashboardThemeChoice } from "../../theme";
import { cn } from "../styles";
import { useDashboardThemeChoice } from "../theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

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
      <ToggleGroup
        aria-label="Theme"
        className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
        onValueChange={([next]) => {
          if (next) setChoice(next);
        }}
        value={[choice]}
      >
        {themeChoices.map(({ Icon, label, value }) => (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <ToggleGroupItem aria-label={`${label} theme`} value={value}>
                  <Icon aria-hidden="true" size={14} strokeWidth={2} />
                </ToggleGroupItem>
              }
            />
            <TooltipContent size="compact">{label}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
}
