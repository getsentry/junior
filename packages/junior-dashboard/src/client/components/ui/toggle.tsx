import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

/** Pressed-state looks shared by `Toggle` and `ToggleGroupItem`. */
const toggleVariants = cva(
  "inline-flex cursor-pointer items-center justify-center font-sans text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
  {
    variants: {
      variant: {
        /** Quiet when off. The pressed state uses the active surface. */
        default:
          "h-7 min-w-10 rounded-md border border-transparent bg-transparent px-2 text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text data-pressed:border-dashboard-border-interactive data-pressed:bg-dashboard-surface-active data-pressed:text-dashboard-text",
        /** A bordered filter chip. The pressed state fills solid. */
        pill: "rounded-md border border-dashboard-border-strong bg-dashboard-surface-raised px-2 py-1 leading-tight text-dashboard-text-muted hover:border-dashboard-border-interactive hover:bg-dashboard-surface-hover hover:text-dashboard-text data-pressed:border-dashboard-border-heavy data-pressed:bg-dashboard-text-solid data-pressed:text-dashboard-text-inverse",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/** Turn one setting on or off. */
function Toggle<Value extends string>({
  className,
  variant,
  ...props
}: TogglePrimitive.Props<Value> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
