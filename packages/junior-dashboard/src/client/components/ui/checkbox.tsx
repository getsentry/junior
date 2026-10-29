import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@dashboard/lib/utils";
import { CheckIcon } from "lucide-react";

/** Render a Base UI checkbox with the dashboard control surface. */
function Checkbox({
  className,
  ...props
}: Omit<CheckboxPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm border border-dashboard-border-interactive bg-dashboard-control text-dashboard-text-inverse transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus data-checked:border-dashboard-focus data-checked:bg-dashboard-focus data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
        <CheckIcon aria-hidden="true" size={12} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
