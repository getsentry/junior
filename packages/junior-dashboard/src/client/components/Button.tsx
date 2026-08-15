import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

import { cn } from "../styles";

type ButtonSize = "default" | "icon";
type ToggleButtonVariant = "pill" | "text";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: ButtonSize;
};

export type ToggleButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed: boolean;
  variant: ToggleButtonVariant;
};

export type ButtonLinkProps = LinkProps & {
  children: ReactNode;
};

const buttonClassName =
  "inline-flex h-9 max-w-full items-center gap-2 rounded border border-white/15 bg-dashboard-surface-raised px-3 font-mono text-sm font-semibold leading-none text-dashboard-text transition-colors hover:border-white/30 hover:bg-dashboard-surface-hover hover:text-dashboard-text";

/** Render the dashboard's standard bordered command button surface. */
export function Button({
  className,
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "icon"
          ? "grid size-9 place-items-center rounded-md border-0 bg-transparent p-0 text-dashboard-text-muted hover:!bg-white/10 hover:!text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 disabled:hover:!bg-transparent disabled:hover:!text-dashboard-text-muted"
          : cn(
              buttonClassName,
              "disabled:hover:border-white/15 disabled:hover:bg-dashboard-surface-raised disabled:hover:text-dashboard-text",
            ),
        props.disabled ? "" : "cursor-pointer",
        className,
      )}
      type={type}
    />
  );
}

/** Render a dashboard navigation link with the standard button surface. */
export function ButtonLink({ className, ...props }: ButtonLinkProps) {
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
  pill: "cursor-pointer rounded border px-2 py-1 font-mono text-xs font-semibold uppercase leading-tight transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55",
  text: "cursor-pointer border-0 bg-transparent px-1.5 py-1 font-mono uppercase tracking-normal underline-offset-4 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55",
};

const toggleButtonPressed: Record<ToggleButtonVariant, string> = {
  pill: "border-white/30 bg-white text-black",
  text: "text-dashboard-text underline decoration-white",
};

const toggleButtonIdle: Record<ToggleButtonVariant, string> = {
  pill: "border-white/10 bg-dashboard-surface-raised text-dashboard-text-muted hover:border-white/25 hover:bg-dashboard-surface-hover hover:text-dashboard-text",
  text: "text-dashboard-text-muted hover:text-dashboard-text",
};
