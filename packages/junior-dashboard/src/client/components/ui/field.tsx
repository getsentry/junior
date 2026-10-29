// Adapted from shadcn/ui Field. See shadcn.LICENSE.
import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

/** Stack a label, control, and messages for one form field. */
function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="field" className={cn("grid gap-2", className)} {...props} />
  );
}

/** Label the field control. */
function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("text-sm font-semibold text-dashboard-text", className)}
      {...props}
    />
  );
}

/** Give help text below the field control. */
function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}

/** Announce a field validation error. */
function FieldError({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn("m-0 text-xs leading-relaxed text-rose-300", className)}
      {...props}
    />
  );
}

export { Field, FieldDescription, FieldError, FieldLabel };
