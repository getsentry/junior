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
        warning:
          "border-amber-300/25 bg-amber-300/5 text-dashboard-text *:[svg]:text-amber-300",
        accent:
          "border-dashboard-accent/15 bg-dashboard-accent/[0.07] text-dashboard-accent-text/80",
      },
      layout: {
        default: "",
        /** Form recovery text. Flex, so the text column keeps its content width. */
        notice: "flex min-w-0 rounded-md p-4 has-[>svg]:gap-x-3",
        /** Full-width strip at the edge of the page. */
        banner:
          "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-none border-0 border-t px-3 py-1.5 text-center font-sans text-xs",
        /** Message text in the flow, without a surface. */
        inline: "block rounded-none border-0 bg-transparent p-0",
      },
    },
    compoundVariants: [
      {
        variant: "destructive",
        layout: "notice",
        className:
          "border-rose-300/25 bg-rose-300/5 text-dashboard-text *:[svg]:text-rose-300",
      },
      {
        variant: "warning",
        layout: "banner",
        className: "border-amber-300/15 bg-amber-300/[0.07] text-amber-100/80",
      },
      { variant: "destructive", layout: "inline", className: "text-rose-300" },
    ],
    defaultVariants: {
      variant: "default",
      layout: "default",
    },
  },
);

/** Show a message in a live region. Pass `role="status"` for polite updates. */
function Alert({
  className,
  layout,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ layout, variant }), className)}
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
