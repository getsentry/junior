import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** One icon option of a `PreferenceToggle`. */
export type PreferenceChoice<T extends string> = {
  Icon: LucideIcon;
  label: string;
  value: T;
};

/** Label one browser preference and pick its value from icon buttons. */
export function PreferenceToggle<T extends string>(props: {
  choices: readonly PreferenceChoice<T>[];
  className?: string;
  /** Accessible name of each button, such as "Light theme". */
  itemLabel(choice: PreferenceChoice<T>): string;
  label: string;
  onChange(value: T): void;
  value: T;
}) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3", props.className)}
    >
      <span className="font-sans text-sm font-semibold text-dashboard-text">
        {props.label}
      </span>
      <ToggleGroup
        aria-label={props.label}
        className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
        onValueChange={([next]) => {
          if (next) props.onChange(next);
        }}
        value={[props.value]}
      >
        {props.choices.map((choice) => (
          <Tooltip key={choice.value}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  aria-label={props.itemLabel(choice)}
                  value={choice.value}
                >
                  <choice.Icon aria-hidden="true" size={14} strokeWidth={2} />
                </ToggleGroupItem>
              }
            />
            <TooltipContent size="compact">{choice.label}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
}
