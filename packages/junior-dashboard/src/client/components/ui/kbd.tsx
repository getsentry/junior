import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

const kbdVariants = cva("pointer-events-none font-sans select-none", {
  variants: {
    variant: {
      /** A key cap beside a control, such as a choice number or Esc. */
      default:
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border bg-dashboard-fill-soft px-1 text-2xs text-muted-foreground",
      /** Shortcut text inside a button or tooltip. It keeps the parent's color. */
      plain: "",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/** Show a keyboard key or shortcut. */
function Kbd({
  className,
  variant,
  ...props
}: ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(kbdVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Kbd };
