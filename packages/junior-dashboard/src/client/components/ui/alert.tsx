import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-dashboard-border-strong bg-dashboard-surface-raised text-dashboard-text",
        destructive:
          "border-rose-300/20 bg-rose-300/[0.08] text-rose-100 *:data-[slot=alert-description]:text-rose-100/70 *:[svg]:text-rose-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** Show a message in a live region. Pass `role="status"` for polite updates. */
function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-dashboard-text",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-dashboard-text-muted md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-dashboard-text [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
