import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

/** Quiet when off. The pressed state uses the active surface. */
const toggleVariants = cva(
  "inline-flex h-7 min-w-10 cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent px-2 font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus data-pressed:border-dashboard-border-interactive data-pressed:bg-dashboard-surface-active data-pressed:text-dashboard-text",
);

/** Turn one setting on or off. */
function Toggle<Value extends string>({
  className,
  ...props
}: TogglePrimitive.Props<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants(), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
