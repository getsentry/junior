import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@dashboard/lib/utils";

const nativeSelectVariants = cva(
  "block w-full min-w-0 appearance-none pr-9 disabled:cursor-not-allowed disabled:opacity-60 forced-colors:appearance-auto [color-scheme:var(--dashboard-color-scheme,dark)]",
  {
    variants: {
      variant: {
        /** Form field. Touch screens get the taller target. */
        form: "min-h-11 rounded-md border border-input bg-dashboard-ink py-2 pl-3 text-base text-foreground focus:border-ring focus:outline-none aria-invalid:border-rose-300 sm:min-h-10 sm:text-sm",
        /** Borderless sort control that fills its frame. */
        sort: "h-full bg-dashboard-control pl-2 font-sans text-xs text-muted-foreground outline-none",
      },
    },
    defaultVariants: { variant: "form" },
  },
);

/** Keep native choices and draw the dashboard arrow. */
function NativeSelect({
  className,
  variant,
  ...props
}: Omit<ComponentProps<"select">, "size"> &
  VariantProps<typeof nativeSelectVariants>) {
  return (
    <span
      data-slot="native-select-wrapper"
      className={cn(
        "relative block w-full min-w-0",
        variant === "sort" && "h-full",
        className,
      )}
    >
      <select
        data-slot="native-select"
        className={nativeSelectVariants({ variant })}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        data-slot="native-select-icon"
        className={cn(
          "pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground forced-colors:hidden",
          props.disabled && "opacity-60",
        )}
      />
    </span>
  );
}

export { NativeSelect };
