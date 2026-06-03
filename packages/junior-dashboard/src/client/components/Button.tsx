import type { ButtonHTMLAttributes } from "react";

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
        "border border-white/15 bg-[#0b0b0b] text-[#d6d6d6] transition-colors hover:border-white/30 hover:bg-[#151515] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/15 disabled:hover:bg-[#0b0b0b] disabled:hover:text-[#d6d6d6]",
        size === "icon"
          ? "grid size-9 place-items-center p-0"
          : "inline-flex h-9 max-w-full items-center gap-2 px-3 text-[0.82rem] font-semibold leading-none",
        props.disabled ? "" : "cursor-pointer",
        className,
      )}
      type={type}
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
  pill: "cursor-pointer border px-2 py-1 text-[0.78rem] font-semibold uppercase leading-tight transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#beaaff]/55",
  text: "cursor-pointer border-0 bg-transparent px-1.5 py-1 uppercase tracking-normal underline-offset-4 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#beaaff]/55",
};

const toggleButtonPressed: Record<ToggleButtonVariant, string> = {
  pill: "border-white/30 bg-white text-black",
  text: "text-white underline decoration-white",
};

const toggleButtonIdle: Record<ToggleButtonVariant, string> = {
  pill: "border-white/10 bg-[#0b0b0b] text-[#888] hover:border-white/25 hover:bg-[#151515] hover:text-white",
  text: "text-[#888] hover:text-white",
};
