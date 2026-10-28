import type { ButtonHTMLAttributes, Ref } from "react";
import { Link, type LinkProps } from "react-router";

import { cn } from "../styles";

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

const buttonClassName =
  "inline-flex h-9 max-w-full items-center justify-center gap-2 rounded-md border border-dashboard-border-emphasis bg-dashboard-surface-raised px-3 font-sans text-sm font-medium leading-none text-dashboard-text transition-colors hover:border-dashboard-border-heavy hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus";

const dangerButtonClassName =
  "inline-flex h-9 max-w-full items-center justify-center gap-2 rounded-md border border-dashboard-border-strong bg-transparent px-3 font-sans text-sm font-medium leading-none text-dashboard-text-muted transition-colors hover:border-rose-300/40 hover:text-rose-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300/55";

/** Render the dashboard's standard bordered command button surface. */
export function Button({
  className,
  size = "default",
  tone = "default",
  type = "button",
  ...props
}: ButtonProps) {
  const isDanger = tone === "danger";
  return (
    <button
      {...props}
      className={cn(
        "font-sans transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "icon"
          ? cn(
              "grid size-9 place-items-center rounded-md border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:hover:!bg-transparent",
              isDanger
                ? "text-dashboard-text-muted hover:!bg-rose-300/10 hover:!text-rose-300 focus-visible:outline-rose-300/55 disabled:hover:!text-dashboard-text-muted"
                : "text-dashboard-text-muted hover:!bg-dashboard-fill-strong hover:!text-dashboard-text focus-visible:outline-dashboard-focus disabled:hover:!text-dashboard-text-muted",
            )
          : tone === "primary"
            ? "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-dashboard-text-solid bg-dashboard-text-solid px-3 font-sans text-sm font-medium leading-none text-dashboard-text-inverse hover:border-dashboard-text-subtle hover:bg-dashboard-text-subtle disabled:hover:border-dashboard-text-solid disabled:hover:bg-dashboard-text-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
            : isDanger
              ? cn(
                  dangerButtonClassName,
                  "disabled:hover:border-dashboard-border-strong disabled:hover:text-dashboard-text-muted",
                )
              : cn(
                  buttonClassName,
                  "disabled:hover:border-dashboard-border-emphasis disabled:hover:bg-dashboard-surface-raised disabled:hover:text-dashboard-text",
                ),
        props.disabled ? "" : "cursor-pointer",
        className,
      )}
      type={type}
    />
  );
}

/** Render a dashboard navigation link with the standard button surface. */
export function ButtonLink({ className, ...props }: LinkProps) {
  return (
    <Link
      {...props}
      className={cn(buttonClassName, "no-underline", className)}
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
