import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@dashboard/lib/utils";
import { toggleVariants } from "./toggle";

/** Own one pressed value and arrow-key focus across a row of segments. */
function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

/** Render one segment with the `ui/toggle` look. */
function ToggleGroupItem<Value extends string>({
  className,
  ...props
}: TogglePrimitive.Props<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(toggleVariants(), className)}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
