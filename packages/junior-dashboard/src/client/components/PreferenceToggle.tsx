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
  "data-checked:border-dashboard-border-interactive data-checked:bg-dashboard-surface-active data-checked:text-dashboard-text",
);

/** One icon option of a `PreferenceToggle`. */
export type PreferenceChoice<T extends string> = {
  Icon: LucideIcon;
  label: string;
  value: T;
};

/** One browser preference that a `PreferenceToggle` picks. */
export type BrowserPreference<T extends string> = {
  choices: readonly PreferenceChoice<T>[];
  /**
   * Name of the preference, such as "Theme". Each button is named by its
   * choice, then this name, such as "Light theme".
   */
  label: string;
  useChoice(): readonly [T, (value: T) => void];
};

/** Label one browser preference and pick its value from icon buttons. */
export function PreferenceToggle<T extends string>(props: {
  className?: string | undefined;
  /**
   * Render the choices as menu radio items, so arrow keys reach them inside
   * a dropdown menu.
   */
  menu?: boolean | undefined;
  preference: BrowserPreference<T>;
}) {
  const { choices, label } = props.preference;
  const [value, onChange] = props.preference.useChoice();
  const itemLabel = (choice: PreferenceChoice<T>) =>
    `${choice.label} ${label.toLowerCase()}`;
  return (
    <div
      className={cn("flex items-center justify-between gap-3", props.className)}
    >
      <span className="font-sans text-sm font-semibold text-dashboard-text">
        {label}
      </span>
      {props.menu ? (
        <DropdownMenuRadioGroup
          aria-label={label}
          className="flex items-center gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={(next: T) => onChange(next)}
          value={value}
        >
          {choices.map((choice) =>
            choiceWithTooltip(
              choice,
              <DropdownMenuRadioItem
                aria-label={itemLabel(choice)}
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
          aria-label={label}
          className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={([next]) => {
            if (next) onChange(next);
          }}
          value={[value]}
        >
          {choices.map((choice) =>
            choiceWithTooltip(
              choice,
              <ToggleGroupItem
                aria-label={itemLabel(choice)}
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
