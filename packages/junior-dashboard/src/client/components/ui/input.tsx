import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

import { submitFormOnModEnter } from "./submit-shortcut";

/** Style the dashboard text control surface shared by inputs and text areas. */
export const textControlClass =
  "block w-full rounded-md border border-input bg-dashboard-ink px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/25 aria-invalid:border-rose-300 disabled:cursor-not-allowed disabled:opacity-50";

const inputVariants = cva(textControlClass, {
  variants: {
    size: {
      default: "",
      comfortable: "min-h-11 text-base sm:min-h-10 sm:text-sm",
    },
  },
  defaultVariants: { size: "default" },
});

/**
 * Render a Base UI text input. Use `size="comfortable"` for larger mobile
 * controls. Ctrl+Enter or Cmd+Enter sends its form.
 */
function Input({
  className,
  size,
  ...props
}: Omit<InputPrimitive.Props, "className" | "size"> &
  VariantProps<typeof inputVariants> & { className?: string }) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(inputVariants({ size }), className)}
      {...props}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        submitFormOnModEnter(event);
      }}
    />
  );
}

export { Input };
