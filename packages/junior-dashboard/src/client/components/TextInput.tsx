import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "../styles";

const textControlClassName =
  "block w-full rounded border border-dashboard-border-emphasis bg-dashboard-ink px-3 py-2 text-sm text-dashboard-text focus:border-dashboard-focus focus:outline-none aria-invalid:border-rose-300 disabled:cursor-not-allowed disabled:opacity-50";

export type TextInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> & {
  className?: string;
  size?: "default" | "comfortable";
};

/** Render the dashboard's standard single-line text control. */
export function TextInput({
  className,
  type = "text",
  size = "default",
  ...props
}: TextInputProps) {
  return (
    <input
      {...props}
      className={cn(
        textControlClassName,
        size === "comfortable" && "min-h-11 text-base sm:min-h-10 sm:text-sm",
        className,
      )}
      type={type}
    />
  );
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  prose?: boolean;
  className?: string;
};

/** Render the dashboard's standard multi-line text control. */
export function TextArea({
  className,
  prose = false,
  ...props
}: TextAreaProps) {
  return (
    <textarea
      {...props}
      className={cn(
        textControlClassName,
        "min-h-36",
        prose ? "font-sans leading-relaxed" : "font-mono",
        className,
      )}
    />
  );
}
