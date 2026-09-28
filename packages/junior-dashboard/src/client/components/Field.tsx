import type { ReactNode } from "react";

import { cn } from "../styles";

export type FieldSize = "compact" | "default";

const labelClass: Record<FieldSize, string> = {
  compact:
    "font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted",
  default: "text-sm font-semibold text-dashboard-text",
};

const stackClass: Record<FieldSize, string> = {
  compact: "grid gap-1.5",
  default: "grid gap-2",
};

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
  const size = props.size ?? "default";
  return (
    <div className={cn(stackClass[size], props.className)}>
      <label className={labelClass[size]} htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p
          id={props.htmlFor ? `${props.htmlFor}-error` : undefined}
          role="alert"
          className="m-0 text-xs leading-relaxed text-rose-300"
        >
          {props.error}
        </p>
      ) : null}
      {props.help ? (
        <p
          id={props.htmlFor ? `${props.htmlFor}-help` : undefined}
          className="m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm"
        >
          {props.help}
        </p>
      ) : null}
    </div>
  );
}
