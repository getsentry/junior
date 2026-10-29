import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "../styles";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

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
    <Input
      {...props}
      className={cn(
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
    <Textarea
      {...props}
      // Keep prose leading after caller text sizes so class merging keeps it.
      className={cn(
        className,
        prose ? "font-sans leading-relaxed" : "font-mono",
      )}
    />
  );
}
