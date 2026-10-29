// Adapted from shadcn/ui Base UI Radio Group. See shadcn.LICENSE.
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@dashboard/lib/utils";

/** Own the selected value and arrow-key focus for a set of radios. */
function RadioGroup<Value>(props: RadioGroupPrimitive.Props<Value>) {
  return <RadioGroupPrimitive data-slot="radio-group" {...props} />;
}

/** Render one Base UI radio with the dashboard control surface. */
function RadioGroupItem({
  className,
  ...props
}: Omit<RadioPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "grid size-4 shrink-0 cursor-pointer place-items-center rounded-full border border-dashboard-border-interactive bg-dashboard-control transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus data-checked:border-dashboard-focus data-checked:bg-dashboard-focus data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-1.5 rounded-full bg-dashboard-text-inverse"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
