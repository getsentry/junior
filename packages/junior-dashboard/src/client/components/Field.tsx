import type { ReactNode } from "react";

import { cn } from "../styles";

/** Label a control with optional help text using the shared form stack. */
export function Field(props: {
  children: ReactNode;
  className?: string;
  help?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
}) {
  return (
    <div className={cn("grid gap-2", props.className)}>
      <label
        className="text-sm font-semibold text-dashboard-text"
        htmlFor={props.htmlFor}
      >
        {props.label}
      </label>
      {props.children}
      {props.help ? (
        <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
          {props.help}
        </p>
      ) : null}
    </div>
  );
}
