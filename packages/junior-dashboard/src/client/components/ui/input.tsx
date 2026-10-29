// Adapted from shadcn/ui Base UI Input. See shadcn.LICENSE.
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@dashboard/lib/utils";

/** Style the dashboard text control surface shared by inputs and text areas. */
export const textControlClass =
  "block w-full rounded-md border border-dashboard-border-emphasis bg-dashboard-ink px-3 py-2 font-sans text-sm text-dashboard-text placeholder:text-dashboard-text-muted/70 focus:border-dashboard-focus focus:outline-none focus:ring-1 focus:ring-dashboard-focus/25 aria-invalid:border-rose-300 disabled:cursor-not-allowed disabled:opacity-50";

/** Render a Base UI text input with the dashboard text control surface. */
function Input({
  className,
  ...props
}: Omit<InputPrimitive.Props, "className"> & { className?: string }) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(textControlClass, className)}
      {...props}
    />
  );
}

export { Input };
