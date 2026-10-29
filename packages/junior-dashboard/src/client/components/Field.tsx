import type { ReactNode } from "react";

import { cn } from "../styles";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  Field as ShadcnField,
} from "./ui/field";

export type FieldSize = "compact" | "default";

/** Label a control with optional help text using the shared form stack. */
export function Field(props: {
  children: ReactNode;
  className?: string;
  help?: ReactNode;
  error?: string;
  htmlFor?: string;
  label: ReactNode;
  size?: FieldSize;
}) {
  const compact = props.size === "compact";
  return (
    <ShadcnField className={cn(compact && "gap-1.5", props.className)}>
      <FieldLabel
        className={
          compact
            ? "font-sans text-xs font-medium text-dashboard-text-muted"
            : undefined
        }
        htmlFor={props.htmlFor}
      >
        {props.label}
      </FieldLabel>
      {props.children}
      {props.error ? (
        <FieldError id={props.htmlFor ? `${props.htmlFor}-error` : undefined}>
          {props.error}
        </FieldError>
      ) : null}
      {props.help ? (
        <FieldDescription
          id={props.htmlFor ? `${props.htmlFor}-help` : undefined}
        >
          {props.help}
        </FieldDescription>
      ) : null}
    </ShadcnField>
  );
}
