import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../styles";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import { toggleVariants } from "./ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

// Base UI marks the checked radio item with data-checked, not data-pressed.
const menuRadioItemClass = cn(
  toggleVariants(),
  "outline-none data-checked:border-dashboard-border-interactive data-checked:bg-dashboard-surface-active data-checked:text-dashboard-text",
);

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
  /**
   * Render the choices as menu radio items, so arrow keys reach them inside
   * a dropdown menu.
   */
  menu?: boolean;
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
      {props.menu ? (
        <DropdownMenuRadioGroup
          aria-label={props.label}
          className="flex items-center gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={(next: T) => props.onChange(next)}
          value={props.value}
        >
          {props.choices.map((choice) =>
            choiceWithTooltip(
              choice,
              <DropdownMenuRadioItem
                aria-label={props.itemLabel(choice)}
                className={menuRadioItemClass}
                value={choice.value}
              >
                <choice.Icon aria-hidden="true" size={14} strokeWidth={2} />
              </DropdownMenuRadioItem>,
            ),
          )}
        </DropdownMenuRadioGroup>
      ) : (
        <ToggleGroup
          aria-label={props.label}
          className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={([next]) => {
            if (next) props.onChange(next);
          }}
          value={[props.value]}
        >
          {props.choices.map((choice) =>
            choiceWithTooltip(
              choice,
              <ToggleGroupItem
                aria-label={props.itemLabel(choice)}
                value={choice.value}
              >
                <choice.Icon aria-hidden="true" size={14} strokeWidth={2} />
              </ToggleGroupItem>,
            ),
          )}
        </ToggleGroup>
      )}
    </div>
  );
}

function choiceWithTooltip<T extends string>(
  choice: PreferenceChoice<T>,
  trigger: ReactElement,
) {
  return (
    <Tooltip key={choice.value}>
      <TooltipTrigger render={trigger} />
      <TooltipContent size="compact">{choice.label}</TooltipContent>
    </Tooltip>
  );
}
