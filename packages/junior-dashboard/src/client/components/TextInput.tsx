import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "../styles";

const textControlClassName =
  "block w-full rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export type TextInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> & {
  className?: string;
};

/** Render the dashboard's standard single-line text control. */
export function TextInput({ className, type = "text", ...props }: TextInputProps) {
  return (
    <input
      {...props}
      className={cn(textControlClassName, className)}
      type={type}
    />
  );
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

/** Render the dashboard's standard multi-line text control. */
export function TextArea({ className, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      className={cn(textControlClassName, "min-h-36 font-mono", className)}
    />
  );
}
