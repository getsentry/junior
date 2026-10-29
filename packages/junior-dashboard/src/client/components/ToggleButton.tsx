import type { ButtonHTMLAttributes } from "react";

import { cn } from "../styles";

type ToggleButtonVariant = "pill" | "text";

export type ToggleButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed: boolean;
  variant: ToggleButtonVariant;
};

/** Render a dashboard toggle button with a consistent pressed-state contract. */
export function ToggleButton({
  className,
  pressed,
  type = "button",
  variant,
  ...props
}: ToggleButtonProps) {
  return (
    <button
      {...props}
      aria-pressed={pressed}
      className={cn(
        toggleButtonBase[variant],
        pressed ? toggleButtonPressed[variant] : toggleButtonIdle[variant],
        className,
      )}
      type={type}
    />
  );
}

const toggleButtonBase: Record<ToggleButtonVariant, string> = {
  pill: "cursor-pointer rounded-md border px-2 py-1 font-sans text-xs font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
  text: "cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-1 font-sans font-medium underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
};

const toggleButtonPressed: Record<ToggleButtonVariant, string> = {
  pill: "border-dashboard-border-heavy bg-dashboard-text-solid text-dashboard-text-inverse",
  text: "text-dashboard-text underline decoration-dashboard-text-solid",
};

const toggleButtonIdle: Record<ToggleButtonVariant, string> = {
  pill: "border-dashboard-border-strong bg-dashboard-surface-raised text-dashboard-text-muted hover:border-dashboard-border-interactive hover:bg-dashboard-surface-hover hover:text-dashboard-text",
  text: "text-dashboard-text-muted hover:text-dashboard-text",
};
