import type { ButtonHTMLAttributes, Ref } from "react";
import { Link, type LinkProps } from "react-router";

import { cn } from "../styles";
import { Button as ShadcnButton, buttonVariants } from "./ui/button";

type ButtonSize = "default" | "icon";
type ButtonTone = "default" | "danger" | "primary";
type ToggleButtonVariant = "pill" | "segment" | "text";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  size?: ButtonSize;
  tone?: ButtonTone;
};

export type ToggleButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed: boolean;
  variant: ToggleButtonVariant;
};

/** Render the dashboard's standard bordered command button surface. */
export function Button({ tone, type = "button", ...props }: ButtonProps) {
  return <ShadcnButton {...props} type={type} variant={tone} />;
}

/** Render a dashboard navigation link with the standard button surface. */
export function ButtonLink({ className, ...props }: LinkProps) {
  return (
    <Link
      {...props}
      className={cn(buttonVariants(), "no-underline", className)}
    />
  );
}

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
  segment:
    "inline-flex h-7 min-w-10 cursor-pointer items-center justify-center rounded-md border px-2 font-sans text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
  text: "cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-1 font-sans font-medium underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
};

const toggleButtonPressed: Record<ToggleButtonVariant, string> = {
  pill: "border-dashboard-border-heavy bg-dashboard-text-solid text-dashboard-text-inverse",
  segment:
    "border-dashboard-border-interactive bg-dashboard-surface-active text-dashboard-text",
  text: "text-dashboard-text underline decoration-dashboard-text-solid",
};

const toggleButtonIdle: Record<ToggleButtonVariant, string> = {
  pill: "border-dashboard-border-strong bg-dashboard-surface-raised text-dashboard-text-muted hover:border-dashboard-border-interactive hover:bg-dashboard-surface-hover hover:text-dashboard-text",
  segment:
    "border-transparent bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
  text: "text-dashboard-text-muted hover:text-dashboard-text",
};
